import { describe, expect, it, vi } from "vitest";
import {
  BrowserControlBackground,
  canDestroyOverlay,
  isToolAllowedInAccessMode,
  reduceSessionOptions
} from "../apps/extension-firefox/src/background.js";
import {
  DEFAULT_MODEL_DESCRIPTORS,
  PROTOCOL_VERSION,
  type OverlayFeedItem,
  type PageSnapshot
} from "../packages/shared/src/index.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function createSnapshot(): PageSnapshot {
  return {
    url: "https://example.com",
    title: "Example",
    viewport: { width: 1280, height: 720 },
    scrollPosition: { x: 0, y: 0 },
    forms: [],
    interactiveElements: [],
    textBlocks: [],
    selectionState: {
      activeElementId: null,
      textSelection: null
    }
  };
}

function createDeferredResponse() {
  let resolve: (value: Response) => void = () => {};
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createMockExtension() {
  const runtimeListeners: Array<
    (message: unknown, sender: { tab?: { id?: number } }) => Promise<unknown> | unknown
  > = [];
  const toolbarListeners: Array<(tab: { id?: number; url?: string }) => void> = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const updatedListeners: Array<(tabId: number, changeInfo: { status?: string }) => void> = [];
  const contentMessages: Array<{ tabId: number; message: any }> = [];
  let injected = false;
  let toolHandler = async (message: { request: { toolName: string } }) => {
    if (message.request.toolName === "get_page_snapshot") {
      return {
        ok: true,
        code: "ok",
        message: "Snapshot captured.",
        pageSnapshot: createSnapshot()
      };
    }
    return {
      ok: true,
      code: "ok",
      message: "Tool finished.",
      pageSnapshot: createSnapshot()
    };
  };

  const api = {
    runtime: {
      onMessage: {
        addListener(listener: (message: unknown, sender: { tab?: { id?: number } }) => unknown) {
          runtimeListeners.push(listener);
        }
      }
    },
    tabs: {
      sendMessage: vi.fn(async (tabId: number, message: any) => {
        contentMessages.push({ tabId, message });
        if (message.kind === "overlay_ping") {
          if (!injected) {
            throw new Error("content script missing");
          }
          return { ok: true };
        }
        if (message.kind === "run_tool") {
          return await toolHandler(message);
        }
        return { ok: true };
      }),
      executeScript: vi.fn(async () => {
        injected = true;
      }),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      goForward: vi.fn(async () => {}),
      captureVisibleTab: vi.fn(async () => "data:image/png;base64,Zm9v"),
      onUpdated: {
        addListener(listener: (tabId: number, changeInfo: { status?: string }) => void) {
          updatedListeners.push(listener);
        },
        removeListener(listener: (tabId: number, changeInfo: { status?: string }) => void) {
          const index = updatedListeners.indexOf(listener);
          if (index >= 0) {
            updatedListeners.splice(index, 1);
          }
        }
      },
      onRemoved: {
        addListener(listener: (tabId: number) => void) {
          tabRemovedListeners.push(listener);
        }
      }
    },
    browserAction: {
      onClicked: {
        addListener(listener: (tab: { id?: number; url?: string }) => void) {
          toolbarListeners.push(listener);
        }
      }
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {})
      }
    }
  };

  return {
    api,
    contentMessages,
    dispatchRuntime(message: unknown, tabId = 7) {
      return runtimeListeners[0]?.(message, {
        tab: { id: tabId }
      });
    },
    dispatchTabUpdated(tabId: number, changeInfo: { status?: string }) {
      for (const listener of updatedListeners) {
        listener(tabId, changeInfo);
      }
    },
    clickToolbar(tab = { id: 7, url: "https://example.com" }) {
      toolbarListeners[0]?.(tab);
    },
    setInjected(value: boolean) {
      injected = value;
    },
    setToolHandler(handler: typeof toolHandler) {
      toolHandler = handler;
    }
  };
}

