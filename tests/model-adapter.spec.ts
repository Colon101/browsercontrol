import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMockModelAdapter } from "../packages/model-adapter/src/index.js";
import { resetIncrementingIds } from "../packages/shared/src/index.js";

describe("ChatMockModelAdapter", () => {
  beforeEach(() => {
    resetIncrementingIds();
  });

  it("normalizes a tool call from a chat completion", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "click_target",
                      arguments: "{\"targetId\":\"t2\"}"
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      )
    );
    const adapter = new ChatMockModelAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    await adapter.startSession({
      sessionId: "run-1",
      cwd: process.cwd(),
      task: {
        goal: "Click continue",
        model: "gpt-5.1-codex",
        effort: "medium",
        mode: "autonomous",
        maxSteps: 6,
        visionEnabled: true
      }
    });
    const turn = await adapter.sendUserMessage("run-1", "Click continue");

    expect(turn).toEqual({
      kind: "tool_call",
      callId: "call-1",
      summary: "click_target {\"targetId\":\"t2\"}",
      toolName: "click_target",
      args: {
        targetId: "t2"
      }
    });
  });

  it("returns a final answer after a tool result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "click_target",
                        arguments: "{\"targetId\":\"t2\"}"
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Done."
                }
              }
            ]
          }),
          { status: 200 }
        )
      );

    const adapter = new ChatMockModelAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    await adapter.startSession({
      sessionId: "run-1",
      cwd: process.cwd(),
      task: {
        goal: "Click continue",
        model: "gpt-5.1-codex",
        effort: "medium",
        mode: "autonomous",
        maxSteps: 6,
        visionEnabled: true
      }
    });

    const firstTurn = await adapter.sendUserMessage("run-1", "Click continue");
    expect(firstTurn.kind).toBe("tool_call");

    const finalTurn = await adapter.submitToolResult("run-1", firstTurn.callId, {
      ok: true,
      code: "ok",
      message: "Clicked target."
    });

    expect(finalTurn).toEqual({
      kind: "final",
      summary: "Done.",
      answer: "Done."
    });
  });
});
