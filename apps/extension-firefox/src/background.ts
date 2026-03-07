import { validateToolArgs } from "../../../packages/browser-tools/src/index.js";
import {
  BackgroundToContentMessageSchema,
  DEFAULT_MODEL_DESCRIPTORS,
  DEFAULT_OVERLAY_POSITION,
  DEFAULT_OVERLAY_SIZE,
  MIN_OVERLAY_SIZE,
  ModelContinueRequestSchema,
  ModelMessageRequestSchema,
  ModelStartRequestSchema,
  ModelsResponseSchema,
  ModelTurnResponseSchema,
  OverlayIntentSchema,
  SessionOptionsSchema,
  ToolCallRequestSchema,
  createDefaultSessionOptions,
  createEnvelopeIds,
  createSessionId,
  type AccessMode,
  type BackgroundToContentMessage,
  type BrowserToolName,
  type ModelDescriptor,
  type ModelTurn,
  type OverlayFeedItem,
  type OverlayViewState,
  type PageSnapshot,
  type SessionOptions,
  type TaskState,
  type ToolCallRequest,
  type ToolResult
} from "../../../packages/shared/src/index.js";

const AGENT_HTTP = "http://127.0.0.1:4317";
const OVERLAY_BOUNDS_STORAGE_KEY = "overlay-bounds-v1";
const CONNECTION_REFRESH_WINDOW_MS = 4000;

const READONLY_ALLOWED_TOOLS = new Set<BrowserToolName>([
  "get_page_snapshot",
  "get_interactive_elements",
  "get_element_details",
  "extract_text",
  "get_form_state",
  "take_screenshot",
  "get_navigation_state",
  "remember_fact",
  "get_memory",
  "summarize_progress"
]);

