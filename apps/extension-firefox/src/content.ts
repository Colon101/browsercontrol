import { runPageTool } from "./page-driver.js";
import {
  DEFAULT_OVERLAY_SIZE,
  MAX_OVERLAY_SIZE,
  MIN_OVERLAY_SIZE,
  BackgroundToContentMessageSchema,
  type BackgroundToContentMessage,
  type ModelDescriptor,
  type OverlayFeedItem,
  type OverlayViewState,
  type ToolCallRequest
} from "../../../packages/shared/src/index.js";

type RuntimeBridge = {
  addMessageListener(listener: (message: unknown) => unknown): void;
  sendMessage(message: unknown): Promise<unknown>;
  getURL(path: string): string;
};

type ContentMessage =
  | BackgroundToContentMessage
  | {
      kind: "run_tool";
      request: ToolCallRequest;
    }
  | {
      kind: "overlay_ping";
    };

type OverlayPayload = Extract<BackgroundToContentMessage, { kind: "overlay_state" }>;

const CONTROL_MOUSE_ICON = `
  <svg class="bc-inline-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="7" y="2.75" width="10" height="18.5" rx="5" />
    <path d="M12 2.75v7" />
    <path d="M7 10h10" />
  </svg>
`;

const NEW_CHAT_ICON = `
  <svg class="bc-inline-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
`;

type OverlayRefs = {
  shell: HTMLDivElement;
  card: HTMLDivElement;
  connection: HTMLSpanElement;
  taskState: HTMLSpanElement;
  headerMessage: HTMLDivElement;
  newChatButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  feed: HTMLDivElement;
  newActivityButton: HTMLButtonElement;
  textarea: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  modelSelect: HTMLSelectElement;
  modelInput: HTMLInputElement;
  effortSelect: HTMLSelectElement;
  accessButton: HTMLButtonElement;
  resizeGrip: HTMLDivElement;
};

export class OverlayHarness {
  private host: HTMLDivElement | null = null;
  private shadowRootNode: ShadowRoot | null = null;
  private refs: OverlayRefs | null = null;
  private payload: OverlayPayload | null = null;
  private cssTextPromise: Promise<string>;
  private stickToBottom = true;
  private hasPendingActivity = false;
  private createCount = 0;
  private draftPosition: OverlayViewState["position"] | null = null;
  private draftSize: OverlayViewState["size"] | null = null;
  private bootstrapped = false;

  constructor(
    private readonly runtime: RuntimeBridge,
    private readonly doc: Document = document,
    private readonly win: Window = window,
    cssTextPromise?: Promise<string>
  ) {
    this.cssTextPromise =
      cssTextPromise ??
      fetch(this.runtime.getURL("overlay.css")).then(async (response) => await response.text());
  }

  async bootstrap() {
    if (this.bootstrapped) {
      const response = (await this.runtime.sendMessage({
        kind: "request_state"
      })) as BackgroundToContentMessage | undefined;
      if (response) {
        await this.handleMessage(response);
      }
      return;
    }

    this.bootstrapped = true;
    this.runtime.addMessageListener((message) => this.handleMessage(message));
    const response = (await this.runtime.sendMessage({
      kind: "overlay_ready"
    })) as BackgroundToContentMessage | undefined;
    if (response) {
      await this.handleMessage(response);
    }
  }

  getHost() {
    return this.host;
  }

  getCreateCount() {
    return this.createCount;
  }

