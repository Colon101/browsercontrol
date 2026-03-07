import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "../apps/agent/src/index.js";
import {
  type ModelAdapter
} from "../packages/model-adapter/src/index.js";
import {
  DEFAULT_MODEL_DESCRIPTORS,
  type ModelTurn,
  type TaskSpec
} from "../packages/shared/src/index.js";

class MockModelAdapter implements ModelAdapter {
  public readonly startSession = vi.fn(async (_config: { sessionId: string; task: TaskSpec; cwd: string }) => {});
  public readonly sendUserMessage = vi.fn(async () => {
    return {
      kind: "final",
      summary: "Done",
      answer: "Ready"
    } satisfies ModelTurn;
  });
  public readonly submitToolResult = vi.fn(async () => {
    return {
      kind: "final",
      summary: "Done",
      answer: "Continued"
    } satisfies ModelTurn;
  });
  public readonly cancelSession = vi.fn(async () => {});

  async listModels() {
    return DEFAULT_MODEL_DESCRIPTORS.map((model) => ({ ...model }));
  }

  onEvent() {
    return () => {};
  }
}

describe("agent server", () => {
  let dataDir = "";

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("exposes truthful model metadata", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "browsercontrol-agent-"));
    const adapter = new MockModelAdapter();
    const server = await createAgentServer({
      cwd: process.cwd(),
      dataDir,
      modelAdapter: adapter,
      logger: false
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/models"
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual(DEFAULT_MODEL_DESCRIPTORS);
  });

  it("normalizes the model start endpoint", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "browsercontrol-agent-"));
    const adapter = new MockModelAdapter();
    const server = await createAgentServer({
      cwd: process.cwd(),
      dataDir,
      modelAdapter: adapter,
      logger: false
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/model/start",
      payload: {
        sessionId: "session-1",
        task: "Inspect the current page",
        pageSnapshot: {
          url: "https://example.com",
          title: "Example",
          viewport: { width: 1440, height: 900 },
          scrollPosition: { x: 0, y: 0 },
          forms: [],
          interactiveElements: [],
          textBlocks: [],
          selectionState: {
            activeElementId: null,
            textSelection: null
          }
        },
        memory: {},
        feedSummary: "",
        sessionOptions: {
          model: "gpt-5.3-codex",
          effort: "medium",
          accessMode: "readonly"
        }
      }
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(adapter.startSession).toHaveBeenCalledTimes(1);
    expect(adapter.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(response.json().turn.kind).toBe("final");
  });

  it("accepts follow-up user messages on an existing session", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "browsercontrol-agent-"));
    const adapter = new MockModelAdapter();
    const server = await createAgentServer({
      cwd: process.cwd(),
      dataDir,
      modelAdapter: adapter,
      logger: false
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/model/message",
      payload: {
        sessionId: "session-1",
        prompt: "Keep going",
        pageSnapshot: {
          url: "https://example.com",
          title: "Example",
          viewport: { width: 1440, height: 900 },
          scrollPosition: { x: 0, y: 0 },
          forms: [],
          interactiveElements: [],
          textBlocks: [],
          selectionState: {
            activeElementId: null,
            textSelection: null
          }
        },
        memory: {},
        feedSummary: "ANSWER: Ready",
        sessionOptions: {
          model: "gpt-5.3-codex",
          effort: "medium",
          accessMode: "readonly"
        }
      }
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(adapter.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(response.json().turn.kind).toBe("final");
  });
});
