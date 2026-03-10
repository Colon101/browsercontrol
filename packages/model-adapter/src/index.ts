import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { getToolArgSchema } from "../../browser-tools/src/index.js";
import {
  DEFAULT_MODEL_DESCRIPTORS,
  ModelIdSchema,
  BrowserToolNameSchema,
  createIncrementingId,
  resolveEffectiveModelId,
  type BrowserToolName,
  type Effort,
  type ModelDescriptor,
  type ModelTurn,
  type TaskSpec
} from "../../shared/src/index.js";

export type ModelAdapterEvent =
  | { type: "progress"; sessionId: string; summary: string; raw?: unknown }
  | { type: "error"; sessionId: string; message: string };

export interface ModelSessionConfig {
  sessionId: string;
  task: TaskSpec;
  cwd: string;
}

export interface ModelAdapter {
  listModels(): Promise<ModelDescriptor[]>;
  startSession(config: ModelSessionConfig): Promise<void>;
  sendUserMessage(
    sessionId: string,
    message: string,
    options?: {
      imagePath?: string;
    }
  ): Promise<ModelTurn>;
  submitToolResult(
    sessionId: string,
    callId: string,
    result: unknown
  ): Promise<ModelTurn>;
  cancelSession(sessionId: string): Promise<void>;
  onEvent(handler: (event: ModelAdapterEvent) => void): () => void;
}

type ChatMessage =
  | { role: "system"; content: string }
  | {
      role: "user";
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | { type: "image_url"; image_url: { url: string } }
          >;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

interface ChatMockSessionState {
  config: ModelSessionConfig;
  messages: ChatMessage[];
  toolCallMap: Map<string, string>;
}

const completionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.union([z.string(), z.null()]).optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal("function"),
                function: z.object({
                  name: z.string(),
                  arguments: z.string()
                })
              })
            )
            .optional()
        })
      })
    )
    .min(1)
});

export class ChatMockModelAdapter implements ModelAdapter {
  private readonly sessions = new Map<string, ChatMockSessionState>();
  private readonly events = new EventEmitter();
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; apiKey?: string | null; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl =
      (options.baseUrl ?? process.env.BROWSERCONTROL_CHATMOCK_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
    this.apiKey =
      options.apiKey ??
      process.env.BROWSERCONTROL_CHATMOCK_API_KEY ??
      process.env.OPENAI_API_KEY ??
      null;
    this.fetchImpl =
      options.fetchImpl ??
      ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetch(input, init));
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return DEFAULT_MODEL_DESCRIPTORS.map((model) => ({ ...model }));
  }

  async startSession(config: ModelSessionConfig): Promise<void> {
    this.sessions.set(config.sessionId, {
      config,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt()
        }
      ],
      toolCallMap: new Map()
    });
  }

  async sendUserMessage(
    sessionId: string,
    message: string,
    options?: {
      imagePath?: string;
    }
  ): Promise<ModelTurn> {
    const session = this.requireSession(sessionId);
    session.messages.push({
      role: "user",
      content: await buildUserContent(message, options?.imagePath)
    });
    return await this.complete(session);
  }

  async submitToolResult(
    sessionId: string,
    callId: string,
    result: unknown
  ): Promise<ModelTurn> {
    const session = this.requireSession(sessionId);
    const providerCallId = session.toolCallMap.get(callId) ?? callId;
    session.messages.push({
      role: "tool",
      tool_call_id: providerCallId,
      content: JSON.stringify(result)
    });
    return await this.complete(session);
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  onEvent(handler: (event: ModelAdapterEvent) => void): () => void {
    this.events.on("event", handler);
    return () => this.events.off("event", handler);
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown model session: ${sessionId}`);
    }
    return session;
  }

  private async complete(session: ChatMockSessionState): Promise<ModelTurn> {
    const model = resolveRequestedModel(
      session.config.task.model,
      session.config.task.effort
    );
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: session.messages,
        tools: buildToolDefinitions(),
        tool_choice: "auto",
        stream: false
      })
    });

    if (!response.ok) {
      const message = await response.text();
      const error = `ChatMock request failed with ${response.status}: ${message || "empty response"}`;
      this.emit({
        type: "error",
        sessionId: session.config.sessionId,
        message: error
      });
      throw new Error(error);
    }

    const payload = completionResponseSchema.parse(await response.json());
    const message = payload.choices[0]!.message;
    const toolCall = message.tool_calls?.[0];
    if (toolCall) {
      session.messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: [toolCall]
      });
      const turn = parseToolCall(toolCall);
      session.toolCallMap.set(turn.callId, toolCall.id);
      this.emit({
        type: "progress",
        sessionId: session.config.sessionId,
        summary: `${turn.toolName} ${JSON.stringify(turn.args)}`
      });
      return turn;
    }

    const answer = normalizeAssistantText(message.content);
    session.messages.push({
      role: "assistant",
      content: answer
    });
    this.emit({
      type: "progress",
      sessionId: session.config.sessionId,
      summary: answer
    });
    return {
      kind: "final",
      summary: answer ? summarizeFinalMessage(answer) : "Completed",
      answer
    };
  }

  private emit(event: ModelAdapterEvent) {
    this.events.emit("event", event);
  }
}

export function createDefaultModelAdapter() {
  return new ChatMockModelAdapter();
}

function parseToolCall(toolCall: {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}): Extract<ModelTurn, { kind: "tool_call" }> {
  const toolName = BrowserToolNameSchema.parse(toolCall.function.name);
  const args = parseToolArgs(toolName, toolCall.function.arguments);
  return {
    kind: "tool_call",
    callId: createIncrementingId("call"),
    summary: summarizeToolCall(toolName, args),
    toolName,
    args
  };
}

function parseToolArgs(toolName: BrowserToolName, raw: string) {
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Model returned invalid JSON arguments for ${toolName}: ${error.message}`
        : `Model returned invalid JSON arguments for ${toolName}.`
    );
  }
  return getToolArgSchema(toolName).parse(parsed) as Record<string, unknown>;
}

