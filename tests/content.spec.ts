// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayHarness } from "../apps/extension-firefox/src/content.js";
import { DEFAULT_MODEL_DESCRIPTORS, type BackgroundToContentMessage } from "../packages/shared/src/index.js";

const TEST_CSS = `
  .bc-shell { font-family: Test Sans; }
  .bc-feed-item-body { unicode-bidi: plaintext; overflow-wrap: anywhere; }
`;

function createRuntime() {
  const listeners: Array<(message: unknown) => unknown> = [];
  const sentMessages: unknown[] = [];
  return {
    bridge: {
      addMessageListener(listener: (message: unknown) => unknown) {
        listeners.push(listener);
      },
      sendMessage: vi.fn(async (message: unknown) => {
        sentMessages.push(message);
        if ((message as { kind?: string }).kind === "close_overlay") {
          return { ok: true };
        }
        return undefined;
      }),
      getURL: vi.fn((path: string) => path)
    },
    sentMessages,
    dispatch(message: unknown) {
      return listeners[0]?.(message);
    }
  };
}

function overlayStateMessage(): BackgroundToContentMessage {
  return {
    kind: "overlay_state",
    viewState: {
      visible: true,
      destroyed: false,
      position: { x: -1, y: 16 },
      size: { width: 380, height: 560 },
      pendingActivity: false,
      taskState: "idle",
      sessionOptions: {
        model: "gpt-5.3-codex",
        effort: "medium",
        accessMode: "readonly"
      },
      sessionId: "session-1",
      connectionState: "online",
      headerMessage: null
    },
    models: DEFAULT_MODEL_DESCRIPTORS,
    feed: [
      {
        id: "user-1",
        kind: "user",
        timestamp: new Date().toISOString(),
        body: "בדוק את הכותרת באנגלית English בתוך משפט אחד"
      },
      {
        id: "tool-1",
        kind: "tool",
        timestamp: new Date().toISOString(),
        title: "extract_text",
        body: "עברית English mixed tool output",
        toolName: "extract_text",
        stage: "finish"
      }
    ]
  };
}

