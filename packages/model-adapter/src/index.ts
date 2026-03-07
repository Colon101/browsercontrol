import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { listToolSchemas } from "../../browser-tools/src/index.js";
import {
  DEFAULT_MODEL_DESCRIPTORS,
  BrowserToolNameSchema,
  ModelIdSchema,
  type ModelDescriptor,
  type ModelId,
  type ModelTurn,
  type TaskSpec
} from "../../shared/src/index.js";

export type ModelAdapterEvent =
  | { type: "progress"; sessionId: string; summary: string; raw?: unknown }
  | { type: "error"; sessionId: string; message: string }
  | { type: "spawn"; sessionId: string; command: string[] };

export interface ModelSessionConfig {
  sessionId: string;
  task: TaskSpec;
  cwd: string;
}

export interface ModelAdapter {
  listModels(): Promise<ModelDescriptor[]>;
  startSession(config: ModelSessionConfig): Promise<void>;
  sendUserMessage(sessionId: string, message: string): Promise<ModelTurn>;
  submitToolResult(
    sessionId: string,
    callId: string,
    result: unknown
  ): Promise<ModelTurn>;
  cancelSession(sessionId: string): Promise<void>;
  onEvent(handler: (event: ModelAdapterEvent) => void): () => void;
}

type ConversationEntry =
  | { role: "user"; content: string }
  | { role: "tool"; callId: string; content: string };

interface SessionState {
  config: ModelSessionConfig;
  history: ConversationEntry[];
  lastScreenshotPath?: string;
}

const outputSchema = {
  type: "object",
  required: ["kind", "summary", "callId", "toolName", "argsJson", "answer"],
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["tool_call", "final"]
    },
    summary: {
      type: "string"
    },
    callId: {
      type: "string"
    },
    toolName: {
      type: "string"
    },
    argsJson: {
      type: "string"
    },
    answer: {
      type: "string"
    }
  }
};

const rawModelTurnSchema = z.object({
  kind: z.enum(["tool_call", "final"]),
  summary: z.string(),
  callId: z.string(),
  toolName: z.string(),
  argsJson: z.string(),
  answer: z.string()
});

export class CodexCliAdapter implements ModelAdapter {
  private sessions = new Map<string, SessionState>();
  private events = new EventEmitter();
  private running = new Map<string, ReturnType<typeof spawn>>();

  async listModels(): Promise<ModelDescriptor[]> {
    return DEFAULT_MODEL_DESCRIPTORS.map((model) => ({ ...model }));
  }

  async startSession(config: ModelSessionConfig): Promise<void> {
    this.sessions.set(config.sessionId, {
      config,
      history: []
    });
  }

  async sendUserMessage(sessionId: string, message: string): Promise<ModelTurn> {
    const session = this.requireSession(sessionId);
    session.history.push({ role: "user", content: message });
    return this.invokeTurn(session);
  }

  async submitToolResult(
    sessionId: string,
    callId: string,
    result: unknown
  ): Promise<ModelTurn> {
    const session = this.requireSession(sessionId);
    session.history.push({
      role: "tool",
      callId,
      content: JSON.stringify(result, null, 2)
    });

    if (
      typeof result === "object" &&
      result !== null &&
      "artifactPath" in result &&
      typeof result.artifactPath === "string"
    ) {
      session.lastScreenshotPath = result.artifactPath;
    }

    return this.invokeTurn(session);
  }