type ExtensionApi = {
  runtime: {
    onMessage: {
      addListener(
        listener: (message: unknown, sender: { tab?: { id?: number } }) => unknown
      ): void;
    };
  };
  tabs: {
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    executeScript(tabId: number, details: { file: string }): Promise<unknown>;
    update(tabId: number, updateProperties: { url: string }): Promise<unknown>;
    goBack(tabId: number): Promise<void>;
    goForward(tabId: number): Promise<void>;
    captureVisibleTab(
      windowId?: number,
      options?: { format: "png" | "jpeg" }
    ): Promise<string>;
    onUpdated: {
      addListener(
        listener: (tabId: number, changeInfo: { status?: string }) => void
      ): void;
      removeListener(
        listener: (tabId: number, changeInfo: { status?: string }) => void
      ): void;
    };
    onRemoved: {
      addListener(listener: (tabId: number) => void): void;
    };
  };
  browserAction: {
    onClicked: {
      addListener(listener: (tab: { id?: number; url?: string }) => void): void;
    };
  };
  storage?: {
    local?: {
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
};

type FetchLike = typeof fetch;

type TabSessionState = {
  tabId: number;
  feed: OverlayFeedItem[];
  memory: Record<string, string>;
  models: ModelDescriptor[];
  lastSnapshot: PageSnapshot | null;
  viewState: OverlayViewState;
  pauseRequested: boolean;
  busy: boolean;
  pendingTurn: ModelTurn | null;
  pendingContinuation:
    | {
        callId: string;
        toolResult: ToolResult;
      }
    | null;
  lastConnectionCheckAt: number;
  connectionRefresh: Promise<void> | null;
};

type ContentToolMessage = {
  kind: "run_tool";
  request: ToolCallRequest;
};

type ContentPingMessage = {
  kind: "overlay_ping";
};

export function isToolAllowedInAccessMode(
  toolName: BrowserToolName,
  accessMode: AccessMode
) {
  return accessMode === "take_control" || READONLY_ALLOWED_TOOLS.has(toolName);
}

export function canDestroyOverlay(taskState: TaskState) {
  return taskState !== "running" && taskState !== "starting";
}

export function reduceSessionOptions(
  current: SessionOptions,
  next: SessionOptions,
  models: ModelDescriptor[]
) {
  const parsed = SessionOptionsSchema.parse(next);
  const availableModels = models.length > 0 ? models : DEFAULT_MODEL_DESCRIPTORS;
  const selectedModel = availableModels.find((model) => model.id === parsed.model);
  const fallbackModel = availableModels.find((model) => model.id === current.model) ?? availableModels[0];
  const resolvedModel = selectedModel ?? fallbackModel;

  return SessionOptionsSchema.parse({
    model: resolvedModel.id,
    effort: parsed.effort,
    accessMode: parsed.accessMode
  });
}

class OverlayController {
  private injectedTabs = new Set<number>();
  private storedBoundsPromise: Promise<Pick<OverlayViewState, "position" | "size">>;

  constructor(
    private readonly ext: ExtensionApi,
    private readonly getState: (tabId: number) => Promise<TabSessionState>,
    private readonly sendState: (tabId: number) => Promise<void>
  ) {
    this.storedBoundsPromise = this.loadStoredBounds();
  }

  async createInitialViewState(models: ModelDescriptor[]): Promise<OverlayViewState> {
    const bounds = await this.storedBoundsPromise;
    return {
      visible: false,
      destroyed: true,
      position: bounds.position,
      size: bounds.size,
      pendingActivity: false,
      taskState: "idle",
      sessionOptions: createDefaultSessionOptions(models),
      sessionId: null,
      connectionState: "checking",
      headerMessage: null
    };
  }

  async handleOverlayReady(tabId: number) {
    const state = await this.getState(tabId);
    this.injectedTabs.add(tabId);
    state.viewState.destroyed = false;
    state.viewState.visible = true;
    state.viewState.pendingActivity = false;
    return this.createPayload(state);
  }

  async ensureVisible(tabId: number) {
    const state = await this.getState(tabId);
    state.viewState.destroyed = false;
    state.viewState.visible = true;
    state.viewState.pendingActivity = false;
    await this.ensureContentInjected(tabId);
    await this.sendState(tabId);
  }

  async requestClose(tabId: number) {
    const state = await this.getState(tabId);
    if (!canDestroyOverlay(state.viewState.taskState)) {
      appendFeedItem(state, "warning", {
        title: "Pause first to close",
        body: "Pause the active run before closing the overlay."
      });
      await this.sendState(tabId);
      return { ok: false, message: "Pause first to close" };
    }

    state.viewState.visible = false;
    state.viewState.destroyed = true;
    state.viewState.pendingActivity = false;
    await this.persistBounds(state.viewState);
    await this.sendContentMessage(tabId, { kind: "destroy_overlay" });
    return { ok: true };
  }

  async handleToolbarClick(tab: { id?: number; url?: string }) {
    if (!tab.id || !isInjectableUrl(tab.url)) {
      return;
    }

    const state = await this.getState(tab.id);
    if (!canDestroyOverlay(state.viewState.taskState)) {
      appendFeedItem(state, "warning", {
        title: "Pause first to close",
        body: "The toolbar button cannot close the overlay while a run is active."
      });
      await this.ensureVisible(tab.id);
      return;
    }

    if (state.viewState.destroyed || !state.viewState.visible) {
      await this.ensureVisible(tab.id);
      return;
    }

    await this.requestClose(tab.id);
  }

  async updateBounds(
    tabId: number,
    position: OverlayViewState["position"],
    size: OverlayViewState["size"]
  ) {
    const state = await this.getState(tabId);
    state.viewState.position = position;
    state.viewState.size = {
      width: Math.max(MIN_OVERLAY_SIZE.width, Math.min(size.width, 520)),
      height: Math.max(MIN_OVERLAY_SIZE.height, Math.min(size.height, 760))
    };
    await this.persistBounds(state.viewState);
    await this.sendState(tabId);
  }

  async ensureContentInjected(tabId: number) {
    if (!this.injectedTabs.has(tabId)) {
      await this.ext.tabs.executeScript(tabId, { file: "content.js" });
      this.injectedTabs.add(tabId);
      return;
    }

    try {
      await this.ext.tabs.sendMessage(tabId, { kind: "overlay_ping" } satisfies ContentPingMessage);
    } catch {
      this.injectedTabs.delete(tabId);
      await this.ext.tabs.executeScript(tabId, { file: "content.js" });
      this.injectedTabs.add(tabId);
    }
  }

  handleTabRemoved(tabId: number) {
    this.injectedTabs.delete(tabId);
  }

  handleTabNavigated(tabId: number) {
    this.injectedTabs.delete(tabId);
  }

  async sync(tabId: number) {
    const state = await this.getState(tabId);
    if (state.viewState.destroyed || !state.viewState.visible) {
      return;
    }
    await this.ensureContentInjected(tabId);
    await this.sendContentMessage(tabId, this.createPayload(state));
  }

  private createPayload(state: TabSessionState): BackgroundToContentMessage {
    return BackgroundToContentMessageSchema.parse({
      kind: "overlay_state",
      viewState: state.viewState,
      feed: state.feed,
      models: state.models
    });
  }

  private async sendContentMessage(tabId: number, message: BackgroundToContentMessage) {
    try {
      await this.ext.tabs.sendMessage(tabId, message);
    } catch {
      return;
    }
  }

  private async loadStoredBounds() {
    if (!this.ext.storage?.local) {
      return {
        position: DEFAULT_OVERLAY_POSITION,
        size: DEFAULT_OVERLAY_SIZE
      };
    }

    try {
      const stored = await this.ext.storage.local.get(OVERLAY_BOUNDS_STORAGE_KEY);
      const payload = stored[OVERLAY_BOUNDS_STORAGE_KEY] as
        | Pick<OverlayViewState, "position" | "size">
        | undefined;
      if (
        payload &&
        typeof payload.position?.x === "number" &&
        typeof payload.position?.y === "number" &&
        typeof payload.size?.width === "number" &&
        typeof payload.size?.height === "number"
      ) {
        return payload;
      }
    } catch {
      return {
        position: DEFAULT_OVERLAY_POSITION,
        size: DEFAULT_OVERLAY_SIZE
      };
    }

    return {
      position: DEFAULT_OVERLAY_POSITION,
      size: DEFAULT_OVERLAY_SIZE
    };
  }

  private async persistBounds(viewState: OverlayViewState) {
    if (!this.ext.storage?.local) {
      return;
    }

    await this.ext.storage.local.set({
      [OVERLAY_BOUNDS_STORAGE_KEY]: {
        position: viewState.position,
        size: viewState.size
      }
    });
  }
}

class ToolExecutionController {
  constructor(
    private readonly ext: ExtensionApi,
    private readonly overlay: OverlayController
  ) {}

  async execute(state: TabSessionState, turn: Extract<ModelTurn, { kind: "tool_call" }>) {
    if (turn.toolName === "remember_fact") {
      const parsed = validateToolArgs("remember_fact", turn.args);
      state.memory[parsed.key] = parsed.value;
      return {
        ok: true,
        code: "ok",
        message: "Stored fact in memory.",
        data: {
          key: parsed.key,
          value: parsed.value
        }
      } satisfies ToolResult;
    }

    if (turn.toolName === "get_memory") {
      const parsed = validateToolArgs("get_memory", turn.args);
      return {
        ok: true,
        code: "ok",
        message: "Loaded memory.",
        data: parsed.key ? { [parsed.key]: state.memory[parsed.key] ?? null } : state.memory
      } satisfies ToolResult;
    }

    if (turn.toolName === "summarize_progress") {
      return {
        ok: true,
        code: "ok",
        message: "Summarized progress.",
        data: {
          summary: summarizeFeed(state.feed)
        }
      } satisfies ToolResult;
    }

    if (!isToolAllowedInAccessMode(turn.toolName, state.viewState.sessionOptions.accessMode)) {
      return {
        ok: false,
        code: "readonly_blocked",
        message: `${turn.toolName} is blocked in Readonly mode.`,
        data: {
          accessMode: state.viewState.sessionOptions.accessMode
        }
      } satisfies ToolResult;
    }

    const request = ToolCallRequestSchema.parse({
      type: "tool_call_request",
      requestId: createEnvelopeIds().id,
      sessionId: state.viewState.sessionId,
      tabId: state.tabId,
      timestamp: new Date().toISOString(),
      toolName: turn.toolName,
      args: turn.args,
      summary: turn.summary
    });

    return await this.executeToolRequest(request);
  }

  private async executeToolRequest(request: ToolCallRequest): Promise<ToolResult> {
    const tabId = request.tabId;
    if (tabId === null) {
      return {
        ok: false,
        code: "no_active_tab",
        message: "No active tab is available for tool execution."
      };
    }

    if (request.toolName === "navigate_to") {
      const parsed = validateToolArgs("navigate_to", request.args);
      await this.ext.tabs.update(tabId, { url: parsed.url });
      await waitForTabUpdate(this.ext, tabId);
      return this.requestPageSnapshot(tabId, request.sessionId);
    }

    if (request.toolName === "go_back") {
      await this.ext.tabs.goBack(tabId);
      await waitForTabUpdate(this.ext, tabId);
      return this.requestPageSnapshot(tabId, request.sessionId);
    }

    if (request.toolName === "go_forward") {
      await this.ext.tabs.goForward(tabId);
      await waitForTabUpdate(this.ext, tabId);
      return this.requestPageSnapshot(tabId, request.sessionId);
    }

    if (request.toolName === "take_screenshot") {
      const dataUrl = await this.ext.tabs.captureVisibleTab(undefined, { format: "png" });
      return {
        ok: true,
        code: "ok",
        message: "Captured visible tab screenshot.",
        screenshotBase64: dataUrl.split(",")[1]
      };
    }

    await this.overlay.ensureContentInjected(tabId);

    if (request.toolName === "click_element") {
      try {
        const result = (await this.ext.tabs.sendMessage(tabId, {
          kind: "run_tool",
          request
        } satisfies ContentToolMessage)) as ToolResult;
        return await this.reconcileClickNavigation(request, result);
      } catch (error) {
        const navigated = await waitForPotentialNavigation(this.ext, tabId, 5000);
        if (!navigated) {
          throw error;
        }
        const snapshot = await this.requestPageSnapshot(tabId, request.sessionId);
        if (!snapshot.ok || !snapshot.pageSnapshot) {
          return snapshot;
        }
        return {
          ok: true,
          code: "ok",
          message: "Clicked element and followed page navigation.",
          pageSnapshot: snapshot.pageSnapshot
        } satisfies ToolResult;
      }
    }

    return (await this.ext.tabs.sendMessage(tabId, {
      kind: "run_tool",
      request
    } satisfies ContentToolMessage)) as ToolResult;
  }

  private requestPageSnapshot(tabId: number, sessionId: string) {
    return this.executeToolRequest({
      type: "tool_call_request",
      requestId: createEnvelopeIds().id,
      sessionId,
      tabId,
      timestamp: new Date().toISOString(),
      toolName: "get_page_snapshot",
      args: {}
    });
  }

  private async reconcileClickNavigation(request: ToolCallRequest, result: ToolResult) {
    const tabId = request.tabId;
    if (tabId === null || !result.ok) {
      return result;
    }

    const navigated = await waitForPotentialNavigation(this.ext, tabId, 5000);
    if (!navigated) {
      return result;
    }

    const snapshot = await this.requestPageSnapshot(tabId, request.sessionId);
    if (!snapshot.ok || !snapshot.pageSnapshot) {
      return {
        ...result,
        message: `${result.message} Navigation completed, but the new page snapshot could not be collected.`
      };
    }

    return {
      ...result,
      message: "Clicked element and synced the new page state.",
      pageSnapshot: snapshot.pageSnapshot
    };
  }
}

class SessionController {
  constructor(
    private readonly getState: (tabId: number) => Promise<TabSessionState>,
    private readonly overlay: OverlayController,
    private readonly tools: ToolExecutionController,
    private readonly fetchImpl: FetchLike
  ) {}

  async refreshConnection(tabId: number, force = false) {
    const state = await this.getState(tabId);
    const now = Date.now();
    if (
      !force &&
      state.connectionRefresh === null &&
      now - state.lastConnectionCheckAt < CONNECTION_REFRESH_WINDOW_MS
    ) {
      return;
    }

    if (state.connectionRefresh) {
      await state.connectionRefresh;
      return;
    }

    state.connectionRefresh = (async () => {
      state.viewState.connectionState = "checking";
      await this.overlay.sync(tabId);

      try {
        const [healthResponse, modelsResponse] = await Promise.all([
          this.fetchImpl(`${AGENT_HTTP}/health`),
          this.fetchImpl(`${AGENT_HTTP}/api/models`)
        ]);
        if (!healthResponse.ok || !modelsResponse.ok) {
          throw new Error("Local model host is offline.");
        }

        const modelsJson = ModelsResponseSchema.parse(await modelsResponse.json());
        state.models = modelsJson.models;
        state.viewState.sessionOptions = reduceSessionOptions(
          state.viewState.sessionOptions,
          state.viewState.sessionOptions,
          state.models
        );
        state.viewState.connectionState = "online";
        if (state.viewState.taskState === "idle") {
          state.viewState.headerMessage = null;
        }
      } catch (error) {
        console.error("[BrowserControl] connection check failed", error);
        state.viewState.connectionState = "offline";
        state.viewState.headerMessage = toErrorMessage(
          error,
          "Local model host is offline"
        );
      } finally {
        state.lastConnectionCheckAt = Date.now();
        state.connectionRefresh = null;
      }

      await this.overlay.sync(tabId);
    })();

    await state.connectionRefresh;
  }

  async updateSessionOptions(tabId: number, sessionOptions: SessionOptions) {
    const state = await this.getState(tabId);
    state.viewState.sessionOptions = reduceSessionOptions(
      state.viewState.sessionOptions,
      sessionOptions,
      state.models
    );
    await this.overlay.sync(tabId);
    return { ok: true };
  }

  async newChat(tabId: number) {
    const state = await this.getState(tabId);
    if (state.viewState.taskState === "running" || state.viewState.taskState === "starting") {
      appendFeedItem(state, "warning", {
        title: "Pause first to start a new chat",
        body: "Pause the active run before resetting this conversation."
      });
      await this.overlay.sync(tabId);
      return { ok: false, message: "Pause first to start a new chat." };
    }

    const previousSessionId = state.viewState.sessionId;
    resetSession(state);
    await this.overlay.sync(tabId);

    if (previousSessionId) {
      await this.cancelRemoteSession(previousSessionId);
    }

    return { ok: true };
  }

  async sendPrompt(tabId: number, prompt: string) {
    const state = await this.getState(tabId);
    const trimmed = prompt.trim();
    if (!trimmed) {
      return { ok: false, message: "Prompt is empty." };
    }

    if (state.viewState.taskState === "running" || state.viewState.taskState === "starting") {
      appendFeedItem(state, "warning", {
        title: "Run already active",
        body: "Pause the current run before sending another prompt."
      });
      await this.overlay.sync(tabId);
      return { ok: false, message: "Run already active." };
    }

    if (state.viewState.taskState === "paused") {
      appendFeedItem(state, "warning", {
        title: "Resume or start a new chat",
        body: "A paused run cannot accept another message yet."
      });
      await this.overlay.sync(tabId);
      return { ok: false, message: "Resume or start a new chat." };
    }

    if (state.viewState.taskState === "error") {
      const previousSessionId = state.viewState.sessionId;
      resetSession(state);
      if (previousSessionId) {
        await this.cancelRemoteSession(previousSessionId);
      }
    }

    const isFollowUp = Boolean(state.viewState.sessionId) && state.viewState.taskState === "completed";
    if (!isFollowUp) {
      resetRunState(state);
      state.viewState.sessionId = createSessionId();
    }

    state.viewState.taskState = "starting";
    state.viewState.headerMessage = "Thinking...";
    appendFeedItem(state, "user", {
      body: trimmed
    });
    appendFeedItem(state, "status", {
      title: "Thinking...",
      body: isFollowUp ? "Preparing the next model turn." : "Preparing the first model turn."
    });
    await this.overlay.sync(tabId);

    await this.refreshConnection(tabId, true);
    if (state.viewState.connectionState !== "online") {
      this.failSession(state, "Local model host is offline.");
      await this.overlay.sync(tabId);
      return { ok: false, message: "Local model host is offline." };
    }

    try {
      state.busy = true;
      state.lastSnapshot = await this.capturePageSnapshot(state);
      const response = isFollowUp
        ? await this.sendFollowUpMessage(state, trimmed)
        : await this.startSession(state, trimmed);
      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json.error ?? "Unable to start the model session.");
      }
      state.busy = false;
      const turn = ModelTurnResponseSchema.parse(json).turn;
      if (state.pauseRequested) {
        state.pendingTurn = turn;
        this.enterPausedState(state);
        await this.overlay.sync(tabId);
        return { ok: true, sessionId: state.viewState.sessionId };
      }
      void this.runLoop(state, turn);
      return { ok: true, sessionId: state.viewState.sessionId };
    } catch (error) {
      console.error("[BrowserControl] failed to send prompt", error);
      state.busy = false;
      this.failSession(
        state,
        error instanceof Error ? error.message : "Unable to start the model session."
      );
      await this.overlay.sync(tabId);
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Unable to start the model session."
      };
    }
  }

  async pause(tabId: number) {
    const state = await this.getState(tabId);
    if (state.viewState.taskState !== "running" && state.viewState.taskState !== "starting") {
      return { ok: false, message: "No running task to pause." };
    }

    state.pauseRequested = true;
    state.viewState.headerMessage = "Pausing after the current step";
    if (!state.busy) {
      this.enterPausedState(state);
    }
    await this.overlay.sync(tabId);
    return { ok: true };
  }

  async resume(tabId: number) {
    const state = await this.getState(tabId);
    if (state.viewState.taskState !== "paused") {
      return { ok: false, message: "No paused task to resume." };
    }

    state.pauseRequested = false;
    state.viewState.taskState = "running";
    state.viewState.headerMessage = null;
    await this.overlay.sync(tabId);

    if (state.pendingContinuation) {
      const pending = state.pendingContinuation;
      state.pendingContinuation = null;
      void this.continueAfterTool(tabId, state, pending.callId, pending.toolResult);
      return { ok: true };
    }

    if (state.pendingTurn) {
      const turn = state.pendingTurn;
      state.pendingTurn = null;
      void this.runLoop(state, turn);
      return { ok: true };
    }

    return { ok: true };
  }

  private async runLoop(state: TabSessionState, initialTurn: ModelTurn) {
    let turn = initialTurn;

    while (true) {
      if (state.pauseRequested) {
        state.pendingTurn = turn;
        this.enterPausedState(state);
        await this.overlay.sync(state.tabId);
        return;
      }

      state.viewState.taskState = "running";
      state.viewState.headerMessage = null;

      if (turn.kind === "final") {
        appendFeedItem(state, "answer", {
          title: turn.summary,
          body: turn.answer
        });
        state.viewState.taskState = "completed";
        state.viewState.headerMessage = null;
        state.pendingTurn = null;
        state.pendingContinuation = null;
        await this.overlay.sync(state.tabId);
        return;
      }

      state.viewState.headerMessage = turn.summary;
      appendFeedItem(state, "tool", {
        title: `Running ${turn.toolName}`,
        body: turn.summary,
        toolName: turn.toolName,
        stage: "start"
      });
      await this.overlay.sync(state.tabId);

      try {
        state.busy = true;
        const toolResult = await this.tools.execute(state, turn);
        state.busy = false;

        if (toolResult.pageSnapshot) {
          state.lastSnapshot = toolResult.pageSnapshot;
        }

        if (toolResult.code === "readonly_blocked") {
          appendFeedItem(state, "warning", {
            title: "Readonly blocked an action",
            body: `${turn.toolName} was blocked. Switch Access to Take Control to allow browser actions.`
          });
        }

        appendFeedItem(state, toolResult.ok ? "tool" : "error", {
          title: toolResult.ok ? `Finished ${turn.toolName}` : `Failed ${turn.toolName}`,
          body: toolResult.message,
          toolName: turn.toolName,
          stage: toolResult.ok ? "finish" : toolResult.code === "readonly_blocked" ? "blocked" : "fail"
        });
        state.viewState.headerMessage = "Thinking...";
        await this.overlay.sync(state.tabId);

        if (state.pauseRequested) {
          state.pendingContinuation = {
            callId: turn.callId,
            toolResult
          };
          this.enterPausedState(state);
          await this.overlay.sync(state.tabId);
          return;
        }

        turn = await this.requestContinue(state, turn.callId, toolResult);
      } catch (error) {
        console.error("[BrowserControl] model loop failed", error);
        state.busy = false;
        this.failSession(state, error instanceof Error ? error.message : String(error));
        await this.overlay.sync(state.tabId);
        return;
      }
    }
  }

  private async continueAfterTool(
    tabId: number,
    state: TabSessionState,
    callId: string,
    toolResult: ToolResult
  ) {
    try {
      const turn = await this.requestContinue(state, callId, toolResult);
      void this.runLoop(state, turn);
    } catch (error) {
      console.error("[BrowserControl] failed to continue model session", error);
      this.failSession(state, error instanceof Error ? error.message : String(error));
      await this.overlay.sync(tabId);
    }
  }

  private async requestContinue(
    state: TabSessionState,
    callId: string,
    toolResult: ToolResult
  ) {
    const sessionId = state.viewState.sessionId;
    if (!sessionId) {
      throw new Error("Missing model session id.");
    }
    state.busy = true;
    const requestBody = ModelContinueRequestSchema.parse({
      sessionId,
      callId,
      toolResult,
      pageSnapshot: state.lastSnapshot ?? undefined,
      memory: state.memory,
      sessionOptions: state.viewState.sessionOptions
    });
    const response = await this.fetchImpl(`${AGENT_HTTP}/api/model/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    const json = await response.json();
    state.busy = false;
    if (!response.ok || !json.ok) {
      throw new Error(json.error ?? "Model returned no actionable turn.");
    }
    return ModelTurnResponseSchema.parse(json).turn;
  }

  private async capturePageSnapshot(state: TabSessionState) {
    const snapshotResult = await this.tools.execute(state, {
      kind: "tool_call",
      callId: createEnvelopeIds().id,
      summary: "Collecting page snapshot.",
      toolName: "get_page_snapshot",
      args: {}
    });
    if (!snapshotResult.ok || !snapshotResult.pageSnapshot) {
      throw new Error(snapshotResult.message || "Unable to collect the current page snapshot.");
    }
    return snapshotResult.pageSnapshot;
  }

  private async startSession(state: TabSessionState, prompt: string) {
    const sessionId = state.viewState.sessionId;
    const pageSnapshot = state.lastSnapshot;
    if (!sessionId || !pageSnapshot) {
      throw new Error("Missing initial session context.");
    }
    const startRequest = ModelStartRequestSchema.parse({
      sessionId,
      task: prompt,
      pageSnapshot,
      memory: state.memory,
      feedSummary: summarizeFeed(state.feed),
      sessionOptions: state.viewState.sessionOptions
    });
    return await this.fetchImpl(`${AGENT_HTTP}/api/model/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(startRequest)
    });
  }

  private async sendFollowUpMessage(state: TabSessionState, prompt: string) {
    const sessionId = state.viewState.sessionId;
    if (!sessionId) {
      throw new Error("Missing model session id.");
    }
    const requestBody = ModelMessageRequestSchema.parse({
      sessionId,
      prompt,
      pageSnapshot: state.lastSnapshot ?? undefined,
      memory: state.memory,
      feedSummary: summarizeFeed(state.feed),
      sessionOptions: state.viewState.sessionOptions
    });
    return await this.fetchImpl(`${AGENT_HTTP}/api/model/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
  }

  private async cancelRemoteSession(sessionId: string) {
    try {
      await this.fetchImpl(`${AGENT_HTTP}/api/model/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId })
      });
    } catch (error) {
      console.error("[BrowserControl] failed to cancel session", error);
    }
  }

  private enterPausedState(state: TabSessionState) {
    state.viewState.taskState = "paused";
    state.viewState.headerMessage = "Paused";
    state.busy = false;
  }

  private failSession(state: TabSessionState, message: string) {
    appendFeedItem(state, "error", {
      title: "Run failed",
      body: message
    });
    state.viewState.taskState = "error";
    state.viewState.headerMessage = message;
    state.busy = false;
    state.pendingTurn = null;
    state.pendingContinuation = null;
    state.pauseRequested = false;
  }
}

