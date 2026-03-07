import { buildFailure, buildSuccess, validateToolArgs } from "../../../packages/browser-tools/src/index.js";
import type { BrowserToolName } from "../../../packages/shared/src/index.js";

function cssPathFor(element: Element) {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body) {
    const tag = current.tagName.toLowerCase();
    const siblings = Array.from(current.parentElement?.children ?? []).filter(
      (child) => child.tagName === current?.tagName
    );
    const index = siblings.indexOf(current) + 1;
    parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
    current = current.parentElement;
  }
  return ["body", ...parts].join(" > ");
}

function ensureElementId(element: Element) {
  const existing = element.getAttribute("data-browsercontrol-id");
  if (existing) {
    return existing;
  }
  const seed = `${element.tagName.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`;
  element.setAttribute("data-browsercontrol-id", seed);
  return seed;
}

function getInteractiveCandidates() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        "[role='button']",
        "[role='link']",
        "[tabindex]"
      ].join(",")
    )
  );
}

function serializeElement(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const label =
    element.getAttribute("aria-label") ||
    document.querySelector(`label[for="${element.id}"]`)?.textContent ||
    null;
  return {
    elementId: ensureElementId(element),
    tag: element instanceof HTMLInputElement ? `input:${element.type || "text"}` : element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    label: label?.trim() || null,
    text: element.textContent?.trim() || null,
    selectorHints: [cssPathFor(element), element.id ? `#${element.id}` : ""].filter(Boolean),
    bbox: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    },
    visible: rect.width > 0 && rect.height > 0,
    enabled: !(element as HTMLInputElement).disabled,
    checked:
      element instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(element.type)
        ? element.checked
        : undefined,
    selectedValue: element instanceof HTMLSelectElement ? element.value : undefined
  };
}

export function collectPageSnapshot() {
  const interactiveElements = getInteractiveCandidates().map(serializeElement);
  const forms = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select"
    )
  ).map((field) => ({
    elementId: ensureElementId(field),
    label:
      field.getAttribute("aria-label") ||
      document.querySelector(`label[for="${field.id}"]`)?.textContent?.trim() ||
      null,
    type: field instanceof HTMLSelectElement ? "select" : field.type || field.tagName.toLowerCase(),
    value: "value" in field ? field.value : null,
    checked: field instanceof HTMLInputElement ? field.checked : null
  }));
  const textBlocks = Array.from(document.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, article, section"))
    .slice(0, 80)
    .map((node, index) => {
      const rect = node.getBoundingClientRect();
      return {
        id: `text-${index}`,
        text: (node.innerText ?? node.textContent ?? "").trim(),
        bbox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        }
      };
    })
    .filter((item) => item.text);

  const selection = window.getSelection();
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  return {
    url: window.location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    scrollPosition: {
      x: window.scrollX,
      y: window.scrollY
    },
    forms,
    interactiveElements,
    textBlocks,
    selectionState: {
      activeElementId: activeElement ? ensureElementId(activeElement) : null,
      textSelection: selection ? selection.toString() || null : null
    }
  };
}

function lookupElement(elementId: string) {
  const found = document.querySelector<HTMLElement>(`[data-browsercontrol-id="${elementId}"]`);
  if (!found) {
    throw new Error(`Element not found: ${elementId}`);
  }
  return found;
}

