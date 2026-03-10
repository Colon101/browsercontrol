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
            data: [{ id: "gpt-5.1-codex" }]
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

  it("lists live ChatMock models instead of the stale fallback catalog", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-5.4" },
            { id: "gpt-5.4-high" },
            { id: "gpt-5.3-codex" },
            { id: "gpt-5.1-codex-mini" }
          ]
        }),
        { status: 200 }
      )
    );
    const adapter = new ChatMockModelAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    await expect(adapter.listModels()).resolves.toEqual([
      {
        id: "auto",
        label: "Auto",
        supportsEffort: true,
        defaultEffort: "medium"
      },
      {
        id: "gpt-5.4",
        label: "GPT 5.4",
        supportsEffort: true,
        defaultEffort: "high"
      },
      {
        id: "gpt-5.3-codex",
        label: "GPT 5.3 Codex",
        supportsEffort: true,
        defaultEffort: "medium"
      },
      {
        id: "gpt-5.1-codex-mini",
        label: "GPT 5.1 Codex mini",
        supportsEffort: false,
        defaultEffort: "low"
      }
    ]);
  });

  it("preserves assistant tool-call history across multiple tool turns", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-5.1-codex" }]
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
                  content: null,
                  tool_calls: [
                    {
                      id: "provider-call-1",
                      type: "function",
                      function: {
                        name: "type_target",
                        arguments: "{\"targetId\":\"t7\",\"text\":\"Canada\",\"append\":false}"
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
                  content: null,
                  tool_calls: [
                    {
                      id: "provider-call-2",
                      type: "function",
                      function: {
                        name: "click_target",
                        arguments: "{\"targetId\":\"t8\"}"
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
        goal: "Play the game",
        model: "gpt-5.1-codex",
        effort: "medium",
        mode: "autonomous",
        maxSteps: 6,
        visionEnabled: true
      }
    });

    const firstTurn = await adapter.sendUserMessage("run-1", "Do a first guess");
    expect(firstTurn).toMatchObject({
      kind: "tool_call",
      toolName: "type_target",
      callId: "call-1"
    });

    const secondTurn = await adapter.submitToolResult("run-1", "call-1", {
      ok: true,
      code: "ok",
      message: "Updated target value."
    });
    expect(secondTurn).toMatchObject({
      kind: "tool_call",
      toolName: "click_target",
      callId: "call-2"
    });

    const finalRequest = fetchMock.mock.calls[2]?.[1];
    const finalBody =
      finalRequest && typeof finalRequest === "object" && "body" in finalRequest
        ? JSON.parse(String(finalRequest.body))
        : null;

    expect(finalBody?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            expect.objectContaining({
              id: "provider-call-1"
            })
          ]
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "provider-call-1"
        })
      ])
    );
  });
});
