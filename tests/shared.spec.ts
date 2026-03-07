import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_DESCRIPTORS,
  ModelStartRequestSchema,
  TaskSpecSchema,
  createDefaultSessionOptions,
  createEnvelopeIds,
  createSessionId
} from "../packages/shared/src/index.js";

describe("shared contracts", () => {
  it("creates session and envelope ids", () => {
    const sessionId = createSessionId();
    const envelope = createEnvelopeIds();

    expect(sessionId).toBeTruthy();
    expect(envelope.id).toBeTruthy();
    expect(new Date(envelope.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("parses task specs with string model defaults", () => {
    const task = TaskSpecSchema.parse({
      goal: "Inspect the current page"
    });

    expect(task.model).toBe("gpt-5.3-codex");
    expect(task.mode).toBe("autonomous");
    expect(task.maxSteps).toBe(20);
  });

  it("creates default session options from backend model metadata", () => {
    const options = createDefaultSessionOptions(DEFAULT_MODEL_DESCRIPTORS);
    expect(options.model).toBe("gpt-5.3-codex");
    expect(options.effort).toBe("medium");
    expect(options.accessMode).toBe("readonly");
  });

  it("validates model start requests with session options", () => {
    const request = ModelStartRequestSchema.parse({
      sessionId: "session-1",
      task: "Summarize the page",
      pageSnapshot: {
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
      },
      memory: {},
      feedSummary: "",
      sessionOptions: createDefaultSessionOptions(DEFAULT_MODEL_DESCRIPTORS)
    });

    expect(request.sessionOptions.accessMode).toBe("readonly");
    expect(request.sessionOptions.model).toBe("gpt-5.3-codex");
  });
});
