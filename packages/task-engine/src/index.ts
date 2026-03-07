import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  buildFailure,
  buildSuccess,
  evaluatePolicy,
  validateToolArgs,
  verifyToolResult
} from "../../browser-tools/src/index.js";
import type {
  ModelAdapter,
  ModelAdapterEvent,
  ModelSessionConfig
} from "../../model-adapter/src/index.js";
import {
  createEnvelopeIds,
  PageSnapshotSchema,
  type BrowserToolName,
  type PageSnapshot,
  type TaskSpec,
  type ToolResult
} from "../../shared/src/index.js";

export interface BrowserBridge {
  invokeTool(
    sessionId: string,
    tabId: number,
    toolName: BrowserToolName,
    args: unknown,
    summary?: string
  ): Promise<ToolResult>;
}

export type TaskEngineEvent =
  | {
      type: "status";
      sessionId: string;
      tabId: number;
      status: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";
      summary: string;
      stepCount: number;
    }
  | {
      type: "progress";
      sessionId: string;
      tabId: number;
      phase:
        | "reading_page"
        | "deciding"
        | "clicking"
        | "typing"
        | "waiting_for_page"
        | "extracting_answer"
        | "blocked"
        | "idle";
      summary: string;
      detail?: string;
    }
  | {
      type: "policy_violation";
      sessionId: string;
      tabId: number;
      reason: string;
      action: string;
    }
  | {
      type: "error";
      sessionId: string;
      tabId: number;
      code: string;
      message: string;
      detail?: string;
    };

interface TaskRuntime {
  sessionId: string;
  tabId: number;
  task: TaskSpec;
  status: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  stepCount: number;
  memory: Record<string, string>;
  actionLog: string[];
  lastSnapshot?: PageSnapshot;
  cancelled: boolean;
}

export class TaskEngine {
  private events = new EventEmitter();
  private activeTasks = new Map<string, TaskRuntime>();

  constructor(
    private readonly modelAdapter: ModelAdapter,
    private readonly bridge: BrowserBridge,
    private readonly options: {
      dataDir: string;
      cwd: string;
    }
  ) {
    this.modelAdapter.onEvent((event) => this.handleModelEvent(event));
  }

  onEvent(handler: (event: TaskEngineEvent) => void) {
    this.events.on("event", handler);
    return () => this.events.off("event", handler);
  }

  async startTask(sessionId: string, tabId: number, task: TaskSpec) {
    const runtime: TaskRuntime = {
      sessionId,
      tabId,
      task,
      status: "running",
      stepCount: 0,
      memory: {},
      actionLog: [],
      cancelled: false
    };
    this.activeTasks.set(sessionId, runtime);

    const modelConfig: ModelSessionConfig = {
      sessionId,
      task,
      cwd: this.options.cwd
    };
    await this.modelAdapter.startSession(modelConfig);

    this.emitStatus(runtime, "running", "Task started.");

    void this.runTask(runtime).catch((error) => {
      this.emitError(runtime, "task_crashed", "Task crashed.", String(error));
      this.emitStatus(runtime, "failed", "Task crashed.");
    });
  }

  async cancelTask(sessionId: string) {
    const runtime = this.activeTasks.get(sessionId);
    if (!runtime) {
      return;
    }
    runtime.cancelled = true;
    runtime.status = "cancelled";
    await this.modelAdapter.cancelSession(sessionId);
    this.emitStatus(runtime, "cancelled", "Task cancelled.");
  }

  getRuntime(sessionId: string) {
    return this.activeTasks.get(sessionId);
  }

