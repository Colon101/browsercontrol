import {
  buildFailure,
  buildSuccess,
  validateToolArgs
} from "../../../packages/browser-tools/src/index.js";
import type {
  ActionFeedback,
  BrowserToolName,
  InteractionTarget,
  PageSnapshot,
  ToolResult
} from "../../../packages/shared/src/index.js";

const STABLE_ID_ATTR = "data-browsercontrol-id";
const TARGET_ID_ATTR = "data-browsercontrol-target-id";
const SEMANTIC_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[contenteditable='true']"
].join(",");
const INTERACTIVE_CANDIDATE_SELECTOR = [
  SEMANTIC_INTERACTIVE_SELECTOR,
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

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

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function ensureElementId(element: Element) {
  const existing = element.getAttribute(STABLE_ID_ATTR);
  if (existing) {
    return existing;
  }
  const seed = `${element.tagName.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`;
  element.setAttribute(STABLE_ID_ATTR, seed);
  return seed;
}

function clearTargetIds() {
  for (const element of Array.from(document.querySelectorAll(`[${TARGET_ID_ATTR}]`))) {
    element.removeAttribute(TARGET_ID_ATTR);
  }
}

function getInteractiveCandidates() {
  return Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE_CANDIDATE_SELECTOR)).filter(
    (element) => isActionableElement(element)
  );
}

function isVisibleElement(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    style.pointerEvents !== "none"
  );
}

function getElementLabel(element: HTMLElement) {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return normalizeText(
      element.getAttribute("aria-label") ||
        document.querySelector(`label[for="${element.id}"]`)?.textContent ||
        element.getAttribute("placeholder") ||
        element.name ||
        element.value
    );
  }

  return normalizeText(
    element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      (element instanceof HTMLAnchorElement ||
      element instanceof HTMLButtonElement ||
      element.getAttribute("role") === "tab" ||
      element.getAttribute("role") === "menuitem"
        ? element.innerText || element.textContent
        : getDirectTextContent(element))
  );
}

function getDirectTextContent(element: HTMLElement) {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ");
}

function getReadableText(element: HTMLElement) {
  return normalizeText(
    element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.innerText ||
      element.textContent
  );
}

function hasInteractiveRole(element: HTMLElement) {
  const role = element.getAttribute("role");
  return role === "button" || role === "link" || role === "tab" || role === "menuitem";
}