  async handleMessage(message: unknown) {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>).kind === "run_tool"
    ) {
      const request = (message as { request: ToolCallRequest }).request;
      return await runPageTool(request.toolName, request.args);
    }

    if (
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>).kind === "overlay_ping"
    ) {
      return { ok: true };
    }

    const payload = BackgroundToContentMessageSchema.parse(message);
    if (payload.kind === "destroy_overlay") {
      this.destroyHost();
      return { ok: true };
    }

    this.payload = payload;
    await this.ensureHost();
    this.render();
    return { ok: true };
  }

  destroyHost() {
    this.host?.remove();
    this.host = null;
    this.shadowRootNode = null;
    this.refs = null;
  }

  private async ensureHost() {
    if (this.host?.isConnected && this.refs) {
      return;
    }

    const staleHost = this.doc.getElementById("browsercontrol-host");
    if (staleHost) {
      staleHost.remove();
    }

    const host = this.doc.createElement("div");
    host.id = "browsercontrol-host";
    host.setAttribute(
      "style",
      [
        "all: initial",
        "position: fixed",
        "left: 0",
        "top: 0",
        "width: 0",
        "height: 0",
        "z-index: 2147483647"
      ].join(";")
    );
    const shadowRootNode = host.attachShadow({ mode: "open" });
    const style = this.doc.createElement("style");
    style.textContent = await this.cssTextPromise;
    shadowRootNode.append(style);

    const shell = this.doc.createElement("div");
    shell.className = "bc-shell";
    shell.dir = "ltr";
    shell.innerHTML = `
      <section class="bc-card" role="dialog" aria-label="BrowserControl overlay">
        <header class="bc-header">
          <div class="bc-header-copy">
            <div class="bc-brand-row">
              <div class="bc-brand-mark" aria-hidden="true">
                <svg class="bc-brand-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 8V4H8" />
                  <rect width="16" height="12" x="4" y="8" rx="2" />
                  <path d="M2 14h2" />
                  <path d="M20 14h2" />
                  <path d="M15 13v2" />
                  <path d="M9 13v2" />
                </svg>
              </div>
              <div class="bc-title-stack">
                <div class="bc-title-row">
                  <h1 class="bc-title">BrowserControl</h1>
                  <span class="bc-pill bc-pill-connection"></span>
                  <span class="bc-pill bc-pill-task"></span>
                </div>
                <div class="bc-header-message"></div>
              </div>
            </div>
          </div>
          <div class="bc-header-actions">
            <button class="bc-icon-button bc-icon-button-compact" data-action="new-chat" data-bc-nodrag="true" type="button" aria-label="Start a new chat" title="Start a new chat">
              ${NEW_CHAT_ICON}
            </button>
            <button class="bc-icon-button" data-action="pause" data-bc-nodrag="true" type="button"></button>
            <button class="bc-icon-button bc-icon-button-compact" data-action="close" data-bc-nodrag="true" type="button" aria-label="Close overlay" title="Close overlay">X</button>
          </div>
        </header>
        <div class="bc-feed-wrap">
          <div class="bc-feed" aria-live="polite"></div>
          <button class="bc-new-activity" type="button">New activity</button>
        </div>
        <div class="bc-composer">
          <div class="bc-composer-inline">
            <textarea rows="3" placeholder="Ask BrowserControl about this page." dir="auto"></textarea>
            <button class="bc-send-button" data-bc-nodrag="true" type="button">Send</button>
          </div>
        </div>
        <footer class="bc-session-bar">
          <label class="bc-field">
            <span>Model</span>
            <select class="bc-model-select"></select>
            <input class="bc-model-input" type="text" />
          </label>
          <label class="bc-field">
            <span>Effort</span>
            <select class="bc-effort-select">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <div class="bc-field bc-access-field">
            <span>Access</span>
            <button class="bc-access-button" data-bc-nodrag="true" type="button"></button>
          </div>
        </footer>
        <div class="bc-resize-grip" aria-hidden="true"></div>
      </section>
    `;

    shadowRootNode.append(shell);
    this.doc.documentElement.append(host);

    this.host = host;
    this.shadowRootNode = shadowRootNode;
    this.createCount += 1;
    this.refs = {
      shell,
      card: shell.querySelector(".bc-card") as HTMLDivElement,
      connection: shell.querySelector(".bc-pill-connection") as HTMLSpanElement,
      taskState: shell.querySelector(".bc-pill-task") as HTMLSpanElement,
      headerMessage: shell.querySelector(".bc-header-message") as HTMLDivElement,
      newChatButton: shell.querySelector('[data-action="new-chat"]') as HTMLButtonElement,
      pauseButton: shell.querySelector('[data-action="pause"]') as HTMLButtonElement,
      closeButton: shell.querySelector('[data-action="close"]') as HTMLButtonElement,
      feed: shell.querySelector(".bc-feed") as HTMLDivElement,
      newActivityButton: shell.querySelector(".bc-new-activity") as HTMLButtonElement,
      textarea: shell.querySelector("textarea") as HTMLTextAreaElement,
      sendButton: shell.querySelector(".bc-send-button") as HTMLButtonElement,
      modelSelect: shell.querySelector(".bc-model-select") as HTMLSelectElement,
      modelInput: shell.querySelector(".bc-model-input") as HTMLInputElement,
      effortSelect: shell.querySelector(".bc-effort-select") as HTMLSelectElement,
      accessButton: shell.querySelector(".bc-access-button") as HTMLButtonElement,
      resizeGrip: shell.querySelector(".bc-resize-grip") as HTMLDivElement
    };

    this.bindUi();
  }

  private bindUi() {
    if (!this.refs) {
      return;
    }

    for (const control of [
      this.refs.newChatButton,
      this.refs.pauseButton,
      this.refs.closeButton,
      this.refs.sendButton,
      this.refs.accessButton
    ]) {
      control.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
    }

    this.refs.sendButton.addEventListener("click", () => {
      void this.handleSend();
    });
    this.refs.textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.handleSend();
      }
    });
    this.refs.newChatButton.addEventListener("click", () => {
      void this.runtime.sendMessage({ kind: "new_chat" });
    });
    this.refs.pauseButton.addEventListener("click", () => {
      if (!this.payload) {
        return;
      }
      const kind =
        this.payload.viewState.taskState === "paused" ? "resume_task" : "pause_task";
      void this.runtime.sendMessage({ kind });
    });
    this.refs.closeButton.addEventListener("click", async () => {
      try {
        const result = (await this.runtime.sendMessage({
          kind: "close_overlay"
        })) as { ok?: boolean } | undefined;
        if (result?.ok) {
          this.destroyHost();
        }
      } catch {
        if (this.payload && canCloseLocally(this.payload.viewState.taskState)) {
          await this.bootstrap();
        }
      }
    });
    this.refs.modelSelect.addEventListener("change", () => {
      void this.pushSessionOptions({
        model: this.refs?.modelSelect.value ?? ""
      });
    });
    this.refs.modelInput.addEventListener("change", () => {
      void this.pushSessionOptions({
        model: this.refs?.modelInput.value ?? ""
      });
    });
    this.refs.effortSelect.addEventListener("change", () => {
      void this.pushSessionOptions({
        effort:
          (this.refs?.effortSelect.value as OverlayViewState["sessionOptions"]["effort"]) ??
          "medium"
      });
    });
    this.refs.accessButton.addEventListener("click", () => {
      const accessMode =
        this.payload?.viewState.sessionOptions.accessMode === "take_control"
          ? "readonly"
          : "take_control";
      void this.pushSessionOptions({
        accessMode
      });
    });
    this.refs.feed.addEventListener("scroll", () => {
      this.stickToBottom = this.isNearBottom();
      if (this.stickToBottom) {
        this.hasPendingActivity = false;
        this.renderPendingActivity();
      }
    });
    this.refs.newActivityButton.addEventListener("click", () => {
      this.stickToBottom = true;
      this.hasPendingActivity = false;
      this.scrollToBottom();
      this.renderPendingActivity();
    });

    installDragBehavior(
      this.refs.card,
      this.refs.shell.querySelector(".bc-header") as HTMLElement,
      (bounds) => {
        const clamped = clampBounds(bounds.position, bounds.size, this.win);
        this.draftPosition = clamped.position;
        this.draftSize = clamped.size;
        this.applyBounds(clamped.position, clamped.size);
      },
      (bounds) => {
        const clamped = clampBounds(bounds.position, bounds.size, this.win);
        this.draftPosition = null;
        this.draftSize = null;
        void this.runtime.sendMessage({
          kind: "update_bounds",
          position: clamped.position,
          size: clamped.size
        });
      },
      () => this.getCurrentBounds()
    );
    installResizeBehavior(
      this.refs.card,
      this.refs.resizeGrip,
      (bounds) => {
        const clamped = clampBounds(bounds.position, bounds.size, this.win);
        this.draftPosition = clamped.position;
        this.draftSize = clamped.size;
        this.applyBounds(clamped.position, clamped.size);
      },
      (bounds) => {
        const clamped = clampBounds(bounds.position, bounds.size, this.win);
        this.draftPosition = null;
        this.draftSize = null;
        void this.runtime.sendMessage({
          kind: "update_bounds",
          position: clamped.position,
          size: clamped.size
        });
      },
      () => this.getCurrentBounds()
    );

    this.win.addEventListener("resize", () => {
      const bounds = this.getCurrentBounds();
      this.applyBounds(bounds.position, bounds.size);
      void this.runtime.sendMessage({
        kind: "update_bounds",
        position: bounds.position,
        size: bounds.size
      });
    });
  }

  private async handleSend() {
    if (!this.refs) {
      return;
    }
    if (this.refs.sendButton.disabled) {
      return;
    }
    const prompt = this.refs.textarea.value.trim();
    if (!prompt) {
      return;
    }
    await this.runtime.sendMessage({
      kind: "send_prompt",
      prompt
    });
    this.refs.textarea.value = "";
  }

  private async pushSessionOptions(patch: Partial<OverlayViewState["sessionOptions"]>) {
    if (!this.payload) {
      return;
    }

    await this.runtime.sendMessage({
      kind: "update_session_options",
      sessionOptions: {
        ...this.payload.viewState.sessionOptions,
        ...patch
      }
    });
  }

  private render() {
    if (!this.payload || !this.refs) {
      return;
    }

    const previousFeedHeight = this.refs.feed.scrollHeight;
    const previousScrollBottom = previousFeedHeight - this.refs.feed.scrollTop;
    const { viewState, feed, models } = this.payload;

    this.refs.connection.textContent =
      viewState.connectionState === "online"
        ? "Online"
        : viewState.connectionState === "offline"
          ? "Offline"
          : "Checking";
    this.refs.connection.dataset.state = viewState.connectionState;
    this.refs.taskState.textContent = formatTaskState(viewState.taskState);
    this.refs.taskState.dataset.state = viewState.taskState;
    this.refs.headerMessage.textContent = viewState.headerMessage ?? "";
    this.refs.pauseButton.textContent = viewState.taskState === "paused" ? "Resume" : "Pause";
    this.refs.pauseButton.disabled =
      viewState.taskState === "idle" ||
      viewState.taskState === "completed" ||
      viewState.taskState === "error";
    this.refs.newChatButton.disabled =
      viewState.taskState === "running" || viewState.taskState === "starting";
    this.refs.sendButton.disabled =
      viewState.connectionState !== "online" ||
      viewState.taskState === "running" ||
      viewState.taskState === "starting" ||
      viewState.taskState === "paused";

    this.refs.card.dataset.accessMode = viewState.sessionOptions.accessMode;

    renderModelControls(
      this.refs.modelSelect,
      this.refs.modelInput,
      models,
      viewState.sessionOptions.model
    );
    this.refs.effortSelect.value = viewState.sessionOptions.effort;
    this.refs.accessButton.dataset.accessMode = viewState.sessionOptions.accessMode;
    this.refs.accessButton.innerHTML = CONTROL_MOUSE_ICON;
    this.refs.accessButton.title =
      viewState.sessionOptions.accessMode === "take_control"
        ? "Return to Readonly"
        : "Take Control";
    this.refs.accessButton.setAttribute("aria-label", this.refs.accessButton.title);
    this.refs.accessButton.setAttribute(
      "aria-pressed",
      viewState.sessionOptions.accessMode === "take_control" ? "true" : "false"
    );

    this.renderFeed(feed, previousScrollBottom);
    this.applyBounds(
      this.draftPosition ?? viewState.position,
      this.draftSize ?? viewState.size
    );
  }

  private renderFeed(feed: OverlayFeedItem[], previousScrollBottom: number) {
    if (!this.refs) {
      return;
    }

    const wasNearBottom = this.stickToBottom || this.isNearBottom(previousScrollBottom);
    this.refs.feed.replaceChildren(...feed.map((item) => renderFeedItem(this.doc, item)));

    if (wasNearBottom) {
      this.scrollToBottom();
      this.hasPendingActivity = false;
    } else {
      this.hasPendingActivity = true;
    }
    this.renderPendingActivity();
  }

  private renderPendingActivity() {
    if (!this.refs) {
      return;
    }
    this.refs.newActivityButton.hidden = !this.hasPendingActivity;
  }

  private applyBounds(
    position: OverlayViewState["position"],
    size: OverlayViewState["size"]
  ) {
    if (!this.refs) {
      return;
    }

    const clamped = clampBounds(position, size, this.win);
    this.refs.card.style.left = `${clamped.position.x}px`;
    this.refs.card.style.top = `${clamped.position.y}px`;
    this.refs.card.style.width = `${clamped.size.width}px`;
    this.refs.card.style.height = `${clamped.size.height}px`;
  }

  private getCurrentBounds() {
    if (!this.payload) {
      return {
        position: { x: 16, y: 16 },
        size: DEFAULT_OVERLAY_SIZE
      };
    }

    return clampBounds(
      this.draftPosition ?? this.payload.viewState.position,
      this.draftSize ?? this.payload.viewState.size,
      this.win
    );
  }

  private scrollToBottom() {
    if (!this.refs) {
      return;
    }
    this.refs.feed.scrollTop = this.refs.feed.scrollHeight;
  }

  private isNearBottom(previousScrollBottom?: number) {
    if (!this.refs) {
      return true;
    }
    const distance =
      previousScrollBottom ??
      this.refs.feed.scrollHeight - this.refs.feed.scrollTop - this.refs.feed.clientHeight;
    return distance < 48;
  }
}