export class BrowserControlBackground {
  private readonly tabStates = new Map<number, TabSessionState>();
  private readonly statePromises = new Map<number, Promise<TabSessionState>>();
  private readonly overlay: OverlayController;
  private readonly sessions: SessionController;
  private readonly tools: ToolExecutionController;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly ext: ExtensionApi, fetchImpl?: FetchLike) {
    this.fetchImpl =
      fetchImpl ??
      ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) =>
        fetch(input, init));
    this.overlay = new OverlayController(ext, (tabId) => this.ensureTabState(tabId), (tabId) =>
      this.overlay.sync(tabId)
    );
    this.tools = new ToolExecutionController(ext, this.overlay);
    this.sessions = new SessionController(
      (tabId) => this.ensureTabState(tabId),
      this.overlay,
      this.tools,
      this.fetchImpl
    );
  }

  start() {
    this.ext.runtime.onMessage.addListener((message, sender) =>
      this.handleRuntimeMessage(message, sender)
    );
    this.ext.browserAction.onClicked.addListener((tab) => {
      void this.overlay.handleToolbarClick(tab);
    });
    this.ext.tabs.onUpdated.addListener((tabId, changeInfo) => {
      void this.handleTabUpdated(tabId, changeInfo);
    });
    this.ext.tabs.onRemoved.addListener((tabId) => {
      this.tabStates.delete(tabId);
      this.statePromises.delete(tabId);
      this.overlay.handleTabRemoved(tabId);
    });
  }

  private async handleRuntimeMessage(
    message: unknown,
    sender: { tab?: { id?: number } }
  ) {
    const tabId = sender.tab?.id;
    if (!tabId) {
      return undefined;
    }

    if (
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>).kind === "run_tool"
    ) {
      return undefined;
    }

    const intent = OverlayIntentSchema.parse(message);
    switch (intent.kind) {
      case "overlay_ready":
      case "request_state":
        await this.sessions.refreshConnection(tabId);
        return this.overlay.handleOverlayReady(tabId);
      case "send_prompt":
        return this.sessions.sendPrompt(tabId, intent.prompt);
      case "pause_task":
        return this.sessions.pause(tabId);
      case "resume_task":
        return this.sessions.resume(tabId);
      case "close_overlay":
        return this.overlay.requestClose(tabId);
      case "new_chat":
        return this.sessions.newChat(tabId);
      case "update_bounds":
        await this.overlay.updateBounds(tabId, intent.position, intent.size);
        return { ok: true };
      case "update_session_options":
        return this.sessions.updateSessionOptions(tabId, intent.sessionOptions);
      default:
        return undefined;
    }
  }

  private async ensureTabState(tabId: number): Promise<TabSessionState> {
    const existing = this.tabStates.get(tabId);
    if (existing) {
      return existing;
    }

    const pending = this.statePromises.get(tabId);
    if (pending) {
      return pending;
    }

    const promise = this.createTabState(tabId);
    this.statePromises.set(tabId, promise);
    const created = await promise;
    this.tabStates.set(tabId, created);
    this.statePromises.delete(tabId);
    return created;
  }

  private async createTabState(tabId: number): Promise<TabSessionState> {
    const models = DEFAULT_MODEL_DESCRIPTORS.map((model) => ({ ...model }));
    return {
      tabId,
      feed: [],
      memory: {},
      models,
      lastSnapshot: null,
      viewState: await this.overlay.createInitialViewState(models),
      pauseRequested: false,
      busy: false,
      pendingTurn: null,
      pendingContinuation: null,
      lastConnectionCheckAt: 0,
      connectionRefresh: null
    };
  }

  private async handleTabUpdated(tabId: number, changeInfo: { status?: string }) {
    const state = this.tabStates.get(tabId);
    if (!state || !changeInfo.status) {
      return;
    }

    if (changeInfo.status === "loading") {
      this.overlay.handleTabNavigated(tabId);
      return;
    }

    if (
      changeInfo.status === "complete" &&
      state.viewState.visible &&
      !state.viewState.destroyed
    ) {
      await this.overlay.sync(tabId);
    }
  }
}

