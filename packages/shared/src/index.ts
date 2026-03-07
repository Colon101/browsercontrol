import { z } from "zod";

export const PROTOCOL_VERSION = 2;

export const ModelIdSchema = z.string().min(1);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const EffortSchema = z.enum(["low", "medium", "high"]);
export type Effort = z.infer<typeof EffortSchema>;

export const AccessModeSchema = z.enum(["readonly", "take_control"]);
export type AccessMode = z.infer<typeof AccessModeSchema>;

export const SessionOptionsSchema = z.object({
  model: ModelIdSchema,
  effort: EffortSchema,
  accessMode: AccessModeSchema
});

export type SessionOptions = z.infer<typeof SessionOptionsSchema>;

export const ModelDescriptorSchema = z.object({
  id: ModelIdSchema,
  label: z.string(),
  supportsEffort: z.boolean(),
  defaultEffort: EffortSchema.optional()
});

export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const DEFAULT_MODEL_DESCRIPTORS = [
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    supportsEffort: true,
    defaultEffort: "medium"
  },
  {
    id: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    supportsEffort: true,
    defaultEffort: "medium"
  },
  {
    id: "gpt-5.1-codex-max",
    label: "GPT-5.1 Codex Max",
    supportsEffort: true,
    defaultEffort: "high"
  },
  {
    id: "gpt-5.1-codex",
    label: "GPT-5.1 Codex",
    supportsEffort: true,
    defaultEffort: "medium"
  },
  {
    id: "gpt-5.1-codex-mini",
    label: "GPT-5.1 Codex mini",
    supportsEffort: true,
    defaultEffort: "low"
  },
  {
    id: "custom",
    label: "Custom model",
    supportsEffort: false
  }
] satisfies ModelDescriptor[];

export const BrowserToolNameSchema = z.enum([
  "get_page_snapshot",
  "get_interactive_elements",
  "get_element_details",
  "extract_text",
  "get_form_state",
  "take_screenshot",
  "get_navigation_state",
  "click_element",
  "type_into",
  "set_checkbox",
  "select_option",
  "scroll_page",
  "navigate_to",
  "go_back",
  "go_forward",
  "wait_for",
  "focus_element",
  "remember_fact",
  "get_memory",
  "summarize_progress"
]);

export type BrowserToolName = z.infer<typeof BrowserToolNameSchema>;

export const BBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
});

export const InteractiveElementSchema = z.object({
  elementId: z.string(),
  tag: z.string(),
  role: z.string().nullable(),
  label: z.string().nullable(),
  text: z.string().nullable(),
  selectorHints: z.array(z.string()),
  bbox: BBoxSchema,
  visible: z.boolean(),
  enabled: z.boolean(),
  checked: z.boolean().optional(),
  selectedValue: z.string().nullable().optional()
});

export const FormFieldSchema = z.object({
  elementId: z.string(),
  label: z.string().nullable(),
  type: z.string(),
  value: z.string().nullable(),
  checked: z.boolean().nullable()
});

export const TextBlockSchema = z.object({
  id: z.string(),
  text: z.string(),
  bbox: BBoxSchema
});

export const PageSnapshotSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  viewport: z.object({
    width: z.number(),
    height: z.number()
  }),
  scrollPosition: z.object({
    x: z.number(),
    y: z.number()
  }),
  forms: z.array(FormFieldSchema),
  interactiveElements: z.array(InteractiveElementSchema),
  textBlocks: z.array(TextBlockSchema),
  selectionState: z.object({
    activeElementId: z.string().nullable(),
    textSelection: z.string().nullable()
  })
});

export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;
export type InteractiveElement = z.infer<typeof InteractiveElementSchema>;

export const TaskSpecSchema = z.object({
  goal: z.string().min(1),
  userNotes: z.string().optional(),
  model: ModelIdSchema.default("gpt-5.3-codex"),
  mode: z.literal("autonomous").default("autonomous"),
  maxSteps: z.number().int().min(1).max(100).default(20),
  visionEnabled: z.boolean().default(true)
});

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const ToolCallArgsSchema = z.record(z.string(), z.unknown());

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  code: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
  pageSnapshot: PageSnapshotSchema.optional(),
  screenshotBase64: z.string().optional(),
  artifactPath: z.string().optional()
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ToolCallRequestSchema = z.object({
  type: z.literal("tool_call_request"),
  requestId: z.string(),
  sessionId: z.string(),
  tabId: z.number().int().nullable(),
  timestamp: z.string(),
  toolName: BrowserToolNameSchema,
  args: ToolCallArgsSchema,
  summary: z.string().nullable().optional()
});

export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

export const ToolCallResultSchema = z.object({
  type: z.literal("tool_call_result"),
  requestId: z.string(),
  sessionId: z.string(),
  tabId: z.number().int().nullable(),
  timestamp: z.string(),
  toolName: BrowserToolNameSchema,
  result: ToolResultSchema
});

export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;

export const TaskStateSchema = z.enum([
  "idle",
  "starting",
  "running",
  "paused",
  "completed",
  "error"
]);

export type TaskState = z.infer<typeof TaskStateSchema>;

export const OverlayFeedItemKindSchema = z.enum([
  "user",
  "status",
  "tool",
  "answer",
  "warning",
  "error"
]);

export const OverlayFeedStageSchema = z.enum([
  "queued",
  "start",
  "finish",
  "fail",
  "blocked"
]);