  private async runTask(runtime: TaskRuntime) {
    this.emitProgress(runtime, "reading_page", "Collecting initial page snapshot.");
    const initialSnapshot = await this.bridge.invokeTool(
      runtime.sessionId,
      runtime.tabId,
      "get_page_snapshot",
      {}
    );
    if (!initialSnapshot.ok || !initialSnapshot.pageSnapshot) {
      throw new Error(initialSnapshot.message);
    }
    runtime.lastSnapshot = PageSnapshotSchema.parse(initialSnapshot.pageSnapshot);
    await this.persistSnapshot(runtime, runtime.lastSnapshot);

    let turn = await this.modelAdapter.sendUserMessage(
      runtime.sessionId,
      this.buildInitialPrompt(runtime)
    );

    while (!runtime.cancelled && runtime.stepCount < runtime.task.maxSteps) {
      if (turn.kind === "final") {
        runtime.actionLog.push(`Final: ${turn.answer}`);
        await this.persistLog(runtime);
        this.emitStatus(runtime, "completed", turn.summary);
        return;
      }

      runtime.stepCount += 1;
      runtime.actionLog.push(`${turn.toolName}: ${turn.summary}`);
      this.emitProgress(
        runtime,
        this.phaseForTool(turn.toolName),
        turn.summary,
        JSON.stringify(turn.args)
      );

      let toolResult: ToolResult;
      if (this.isLocalTool(turn.toolName)) {
        toolResult = await this.runLocalTool(runtime, turn.toolName, turn.args);
      } else {
        const policy = evaluatePolicy(turn.toolName, turn.args, runtime.lastSnapshot);
        if (!policy.allowed) {
          this.emitPolicyViolation(runtime, policy.reason, policy.action);
          toolResult = buildFailure("policy_blocked", policy.reason, {
            action: policy.action
          });
        } else {
          validateToolArgs(turn.toolName, turn.args);
          toolResult = await this.bridge.invokeTool(
            runtime.sessionId,
            runtime.tabId,
            turn.toolName,
            turn.args,
            turn.summary
          );
          const verification = verifyToolResult(
            turn.toolName,
            runtime.lastSnapshot,
            toolResult
          );
          runtime.actionLog.push(
            verification.verified
              ? `Verified: ${verification.reason}`
              : `Verification warning: ${verification.reason}`
          );
        }
      }

      if (toolResult.pageSnapshot) {
        runtime.lastSnapshot = PageSnapshotSchema.parse(toolResult.pageSnapshot);
        await this.persistSnapshot(runtime, runtime.lastSnapshot);
      }
      const modelPayload = await this.prepareToolPayload(runtime, toolResult);
      turn = await this.modelAdapter.submitToolResult(
        runtime.sessionId,
        turn.callId,
        modelPayload
      );
      await this.persistLog(runtime);
    }

    if (runtime.cancelled) {
      this.emitStatus(runtime, "cancelled", "Task cancelled.");
      return;
    }

    this.emitError(
      runtime,
      "max_steps_exceeded",
      "Task hit the configured max step limit."
    );
    this.emitStatus(runtime, "failed", "Task hit the configured max step limit.");
  }

  private buildInitialPrompt(runtime: TaskRuntime) {
    return JSON.stringify(
      {
        sessionId: runtime.sessionId,
        task: runtime.task,
        pageSnapshot: runtime.lastSnapshot,
        memory: runtime.memory,
        recentActions: runtime.actionLog
      },
      null,
      2
    );
  }

  private isLocalTool(toolName: BrowserToolName) {
    return (
      toolName === "remember_fact" ||
      toolName === "get_memory" ||
      toolName === "summarize_progress"
    );
  }

  private async runLocalTool(
    runtime: TaskRuntime,
    toolName: BrowserToolName,
    args: unknown
  ): Promise<ToolResult> {
    switch (toolName) {
      case "remember_fact": {
        const parsed = validateToolArgs("remember_fact", args);
        runtime.memory[parsed.key] = parsed.value;
        return buildSuccess("Stored fact in task memory.", {
          key: parsed.key,
          value: parsed.value
        });
      }
      case "get_memory": {
        const parsed = validateToolArgs("get_memory", args);
        return buildSuccess(
          "Returned task memory.",
          parsed.key ? { [parsed.key]: runtime.memory[parsed.key] ?? null } : runtime.memory
        );
      }
      case "summarize_progress": {
        return buildSuccess("Summarized progress.", {
          summary: runtime.actionLog.slice(-8).join("\n")
        });
      }
      default:
        return buildFailure("unsupported_local_tool", `Unhandled local tool: ${toolName}`);
    }
  }

