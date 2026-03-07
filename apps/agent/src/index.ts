import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { CodexCliAdapter, type ModelAdapter } from "../../../packages/model-adapter/src/index.js";
import {
  DEFAULT_MODEL_DESCRIPTORS,
  ErrorResponseSchema,
  HealthResponseSchema,
  ModelContinueRequestSchema,
  ModelMessageRequestSchema,
  ModelStartRequestSchema,
  ModelTurnResponseSchema,
  ModelsResponseSchema,
  ModelCancelRequestSchema,
  PROTOCOL_VERSION,
  RuntimeStateResponseSchema,
  TaskSpecSchema,
  type ModelContinueRequest,
  type ModelMessageRequest,
  type ModelStartRequest,
  type ToolResult
} from "../../../packages/shared/src/index.js";

const APP_VERSION = "0.1.0";

export interface AgentServerOptions {
  cwd?: string;
  dataDir?: string;
  modelAdapter?: ModelAdapter;
  logger?: boolean;
}

export async function createAgentServer(
  options: AgentServerOptions = {}
): Promise<FastifyInstance> {
  const cwd = options.cwd ?? process.cwd();
  const dataDir = options.dataDir ?? join(cwd, ".data");
  const modelAdapter = options.modelAdapter ?? new CodexCliAdapter();
  const server = Fastify({
    logger: options.logger ?? true
  });
  const activeSessions = new Set<string>();

  await mkdir(dataDir, { recursive: true });

  modelAdapter.onEvent((event) => {
    switch (event.type) {
      case "spawn":
        server.log.info(
          {
            sessionId: event.sessionId,
            command: event.command
          },
          "model session spawned"
        );
        break;
      case "progress":
        server.log.info(
          {
            sessionId: event.sessionId,
            summary: event.summary
          },
          "model progress"
        );
        break;
      case "error":
        server.log.error(
          {
            sessionId: event.sessionId,
            message: event.message
          },
          "model error"
        );
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

  server.post("/api/model/start", async (request, reply) => {
    try {
      const body = ModelStartRequestSchema.parse(request.body ?? {});
      const task = TaskSpecSchema.parse({
        goal: body.task,
        model: body.sessionOptions.model
      });

      await modelAdapter.startSession({
        sessionId: body.sessionId,
        task,
        cwd
      });
      activeSessions.add(body.sessionId);

      return ModelTurnResponseSchema.parse({
        ok: true,
        turn: await modelAdapter.sendUserMessage(body.sessionId, buildStartPrompt(body))
      });
    } catch (error) {
      server.log.error(
        {
          err: error
        },
        "failed to start model session"
      );
      reply.code(isValidationError(error) ? 400 : 500);
      return ErrorResponseSchema.parse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.post("/api/model/continue", async (request, reply) => {
    try {
      const body = ModelContinueRequestSchema.parse(request.body ?? {});
      const toolResult = await persistArtifacts(dataDir, body.sessionId, body.toolResult);
      return ModelTurnResponseSchema.parse({
        ok: true,
        turn: await modelAdapter.submitToolResult(
          body.sessionId,
          body.callId,
          buildContinuationPayload(body, toolResult)
        )
      });
    } catch (error) {
      server.log.error(
        {
          err: error
        },
        "failed to continue model session"
      );
      reply.code(isValidationError(error) ? 400 : 500);
      return ErrorResponseSchema.parse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.post("/api/model/message", async (request, reply) => {
    try {
      const body = ModelMessageRequestSchema.parse(request.body ?? {});
      return ModelTurnResponseSchema.parse({
        ok: true,
        turn: await modelAdapter.sendUserMessage(body.sessionId, buildMessagePrompt(body))
      });
    } catch (error) {
      server.log.error(
        {
          err: error
        },
        "failed to send follow-up message"
      );
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
      await modelAdapter.cancelSession(body.sessionId);
      activeSessions.delete(body.sessionId);
      return { ok: true };
    } catch (error) {
      server.log.error(
        {
          err: error
        },
        "failed to cancel model session"
      );
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

function buildStartPrompt(body: ModelStartRequest) {
  return JSON.stringify(
    {
      task: body.task,
      pageSnapshot: body.pageSnapshot,
      memory: body.memory,
      feedSummary: body.feedSummary,
      sessionOptions: body.sessionOptions
    },
    null,
    2
  );
}

function buildMessagePrompt(body: ModelMessageRequest) {
  return JSON.stringify(
    {
      prompt: body.prompt,
      pageSnapshot: body.pageSnapshot ?? null,
      memory: body.memory,
      feedSummary: body.feedSummary,
      sessionOptions: body.sessionOptions
    },
    null,
    2
  );
}

function buildContinuationPayload(body: ModelContinueRequest, toolResult: ToolResult) {
  return {
    toolResult,
    pageSnapshot: body.pageSnapshot ?? toolResult.pageSnapshot ?? null,
    memory: body.memory,
    sessionOptions: body.sessionOptions
  };
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
  const file = join(
    taskDir,
    `screenshot-${createHash("sha1").update(result.screenshotBase64).digest("hex")}.png`
  );
  await mkdir(taskDir, { recursive: true });
  await writeFile(file, Buffer.from(result.screenshotBase64, "base64"));

  return {
    ...result,
    artifactPath: file,
    screenshotBase64: undefined
  };
}

function isValidationError(error: unknown) {
  return error instanceof Error && error.name === "ZodError";
}

async function main() {
  const server = await createAgentServer();
  const port = Number(process.env.PORT || 4317);
  await server.listen({
    host: "127.0.0.1",
    port
  });
  server.log.info({ port }, "BrowserControl agent listening");
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
