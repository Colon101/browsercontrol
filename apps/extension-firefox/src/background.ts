import {
  BackgroundToContentMessageSchema,
  DEFAULT_MODEL_DESCRIPTORS,
  DEFAULT_OVERLAY_POSITION,
  DEFAULT_OVERLAY_SIZE,
  MIN_OVERLAY_SIZE,
  BrowserToolNameSchema,
  ModelContinueRequestSchema,
  ModelMessageRequestSchema,
  ModelStartRequestSchema,
  ModelsResponseSchema,
  NextRunIdResponseSchema,
  ModelTurnResponseSchema,
  OverlayIntentSchema,
  SessionOptionsSchema,
  ToolCallRequestSchema,
  createDefaultSessionOptions,
  createEnvelopeIds,
  createIncrementingId,
  type AccessMode,
  type ActionFeedback,
  type BackgroundToContentMessage,
  type BrowserToolName,
  type InteractionTarget,
  type ModelDescriptor,
  type ModelContinueRequest,
  type ModelMessageRequest,
  type ModelStartRequest,
  type ModelTurn,
  type OverlayFeedItem,
  type OverlayViewState,
  type PageSnapshot,
  type SessionOptions,
  type TaskState,
  type ToolCallRequest,
  type ToolResult,
  type VisualContext
} from "../../../packages/shared/src/index.js";

const AGENT_HTTP = "http://127.0.0.1:4317";
const OVERLAY_BOUNDS_STORAGE_KEY = "overlay-bounds-v1";
const EXTENSION_RUNTIME_STORAGE_KEY = "extension-runtime-v1";
const CONNECTION_REFRESH_WINDOW_MS = 4000;
const RUNTIME_REFRESH_WINDOW_MS = 1500;