  async cancelSession(sessionId: string): Promise<void> {
    const child = this.running.get(sessionId);
    if (child) {
      child.kill("SIGTERM");
      this.running.delete(sessionId);
    }
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

  private async invokeTurn(session: SessionState): Promise<ModelTurn> {
    const tempDir = await mkdtemp(join(tmpdir(), "browsercontrol-codex-"));
    const schemaPath = join(tempDir, "output.schema.json");
    const outputPath = join(tempDir, "last-message.json");
    await writeFile(schemaPath, JSON.stringify(outputSchema, null, 2), "utf8");

    const args = [
      "-y",
      "@openai/codex",
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-m",
      this.resolveModel(session.config.task.model),
      "-"
    ];

    if (session.lastScreenshotPath) {
      args.splice(args.length - 1, 0, "-i", session.lastScreenshotPath);
    }

    const prompt = this.buildPrompt(session);
    this.emit({
      type: "spawn",
      sessionId: session.config.sessionId,
      command: ["npx", ...args]
    });

    const turn = await new Promise<ModelTurn>((resolve, reject) => {
      const child = spawn("npx", args, {
        cwd: session.config.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.running.set(session.config.sessionId, child);

      child.stdin.end(prompt);

      let stderr = "";
      let stdoutRemainder = "";
      child.stdout.on("data", (chunk) => {
        stdoutRemainder += chunk.toString();
        const lines = stdoutRemainder.split("\n");
        stdoutRemainder = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          try {
            const event = JSON.parse(trimmed);
            this.emit({
              type: "progress",
              sessionId: session.config.sessionId,
              summary: this.summarizeEvent(event),
              raw: event
            });
          } catch {
            this.emit({
              type: "progress",
              sessionId: session.config.sessionId,
              summary: trimmed
            });
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", async (code) => {
        this.running.delete(session.config.sessionId);
        if (code !== 0) {
          reject(
            new Error(
              stderr ||
                "Codex CLI exited with a non-zero status. Make sure Codex is installed and logged in."
            )
          );
          return;
        }

        try {
          const rawOutput = await readFile(outputPath, "utf8");
          resolve(parseModelTurnPayload(JSON.parse(rawOutput)));
        } catch (error) {
          reject(error);
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      });
    });

    return turn;
  }

  private emit(event: ModelAdapterEvent) {
    this.events.emit("event", event);
  }

  private buildPrompt(session: SessionState) {
    const toolDocs = listToolSchemas()
      .map(
        (tool) =>
          `- ${tool.toolName}: ${JSON.stringify(tool.schema.properties ?? {}, null, 2)}`
      )
      .join("\n");

    const history = session.history
      .map((entry) => {
        if (entry.role === "user") {
          return `USER:\n${entry.content}`;
        }
        return `TOOL RESULT (${entry.callId}):\n${entry.content}`;
      })
      .join("\n\n");

    return [
      "You are BrowserControl's decision engine.",
      "You do not have direct browser access. You must choose exactly one next tool call or provide the final answer.",
      "Prefer DOM-native actions. Only ask for screenshots when the DOM state is insufficient.",
      "Never request downloads, uploads, payments, CAPTCHAs, account recovery, or opening new tabs.",
      "Do not repeat the same browser action unless the latest tool result or page snapshot clearly shows it is still necessary.",
      "If a tool result reports a completed action, adapt to the new page state instead of retrying the same call.",
      'Return strictly valid JSON matching the provided schema.',
      'Always include all six fields: "kind", "summary", "callId", "toolName", "argsJson", "answer".',
      'If kind is "tool_call", set "callId" to a non-empty ID, "toolName" to the requested tool, "argsJson" to a compact JSON string for the tool arguments object, and "answer" to an empty string.',
      'If kind is "final", set "answer" to the final answer, and set "callId" to "", "toolName" to "", and "argsJson" to "{}".',
      "",
      `Goal: ${session.config.task.goal}`,
      session.config.task.userNotes ? `User notes: ${session.config.task.userNotes}` : "",
      `Max steps: ${session.config.task.maxSteps}`,
      `Vision enabled: ${session.config.task.visionEnabled}`,
      "",
      "Available tools:",
      toolDocs,
      "",
      "Conversation history:",
      history || "No history yet."
    ]
      .filter(Boolean)
      .join("\n");
  }

  private summarizeEvent(event: unknown) {
    if (typeof event !== "object" || event === null) {
      return "Codex emitted an event.";
    }
    const record = event as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
    if (typeof record.summary === "string") {
      return record.summary;
    }
    if (typeof record.type === "string") {
      return `Codex event: ${record.type}`;
    }
    return "Codex emitted an event.";
  }

  private resolveModel(model: ModelId) {
    return ModelIdSchema.parse(model);
  }
}

export function parseModelTurnPayload(input: unknown): ModelTurn {
  const parsed = rawModelTurnSchema.parse(input);

  if (parsed.kind === "final") {
    if (!parsed.answer.trim()) {
      throw new Error("Model returned a final turn without an answer.");
    }
    return {
      kind: "final",
      summary: parsed.summary,
      answer: parsed.answer
    };
  }

  const toolName = BrowserToolNameSchema.parse(parsed.toolName);
  if (!parsed.callId.trim()) {
    throw new Error("Model returned a tool call without a callId.");
  }
  const args = parseArgsJson(parsed.argsJson);

  return {
    kind: "tool_call",
    callId: parsed.callId,
    summary: parsed.summary,
    toolName,
    args
  };
}

function parseArgsJson(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Tool args JSON must decode to an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Model returned invalid argsJson: ${error.message}`
        : "Model returned invalid argsJson."
    );
  }
}