  private phaseForTool(toolName: BrowserToolName) {
    switch (toolName) {
      case "click_element":
        return "clicking" as const;
      case "type_into":
      case "set_checkbox":
      case "select_option":
        return "typing" as const;
      case "wait_for":
        return "waiting_for_page" as const;
      case "extract_text":
      case "get_page_snapshot":
      case "take_screenshot":
      case "get_interactive_elements":
      case "get_form_state":
        return "reading_page" as const;
      default:
        return "deciding" as const;
    }
  }

  private emitStatus(
    runtime: TaskRuntime,
    status: TaskRuntime["status"],
    summary: string
  ) {
    runtime.status = status;
    this.events.emit("event", {
      type: "status",
      sessionId: runtime.sessionId,
      tabId: runtime.tabId,
      status,
      summary,
      stepCount: runtime.stepCount
    } satisfies TaskEngineEvent);
  }

  private emitProgress(
    runtime: TaskRuntime,
    phase: Extract<TaskEngineEvent, { type: "progress" }>["phase"],
    summary: string,
    detail?: string
  ) {
    this.events.emit("event", {
      type: "progress",
      sessionId: runtime.sessionId,
      tabId: runtime.tabId,
      phase,
      summary,
      detail
    } satisfies TaskEngineEvent);
  }

  private emitPolicyViolation(
    runtime: TaskRuntime,
    reason: string,
    action: string
  ) {
    this.events.emit("event", {
      type: "policy_violation",
      sessionId: runtime.sessionId,
      tabId: runtime.tabId,
      reason,
      action
    } satisfies TaskEngineEvent);
  }

  private emitError(
    runtime: TaskRuntime,
    code: string,
    message: string,
    detail?: string
  ) {
    this.events.emit("event", {
      type: "error",
      sessionId: runtime.sessionId,
      tabId: runtime.tabId,
      code,
      message,
      detail
    } satisfies TaskEngineEvent);
  }

  private handleModelEvent(event: ModelAdapterEvent) {
    const runtime = this.activeTasks.get(event.sessionId);
    if (!runtime) {
      return;
    }
    if (event.type === "progress") {
      this.emitProgress(runtime, "deciding", event.summary);
      return;
    }
    if (event.type === "error") {
      this.emitError(runtime, "model_error", event.message);
    }
  }

  private async persistSnapshot(runtime: TaskRuntime, snapshot: PageSnapshot) {
    const file = join(
      this.options.dataDir,
      "tasks",
      runtime.sessionId,
      `snapshot-${Date.now()}.json`
    );
    await this.writeJson(file, snapshot);
  }

  private async persistLog(runtime: TaskRuntime) {
    const file = join(this.options.dataDir, "tasks", runtime.sessionId, "run.json");
    await this.writeJson(file, {
      sessionId: runtime.sessionId,
      tabId: runtime.tabId,
      task: runtime.task,
      status: runtime.status,
      stepCount: runtime.stepCount,
      memory: runtime.memory,
      actionLog: runtime.actionLog,
      lastSnapshot: runtime.lastSnapshot
    });
  }

  private async prepareToolPayload(runtime: TaskRuntime, result: ToolResult) {
    if (result.screenshotBase64) {
      const artifactPath = join(
        this.options.dataDir,
        "tasks",
        runtime.sessionId,
        `screenshot-${createHash("sha1")
          .update(result.screenshotBase64)
          .digest("hex")}.png`
      );
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, Buffer.from(result.screenshotBase64, "base64"));
      return {
        ...result,
        screenshotBase64: undefined,
        artifactPath
      };
    }
    return result;
  }

  private async writeJson(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2), "utf8");
  }
}

export async function readLastTaskRun(
  dataDir: string,
  sessionId: string
): Promise<unknown | null> {
  try {
    const file = join(dataDir, "tasks", sessionId, "run.json");
    const content = await readFile(file, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function makeSessionId(seed?: string) {
  return seed ? `session-${seed}` : `session-${randomUUID()}`;
}

export function createStatusEnvelope(
  sessionId: string,
  tabId: number | null,
  status: string,
  summary: string,
  stepCount: number
) {
  const { id, timestamp } = createEnvelopeIds();
  return {
    type: "task_status" as const,
    eventId: id,
    sessionId,
    tabId,
    timestamp,
    status,
    summary,
    stepCount
  };
}