function buildToolDefinitions() {
  return TOOL_DEFINITIONS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(getToolArgSchema(tool.name))
    }
  }));
}

const TOOL_DEFINITIONS: Array<{ name: BrowserToolName; description: string }> = [
  {
    name: "click_target",
    description: "Click a visible target from the latest target map."
  },
  {
    name: "click_coords",
    description: "Click visible viewport coordinates only when no target ID is sufficient."
  },
  {
    name: "type_target",
    description: "Type text into an editable target from the latest target map."
  },
  {
    name: "set_checkbox_target",
    description: "Set a checkbox target to checked or unchecked."
  },
  {
    name: "select_option_target",
    description: "Choose an option inside a select target."
  },
  {
    name: "scroll_viewport",
    description: "Scroll the current page viewport."
  },
  {
    name: "press_key",
    description: "Press a keyboard key in the page."
  },
  {
    name: "wait_for",
    description: "Wait until the page meets a simple URL, selector, or text condition."
  },
  {
    name: "inspect_target",
    description: "Inspect one target and return more HTML/text details."
  },
  {
    name: "extract_text",
    description: "Extract compact page text, optionally filtered by a query."
  },
  {
    name: "get_navigation_state",
    description: "Return the current URL, title, and history state."
  },
  {
    name: "go_back",
    description: "Navigate back in the current tab."
  }
];

function buildSystemPrompt() {
  return [
    "You are BrowserControl's decision engine.",
    "You see a screenshot and a compact target map for the current page.",
    "You can either call exactly one tool or provide the final answer.",
    "Prefer semantic target tools over coordinate clicks.",
    "Use click_coords only when the screenshot shows a location that is not represented well by a target.",
    "After each tool result you will receive a fresh screenshot and a fresh target map.",
    "Do not ask to open or reason across new tabs. Same-tab navigation is enforced.",
    'If accessMode is "readonly", do not pretend interactions succeeded.',
    "Be concise."
  ].join("\n");
}

async function buildUserContent(message: string, imagePath?: string) {
  if (!imagePath) {
    return message;
  }

  return [
    {
      type: "text" as const,
      text: message
    },
    {
      type: "image_url" as const,
      image_url: {
        url: await readImageAsDataUrl(imagePath)
      }
    }
  ];
}

async function readImageAsDataUrl(imagePath: string) {
  const file = await readFile(imagePath);
  return `data:image/png;base64,${file.toString("base64")}`;
}

function resolveRequestedModel(model: string, effort: Effort) {
  return ModelIdSchema.parse(resolveEffectiveModelId(model, effort));
}

function normalizeAssistantText(content: string | null | undefined) {
  return typeof content === "string" ? content.trim() : "";
}

function summarizeToolCall(toolName: BrowserToolName, args: Record<string, unknown>) {
  const argsText = JSON.stringify(args);
  return `${toolName}${argsText === "{}" ? "" : ` ${argsText}`}`;
}

function summarizeFinalMessage(message: string) {
  const line = message
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean);
  return line ? line.slice(0, 120) : "Completed";
}