describe("background controllers", () => {
  it("enforces readonly tool gating", () => {
    expect(isToolAllowedInAccessMode("get_page_snapshot", "readonly")).toBe(true);
    expect(isToolAllowedInAccessMode("click_element", "readonly")).toBe(false);
    expect(isToolAllowedInAccessMode("click_element", "take_control")).toBe(true);
  });

  it("enforces close gating", () => {
    expect(canDestroyOverlay("running")).toBe(false);
    expect(canDestroyOverlay("starting")).toBe(false);
    expect(canDestroyOverlay("paused")).toBe(true);
  });

  it("reduces session options against backend model truth", () => {
    const reduced = reduceSessionOptions(
      {
        model: "gpt-5.3-codex",
        effort: "medium",
        accessMode: "readonly"
      },
      {
        model: "missing-model",
        effort: "high",
        accessMode: "take_control"
      },
      DEFAULT_MODEL_DESCRIPTORS
    );

    expect(reduced.model).toBe("gpt-5.3-codex");
    expect(reduced.effort).toBe("high");
    expect(reduced.accessMode).toBe("take_control");
  });

  it("injects the overlay only on toolbar demand", async () => {
    const mock = createMockExtension();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          version: "0.1.0"
        });
      }
      return jsonResponse({
        ok: true,
        models: DEFAULT_MODEL_DESCRIPTORS,
        defaultModel: "gpt-5.3-codex"
      });
    });
    const background = new BrowserControlBackground(mock.api as never, fetchMock as never);
    background.start();

    expect(mock.api.tabs.executeScript).not.toHaveBeenCalled();
    mock.clickToolbar();
    await flush();

    expect(mock.api.tabs.executeScript).toHaveBeenCalledTimes(1);
  });

  it("reinjects the overlay automatically after a hard navigation", async () => {
    const mock = createMockExtension();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          version: "0.1.0"
        });
      }
      return jsonResponse({
        ok: true,
        models: DEFAULT_MODEL_DESCRIPTORS,
        defaultModel: "gpt-5.3-codex"
      });
    });
    const background = new BrowserControlBackground(mock.api as never, fetchMock as never);
    background.start();

    mock.clickToolbar();
    await flush();

    expect(mock.api.tabs.executeScript).toHaveBeenCalledTimes(1);

    mock.setInjected(false);
    mock.dispatchTabUpdated(7, { status: "loading" });
    mock.dispatchTabUpdated(7, { status: "complete" });
    await flush();

    expect(mock.api.tabs.executeScript).toHaveBeenCalledTimes(2);
  });

  it("shows immediate user and thinking entries before the backend resolves", async () => {
    const mock = createMockExtension();
    const startResponse = createDeferredResponse();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          version: "0.1.0"
        });
      }
      if (url.endsWith("/api/models")) {
        return jsonResponse({
          ok: true,
          models: DEFAULT_MODEL_DESCRIPTORS,
          defaultModel: "gpt-5.3-codex"
        });
      }
      if (url.endsWith("/api/model/start")) {
        return await startResponse.promise;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    const background = new BrowserControlBackground(mock.api as never, fetchMock as never);
    background.start();

    await mock.dispatchRuntime({ kind: "overlay_ready" });
    const sendPromise = mock.dispatchRuntime({
      kind: "send_prompt",
      prompt: "Inspect this page"
    });
    await flush();

    const overlayStates = mock.contentMessages
      .filter((entry) => entry.message.kind === "overlay_state")
      .map((entry) => entry.message);
    const latest = overlayStates.at(-1);
    expect(latest.feed.some((item: OverlayFeedItem) => item.kind === "user")).toBe(true);
    expect(
      latest.feed.some(
        (item: OverlayFeedItem) => item.kind === "status" && item.title === "Thinking..."
      )
    ).toBe(true);

    startResponse.resolve(
      jsonResponse({
        ok: true,
        turn: {
          kind: "final",
          summary: "Done",
          answer: "All set"
        }
      })
    );
    await sendPromise;
    await flush();
  });

  it("reuses the same session for follow-up messages after completion", async () => {
    const mock = createMockExtension();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          version: "0.1.0"
        });
      }
      if (url.endsWith("/api/models")) {
        return jsonResponse({
          ok: true,
          models: DEFAULT_MODEL_DESCRIPTORS,
          defaultModel: "gpt-5.3-codex"
        });
      }
      if (url.endsWith("/api/model/start")) {
        return jsonResponse({
          ok: true,
          turn: {
            kind: "final",
            summary: "Done",
            answer: "First answer"
          }
        });
      }
      if (url.endsWith("/api/model/message")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.prompt).toBe("And now what changed?");
        return jsonResponse({
          ok: true,
          turn: {
            kind: "final",
            summary: "Done",
            answer: "Second answer"
          }
        });
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    const background = new BrowserControlBackground(mock.api as never, fetchMock as never);
    background.start();

    await mock.dispatchRuntime({ kind: "overlay_ready" });
    await mock.dispatchRuntime({
      kind: "send_prompt",
      prompt: "Inspect this page"
    });
    await flush();
    await flush();

    await mock.dispatchRuntime({
      kind: "send_prompt",
      prompt: "And now what changed?"
    });
    await flush();
    await flush();

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/model/message"))
    ).toBe(true);

    const latest = mock.contentMessages
      .filter((entry) => entry.message.kind === "overlay_state")
      .at(-1)?.message;
    expect(latest.feed.filter((item: OverlayFeedItem) => item.kind === "user")).toHaveLength(2);
    expect(latest.feed.filter((item: OverlayFeedItem) => item.kind === "answer")).toHaveLength(2);
  });

  it("blocks toolbar close while a task is still starting", async () => {
    const mock = createMockExtension();
    const startResponse = createDeferredResponse();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          version: "0.1.0"
        });
      }
      if (url.endsWith("/api/models")) {
        return jsonResponse({
          ok: true,
          models: DEFAULT_MODEL_DESCRIPTORS,
          defaultModel: "gpt-5.3-codex"
        });
      }
      if (url.endsWith("/api/model/start")) {
        return await startResponse.promise;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    const background = new BrowserControlBackground(mock.api as never, fetchMock as never);
    background.start();

    await mock.dispatchRuntime({ kind: "overlay_ready" });
    void mock.dispatchRuntime({
      kind: "send_prompt",
      prompt: "Hold state"
    });
    await flush();

    mock.clickToolbar();
    await flush();

    expect(
      mock.contentMessages.some((entry) => entry.message.kind === "destroy_overlay")
    ).toBe(false);
    const latest = mock.contentMessages
      .filter((entry) => entry.message.kind === "overlay_state")
      .at(-1)?.message;
    expect(
      latest.feed.some(
        (item: OverlayFeedItem) => item.kind === "warning" && item.title === "Pause first to close"
      )
    ).toBe(true);

    startResponse.resolve(
      jsonResponse({
        ok: true,
        turn: {
          kind: "final",
          summary: "Done",
          answer: "Finished"
        }
      })
    );
    await flush();
  });

  it("restores a paused session after destroy and reopen", async () => {
    const mock = createMockExtension();
    const startResponse = createDeferredResponse();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          version: "0.1.0"
        });
      }
      if (url.endsWith("/api/models")) {
        return jsonResponse({
          ok: true,
          models: DEFAULT_MODEL_DESCRIPTORS,
          defaultModel: "gpt-5.3-codex"
        });
      }
      if (url.endsWith("/api/model/start")) {
        return await startResponse.promise;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    const background = new BrowserControlBackground(mock.api as never, fetchMock as never);
    background.start();

    await mock.dispatchRuntime({ kind: "overlay_ready" });
    const promptPromise = mock.dispatchRuntime({
      kind: "send_prompt",
      prompt: "Pause this"
    });
    await flush();
    await mock.dispatchRuntime({ kind: "pause_task" });

    startResponse.resolve(
      jsonResponse({
        ok: true,
        turn: {
          kind: "final",
          summary: "Ready to answer",
          answer: "Paused answer"
        }
      })
    );
    await promptPromise;
    await flush();

    const closeResult = await mock.dispatchRuntime({ kind: "close_overlay" });
    expect(closeResult).toEqual({ ok: true });

    const restored = await mock.dispatchRuntime({ kind: "overlay_ready" });
    expect((restored as any).viewState.taskState).toBe("paused");
    expect((restored as any).feed.some((item: OverlayFeedItem) => item.kind === "user")).toBe(
      true
    );
  });

  it("clears the feed and returns to idle on new chat", async () => {
    const mock = createMockExtension();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          version: "0.1.0"
        });
      }
      if (url.endsWith("/api/models")) {
        return jsonResponse({
          ok: true,
          models: DEFAULT_MODEL_DESCRIPTORS,
          defaultModel: "gpt-5.3-codex"
        });
      }
      if (url.endsWith("/api/model/start")) {
        return jsonResponse({
          ok: true,
          turn: {
            kind: "final",
            summary: "Done",
            answer: "Ready"
          }
        });
      }
      if (url.endsWith("/api/model/cancel")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    const background = new BrowserControlBackground(mock.api as never, fetchMock as never);
    background.start();

    await mock.dispatchRuntime({ kind: "overlay_ready" });
    await mock.dispatchRuntime({
      kind: "send_prompt",
      prompt: "Inspect this page"
    });
    await flush();
    await flush();

    await mock.dispatchRuntime({ kind: "new_chat" });
    await flush();

    const latest = mock.contentMessages
      .filter((entry) => entry.message.kind === "overlay_state")
      .at(-1)?.message;
    expect(latest.feed).toEqual([]);
    expect(latest.viewState.taskState).toBe("idle");
    expect(latest.viewState.sessionId).toBeNull();
  });

  it("emits tool start and finish feed items during a controlled run", async () => {
    const mock = createMockExtension();
    mock.setToolHandler(async (message) => {
      if (message.request.toolName === "get_page_snapshot") {
        return {
          ok: true,
          code: "ok",
          message: "Snapshot captured.",
          pageSnapshot: createSnapshot()
        };
      }

      return {
        ok: true,
        code: "ok",
        message: "Extracted the relevant text.",
        pageSnapshot: createSnapshot()
      };
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          version: "0.1.0"
        });
      }
      if (url.endsWith("/api/models")) {
        return jsonResponse({
          ok: true,
          models: DEFAULT_MODEL_DESCRIPTORS,
          defaultModel: "gpt-5.3-codex"
        });
      }
      if (url.endsWith("/api/model/start")) {
        return jsonResponse({
          ok: true,
          turn: {
            kind: "tool_call",
            callId: "call-1",
            summary: "Read the page text",
            toolName: "extract_text",
            args: {}
          }
        });
      }
      if (url.endsWith("/api/model/continue")) {
        return jsonResponse({
          ok: true,
          turn: {
            kind: "final",
            summary: "Done",
            answer: "Summarized"
          }
        });
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    const background = new BrowserControlBackground(mock.api as never, fetchMock as never);
    background.start();

    await mock.dispatchRuntime({ kind: "overlay_ready" });
    await mock.dispatchRuntime({
      kind: "send_prompt",
      prompt: "Summarize the visible page"
    });
    await flush();
    await flush();

    const latest = mock.contentMessages
      .filter((entry) => entry.message.kind === "overlay_state")
      .at(-1)?.message;
    expect(
      latest.feed.some(
        (item: OverlayFeedItem) => item.kind === "tool" && item.stage === "start"
      )
    ).toBe(true);
    expect(
      latest.feed.some(
        (item: OverlayFeedItem) => item.kind === "tool" && item.stage === "finish"
      )
    ).toBe(true);
  });

  it("recovers from click-driven navigation and continues on the new page", async () => {
    const mock = createMockExtension();
    mock.setToolHandler(async (message) => {
      if (message.request.toolName === "get_page_snapshot") {
        return {
          ok: true,
          code: "ok",
          message: "Snapshot captured.",
          pageSnapshot: createSnapshot()
        };
      }

      if (message.request.toolName === "click_element") {
        mock.setInjected(false);
        queueMicrotask(() => {
          mock.dispatchTabUpdated(7, { status: "loading" });
          mock.dispatchTabUpdated(7, { status: "complete" });
        });
        throw new Error("content script unloaded during navigation");
      }

      return {
        ok: true,
        code: "ok",
        message: "Tool finished.",
        pageSnapshot: createSnapshot()
      };
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          version: "0.1.0"
        });
      }
      if (url.endsWith("/api/models")) {
        return jsonResponse({
          ok: true,
          models: DEFAULT_MODEL_DESCRIPTORS,
          defaultModel: "gpt-5.3-codex"
        });
      }
      if (url.endsWith("/api/model/start")) {
        return jsonResponse({
          ok: true,
          turn: {
            kind: "tool_call",
            callId: "call-1",
            summary: "Open the selected result",
            toolName: "click_element",
            args: {
              elementId: "link-1"
            }
          }
        });
      }
      if (url.endsWith("/api/model/continue")) {
        return jsonResponse({
          ok: true,
          turn: {
            kind: "final",
            summary: "Done",
            answer: "Recovered after navigation"
          }
        });
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    const background = new BrowserControlBackground(mock.api as never, fetchMock as never);
    background.start();

    await mock.dispatchRuntime({ kind: "overlay_ready" });
    await mock.dispatchRuntime({
      kind: "send_prompt",
      prompt: "Open the selected result"
    });
    await flush();
    await flush();
    await flush();

    const latest = mock.contentMessages
      .filter((entry) => entry.message.kind === "overlay_state")
      .at(-1)?.message;
    expect(mock.api.tabs.executeScript).toHaveBeenCalled();
    expect(
      latest.feed.some((item: OverlayFeedItem) => item.kind === "answer")
    ).toBe(true);
  });
});