const READONLY_ALLOWED_TOOLS = new Set<BrowserToolName>([
  "get_page_snapshot",
  "inspect_target",
  "extract_text",
  "get_navigation_state",
  "go_back"
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
    executeScript(tabId: number, details: { file?: string; code?: string }): Promise<unknown>;
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
  models: ModelDescriptor[];
  lastSnapshot: PageSnapshot | null;
  lastTargets: InteractionTarget[];
  viewState: OverlayViewState;
  pauseRequested: boolean;
  busy: boolean;
  pendingTurn: ModelTurn | null;
  pendingContinuation:
    | {
        callId: string;
        toolResult: ToolResult;
        lastActionSummary?: string;
        lastError?: string;
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

type ContentOverlaySuppressionMessage = {
  kind: "set_overlay_suppressed";
  hidden: boolean;
};

type ContentSanitizeCaptureMessage = {
  kind: "sanitize_capture";
  dataUrl: string;
  overlayBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
};

type ExtensionRuntimePayload = {
  ok: true;
  version: string;
  generatedAt: string;
  contentScript: string;
  overlayCss: string;
};

type StoredExtensionRuntime = {
  version: string;
  generatedAt: string;
  contentScript: string;
  overlayCss: string;
};

class ExtensionRuntimeManager {
  private cachedRuntime: StoredExtensionRuntime | null = null;
  private storageLoadPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private lastRefreshAt = 0;

  constructor(
    private readonly ext: ExtensionApi,
    private readonly fetchImpl: FetchLike
  ) {}

  async resolveContentInjection(force = false) {
    await this.refreshIfNeeded(force);

    const runtime = this.cachedRuntime;
    if (runtime) {
      return {
        version: `remote:${runtime.version}`,
        details: {
          code: this.buildInjectedContentScript(runtime)
        }
      };
    }

    return {
      version: "packaged",
      details: {
        file: "content.js"
      }
    };
  }

  async refreshIfNeeded(force = false) {
    await this.ensureLoadedFromStorage();
    const now = Date.now();
    if (!force && now - this.lastRefreshAt < RUNTIME_REFRESH_WINDOW_MS) {
      return;
    }
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = (async () => {
      try {
        const response = await this.fetchImpl(`${AGENT_HTTP}/api/extension/runtime`);
        if (!response.ok) {
          throw new Error(`Extension runtime responded with ${response.status}.`);
        }

        const payload = parseExtensionRuntimePayload(await response.json());
        this.cachedRuntime = {
          version: payload.version,
          generatedAt: payload.generatedAt,
          contentScript: payload.contentScript,
          overlayCss: payload.overlayCss
        };
        this.lastRefreshAt = Date.now();
        await this.persistRuntime();
      } catch (error) {
        void error;
        this.lastRefreshAt = Date.now();
      } finally {
        this.refreshPromise = null;
      }
    })();

    await this.refreshPromise;
  }

  private async ensureLoadedFromStorage() {
    if (this.storageLoadPromise) {
      await this.storageLoadPromise;
      return;
    }

    this.storageLoadPromise = (async () => {
      if (!this.ext.storage?.local) {
        return;
      }

      try {
        const stored = await this.ext.storage.local.get(EXTENSION_RUNTIME_STORAGE_KEY);
        const payload = parseStoredExtensionRuntime(
          stored[EXTENSION_RUNTIME_STORAGE_KEY] as Record<string, unknown> | undefined
        );
        this.cachedRuntime = payload;
      } catch {
        this.cachedRuntime = null;
      }
    })();

    await this.storageLoadPromise;
  }

  private async persistRuntime() {
    if (!this.ext.storage?.local || !this.cachedRuntime) {
      return;
    }

    await this.ext.storage.local.set({
      [EXTENSION_RUNTIME_STORAGE_KEY]: this.cachedRuntime
    });
  }

  private buildInjectedContentScript(runtime: StoredExtensionRuntime) {
    return [
      `globalThis.__browsercontrolRemoteOverlayCss = ${JSON.stringify(runtime.overlayCss)};`,
      runtime.contentScript
    ].join("\n");
  }
}

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
  private injectedTabs = new Map<number, string>();
  private storedBoundsPromise: Promise<Pick<OverlayViewState, "position" | "size">>;

  constructor(
    private readonly ext: ExtensionApi,
    private readonly getState: (tabId: number) => Promise<TabSessionState>,
    private readonly sendState: (tabId: number) => Promise<void>,
    private readonly runtimeManager: ExtensionRuntimeManager
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
      lastAction: null,
      connectionState: "checking",
      headerMessage: null
    };
  }

  async handleOverlayReady(tabId: number) {
    const state = await this.getState(tabId);
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
    const injection = await this.runtimeManager.resolveContentInjection();
    const previousVersion = this.injectedTabs.get(tabId);
    if (previousVersion !== injection.version) {
      await this.ext.tabs.executeScript(tabId, injection.details);
      this.injectedTabs.set(tabId, injection.version);
      if (previousVersion) {
        await this.noteRuntimeUpdated(tabId, previousVersion, injection.version);
      }
      return;
    }

    try {
      await this.ext.tabs.sendMessage(tabId, { kind: "overlay_ping" } satisfies ContentPingMessage);
    } catch {
      this.injectedTabs.delete(tabId);
      const retry = await this.runtimeManager.resolveContentInjection(true);
      await this.ext.tabs.executeScript(tabId, retry.details);
      this.injectedTabs.set(tabId, retry.version);
    }
  }

  private async noteRuntimeUpdated(
    tabId: number,
    previousVersion: string,
    nextVersion: string
  ) {
    const state = await this.getState(tabId);
    appendFeedItem(state, "status", {
      title: "Extension updated",
      body: `${formatRuntimeVersion(previousVersion)} -> ${formatRuntimeVersion(nextVersion)}`
    });
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

  async getVisibleBounds(tabId: number) {
    const state = await this.getState(tabId);
    if (state.viewState.destroyed || !state.viewState.visible) {
      return null;
    }
    return {
      x: state.viewState.position.x,
      y: state.viewState.position.y,
      width: state.viewState.size.width,
      height: state.viewState.size.height
    };
  }

  async withSuppressed<T>(tabId: number, task: () => Promise<T>) {
    await this.setSuppressed(tabId, true);
    try {
      return await task();
    } finally {
      await this.setSuppressed(tabId, false);
    }
  }

  async setSuppressed(tabId: number, hidden: boolean) {
    const state = await this.getState(tabId);
    if (state.viewState.destroyed || !state.viewState.visible) {
      return;
    }
    await this.ensureContentInjected(tabId);
    await this.sendContentMessage(tabId, {
      kind: "set_overlay_suppressed",
      hidden
    } satisfies ContentOverlaySuppressionMessage);
  }

  private createPayload(state: TabSessionState): BackgroundToContentMessage {
    return BackgroundToContentMessageSchema.parse({
      kind: "overlay_state",
      viewState: state.viewState,
      feed: state.feed,
      models: state.models
    });
  }

  private async sendContentMessage(tabId: number, message: unknown) {
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

  async executeToolCall(
    state: TabSessionState,
    turn: Extract<ModelTurn, { kind: "tool_call" }>
  ) {
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
      requestId: createEnvelopeIds("req").id,
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

    if (request.toolName === "go_back") {
      await this.ext.tabs.goBack(tabId);
      await waitForTabUpdate(this.ext, tabId);
      return this.requestPageSnapshot(tabId, request.sessionId);
    }

    await this.overlay.ensureContentInjected(tabId);
    const result = (await this.ext.tabs.sendMessage(tabId, {
      kind: "run_tool",
      request
    } satisfies ContentToolMessage)) as ToolResult;
    if (request.toolName === "click_target" || request.toolName === "click_coords") {
      return await this.reconcileNavigation(request, result);
    }
    return result;
  }

  private requestPageSnapshot(tabId: number, sessionId: string) {
    return this.executeToolRequest({
      type: "tool_call_request",
      requestId: createEnvelopeIds("req").id,
      sessionId,
      tabId,
      timestamp: new Date().toISOString(),
      toolName: "get_page_snapshot",
      args: {}
    });
  }

  private async reconcileNavigation(request: ToolCallRequest, result: ToolResult) {
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
      message: `${result.message} Navigation completed and the new page state was synced.`,
      pageSnapshot: snapshot.pageSnapshot,
      targets: snapshot.targets ?? result.targets,
      actionFeedback: mergeActionFeedback(result.actionFeedback, {
        navigationOccurred: true
      })
    };
  }
}

class SessionController {
  constructor(
    private readonly ext: ExtensionApi,
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
      state.viewState.sessionId = await this.requestNextSessionId();
    }

    state.viewState.taskState = "starting";
    state.viewState.headerMessage = "Thinking...";
    appendFeedItem(state, "user", {
      body: trimmed
    });
    appendFeedItem(state, "status", {
      title:
        state.viewState.sessionOptions.accessMode === "take_control"
          ? "Access: Take Control"
          : "Access: Readonly",
      body:
        state.viewState.sessionOptions.accessMode === "take_control"
          ? "Browser actions are enabled for this run."
          : "Browser actions are blocked. Switch Access to Take Control to allow clicks and typing."
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
      const turn = parseModelTurnResponse(json);
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
      void this.continueAfterTool(
        tabId,
        state,
        pending.callId,
        pending.toolResult,
        pending.lastActionSummary,
        pending.lastError
      );
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
      if (turn.kind === "tool_call") {
        turn = coerceTurnToTargetTurn(turn, state.lastTargets);
      }

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
        title: `Tool ${turn.toolName}`,
        body: formatToolCallBody(turn.summary, turn.args),
        toolName: turn.toolName,
        stage: "start"
      });
      await this.overlay.sync(state.tabId);

      try {
        state.busy = true;
        const toolResult = await this.tools.executeToolCall(state, turn);
        state.busy = false;

        if (toolResult.pageSnapshot) {
          state.lastSnapshot = toolResult.pageSnapshot;
        }
        if (toolResult.targets) {
          state.lastTargets = toolResult.targets;
        }
        state.viewState.lastAction = toolResult.actionFeedback ?? null;

        if (toolResult.code === "readonly_blocked") {
          appendFeedItem(state, "warning", {
            title: "Readonly blocked an action",
            body: `${turn.toolName} was blocked. Switch Access to Take Control to allow browser actions.`
          });
        }

        appendFeedItem(
          state,
          toolResult.ok ? "tool" : "error",
          {
            title: toolResult.ok
              ? `Finished ${turn.toolName}`
              : `Failed ${turn.toolName}`,
            body: formatToolResultBody(toolResult),
            toolName: turn.toolName,
            stage: toolResult.ok
              ? "finish"
              : toolResult.code === "readonly_blocked"
                ? "blocked"
                : "fail"
          }
        );
        state.viewState.headerMessage = "Thinking...";
        await this.overlay.sync(state.tabId);

        const lastActionSummary = turn.summary;
        const lastError = toolResult.ok ? undefined : toolResult.message;
        if (state.pauseRequested) {
          state.pendingContinuation = {
            callId: turn.callId,
            toolResult,
            lastActionSummary,
            lastError
          };
          this.enterPausedState(state);
          await this.overlay.sync(state.tabId);
          return;
        }

        turn = await this.requestContinue(
          state,
          turn.callId,
          toolResult,
          lastActionSummary,
          lastError
        );
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
    toolResult: ToolResult,
    lastActionSummary?: string,
    lastError?: string
  ) {
    try {
      const turn = await this.requestContinue(
        state,
        callId,
        toolResult,
        lastActionSummary,
        lastError
      );
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
    toolResult: ToolResult,
    lastActionSummary?: string,
    lastError?: string
  ) {
    const sessionId = state.viewState.sessionId;
    if (!sessionId) {
      throw new Error("Missing model session id.");
    }
    state.busy = true;
    const visualContext = await this.captureVisualContext(state, {
      lastActionSummary: lastActionSummary ?? toolResult.message,
      lastError,
      lastAction: toolResult.actionFeedback ?? null
    });
    const requestBody = ModelContinueRequestSchema.parse({
      sessionId,
      callId,
      toolResult,
      visualContext,
      pageSnapshot: undefined,
      memory: {},
      sessionOptions: state.viewState.sessionOptions
    });
    if (requestBody.visualContext) {
      logModelRequest(state, "continue", requestBody.visualContext);
    }
    await this.overlay.sync(state.tabId);
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
    return parseModelTurnResponse(json);
  }

  private async capturePageSnapshot(state: TabSessionState) {
    const snapshotResult = await this.tools.executeToolCall(state, {
      kind: "tool_call",
      callId: createEnvelopeIds().id,
      summary: "Collecting page snapshot.",
      toolName: "get_page_snapshot",
      args: {}
    });
    if (!snapshotResult.ok || !snapshotResult.pageSnapshot) {
      throw new Error(snapshotResult.message || "Unable to collect the current page snapshot.");
    }
    state.lastTargets = snapshotResult.targets ?? [];
    return snapshotResult.pageSnapshot;
  }

  private async captureVisualContext(
    state: TabSessionState,
    options: {
      lastActionSummary?: string;
      lastError?: string;
      lastAction?: ActionFeedback | null;
    } = {}
  ): Promise<VisualContext> {
    const snapshot = state.lastSnapshot ?? (await this.capturePageSnapshot(state));
    const targets = state.lastTargets;
    const rawDataUrl = await this.overlay.withSuppressed(state.tabId, async () =>
      await this.ext.tabs.captureVisibleTab(undefined, { format: "png" })
    );
    let dataUrl = await sanitizeCapturedDataUrl(
      this.ext,
      this.overlay,
      state.tabId,
      rawDataUrl
    );
    dataUrl = await annotateCapturedDataUrl(
      dataUrl,
      options.lastAction,
      createIncrementingId("shot")
    );
    return {
      url: snapshot.url,
      title: snapshot.title,
      viewport: snapshot.viewport,
      scrollPosition: snapshot.scrollPosition,
      activeElementId: snapshot.selectionState.activeElementId,
      accessMode: state.viewState.sessionOptions.accessMode,
      targets,
      lastActionSummary: options.lastActionSummary ?? null,
      lastError: options.lastError ?? null,
      lastAction: options.lastAction ?? null,
      screenshotBase64: dataUrl.split(",")[1]
    };
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
      visualContext: await this.captureVisualContext(state),
      pageSnapshot: undefined,
      memory: {},
      feedSummary: "",
      sessionOptions: state.viewState.sessionOptions
    });
    if (startRequest.visualContext) {
      logModelRequest(state, "start", startRequest.visualContext);
    }
    await this.overlay.sync(state.tabId);
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
      visualContext: await this.captureVisualContext(state),
      pageSnapshot: undefined,
      memory: {},
      feedSummary: "",
      sessionOptions: state.viewState.sessionOptions
    });
    if (requestBody.visualContext) {
      logModelRequest(state, "message", requestBody.visualContext);
    }
    await this.overlay.sync(state.tabId);
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

  private async requestNextSessionId() {
    const response = await this.fetchImpl(`${AGENT_HTTP}/api/runs/next-id`);
    const json = await response.json();
    if (!response.ok || !json.ok) {
      throw new Error(json.error ?? "Unable to allocate the next run id.");
    }
    return NextRunIdResponseSchema.parse(json).nextRunId;
  }
}