describe("content overlay", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "<head></head><body></body>";
    document.documentElement.dir = "rtl";
    document.head.innerHTML =
      "<style>*{direction:rtl !important;font-family:monospace !important;box-sizing:content-box !important;}</style>";
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 900
    });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn()
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn()
    });
    if (!("PointerEvent" in window)) {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;

        constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
        }
      }
      Object.defineProperty(window, "PointerEvent", {
        configurable: true,
        value: TestPointerEvent
      });
    }
  });

  it("renders in a shadow root and keeps the shell LTR on rtl pages", async () => {
    const runtime = createRuntime();
    const harness = new OverlayHarness(runtime.bridge, document, window, Promise.resolve(TEST_CSS));

    await harness.handleMessage(overlayStateMessage());

    const host = harness.getHost();
    const shadow = host?.shadowRoot;
    expect(host?.id).toBe("browsercontrol-host");
    expect(shadow).toBeTruthy();
    expect(shadow?.querySelector(".bc-shell")?.getAttribute("dir")).toBe("ltr");
    expect(shadow?.querySelector(".bc-composer-inline")).toBeTruthy();
    expect(shadow?.querySelector(".bc-access-button")?.textContent?.trim()).toBe("");
    expect(shadow?.querySelector(".bc-access-button")?.getAttribute("aria-label")).toBe(
      "Take Control"
    );
    expect(
      shadow?.querySelector(".bc-feed-item-user .bc-feed-item-body")?.getAttribute("dir")
    ).toBe("auto");
  });

  it("keeps hostile page css out of the overlay and preserves mixed-language text nodes", async () => {
    const runtime = createRuntime();
    const harness = new OverlayHarness(runtime.bridge, document, window, Promise.resolve(TEST_CSS));

    await harness.handleMessage(overlayStateMessage());

    const shadow = harness.getHost()?.shadowRoot;
    expect(shadow?.querySelector("style")?.textContent).toContain("unicode-bidi");
    expect(shadow?.querySelector(".bc-title")?.textContent).toBe("BrowserControl");
    expect(shadow?.querySelector(".bc-brand-icon")?.tagName.toLowerCase()).toBe("svg");
    expect(shadow?.querySelector(".bc-feed-item-tool .bc-feed-item-body bdi")?.textContent).toContain(
      "עברית English mixed tool output"
    );
  });

  it("destroys and recreates the host without duplicating it", async () => {
    const runtime = createRuntime();
    const harness = new OverlayHarness(runtime.bridge, document, window, Promise.resolve(TEST_CSS));

    await harness.handleMessage(overlayStateMessage());
    expect(document.querySelectorAll("#browsercontrol-host")).toHaveLength(1);

    await harness.handleMessage({ kind: "destroy_overlay" });
    expect(document.querySelectorAll("#browsercontrol-host")).toHaveLength(0);

    await harness.handleMessage(overlayStateMessage());
    expect(document.querySelectorAll("#browsercontrol-host")).toHaveLength(1);
    expect(harness.getCreateCount()).toBe(2);
  });

  it("destroys the host when the close button is confirmed by the background", async () => {
    const runtime = createRuntime();
    const harness = new OverlayHarness(runtime.bridge, document, window, Promise.resolve(TEST_CSS));

    await harness.handleMessage(overlayStateMessage());

    const closeButton = harness.getHost()?.shadowRoot?.querySelector(
      '[data-action="close"]'
    ) as HTMLButtonElement;
    closeButton.click();
    await Promise.resolve();

    expect(document.querySelectorAll("#browsercontrol-host")).toHaveLength(0);
  });

  it("uses one alternating access button", async () => {
    const runtime = createRuntime();
    const harness = new OverlayHarness(runtime.bridge, document, window, Promise.resolve(TEST_CSS));

    await harness.handleMessage(overlayStateMessage());

    const accessButton = harness.getHost()?.shadowRoot?.querySelector(
      ".bc-access-button"
    ) as HTMLButtonElement;
    accessButton.click();

    expect(runtime.sentMessages).toContainEqual({
      kind: "update_session_options",
      sessionOptions: {
        model: "gpt-5.3-codex",
        effort: "medium",
        accessMode: "take_control"
      }
    });
  });

  it("emits a new chat intent from the header control", async () => {
    const runtime = createRuntime();
    const harness = new OverlayHarness(runtime.bridge, document, window, Promise.resolve(TEST_CSS));

    await harness.handleMessage(overlayStateMessage());

    const newChatButton = harness.getHost()?.shadowRoot?.querySelector(
      '[data-action="new-chat"]'
    ) as HTMLButtonElement;
    newChatButton.click();

    expect(runtime.sentMessages).toContainEqual({
      kind: "new_chat"
    });
  });

  it("updates size through the resize grip and clamps to min/max bounds", async () => {
    const runtime = createRuntime();
    const harness = new OverlayHarness(runtime.bridge, document, window, Promise.resolve(TEST_CSS));

    await harness.handleMessage(overlayStateMessage());

    const grip = harness.getHost()?.shadowRoot?.querySelector(".bc-resize-grip") as HTMLElement;
    grip.dispatchEvent(new window.PointerEvent("pointerdown", { clientX: 0, clientY: 0, pointerId: 1 }));
    grip.dispatchEvent(
      new window.PointerEvent("pointermove", { clientX: 2000, clientY: 2000, pointerId: 1 })
    );
    grip.dispatchEvent(
      new window.PointerEvent("pointerup", { clientX: 2000, clientY: 2000, pointerId: 1 })
    );

    const updateMessage = runtime.sentMessages.find(
      (message) => (message as { kind?: string }).kind === "update_bounds"
    ) as {
      kind: string;
      position: { x: number; y: number };
      size: { width: number; height: number };
    };
    expect(updateMessage.size.width).toBeLessThanOrEqual(520);
    expect(updateMessage.size.height).toBeLessThanOrEqual(760);
    expect(updateMessage.size.width).toBeGreaterThanOrEqual(320);
    expect(updateMessage.size.height).toBeGreaterThanOrEqual(360);
  });
});
