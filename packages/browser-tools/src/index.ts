import { z } from "zod";
import {
  BrowserToolNameSchema,
  PageSnapshotSchema,
  ToolResultSchema,
  type BrowserToolName,
  type PageSnapshot,
  type ToolResult
} from "../../shared/src/index.js";

const toolArgSchemas = {
  get_page_snapshot: z.object({}).strict(),
  click_target: z
    .object({
      targetId: z.string()
    })
    .strict(),
  click_coords: z
    .object({
      x: z.number(),
      y: z.number()
    })
    .strict(),
  type_target: z
    .object({
      targetId: z.string(),
      text: z.string(),
      append: z.boolean().default(false)
    })
    .strict(),
  set_checkbox_target: z
    .object({
      targetId: z.string(),
      checked: z.boolean()
    })
    .strict(),
  select_option_target: z
    .object({
      targetId: z.string(),
      valueOrLabel: z.string()
    })
    .strict(),
  scroll_viewport: z
    .object({
      directionOrPixels: z.union([
        z.enum(["up", "down", "top", "bottom"]),
        z.number().int()
      ])
    })
    .strict(),
  press_key: z
    .object({
      key: z.string().min(1)
    })
    .strict(),
  wait_for: z
    .object({
      condition: z.object({
        kind: z.enum(["url_includes", "selector_exists", "text_includes"]),
        value: z.string()
      }),
      timeoutMs: z.number().int().min(100).max(30000).default(5000)
    })
    .strict(),
  inspect_target: z
    .object({
      targetId: z.string()
    })
    .strict(),
  extract_text: z
    .object({
      query: z.string().optional()
    })
    .strict(),
  get_navigation_state: z.object({}).strict(),
  go_back: z.object({}).strict()
} satisfies Record<BrowserToolName, z.ZodTypeAny>;

export type ToolArgsMap = {
  [K in BrowserToolName]: z.infer<(typeof toolArgSchemas)[K]>;
};

export type PolicyCheck =
  | { allowed: true }
  | { allowed: false; reason: string; action: string };

export function validateToolArgs<T extends BrowserToolName>(
  toolName: T,
  args: unknown
): ToolArgsMap[T] {
  const schema = toolArgSchemas[toolName];
  return schema.parse(args) as ToolArgsMap[T];
}

export function getToolArgSchema(toolName: BrowserToolName) {
  return toolArgSchemas[toolName];
}

export function listToolSchemas() {
  return BrowserToolNameSchema.options.map((toolName) => ({
    toolName,
    schema: z.toJSONSchema(toolArgSchemas[toolName])
  }));
}

export function buildSuccess(
  message: string,
  data?: unknown,
  pageSnapshot?: PageSnapshot
): ToolResult {
  return ToolResultSchema.parse({
    ok: true,
    code: "ok",
    message,
    data,
    pageSnapshot
  });
}

export function buildFailure(
  code: string,
  message: string,
  data?: unknown
): ToolResult {
  return ToolResultSchema.parse({
    ok: false,
    code,
    message,
    data
  });
}

export function evaluatePolicy(
  toolName: BrowserToolName,
  args: unknown,
  snapshot?: PageSnapshot
): PolicyCheck {
  if (toolName === "click_coords" && snapshot) {
    const parsed = validateToolArgs("click_coords", args);
    const target = snapshot.interactiveElements.find((item) => {
      const { x, y, width, height } = item.bbox;
      return (
        parsed.x >= x &&
        parsed.x <= x + width &&
        parsed.y >= y &&
        parsed.y <= y + height
      );
    });
    const hintText = target?.selectorHints.join(" ").toLowerCase() ?? "";
    if (target && (hintText.includes("file") || target.tag.toLowerCase() === "input:file")) {
      return {
        allowed: false,
        reason: "File upload flows are blocked in v1.",
        action: toolName
      };
    }
  }

  return { allowed: true };
}

export function verifyToolResult(
  toolName: BrowserToolName,
  before: PageSnapshot | undefined,
  after: ToolResult
): { verified: boolean; reason: string } {
  if (!after.ok) {
    return { verified: false, reason: after.message };
  }

  const afterSnapshot = after.pageSnapshot
    ? PageSnapshotSchema.parse(after.pageSnapshot)
    : undefined;

  switch (toolName) {
    case "click_target":
    case "click_coords":
    case "go_back":
      if (!before || !afterSnapshot) {
        return { verified: true, reason: "No comparable snapshot available." };
      }
      return {
        verified:
          before.url !== afterSnapshot.url ||
          before.title !== afterSnapshot.title ||
          before.scrollPosition.y !== afterSnapshot.scrollPosition.y,
        reason: "Navigation or visible state changed."
      };
    case "type_target":
    case "set_checkbox_target":
    case "select_option_target": {
      if (!afterSnapshot) {
        return { verified: false, reason: "Missing post-action snapshot." };
      }
      return {
        verified: true,
        reason: "Input action completed and snapshot was refreshed."
      };
    }
    default:
      return { verified: true, reason: "No additional verification required." };
  }
}