export class BrowserControlBackground {
  private readonly tabStates = new Map<number, TabSessionState>();
  private readonly statePromises = new Map<number, Promise<TabSessionState>>();
  private readonly overlay: OverlayController;
  private readonly sessions: SessionController;
  private readonly tools: ToolExecutionController;
  private readonly fetchImpl: FetchLike;
  private readonly runtimeManager: ExtensionRuntimeManager;

  constructor(private readonly ext: ExtensionApi, fetchImpl?: FetchLike) {
    this.fetchImpl =
      fetchImpl ??
      ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) =>
        fetch(input, init));
    this.runtimeManager = new ExtensionRuntimeManager(ext, this.fetchImpl);
    this.overlay = new OverlayController(
      ext,
      (tabId) => this.ensureTabState(tabId),
      (tabId) => this.overlay.sync(tabId),
      this.runtimeManager
    );
    this.tools = new ToolExecutionController(ext, this.overlay);
    this.sessions = new SessionController(
      ext,
      (tabId) => this.ensureTabState(tabId),
      this.overlay,
      this.tools,
      this.fetchImpl
    );
  }

  start() {
    void this.runtimeManager.refreshIfNeeded(true);
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
      models,
      lastSnapshot: null,
      lastTargets: [],
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

function parseModelTurnResponse(json: unknown) {
  const payload = ModelTurnResponseSchema.safeParse(json);
  if (payload.success) {
    return payload.data.turn;
  }

  const record =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  if (record?.ok !== true) {
    throw new Error(
      typeof record?.error === "string" ? record.error : "Model returned no actionable turn."
    );
  }

  return normalizeModelTurn(record.turn);
}

function normalizeModelTurn(turn: unknown): ModelTurn {
  if (typeof turn === "string") {
    return {
      kind: "final",
      summary: truncateFeedText(turn, 120) || "Completed",
      answer: turn
    };
  }

  if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
    throw new Error("Model returned an invalid turn payload.");
  }

  const record = turn as Record<string, unknown>;
  if (
    (record.kind === "final" || typeof record.answer === "string") &&
    typeof record.answer === "string"
  ) {
    return {
      kind: "final",
      summary:
        typeof record.summary === "string" && record.summary.trim()
          ? record.summary
          : truncateFeedText(record.answer, 120) || "Completed",
      answer: record.answer
    };
  }

  if (record.kind === "tool_call" || typeof record.toolName === "string") {
    return {
      kind: "tool_call",
      callId:
        typeof record.callId === "string" && record.callId.trim()
          ? record.callId
          : createEnvelopeIds("call").id,
      summary:
        typeof record.summary === "string" && record.summary.trim()
          ? record.summary
          : "Running browser tool.",
      toolName: BrowserToolNameSchema.parse(record.toolName),
      args:
        typeof record.args === "object" &&
        record.args !== null &&
        !Array.isArray(record.args)
          ? (record.args as Record<string, unknown>)
          : {}
    };
  }

  throw new Error("Model returned a turn without a valid kind or tool.");
}