function isSemanticInteractiveElement(element: HTMLElement) {
  return (
    element.matches(SEMANTIC_INTERACTIVE_SELECTOR) ||
    element instanceof HTMLAnchorElement ||
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

function hasActionableBehavior(element: HTMLElement) {
  return (
    isSemanticInteractiveElement(element) ||
    hasInteractiveRole(element) ||
    element.tabIndex >= 0 ||
    element.isContentEditable ||
    element.hasAttribute("onclick") ||
    typeof (element as HTMLElement & { onclick?: unknown }).onclick === "function"
  );
}

function hasNestedInteractiveDescendant(element: HTMLElement) {
  return Array.from(element.querySelectorAll<HTMLElement>(INTERACTIVE_CANDIDATE_SELECTOR)).some(
    (candidate) => candidate !== element && hasActionableBehavior(candidate)
  );
}

function isGenericContainer(element: HTMLElement) {
  return ["div", "span", "li", "ul", "nav", "section", "article"].includes(
    element.tagName.toLowerCase()
  );
}

function isActionableElement(element: HTMLElement) {
  if (!hasActionableBehavior(element)) {
    return false;
  }

  if (
    !isSemanticInteractiveElement(element) &&
    !hasInteractiveRole(element) &&
    element.tabIndex < 0 &&
    !element.hasAttribute("onclick")
  ) {
    return false;
  }

  if (isGenericContainer(element) && hasNestedInteractiveDescendant(element)) {
    return false;
  }

  if (
    isGenericContainer(element) &&
    !hasInteractiveRole(element) &&
    !element.hasAttribute("onclick") &&
    !isSemanticInteractiveElement(element) &&
    getReadableText(element).length > 80
  ) {
    return false;
  }

  return true;
}

function buildTargetRecord(
  element: HTMLElement,
  targetId: string,
  kind?: InteractionTarget["kind"],
  role?: string | null
) {
  const rect = element.getBoundingClientRect();
  element.setAttribute(TARGET_ID_ATTR, targetId);
  ensureElementId(element);
  return {
    id: targetId,
    name: getElementLabel(element) || getReadableText(element) || element.tagName.toLowerCase(),
    role: role ?? element.getAttribute("role"),
    kind: kind ?? inferTargetKind(element),
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    enabled: !(element as HTMLInputElement).disabled,
    selected:
      element.getAttribute("aria-selected") === "true" ||
      element.getAttribute("aria-current") === "true",
    valueHint:
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? normalizeText(element.value).slice(0, 80) || null
        : null
  } satisfies InteractionTarget;
}

function collectDelegatedChildTargets(element: HTMLElement) {
  if (!isGenericContainer(element) || !hasActionableBehavior(element)) {
    return [];
  }

  const parentRect = element.getBoundingClientRect();
  const descendants = Array.from(element.querySelectorAll<HTMLElement>("*"))
    .filter((candidate) => isVisibleElement(candidate))
    .map((candidate) => ({
      element: candidate,
      label: getReadableText(candidate),
      rect: candidate.getBoundingClientRect()
    }))
    .filter(
      ({ label, rect }) =>
        label.length > 0 &&
        label.length <= 80 &&
        rect.width > 24 &&
        rect.height > 14 &&
        rect.width <= parentRect.width + 4 &&
        rect.height <= Math.max(72, parentRect.height * 0.45)
    )
    .filter(
      ({ rect }) =>
        rect.left >= parentRect.left - 1 &&
        rect.right <= parentRect.right + 1 &&
        rect.top >= parentRect.top - 1 &&
        rect.bottom <= parentRect.bottom + 1
    )
    .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);

  const deduped: HTMLElement[] = [];
  const seen = new Set<string>();
  for (const { element: candidate, label, rect } of descendants) {
    const key = `${label}:${Math.round(rect.top)}:${Math.round(rect.left)}`;
    if (seen.has(key)) {
      continue;
    }
    if (
      deduped.some(
        (existing) =>
          existing.contains(candidate) ||
          candidate.contains(existing) ||
          getReadableText(existing) === label
      )
    ) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped.length >= 2 ? deduped : [];
}

function getElementCenter(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function inferTargetKind(element: HTMLElement): InteractionTarget["kind"] {
  if (element instanceof HTMLAnchorElement || element.getAttribute("role") === "link") {
    return "link";
  }
  if (element instanceof HTMLButtonElement || element.getAttribute("role") === "button") {
    return "button";
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox") {
      return "checkbox";
    }
    if (element.type === "radio") {
      return "radio";
    }
    return "input";
  }
  if (element instanceof HTMLTextAreaElement) {
    return "textarea";
  }
  if (element instanceof HTMLSelectElement) {
    return "select";
  }
  if (element.getAttribute("role") === "tab") {
    return "tab";
  }
  if (element.getAttribute("role") === "menuitem") {
    return "menuitem";
  }
  return "other";
}

function collectInteractionTargets() {
  clearTargetIds();
  const elements = getInteractiveCandidates()
    .filter((element, index, list) => list.indexOf(element) === index)
    .filter((element) => isVisibleElement(element))
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
    });

  const targets: InteractionTarget[] = [];
  for (const element of elements) {
    const delegatedChildren = collectDelegatedChildTargets(element);
    if (delegatedChildren.length > 0) {
      for (const child of delegatedChildren) {
        targets.push(
          buildTargetRecord(
            child,
            `t${targets.length + 1}`,
            inferTargetKind(element),
            element.getAttribute("role")
          )
        );
      }
      continue;
    }

    targets.push(buildTargetRecord(element, `t${targets.length + 1}`));
  }

  return targets;
}