export const OverlayFeedItemSchema = z.object({
  id: z.string(),
  kind: OverlayFeedItemKindSchema,
  timestamp: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  toolName: BrowserToolNameSchema.optional(),
  stage: OverlayFeedStageSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type OverlayFeedItem = z.infer<typeof OverlayFeedItemSchema>;

export const OverlayPositionSchema = z.object({
  x: z.number(),
  y: z.number()
});

export const OverlaySizeSchema = z.object({
  width: z.number(),
  height: z.number()
});

export const OverlayViewStateSchema = z.object({
  visible: z.boolean(),
  destroyed: z.boolean(),
  position: OverlayPositionSchema,
  size: OverlaySizeSchema,
  pendingActivity: z.boolean(),
  taskState: TaskStateSchema,
  sessionOptions: SessionOptionsSchema,
  sessionId: z.string().nullable(),
  connectionState: z.enum(["checking", "online", "offline"]),
  headerMessage: z.string().nullable()
});

export type OverlayViewState = z.infer<typeof OverlayViewStateSchema>;

export const ModelTurnSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool_call"),
    callId: z.string(),
    summary: z.string(),
    toolName: BrowserToolNameSchema,
    args: ToolCallArgsSchema
  }),
  z.object({
    kind: z.literal("final"),
    summary: z.string(),
    answer: z.string()
  })
]);

export type ModelTurn = z.infer<typeof ModelTurnSchema>;

export const ModelStartRequestSchema = z.object({
  sessionId: z.string(),
  task: z.string().min(1),
  pageSnapshot: PageSnapshotSchema,
  memory: z.record(z.string(), z.string()),
  feedSummary: z.string(),
  sessionOptions: SessionOptionsSchema
});

export type ModelStartRequest = z.infer<typeof ModelStartRequestSchema>;

export const ModelContinueRequestSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
  toolResult: ToolResultSchema,
  pageSnapshot: PageSnapshotSchema.optional(),
  memory: z.record(z.string(), z.string()),
  sessionOptions: SessionOptionsSchema
});

export type ModelContinueRequest = z.infer<typeof ModelContinueRequestSchema>;

export const ModelMessageRequestSchema = z.object({
  sessionId: z.string(),
  prompt: z.string().min(1),
  pageSnapshot: PageSnapshotSchema.optional(),
  memory: z.record(z.string(), z.string()),
  feedSummary: z.string(),
  sessionOptions: SessionOptionsSchema
});

export type ModelMessageRequest = z.infer<typeof ModelMessageRequestSchema>;

export const ModelCancelRequestSchema = z.object({
  sessionId: z.string()
});

export const ModelTurnResponseSchema = z.object({
  ok: z.literal(true),
  turn: ModelTurnSchema
});

export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string()
});

export const ModelsResponseSchema = z.object({
  ok: z.literal(true),
  models: z.array(ModelDescriptorSchema),
  defaultModel: ModelIdSchema
});

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  version: z.string()
});

export const RuntimeStateResponseSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  version: z.string(),
  sessionCount: z.number().int().nonnegative(),
  models: z.array(ModelDescriptorSchema)
});

export const BackgroundToContentMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("overlay_state"),
    viewState: OverlayViewStateSchema,
    feed: z.array(OverlayFeedItemSchema),
    models: z.array(ModelDescriptorSchema)
  }),
  z.object({
    kind: z.literal("destroy_overlay")
  })
]);

export type BackgroundToContentMessage = z.infer<typeof BackgroundToContentMessageSchema>;

export const OverlayIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("overlay_ready")
  }),
  z.object({
    kind: z.literal("request_state")
  }),
  z.object({
    kind: z.literal("send_prompt"),
    prompt: z.string().min(1)
  }),
  z.object({
    kind: z.literal("pause_task")
  }),
  z.object({
    kind: z.literal("resume_task")
  }),
  z.object({
    kind: z.literal("close_overlay")
  }),
  z.object({
    kind: z.literal("new_chat")
  }),
  z.object({
    kind: z.literal("update_bounds"),
    position: OverlayPositionSchema,
    size: OverlaySizeSchema
  }),
  z.object({
    kind: z.literal("update_session_options"),
    sessionOptions: SessionOptionsSchema
  })
]);

export type OverlayIntent = z.infer<typeof OverlayIntentSchema>;

export const DEFAULT_OVERLAY_POSITION = {
  x: -1,
  y: 16
} satisfies OverlayViewState["position"];

export const DEFAULT_OVERLAY_SIZE = {
  width: 380,
  height: 560
} satisfies OverlayViewState["size"];

export const MIN_OVERLAY_SIZE = {
  width: 320,
  height: 360
} as const;

export const MAX_OVERLAY_SIZE = {
  width: 520,
  height: 760
} as const;

export function createDefaultSessionOptions(
  models: ModelDescriptor[] = DEFAULT_MODEL_DESCRIPTORS
): SessionOptions {
  const defaultModel = models[0] ?? DEFAULT_MODEL_DESCRIPTORS[0];
  return SessionOptionsSchema.parse({
    model: defaultModel.id,
    effort: defaultModel.defaultEffort ?? "medium",
    accessMode: "readonly"
  });
}

export function createEnvelopeIds() {
  return {
    id: createUuid(),
    timestamp: new Date().toISOString()
  };
}

export function createSessionId() {
  return createUuid();
}

function createUuid() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `fallback-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