function renderFeedItem(doc: Document, item: OverlayFeedItem) {
  const node = doc.createElement("article");
  node.className = `bc-feed-item bc-feed-item-${item.kind}`;
  if (item.stage) {
    node.dataset.stage = item.stage;
  }

  const header = doc.createElement("div");
  header.className = "bc-feed-item-header";
  header.textContent = feedItemLabel(item);
  node.append(header);

  if (item.title) {
    const title = doc.createElement("div");
    title.className = "bc-feed-item-title";
    title.dir = "auto";
    const wrapped = doc.createElement("bdi");
    wrapped.textContent = item.title;
    title.append(wrapped);
    node.append(title);
  }

  if (item.body) {
    const body = doc.createElement("div");
    body.className = "bc-feed-item-body";
    body.dir = "auto";
    const wrapped = doc.createElement("bdi");
    wrapped.textContent = item.body;
    body.append(wrapped);
    node.append(body);
  }

  return node;
}

function renderModelControls(
  modelSelect: HTMLSelectElement,
  modelInput: HTMLInputElement,
  models: ModelDescriptor[],
  selectedModel: string
) {
  if (models.length === 0) {
    modelSelect.hidden = true;
    modelInput.hidden = false;
    modelInput.value = selectedModel;
    return;
  }

  modelInput.hidden = true;
  modelSelect.hidden = false;
  modelSelect.replaceChildren(
    ...models.map((model) => {
      const option = modelSelect.ownerDocument.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      return option;
    })
  );
  modelSelect.value = selectedModel;
}