function coerceTurnToTargetTurn(
  turn: Extract<ModelTurn, { kind: "tool_call" }>,
  targets: InteractionTarget[]
): Extract<ModelTurn, { kind: "tool_call" }> {
  if (turn.toolName !== "click_coords" || targets.length === 0) {
    return turn;
  }

  const target = findTargetForPoint(turn.args, targets);
  if (!target) {
    return turn;
  }

  console.info(
    "[BrowserControl] rewrote click_coords to click_target",
    JSON.stringify({
      callId: turn.callId,
      targetId: target.id,
      name: target.name,
      x: Math.round(target.x),
      y: Math.round(target.y)
    })
  );
  return {
    ...turn,
    summary: `click_target {"targetId":"${target.id}"}`,
    toolName: "click_target",
    args: {
      targetId: target.id
    }
  };
}

function findTargetForPoint(args: Record<string, unknown>, targets: InteractionTarget[]) {
  const x = typeof args.x === "number" ? args.x : null;
  const y = typeof args.y === "number" ? args.y : null;
  if (x === null || y === null) {
    return null;
  }

  const containingTargets = targets.filter(
    (target) =>
      x >= target.x &&
      x <= target.x + target.width &&
      y >= target.y &&
      y <= target.y + target.height
  );
  if (containingTargets.length > 0) {
    return containingTargets.sort(
      (left, right) => left.width * left.height - right.width * right.height
    )[0]!;
  }

  const closest = targets
    .map((target) => ({
      target,
      distance: Math.hypot(
        x - (target.x + target.width / 2),
        y - (target.y + target.height / 2)
      )
    }))
    .sort((left, right) => left.distance - right.distance)[0];

  return closest && closest.distance <= 24 ? closest.target : null;
}