export async function runPageTool(toolName: BrowserToolName, args: unknown) {
  try {
    switch (toolName) {
      case "get_page_snapshot":
        return buildSuccess("Collected page snapshot.", undefined, collectPageSnapshot());
      case "get_interactive_elements": {
        const parsed = validateToolArgs("get_interactive_elements", args);
        const snapshot = collectPageSnapshot();
        const filtered = parsed.filter
          ? snapshot.interactiveElements.filter((item) =>
              `${item.label ?? ""} ${item.text ?? ""} ${item.tag}`
                .toLowerCase()
                .includes(parsed.filter!.toLowerCase())
            )
          : snapshot.interactiveElements;
        return buildSuccess("Collected interactive elements.", filtered, snapshot);
      }
      case "get_element_details": {
        const parsed = validateToolArgs("get_element_details", args);
        const element = lookupElement(parsed.elementId);
        return buildSuccess(
          "Collected element details.",
          {
            html: element.outerHTML,
            text: element.innerText,
            value: (element as HTMLInputElement).value ?? null
          },
          collectPageSnapshot()
        );
      }
      case "extract_text": {
        const parsed = validateToolArgs("extract_text", args);
        const text = document.body.innerText;
        const result = parsed.query
          ? text
              .split("\n")
              .filter((line) => line.toLowerCase().includes(parsed.query!.toLowerCase()))
              .slice(0, 30)
          : text.split("\n").slice(0, 80);
        return buildSuccess("Extracted page text.", { lines: result }, collectPageSnapshot());
      }
      case "get_form_state":
        return buildSuccess("Collected form state.", collectPageSnapshot().forms, collectPageSnapshot());
      case "click_element": {
        const parsed = validateToolArgs("click_element", args);
        const element = lookupElement(parsed.elementId);
        element.click();
        await waitForPaint();
        return buildSuccess("Clicked element.", undefined, collectPageSnapshot());
      }
      case "type_into": {
        const parsed = validateToolArgs("type_into", args);
        const field = lookupElement(parsed.elementId) as HTMLInputElement | HTMLTextAreaElement;
        field.focus();
        field.value = parsed.append ? `${field.value}${parsed.text}` : parsed.text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        await waitForPaint();
        return buildSuccess("Updated field value.", undefined, collectPageSnapshot());
      }
      case "set_checkbox": {
        const parsed = validateToolArgs("set_checkbox", args);
        const field = lookupElement(parsed.elementId) as HTMLInputElement;
        field.checked = parsed.checked;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        await waitForPaint();
        return buildSuccess("Updated checkbox state.", undefined, collectPageSnapshot());
      }
      case "select_option": {
        const parsed = validateToolArgs("select_option", args);
        const field = lookupElement(parsed.elementId) as HTMLSelectElement;
        const option = Array.from(field.options).find(
          (item) =>
            item.value === parsed.valueOrLabel ||
            item.label.toLowerCase() === parsed.valueOrLabel.toLowerCase()
        );
        if (!option) {
          return buildFailure("option_not_found", `Option not found: ${parsed.valueOrLabel}`);
        }
        field.value = option.value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        await waitForPaint();
        return buildSuccess("Updated select value.", undefined, collectPageSnapshot());
      }
      case "scroll_page": {
        const parsed = validateToolArgs("scroll_page", args);
        if (typeof parsed.directionOrPixels === "number") {
          window.scrollBy({ top: parsed.directionOrPixels, behavior: "smooth" });
        } else {
          const map = {
            up: -window.innerHeight * 0.8,
            down: window.innerHeight * 0.8,
            top: -window.scrollY,
            bottom: document.body.scrollHeight
          };
          window.scrollBy({ top: map[parsed.directionOrPixels], behavior: "smooth" });
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        return buildSuccess("Scrolled page.", undefined, collectPageSnapshot());
      }
      case "wait_for": {
        const parsed = validateToolArgs("wait_for", args);
        const started = Date.now();
        while (Date.now() - started < parsed.timeoutMs) {
          if (matchesCondition(parsed.condition.kind, parsed.condition.value)) {
            return buildSuccess("Wait condition satisfied.", undefined, collectPageSnapshot());
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return buildFailure("wait_timeout", "Timed out waiting for page condition.");
      }
      case "focus_element": {
        const parsed = validateToolArgs("focus_element", args);
        lookupElement(parsed.elementId).focus();
        return buildSuccess("Focused element.", undefined, collectPageSnapshot());
      }
      case "get_navigation_state":
        return buildSuccess(
          "Collected navigation state.",
          {
            url: window.location.href,
            title: document.title,
            historyLength: window.history.length
          },
          collectPageSnapshot()
        );
      default:
        return buildFailure("unsupported_tool", `Unsupported page tool: ${toolName}`);
    }
  } catch (error) {
    return buildFailure("tool_failed", error instanceof Error ? error.message : String(error));
  }
}

function matchesCondition(kind: "url_includes" | "selector_exists" | "text_includes", value: string) {
  if (kind === "url_includes") {
    return window.location.href.includes(value);
  }
  if (kind === "selector_exists") {
    return Boolean(document.querySelector(value));
  }
  return document.body.innerText.toLowerCase().includes(value.toLowerCase());
}

function waitForPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
}