function serializeElement(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    elementId: ensureElementId(element),
    tag:
      element instanceof HTMLInputElement
        ? `input:${element.type || "text"}`
        : element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    label: getElementLabel(element) || null,
    text: normalizeText(element.textContent) || null,
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

export function collectPageSnapshot(): PageSnapshot {
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
    type:
      field instanceof HTMLSelectElement ? "select" : field.type || field.tagName.toLowerCase(),
    value: "value" in field ? field.value : null,
    checked: field instanceof HTMLInputElement ? field.checked : null
  }));
  const textBlocks = Array.from(
    document.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, article, section")
  )
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
  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

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

function collectState() {
  const targets = collectInteractionTargets();
  return {
    targets,
    pageSnapshot: collectPageSnapshot()
  };
}

function lookupTarget(targetId: string) {
  const found = document.querySelector<HTMLElement>(`[${TARGET_ID_ATTR}="${targetId}"]`);
  if (!found) {
    throw new Error(`Target not found: ${targetId}`);
  }
  return found;
}

function findActionableElementAtPoint(x: number, y: number) {
  const stack =
    typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)].filter(Boolean);

  for (const node of stack) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    const targeted = node.closest<HTMLElement>(`[${TARGET_ID_ATTR}]`);
    if (targeted) {
      return targeted;
    }
    const actionable = node.closest<HTMLElement>(INTERACTIVE_CANDIDATE_SELECTOR);
    if (actionable && isActionableElement(actionable)) {
      return actionable;
    }
  }

  return null;
}

function buildActionFeedback(
  toolName: ActionFeedback["toolName"],
  target: HTMLElement | null,
  point?: { x: number; y: number } | null,
  partial?: Partial<ActionFeedback>
): ActionFeedback {
  return {
    toolName,
    targetId: target?.getAttribute(TARGET_ID_ATTR) ?? partial?.targetId ?? null,
    point: point ?? partial?.point ?? null,
    resolvedTag: target?.tagName.toLowerCase() ?? partial?.resolvedTag ?? null,
    resolvedRole: target?.getAttribute("role") ?? partial?.resolvedRole ?? null,
    resolvedLabel: target ? getElementLabel(target) || null : partial?.resolvedLabel ?? null,
    usedFallback: partial?.usedFallback ?? false,
    navigationOccurred: partial?.navigationOccurred ?? false
  };
}

function buildToolResult(
  message: string,
  options: {
    data?: unknown;
    actionFeedback?: ActionFeedback;
  } = {}
): ToolResult {
  const state = collectState();
  return {
    ...buildSuccess(message, options.data, state.pageSnapshot),
    targets: state.targets,
    actionFeedback: options.actionFeedback
  };
}

async function runClickInSameTab(target: HTMLElement, x: number, y: number) {
  const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
  const previousTarget = anchor?.getAttribute("target");
  let restoreTarget = false;
  if (anchor && previousTarget === "_blank") {
    anchor.setAttribute("target", "_self");
    restoreTarget = true;
  }

  const previousWindowOpen = window.open;
  window.open = ((url?: string | URL | undefined) => {
    if (typeof url === "string" && url) {
      window.location.assign(url);
    } else if (url instanceof URL) {
      window.location.assign(url.toString());
    }
    return window;
  }) as typeof window.open;

  try {
    target.focus?.();
    dispatchMouseSequence(target, x, y);
    if ("click" in target && typeof target.click === "function") {
      target.click();
    }
  } finally {
    window.open = previousWindowOpen;
    if (anchor && restoreTarget) {
      if (previousTarget == null) {
        anchor.removeAttribute("target");
      } else {
        anchor.setAttribute("target", previousTarget);
      }
    }
  }
}

function getTargetPoint(target: HTMLElement) {
  const center = getElementCenter(target);
  return {
    x: center.x,
    y: center.y
  };
}

async function clickTarget(targetId: string) {
  const target = lookupTarget(targetId);
  const point = getTargetPoint(target);
  const previousUrl = window.location.href;
  await runClickInSameTab(target, point.x, point.y);
  await waitForPaint();
  return buildToolResult("Clicked target.", {
    actionFeedback: buildActionFeedback("click_target", target, point, {
      navigationOccurred: previousUrl !== window.location.href
    })
  });
}

