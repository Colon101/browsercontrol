import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { build } from "esbuild";
import {
  createDefaultModelAdapter,
  type ModelAdapter
} from "../../../packages/model-adapter/src/index.js";
import {
  DEFAULT_MODEL_DESCRIPTORS,
  ErrorResponseSchema,
  HealthResponseSchema,
  ModelContinueRequestSchema,
  ModelMessageRequestSchema,
  ModelStartRequestSchema,
  ModelTurnResponseSchema,
  ModelsResponseSchema,
  NextRunIdResponseSchema,
  ModelCancelRequestSchema,
  PROTOCOL_VERSION,
  RuntimeStateResponseSchema,
  TaskSpecSchema,
  BrowserToolNameSchema,
  createIncrementingId,
  type AccessMode,
  type InteractionTarget,
  type PageSnapshot,
  type ModelContinueRequest,
  type ModelMessageRequest,
  type ModelStartRequest,
  type ModelTurn,
  type ToolResult,
  type VisualContext
} from "../../../packages/shared/src/index.js";

const APP_VERSION = "0.1.0";

export interface AgentServerOptions {
  cwd?: string;
  dataDir?: string;
  modelAdapter?: ModelAdapter;
  logger?: boolean;
}

type ExtensionRuntimeResponse = {
  ok: true;
  version: string;
  generatedAt: string;
  backgroundScript: string;
  contentScript: string;
  overlayCss: string;
};