function feedItemLabel(item: OverlayFeedItem) {
  switch (item.kind) {
    case "user":
      return "You";
    case "answer":
      return "Answer";
    case "tool":
      return item.toolName ? `Tool • ${item.toolName}` : "Tool";
    case "warning":
      return "Warning";
    case "error":
      return "Error";
    default:
      return "Status";
  }
}

function formatTaskState(taskState: OverlayViewState["taskState"]) {
  switch (taskState) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function clampBounds(
  position: OverlayViewState["position"],
  size: OverlayViewState["size"],
  win: Window
) {
  const maxWidth = Math.max(MIN_OVERLAY_SIZE.width, Math.min(MAX_OVERLAY_SIZE.width, Math.floor(win.innerWidth * 0.45)));
  const maxHeight = Math.max(MIN_OVERLAY_SIZE.height, Math.min(MAX_OVERLAY_SIZE.height, Math.floor(win.innerHeight * 0.88)));
  const width = clamp(size.width, MIN_OVERLAY_SIZE.width, maxWidth);
  const height = clamp(size.height, MIN_OVERLAY_SIZE.height, maxHeight);
  const defaultX = win.innerWidth - width - 16;
  const x = clamp(position.x < 0 ? defaultX : position.x, 8, Math.max(8, win.innerWidth - width - 8));
  const y = clamp(position.y, 8, Math.max(8, win.innerHeight - height - 8));
  return {
    position: { x, y },
    size: { width, height }
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function installDragBehavior(
  card: HTMLElement,
  handle: HTMLElement,
  onMove: (bounds: { position: OverlayViewState["position"]; size: OverlayViewState["size"] }) => void,
  onEnd: (bounds: { position: OverlayViewState["position"]; size: OverlayViewState["size"] }) => void,
  getBounds: () => { position: OverlayViewState["position"]; size: OverlayViewState["size"] }
) {
  let startX = 0;
  let startY = 0;
  let startBounds: ReturnType<typeof getBounds> | null = null;

  handle.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement | null)?.closest("[data-bc-nodrag='true']")) {
      return;
    }
    startBounds = getBounds();
    startX = event.clientX;
    startY = event.clientY;
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointermove", (event) => {
    if (!startBounds) {
      return;
    }
    const next = {
      position: {
        x: startBounds.position.x + (event.clientX - startX),
        y: startBounds.position.y + (event.clientY - startY)
      },
      size: startBounds.size
    };
    onMove(next);
  });

  const finish = (event: PointerEvent) => {
    if (!startBounds) {
      return;
    }
    const next = {
      position: {
        x: startBounds.position.x + (event.clientX - startX),
        y: startBounds.position.y + (event.clientY - startY)
      },
      size: startBounds.size
    };
    startBounds = null;
    onEnd(next);
    handle.releasePointerCapture(event.pointerId);
  };

  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function installResizeBehavior(
  card: HTMLElement,
  grip: HTMLElement,
  onMove: (bounds: { position: OverlayViewState["position"]; size: OverlayViewState["size"] }) => void,
  onEnd: (bounds: { position: OverlayViewState["position"]; size: OverlayViewState["size"] }) => void,
  getBounds: () => { position: OverlayViewState["position"]; size: OverlayViewState["size"] }
) {
  let startX = 0;
  let startY = 0;
  let startBounds: ReturnType<typeof getBounds> | null = null;

  grip.addEventListener("pointerdown", (event) => {
    startBounds = getBounds();
    startX = event.clientX;
    startY = event.clientY;
    grip.setPointerCapture(event.pointerId);
  });

  grip.addEventListener("pointermove", (event) => {
    if (!startBounds) {
      return;
    }
    onMove({
      position: startBounds.position,
      size: {
        width: startBounds.size.width + (event.clientX - startX),
        height: startBounds.size.height + (event.clientY - startY)
      }
    });
  });

  const finish = (event: PointerEvent) => {
    if (!startBounds) {
      return;
    }
    onEnd({
      position: startBounds.position,
      size: {
        width: startBounds.size.width + (event.clientX - startX),
        height: startBounds.size.height + (event.clientY - startY)
      }
    });
    startBounds = null;
    grip.releasePointerCapture(event.pointerId);
  };

  grip.addEventListener("pointerup", finish);
  grip.addEventListener("pointercancel", finish);
}