async function clickCoords(x: number, y: number) {
  const target = findActionableElementAtPoint(x, y);
  if (!(target instanceof HTMLElement)) {
    throw new Error(`No target found at (${Math.round(x)}, ${Math.round(y)}).`);
  }
  const previousUrl = window.location.href;
  const point =
    target.hasAttribute(TARGET_ID_ATTR) || isActionableElement(target)
      ? getTargetPoint(target)
      : { x, y };
  await runClickInSameTab(target, point.x, point.y);
  await waitForPaint();
  return buildToolResult("Clicked coordinates.", {
    actionFeedback: buildActionFeedback("click_coords", target, point, {
      usedFallback: true,
      navigationOccurred: previousUrl !== window.location.href
    })
  });
}

async function typeTarget(targetId: string, text: string, append: boolean) {
  const target = lookupTarget(targetId);
  if (
    !(target instanceof HTMLInputElement) &&
    !(target instanceof HTMLTextAreaElement) &&
    !(target instanceof HTMLElement && target.isContentEditable)
  ) {
    throw new Error(`Target is not editable: ${targetId}`);
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.focus();
    target.value = append ? `${target.value}${text}` : text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    target.focus();
    target.textContent = append ? `${target.textContent ?? ""}${text}` : text;
    target.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
    );
  }

  await waitForPaint();
  return buildToolResult("Updated target value.", {
    actionFeedback: buildActionFeedback("type_target", target, getTargetPoint(target))
  });
}

async function setCheckboxTarget(targetId: string, checked: boolean) {
  const target = lookupTarget(targetId);
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
    throw new Error(`Target is not a checkbox: ${targetId}`);
  }
  target.focus();
  target.checked = checked;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForPaint();
  return buildToolResult("Updated checkbox state.", {
    actionFeedback: buildActionFeedback(
      "set_checkbox_target",
      target,
      getTargetPoint(target)
    )
  });
}

async function selectOptionTarget(targetId: string, valueOrLabel: string) {
  const target = lookupTarget(targetId);
  if (!(target instanceof HTMLSelectElement)) {
    throw new Error(`Target is not a select element: ${targetId}`);
  }

  const option = Array.from(target.options).find(
    (item) =>
      item.value === valueOrLabel ||
      item.label.toLowerCase() === valueOrLabel.toLowerCase()
  );
  if (!option) {
    throw new Error(`Option not found: ${valueOrLabel}`);
  }

  target.focus();
  target.value = option.value;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForPaint();
  return buildToolResult("Updated selected option.", {
    actionFeedback: buildActionFeedback(
      "select_option_target",
      target,
      getTargetPoint(target)
    )
  });
}

async function scrollViewport(directionOrPixels: "up" | "down" | "top" | "bottom" | number) {
  if (typeof directionOrPixels === "number") {
    window.scrollBy({ top: directionOrPixels, behavior: "smooth" });
  } else {
    const map = {
      up: -window.innerHeight * 0.8,
      down: window.innerHeight * 0.8,
      top: -window.scrollY,
      bottom: document.body.scrollHeight
    };
    window.scrollBy({ top: map[directionOrPixels], behavior: "smooth" });
  }
  await waitForIdle(250);
  return buildToolResult("Scrolled viewport.", {
    actionFeedback: {
      toolName: "scroll_viewport",
      targetId: null,
      point: null,
      resolvedTag: null,
      resolvedRole: null,
      resolvedLabel: null,
      usedFallback: false,
      navigationOccurred: false
    }
  });
}

async function pressKey(key: string) {
  const target =
    document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const eventInit = {
    key,
    bubbles: true,
    cancelable: true
  } satisfies KeyboardEventInit;

  const proceed = target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
  target.dispatchEvent(new KeyboardEvent("keyup", eventInit));

  if (proceed && key === "Enter") {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.form?.requestSubmit();
    } else if (target instanceof HTMLButtonElement) {
      target.click();
    }
  }

  await waitForPaint();
  return buildToolResult(`Pressed ${key}.`, {
    actionFeedback: buildActionFeedback("press_key", target, null)
  });
}