function logModelRequest(
  state: TabSessionState,
  phase: "start" | "continue" | "message",
  visualContext: VisualContext
) {
  console.info(
    `[BrowserControl] model ${phase} ${state.viewState.sessionId ?? "run-pending"}`,
    {
      url: visualContext.url,
      title: visualContext.title,
      targets: visualContext.targets.slice(0, 25).map((target) => ({
        id: target.id,
        kind: target.kind,
        name: truncateFeedText(target.name, 48),
        x: Math.round(target.x),
        y: Math.round(target.y),
        width: Math.round(target.width),
        height: Math.round(target.height),
        enabled: target.enabled
      }))
    }
  );
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
  state.lastSnapshot = null;
  state.lastTargets = [];
  resetRunState(state);
  state.viewState.pendingActivity = false;
  state.viewState.taskState = "idle";
  state.viewState.sessionId = null;
  state.viewState.lastAction = null;
  state.viewState.headerMessage = null;
}

function resetRunState(state: TabSessionState) {
  state.pauseRequested = false;
  state.busy = false;
  state.pendingTurn = null;
  state.pendingContinuation = null;
}

function formatToolCallBody(summary: string, args: Record<string, unknown>) {
  const trimmedArgs = JSON.stringify(args);
  if (!trimmedArgs || trimmedArgs === "{}") {
    return summary;
  }
  return `${summary}\nargs=${truncateFeedText(trimmedArgs, 180)}`;
}