function appendFeedItem(
  state: TabSessionState,
  kind: OverlayFeedItem["kind"],
  item: Omit<OverlayFeedItem, "id" | "kind" | "timestamp">
) {
  state.feed.push({
    id: createEnvelopeIds().id,
    kind,
    timestamp: new Date().toISOString(),
    ...item
  });
  if (state.viewState.destroyed || !state.viewState.visible) {
    state.viewState.pendingActivity = true;
  }
}

function resetSession(state: TabSessionState) {
  state.feed = [];
  state.memory = {};
  state.lastSnapshot = null;
  resetRunState(state);
  state.viewState.pendingActivity = false;
  state.viewState.taskState = "idle";
  state.viewState.sessionId = null;
  state.viewState.headerMessage = null;
}

function resetRunState(state: TabSessionState) {
  state.pauseRequested = false;
  state.busy = false;
  state.pendingTurn = null;
  state.pendingContinuation = null;
}

function summarizeFeed(feed: OverlayFeedItem[]) {
  return feed
    .slice(-12)
    .map((item) => [item.kind.toUpperCase(), item.title, item.body].filter(Boolean).join(": "))
    .join("\n");
}

async function waitForTabUpdate(ext: ExtensionApi, tabId: number, timeoutMs = 2500) {
  return await new Promise<boolean>((resolve) => {
    const timeout = self.setTimeout(() => {
      ext.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        self.clearTimeout(timeout);
        ext.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    ext.tabs.onUpdated.addListener(listener);
  });
}

async function waitForPotentialNavigation(
  ext: ExtensionApi,
  tabId: number,
  timeoutMs = 5000,
  settleMs = 450
) {
  return await new Promise<boolean>((resolve) => {
    let sawLoading = false;
    let finished = false;

    const settleTimeout = self.setTimeout(() => {
      if (!sawLoading) {
        finish(false);
      }
    }, settleMs);
    const timeout = self.setTimeout(() => {
      finish(false);
    }, timeoutMs);

    const finish = (value: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      self.clearTimeout(settleTimeout);
      self.clearTimeout(timeout);
      ext.tabs.onUpdated.removeListener(listener);
      resolve(value);
    };

    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status === "loading") {
        sawLoading = true;
        return;
      }
      if (changeInfo.status === "complete") {
        finish(true);
      }
    };

    ext.tabs.onUpdated.addListener(listener);
  });
}

function isInjectableUrl(url?: string) {
  return Boolean(url && /^https?:/i.test(url));
}

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function getExtensionApi(): ExtensionApi | null {
  const globalRecord = globalThis as Record<string, unknown>;
  const candidate = globalRecord.browser ?? globalRecord.chrome;
  return candidate ? (candidate as ExtensionApi) : null;
}

const ext = getExtensionApi();
if (ext) {
  new BrowserControlBackground(ext).start();
}