export async function createAgentServer(
  options: AgentServerOptions = {}
): Promise<FastifyInstance> {
  const cwd = options.cwd ?? process.cwd();
  const dataDir = options.dataDir ?? join(cwd, ".data");
  const modelAdapter = options.modelAdapter ?? createDefaultModelAdapter();
  const server = Fastify({
    logger: false
  });
  const activeSessions = new Set<string>();
  const sessionAliases = new Map<string, string>();
  const enableLogs = options.logger !== false;

  await mkdir(dataDir, { recursive: true });

  modelAdapter.onEvent((event) => {
    switch (event.type) {
      case "tool_call":
        logTool(
          enableLogs,
          `${event.sessionId} ${event.toolName} ${truncateForLog(JSON.stringify(event.args), 160)}`
        );
        void appendRunLog(dataDir, event.sessionId, `[tool] ${event.toolName} ${JSON.stringify(event.args)}`);
        break;
      case "progress":
        logInfo(
          enableLogs,
          `model ${event.sessionId} ${truncateForLog(event.summary, 160)}`
        );
        void appendRunLog(dataDir, event.sessionId, `[model] ${event.summary}`);
        break;
      case "error":
        logError(enableLogs, `model error ${event.sessionId}: ${event.message}`);
        void appendRunLog(dataDir, event.sessionId, `[error] ${event.message}`);
        break;
    }
  });

  server.get("/health", async () =>
    HealthResponseSchema.parse({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      version: APP_VERSION
    })
  );

  server.get("/api/state", async () =>
    RuntimeStateResponseSchema.parse({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      version: APP_VERSION,
      sessionCount: activeSessions.size,
      models: await modelAdapter.listModels()
    })
  );

  server.get("/api/models", async () => {
    const models = await modelAdapter.listModels();
    return ModelsResponseSchema.parse({
      ok: true,
      models,
      defaultModel: (models[0] ?? DEFAULT_MODEL_DESCRIPTORS[0]).id
    });
  });

  server.get("/api/runs/next-id", async () => {
    return NextRunIdResponseSchema.parse({
      ok: true,
      nextRunId: await getNextRunId(dataDir)
    });
  });

  server.get("/api/extension/runtime", async (_, reply) => {
    try {
      return await buildExtensionRuntime(cwd);
    } catch (error) {
      logError(enableLogs, `extension runtime build failed: ${toErrorMessage(error)}`);
      reply.code(500);
      return ErrorResponseSchema.parse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.post("/api/model/start", async (request, reply) => {
    try {
      const parsed = ModelStartRequestSchema.parse(request.body ?? {});
      const runtimeSessionId = resolveRuntimeSessionId(parsed.sessionId, sessionAliases);
      const body = {
        ...parsed,
        visualContext: await persistVisualContextArtifacts(
          dataDir,
          runtimeSessionId,
          resolveVisualContext(parsed.visualContext, parsed.pageSnapshot, parsed.sessionOptions.accessMode)
        )
      };
      const task = TaskSpecSchema.parse({
        goal: body.task,
        model: body.sessionOptions.model,
        effort: body.sessionOptions.effort
      });

      await modelAdapter.startSession({
        sessionId: runtimeSessionId,
        task,
        cwd
      });
      activeSessions.add(runtimeSessionId);
      logInfo(
        enableLogs,
        `start ${runtimeSessionId} model=${body.sessionOptions.model} effort=${body.sessionOptions.effort} access=${body.sessionOptions.accessMode} task="${truncateForLog(body.task, 120)}"`
      );
      await appendRunLog(
        dataDir,
        runtimeSessionId,
        `[start] model=${body.sessionOptions.model} effort=${body.sessionOptions.effort} access=${body.sessionOptions.accessMode} task=${JSON.stringify(body.task)}`
      );
      logTargetMap(enableLogs, runtimeSessionId, "start", body.visualContext.targets);
      await appendRunLog(
        dataDir,
        runtimeSessionId,
        `[targets:start] ${JSON.stringify(compactTargetsForLog(body.visualContext.targets))}`
      );
      if (body.visualContext.artifactPath) {
        logInfo(enableLogs, `start ${runtimeSessionId} shot=${basename(body.visualContext.artifactPath)}`);
        await appendRunLog(
          dataDir,
          runtimeSessionId,
          `[shot] start ${basename(body.visualContext.artifactPath)}`
        );
      }

      return ModelTurnResponseSchema.parse({
        ok: true,
        turn: normalizeTurn(await modelAdapter.sendUserMessage(runtimeSessionId, buildStartPrompt(body), {
          imagePath: body.visualContext.artifactPath
        }))
      });
    } catch (error) {
      logError(enableLogs, `start failed: ${toErrorMessage(error)}`);
      reply.code(isValidationError(error) ? 400 : 500);
      return ErrorResponseSchema.parse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.post("/api/model/continue", async (request, reply) => {
    try {
      const parsed = ModelContinueRequestSchema.parse(request.body ?? {});
      const runtimeSessionId = resolveRuntimeSessionId(parsed.sessionId, sessionAliases);
      const body = {
        ...parsed,
        visualContext: await persistVisualContextArtifacts(
          dataDir,
          runtimeSessionId,
          resolveVisualContext(parsed.visualContext, parsed.pageSnapshot, parsed.sessionOptions.accessMode)
        )
      };
      const toolResult = await persistArtifacts(dataDir, runtimeSessionId, body.toolResult);
      logInfo(
        enableLogs,
        `continue ${runtimeSessionId} call=${body.callId} ok=${toolResult.ok} code=${toolResult.code} message="${truncateForLog(toolResult.message, 120)}"`
      );
      await appendRunLog(
        dataDir,
        runtimeSessionId,
        `[continue] call=${body.callId} ok=${toolResult.ok} code=${toolResult.code} message=${JSON.stringify(toolResult.message)}`
      );
      logTargetMap(enableLogs, runtimeSessionId, "continue", body.visualContext.targets);
      await appendRunLog(
        dataDir,
        runtimeSessionId,
        `[targets:continue] ${JSON.stringify(compactTargetsForLog(body.visualContext.targets))}`
      );
      if (body.visualContext.artifactPath) {
        logInfo(enableLogs, `continue ${runtimeSessionId} shot=${basename(body.visualContext.artifactPath)}`);
        await appendRunLog(
          dataDir,
          runtimeSessionId,
          `[shot] continue ${basename(body.visualContext.artifactPath)}`
        );
      }
      return ModelTurnResponseSchema.parse({
        ok: true,
        turn: normalizeTurn(
          await modelAdapter.submitToolResult(
            runtimeSessionId,
            body.callId,
            buildContinuationPayload(body, toolResult)
          )
        )
      });
    } catch (error) {
      logError(enableLogs, `continue failed: ${toErrorMessage(error)}`);
      reply.code(isValidationError(error) ? 400 : 500);
      return ErrorResponseSchema.parse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.post("/api/model/message", async (request, reply) => {
    try {
      const parsed = ModelMessageRequestSchema.parse(request.body ?? {});
      const runtimeSessionId = resolveRuntimeSessionId(parsed.sessionId, sessionAliases);
      const body = {
        ...parsed,
        visualContext: parsed.visualContext
          ? await persistVisualContextArtifacts(dataDir, runtimeSessionId, parsed.visualContext)
          : parsed.pageSnapshot
            ? await persistVisualContextArtifacts(
                dataDir,
                runtimeSessionId,
                resolveVisualContext(undefined, parsed.pageSnapshot, parsed.sessionOptions.accessMode)
              )
            : undefined
      };
      logInfo(
        enableLogs,
        `message ${runtimeSessionId} prompt="${truncateForLog(body.prompt, 120)}"`
      );
      await appendRunLog(
        dataDir,
        runtimeSessionId,
        `[message] prompt=${JSON.stringify(body.prompt)}`
      );
      logTargetMap(enableLogs, runtimeSessionId, "message", body.visualContext?.targets ?? []);
      await appendRunLog(
        dataDir,
        runtimeSessionId,
        `[targets:message] ${JSON.stringify(compactTargetsForLog(body.visualContext?.targets ?? []))}`
      );
      if (body.visualContext?.artifactPath) {
        logInfo(enableLogs, `message ${runtimeSessionId} shot=${basename(body.visualContext.artifactPath)}`);
        await appendRunLog(
          dataDir,
          runtimeSessionId,
          `[shot] message ${basename(body.visualContext.artifactPath)}`
        );
      }
      return ModelTurnResponseSchema.parse({
        ok: true,
        turn: normalizeTurn(
          await modelAdapter.sendUserMessage(runtimeSessionId, buildMessagePrompt(body), {
            imagePath: body.visualContext?.artifactPath
          })
        )
      });
    } catch (error) {
      logError(enableLogs, `message failed: ${toErrorMessage(error)}`);
      reply.code(isValidationError(error) ? 400 : 500);
      return ErrorResponseSchema.parse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.post("/api/model/cancel", async (request, reply) => {
    try {
      const body = ModelCancelRequestSchema.parse(request.body ?? {});
      const runtimeSessionId = resolveRuntimeSessionId(body.sessionId, sessionAliases);
      await modelAdapter.cancelSession(runtimeSessionId);
      activeSessions.delete(runtimeSessionId);
      sessionAliases.delete(body.sessionId);
      logInfo(enableLogs, `cancel ${runtimeSessionId}`);
      await appendRunLog(dataDir, runtimeSessionId, "[cancel]");
      return { ok: true };
    } catch (error) {
      logError(enableLogs, `cancel failed: ${toErrorMessage(error)}`);
      reply.code(isValidationError(error) ? 400 : 500);
      return ErrorResponseSchema.parse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.get("/", async (_, reply) => {
    try {
      const html = await readFile(
        join(cwd, "apps", "settings-ui", "dist", "index.html"),
        "utf8"
      );
      reply.type("text/html").send(html);
    } catch {
      reply
        .type("text/html")
        .send(
          "<!doctype html><html><body><h1>BrowserControl</h1><p>Build the settings UI first.</p></body></html>"
        );
    }
  });

  return server;
}

async function buildExtensionRuntime(cwd: string): Promise<ExtensionRuntimeResponse> {
  const backgroundRuntimeEntry = join(
    cwd,
    "apps",
    "extension-firefox",
    "src",
    "remote-background-entry.ts"
  );
  const runtimeEntry = join(
    cwd,
    "apps",
    "extension-firefox",
    "src",
    "remote-content-entry.ts"
  );
  const overlayCssPath = join(
    cwd,
    "apps",
    "extension-firefox",
    "assets",
    "overlay.css"
  );

  const [bundleResult, overlayCss] = await Promise.all([
    build({
      entryPoints: [backgroundRuntimeEntry, runtimeEntry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      target: ["firefox128"],
      sourcemap: false,
      tsconfig: join(cwd, "tsconfig.json")
    }),
    readFile(overlayCssPath, "utf8")
  ]);

  const outputFiles = new Map(
    bundleResult.outputFiles.map((file) => [basename(file.path), file.text])
  );
  const backgroundScript = outputFiles.get("remote-background-entry.js");
  const contentScript = outputFiles.get("remote-content-entry.js");
  if (!backgroundScript || !contentScript) {
    throw new Error("Extension runtime bundle was empty.");
  }

  const version = createHash("sha1")
    .update(backgroundScript)
    .update("\n")
    .update(contentScript)
    .update("\n")
    .update(overlayCss)
    .digest("hex");

  return {
    ok: true,
    version,
    generatedAt: new Date().toISOString(),
    backgroundScript,
    contentScript,
    overlayCss
  };
}

function resolveVisualContext(
  context: VisualContext | undefined,
  pageSnapshot: PageSnapshot | null | undefined,
  accessMode: AccessMode
) {
  if (context) {
    return context;
  }
  if (!pageSnapshot) {
    throw new Error("Missing visual context for model request.");
  }

  return {
    url: pageSnapshot.url,
    title: pageSnapshot.title,
    viewport: pageSnapshot.viewport,
    scrollPosition: pageSnapshot.scrollPosition,
    activeElementId: pageSnapshot.selectionState.activeElementId,
    accessMode,
    targets: [],
    lastActionSummary: null,
    lastError: null,
    lastAction: null
  } satisfies VisualContext;
}

function normalizeTurn(turn: unknown): ModelTurn {
  if (typeof turn === "string") {
    return {
      kind: "final",
      summary: summarizeFinalMessage(turn),
      answer: turn
    };
  }

  if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
    throw new Error("Model returned an invalid turn payload.");
  }

  const record = turn as Record<string, unknown>;
  const rawKind = typeof record.kind === "string" ? record.kind : "";

  if (rawKind === "final" || hasFinalAnswer(record)) {
    return {
      kind: "final",
      summary: typeof record.summary === "string" ? record.summary : "Completed",
      answer: typeof record.answer === "string" ? record.answer : ""
    };
  }

  if (rawKind === "tool_call" || hasToolPayload(record)) {
    return {
      kind: "tool_call",
      callId:
        typeof record.callId === "string" && record.callId.trim()
          ? record.callId
          : createIncrementingId("call"),
      summary:
        typeof record.summary === "string" ? record.summary : "Running browser tool.",
      toolName: BrowserToolNameSchema.parse(record.toolName),
      args: normalizeLegacyArgs(record)
    };
  }

  throw new Error("Model returned a turn without a valid kind or tool.");
}

function normalizeLegacyArgs(turn: Record<string, unknown>) {
  if (
    typeof turn.args === "object" &&
    turn.args !== null &&
    !Array.isArray(turn.args)
  ) {
    return turn.args as Record<string, unknown>;
  }

  if (typeof turn.argsJson === "string" && turn.argsJson.trim()) {
    try {
      const parsed = JSON.parse(turn.argsJson);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function hasFinalAnswer(turn: Record<string, unknown>) {
  return typeof turn.answer === "string" && turn.answer.trim().length > 0;
}

function hasToolPayload(turn: Record<string, unknown>) {
  return typeof turn.toolName === "string";
}

function resolveRuntimeSessionId(sessionId: string, sessionAliases: Map<string, string>) {
  const existing = sessionAliases.get(sessionId);
  if (existing) {
    return existing;
  }
  const runtimeSessionId = sessionId;
  sessionAliases.set(sessionId, runtimeSessionId);
  return runtimeSessionId;
}

function buildStartPrompt(body: ModelStartRequest) {
  return JSON.stringify(
    {
      task: body.task,
      visualContext: compactVisualContext(body.visualContext),
      sessionOptions: compactSessionOptions(body.sessionOptions)
    },
    null,
    2
  );
}

function buildMessagePrompt(body: ModelMessageRequest) {
  return JSON.stringify(
    {
      prompt: body.prompt,
      visualContext: compactVisualContext(body.visualContext ?? null),
      sessionOptions: compactSessionOptions(body.sessionOptions)
    },
    null,
    2
  );
}

function buildContinuationPayload(body: ModelContinueRequest, toolResult: ToolResult) {
  return {
    toolResult: compactToolResult(toolResult),
    visualContext: compactVisualContext(body.visualContext),
    sessionOptions: compactSessionOptions(body.sessionOptions)
  };
}

function compactToolResult(result: ToolResult) {
  return {
    ...result,
    pageSnapshot: undefined,
    screenshotBase64: undefined,
    data: compactUnknown(result.data)
  };
}

function compactSessionOptions(sessionOptions: { accessMode: AccessMode }) {
  return {
    accessMode: sessionOptions.accessMode
  };
}

function compactVisualContext(context: VisualContext | null | undefined) {
  if (!context) {
    return null;
  }

  return {
    url: context.url,
    title: truncate(context.title, 160),
    viewport: context.viewport,
    scrollPosition: context.scrollPosition,
    activeElementId: context.activeElementId,
    accessMode: context.accessMode,
    targets: context.targets.slice(0, 80).map((target) => ({
      id: truncate(target.id, 16) ?? "",
      name: truncate(target.name, 80) ?? "",
      role: truncate(target.role, 40),
      kind: target.kind,
      x: Math.round(target.x),
      y: Math.round(target.y),
      width: Math.round(target.width),
      height: Math.round(target.height),
      enabled: target.enabled,
      selected: target.selected,
      valueHint: truncate(target.valueHint, 80)
    })),
    lastActionSummary: truncate(context.lastActionSummary, 220),
    lastError: truncate(context.lastError, 220),
    lastAction: context.lastAction
      ? {
          toolName: context.lastAction.toolName,
          targetId: truncate(context.lastAction.targetId, 16),
          point: context.lastAction.point
            ? {
                x: Math.round(context.lastAction.point.x),
                y: Math.round(context.lastAction.point.y)
              }
            : null,
          resolvedTag: truncate(context.lastAction.resolvedTag, 40),
          resolvedRole: truncate(context.lastAction.resolvedRole, 40),
          resolvedLabel: truncate(context.lastAction.resolvedLabel, 80),
          usedFallback: context.lastAction.usedFallback,
          navigationOccurred: context.lastAction.navigationOccurred
        }
      : null,
  };
}

function compactPageSnapshot(snapshot: PageSnapshot | null | undefined) {
  if (!snapshot) {
    return snapshot ?? null;
  }

  return {
    ...snapshot,
    forms: snapshot.forms.slice(0, 60).map((field) => ({
      ...field,
      label: truncate(field.label, 120),
      type: truncate(field.type, 60),
      value: truncate(field.value, 200)
    })),
    interactiveElements: snapshot.interactiveElements.slice(0, 80).map((item) => ({
      ...item,
      tag: truncate(item.tag, 60),
      role: truncate(item.role, 60),
      label: truncate(item.label, 160),
      text: truncate(item.text, 200),
      selectorHints: item.selectorHints.slice(0, 3).map((hint) => truncate(hint, 120))
    })),
    textBlocks: snapshot.textBlocks.slice(0, 40).map((block) => ({
      ...block,
      text: truncate(block.text, 280) ?? ""
    })),
    selectionState: {
      ...snapshot.selectionState,
      textSelection: truncate(snapshot.selectionState.textSelection, 200)
    }
  };
}

function truncate(value: string | null | undefined, maxLength: number) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return truncate(value, 600);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => compactUnknown(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    return Object.fromEntries(entries.map(([key, item]) => [key, compactUnknown(item)]));
  }
  return value;
}

async function persistArtifacts(
  dataDir: string,
  sessionId: string,
  result: ToolResult
): Promise<ToolResult> {
  if (typeof result.screenshotBase64 !== "string") {
    return result;
  }

  const taskDir = join(dataDir, "tasks", sessionId);
  const file = join(taskDir, `${createIncrementingId("shot")}.png`);
  await mkdir(taskDir, { recursive: true });
  await writeFile(file, Buffer.from(result.screenshotBase64, "base64"));

  return {
    ...result,
    artifactPath: file,
    screenshotBase64: undefined
  };
}

async function persistVisualContextArtifacts(
  dataDir: string,
  sessionId: string,
  context: VisualContext
): Promise<VisualContext> {
  if (typeof context.screenshotBase64 !== "string") {
    return context;
  }

  const taskDir = join(dataDir, "tasks", sessionId);
  const file = join(taskDir, `${createIncrementingId("shot")}.png`);
  await mkdir(taskDir, { recursive: true });
  await writeFile(file, Buffer.from(context.screenshotBase64, "base64"));

  return {
    ...context,
    artifactPath: file,
    screenshotBase64: undefined
  };
}

function isValidationError(error: unknown) {
  return error instanceof Error && error.name === "ZodError";
}

function logInfo(enabled: boolean, message: string) {
  if (!enabled) {
    return;
  }
  console.log(`[agent] ${message}`);
}

function logTool(enabled: boolean, message: string) {
  if (!enabled) {
    return;
  }
  console.log(`[tool] ${message}`);
}

function logError(enabled: boolean, message: string) {
  if (!enabled) {
    return;
  }
  console.error(`[agent] ${message}`);
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function truncateForLog(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function appendRunLog(dataDir: string, sessionId: string, line: string) {
  const taskDir = join(dataDir, "tasks", sessionId);
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "run.log"), `${new Date().toISOString()} ${line}\n`, {
    flag: "a"
  });
}

async function getNextRunId(dataDir: string) {
  const tasksDir = join(dataDir, "tasks");
  try {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    let maxRun = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const match = /^run-(\d+)$/.exec(entry.name);
      if (!match) {
        continue;
      }
      maxRun = Math.max(maxRun, Number(match[1]));
    }
    return `run-${maxRun + 1}`;
  } catch {
    return "run-1";
  }
}

function summarizeFinalMessage(message: string) {
  const line = message
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean);
  return line ? truncateForLog(line, 120) : "Completed";
}

function logTargetMap(
  enabled: boolean,
  sessionId: string,
  phase: "start" | "continue" | "message",
  targets: InteractionTarget[]
) {
  if (!enabled) {
    return;
  }
  const preview = compactTargetsForLog(targets);
  console.log(`[agent] ${phase} ${sessionId} targets=${targets.length} ${JSON.stringify(preview)}`);
}

function compactTargetsForLog(targets: InteractionTarget[]) {
  return targets.slice(0, 20).map((target) => ({
    id: target.id,
    kind: target.kind,
    name: truncateForLog(target.name, 48),
    x: Math.round(target.x),
    y: Math.round(target.y)
  }));
}

async function main() {
  const server = await createAgentServer();
  const port = Number(process.env.PORT || 4317);
  await server.listen({
    host: "127.0.0.1",
    port
  });
  logInfo(true, `listening http://127.0.0.1:${port}`);
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