function formatToolResultBody(toolResult: ToolResult) {
  const segments = [
    truncateFeedText(toolResult.message, 140)
  ];
  if (toolResult.actionFeedback?.resolvedLabel || toolResult.actionFeedback?.resolvedTag) {
    segments.push(
      `target=${truncateFeedText(
        [
          toolResult.actionFeedback.resolvedLabel,
          toolResult.actionFeedback.resolvedTag
        ]
          .filter(Boolean)
          .join(" "),
        80
      )}`
    );
  }
  if (toolResult.actionFeedback?.point) {
    segments.push(
      `point=(${Math.round(toolResult.actionFeedback.point.x)},${Math.round(toolResult.actionFeedback.point.y)})`
    );
  }
  if (toolResult.targets) {
    segments.push(`targets=${toolResult.targets.length}`);
  }
  return segments.join("\n");
}

function truncateFeedText(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
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

async function sanitizeCapturedDataUrl(
  ext: ExtensionApi,
  overlay: OverlayController,
  tabId: number,
  dataUrl: string
) {
  const overlayBounds = await overlay.getVisibleBounds(tabId);
  if (!overlayBounds) {
    return dataUrl;
  }

  try {
    const sanitized = (await ext.tabs.sendMessage(tabId, {
      kind: "sanitize_capture",
      dataUrl,
      overlayBounds
    } satisfies ContentSanitizeCaptureMessage)) as string | undefined;
    return typeof sanitized === "string" && sanitized.startsWith("data:image/")
      ? sanitized
      : dataUrl;
  } catch {
    return dataUrl;
  }
}

function mergeActionFeedback(
  feedback: ActionFeedback | undefined,
  patch: Partial<ActionFeedback>
): ActionFeedback | undefined {
  if (!feedback && !patch.toolName) {
    return undefined;
  }
  return {
    toolName: patch.toolName ?? feedback?.toolName ?? "click_coords",
    targetId: patch.targetId ?? feedback?.targetId ?? null,
    point: patch.point ?? feedback?.point ?? null,
    resolvedTag: patch.resolvedTag ?? feedback?.resolvedTag ?? null,
    resolvedRole: patch.resolvedRole ?? feedback?.resolvedRole ?? null,
    resolvedLabel: patch.resolvedLabel ?? feedback?.resolvedLabel ?? null,
    usedFallback: patch.usedFallback ?? feedback?.usedFallback ?? false,
    navigationOccurred:
      patch.navigationOccurred ?? feedback?.navigationOccurred ?? false
  };
}

async function annotateCapturedDataUrl(
  dataUrl: string,
  action: ActionFeedback | null | undefined,
  shotId: string
) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load captured image."));
    img.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return dataUrl;
  }

  context.drawImage(image, 0, 0);
  if (action?.point) {
    const x = Math.round(action.point.x);
    const y = Math.round(action.point.y);

    context.strokeStyle = "rgba(24, 174, 255, 0.98)";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x, y, 10, 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = "rgba(24, 174, 255, 0.98)";
    context.beginPath();
    context.arc(x, y, 4, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = "rgba(16, 21, 29, 0.88)";
  context.fillRect(12, 12, 92, 24);
  context.fillStyle = "#ffffff";
  context.font = "12px monospace";
  context.fillText(shotId, 18, 28);

  const maxDimension = 1280;
  const scale = Math.min(1, maxDimension / Math.max(canvas.width, canvas.height));
  if (scale >= 1) {
    return canvas.toDataURL("image/png");
  }

  const scaledCanvas = document.createElement("canvas");
  scaledCanvas.width = Math.max(1, Math.round(canvas.width * scale));
  scaledCanvas.height = Math.max(1, Math.round(canvas.height * scale));
  const scaledContext = scaledCanvas.getContext("2d");
  if (!scaledContext) {
    return canvas.toDataURL("image/png");
  }

  scaledContext.drawImage(canvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
  return scaledCanvas.toDataURL("image/png");
}

function isInjectableUrl(url?: string) {
  return Boolean(url && /^https?:/i.test(url));
}

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatRuntimeVersion(version: string) {
  return version.startsWith("remote:") ? version.slice("remote:".length) : version;
}

function parseExtensionRuntimePayload(payload: unknown): ExtensionRuntimePayload {
  const record = payload as Record<string, unknown> | null;
  if (
    !record ||
    record.ok !== true ||
    typeof record.version !== "string" ||
    typeof record.generatedAt !== "string" ||
    typeof record.contentScript !== "string" ||
    typeof record.overlayCss !== "string"
  ) {
    throw new Error("Invalid extension runtime payload.");
  }

  return {
    ok: true,
    version: record.version,
    generatedAt: record.generatedAt,
    contentScript: record.contentScript,
    overlayCss: record.overlayCss
  };
}

function parseStoredExtensionRuntime(
  payload: Record<string, unknown> | undefined
): StoredExtensionRuntime | null {
  if (
    !payload ||
    typeof payload.version !== "string" ||
    typeof payload.generatedAt !== "string" ||
    typeof payload.contentScript !== "string" ||
    typeof payload.overlayCss !== "string"
  ) {
    return null;
  }

  return {
    version: payload.version,
    generatedAt: payload.generatedAt,
    contentScript: payload.contentScript,
    overlayCss: payload.overlayCss
  };
}

export function getExtensionApi(): ExtensionApi | null {
  const globalRecord = globalThis as Record<string, unknown>;
  const candidate = globalRecord.browser ?? globalRecord.chrome;
  return candidate ? (candidate as ExtensionApi) : null;
}

export function bootBackground(ext = getExtensionApi()) {
  if (!ext) {
    return null;
  }

  const background = new BrowserControlBackground(ext);
  background.start();
  return background;
}
