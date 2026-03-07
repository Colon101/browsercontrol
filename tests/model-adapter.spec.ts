import { describe, expect, it } from "vitest";
import { parseModelTurnPayload } from "../packages/model-adapter/src/index.js";

describe("model adapter payload normalization", () => {
  it("normalizes a tool call payload from the flat response schema", () => {
    const turn = parseModelTurnPayload({
      kind: "tool_call",
      summary: "Inspect the page",
      callId: "call-1",
      toolName: "get_page_snapshot",
      argsJson: "{}",
      answer: ""
    });

    expect(turn).toEqual({
      kind: "tool_call",
      summary: "Inspect the page",
      callId: "call-1",
      toolName: "get_page_snapshot",
      args: {}
    });
  });

  it("normalizes a final payload from the flat response schema", () => {
    const turn = parseModelTurnPayload({
      kind: "final",
      summary: "Done",
      callId: "",
      toolName: "",
      argsJson: "{}",
      answer: "Here is the answer."
    });

    expect(turn).toEqual({
      kind: "final",
      summary: "Done",
      answer: "Here is the answer."
    });
  });
});
