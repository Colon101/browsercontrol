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
  get_interactive_elements: z
    .object({
      filter: z.string().optional()
    })
    .strict(),
  get_element_details: z
    .object({
      elementId: z.string()
    })
    .strict(),
  extract_text: z
    .object({
      query: z.string().optional()
    })
    .strict(),
  get_form_state: z.object({}).strict(),
  take_screenshot: z.object({}).strict(),
  get_navigation_state: z.object({}).strict(),
  click_element: z
    .object({
      elementId: z.string(),
      clickMode: z.enum(["auto", "direct"]).default("auto")
    })
    .strict(),
  type_into: z
    .object({
      elementId: z.string(),
      text: z.string(),
      append: z.boolean().default(false)
    })
    .strict(),
  set_checkbox: z
    .object({
      elementId: z.string(),
      checked: z.boolean()
    })
    .strict(),
  select_option: z
    .object({
      elementId: z.string(),
      valueOrLabel: z.string()
    })
    .strict(),
  scroll_page: z
    .object({
      directionOrPixels: z.union([
        z.enum(["up", "down", "top", "bottom"]),
        z.number().int()
      ])
    })
    .strict(),
  navigate_to: z
    .object({
      url: z.string().url()
    })
    .strict(),
  go_back: z.object({}).strict(),
  go_forward: z.object({}).strict(),
  wait_for: z
    .object({
      condition: z.object({
        kind: z.enum(["url_includes", "selector_exists", "text_includes"]),
        value: z.string()
      }),
      timeoutMs: z.number().int().min(100).max(30000).default(5000)
    })
    .strict(),
  focus_element: z
    .object({
      elementId: z.string()
    })
    .strict(),
  remember_fact: z
    .object({
      key: z.string(),
      value: z.string()
    })
    .strict(),
  get_memory: z
    .object({
      key: z.string().optional()
    })
    .strict(),
  summarize_progress: z.object({}).strict()
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
  if (toolName === "navigate_to") {
    const parsed = validateToolArgs("navigate_to", args);
    if (
      parsed.url.startsWith("mailto:") ||
      parsed.url.startsWith("tel:") ||
      parsed.url.startsWith("ftp:")
    ) {
      return {
        allowed: false,
        reason: "External protocol launches are blocked in v1.",
        action: toolName
      };
    }
  }

  if (toolName === "click_element" && snapshot) {
    const parsed = validateToolArgs("click_element", args);
    const target = snapshot.interactiveElements.find(
      (item) => item.elementId === parsed.elementId
    );
    if (!target) {
      return {
        allowed: false,
        reason: "Requested click target was not present in the latest snapshot.",
        action: toolName
      };
    }

    const hintText = target.selectorHints.join(" ").toLowerCase();
    if (hintText.includes("file") || target.tag.toLowerCase() === "input:file") {
      return {
        allowed: false,
        reason: "File upload flows are blocked in v1.",
        action: toolName
      };
    }
  }

  if (toolName === "type_into" && snapshot) {
    const parsed = validateToolArgs("type_into", args);
    const target = snapshot.forms.find((item) => item.elementId === parsed.elementId);
    if (target?.type === "password") {
      return {
        allowed: false,
        reason: "Sensitive account recovery and credential flows are blocked in v1.",
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
    case "click_element":
    case "navigate_to":
    case "go_back":
    case "go_forward":
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
    case "type_into": {
      if (!afterSnapshot) {
        return { verified: false, reason: "Missing post-action snapshot." };
      }
      return {
        verified: true,
        reason: "Input action completed and snapshot was refreshed."
      };
    }
    case "set_checkbox":
    case "select_option":
      return {
        verified: Boolean(afterSnapshot),
        reason: afterSnapshot
          ? "Selection state refreshed after action."
          : "Missing post-action snapshot."
      };
    default:
      return { verified: true, reason: "No additional verification required." };
  }
}