function canCloseLocally(taskState: OverlayViewState["taskState"]) {
  return taskState !== "running" && taskState !== "starting";
}

function createRuntimeBridge(ext: {
  runtime: {
    onMessage: {
      addListener(listener: (message: unknown) => unknown): void;
    };
    sendMessage(message: unknown): Promise<unknown>;
    getURL(path: string): string;
  };
}): RuntimeBridge {
  return {
    addMessageListener(listener) {
      ext.runtime.onMessage.addListener(listener);
    },
    sendMessage(message) {
      return ext.runtime.sendMessage(message);
    },
    getURL(path) {
      return ext.runtime.getURL(path);
    }
  };
}

function getExtensionApi() {
  const globalRecord = globalThis as Record<string, unknown>;
  return (globalRecord.browser ?? globalRecord.chrome) as
    | {
        runtime: {
          onMessage: {
            addListener(listener: (message: unknown) => unknown): void;
          };
          sendMessage(message: unknown): Promise<unknown>;
          getURL(path: string): string;
        };
      }
    | undefined;
}

declare global {
  interface Window {
    __browsercontrolOverlayHarness?: OverlayHarness;
  }
}

const ext = getExtensionApi();
if (ext && window.top === window) {
  const existing = window.__browsercontrolOverlayHarness;
  if (existing) {
    void existing.bootstrap();
  } else {
    const harness = new OverlayHarness(createRuntimeBridge(ext));
    window.__browsercontrolOverlayHarness = harness;
    void harness.bootstrap();
  }
}