async function inspectTarget(targetId: string) {
  const target = lookupTarget(targetId);
  const data = {
    html: target.outerHTML,
    text: target.innerText,
    value:
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
        ? target.value
        : null,
    selectorHints: [cssPathFor(target), target.id ? `#${target.id}` : ""].filter(Boolean)
  };
  return buildToolResult("Inspected target.", { data });
}

async function extractText(query?: string) {
  const text = document.body.innerText;
  const lines = query
    ? text
        .split("\n")
        .filter((line) => line.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 30)
    : text.split("\n").slice(0, 60);
  return buildToolResult("Extracted page text.", {
    data: {
      lines
    }
  });
}

async function waitForCondition(
  condition: { kind: "url_includes" | "selector_exists" | "text_includes"; value: string },
  timeoutMs: number
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (matchesCondition(condition.kind, condition.value)) {
      return buildToolResult("Wait condition satisfied.");
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return buildFailure("wait_timeout", "Timed out waiting for page condition.");
}

export async function runPageTool(toolName: BrowserToolName, args: unknown) {
  try {
    switch (toolName) {
      case "get_page_snapshot":
        return buildToolResult("Collected page snapshot.");
      case "click_target": {
        const parsed = validateToolArgs("click_target", args);
        return await clickTarget(parsed.targetId);
      }
      case "click_coords": {
        const parsed = validateToolArgs("click_coords", args);
        return await clickCoords(parsed.x, parsed.y);
      }
      case "type_target": {
        const parsed = validateToolArgs("type_target", args);
        return await typeTarget(parsed.targetId, parsed.text, parsed.append);
      }
      case "set_checkbox_target": {
        const parsed = validateToolArgs("set_checkbox_target", args);
        return await setCheckboxTarget(parsed.targetId, parsed.checked);
      }
      case "select_option_target": {
        const parsed = validateToolArgs("select_option_target", args);
        return await selectOptionTarget(parsed.targetId, parsed.valueOrLabel);
      }
      case "scroll_viewport": {
        const parsed = validateToolArgs("scroll_viewport", args);
        return await scrollViewport(parsed.directionOrPixels);
      }
      case "press_key": {
        const parsed = validateToolArgs("press_key", args);
        return await pressKey(parsed.key);
      }
      case "wait_for": {
        const parsed = validateToolArgs("wait_for", args);
        return await waitForCondition(parsed.condition, parsed.timeoutMs);
      }
      case "inspect_target": {
        const parsed = validateToolArgs("inspect_target", args);
        return await inspectTarget(parsed.targetId);
      }
      case "extract_text": {
        const parsed = validateToolArgs("extract_text", args);
        return await extractText(parsed.query);
      }
      case "get_navigation_state":
        return buildToolResult("Collected navigation state.", {
          data: {
            url: window.location.href,
            title: document.title,
            historyLength: window.history.length
          }
        });
      case "go_back":
        return buildFailure("background_only", "go_back must run in the background script.");
    }
  } catch (error) {
    const state = collectState();
    return {
      ...buildFailure(
        "tool_failed",
        error instanceof Error ? error.message : String(error)
      ),
      targets: state.targets,
      pageSnapshot: state.pageSnapshot
    } satisfies ToolResult;
  }
}

function dispatchMouseSequence(target: HTMLElement, x: number, y: number) {
  const mouseInit = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y
  } satisfies MouseEventInit;

  target.dispatchEvent(new MouseEvent("pointerdown", mouseInit));
  target.dispatchEvent(new MouseEvent("mousedown", mouseInit));
  target.dispatchEvent(new MouseEvent("pointerup", mouseInit));
  target.dispatchEvent(new MouseEvent("mouseup", mouseInit));
  target.dispatchEvent(new MouseEvent("click", mouseInit));
}

function matchesCondition(kind: "url_includes" | "selector_exists" | "text_includes", value: string) {
  switch (kind) {
    case "url_includes":
      return window.location.href.includes(value);
    case "selector_exists":
      return Boolean(document.querySelector(value));
    case "text_includes":
      return document.body.innerText.toLowerCase().includes(value.toLowerCase());
  }
}

async function waitForPaint() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await waitForIdle(80);
}

async function waitForIdle(timeoutMs: number) {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
