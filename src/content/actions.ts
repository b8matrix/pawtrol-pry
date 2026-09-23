// In-page tool execution. Inputs arrive with tokens already resolved by the
// worker; results go back through the vault's redactValues before any model sees them.

import type { ActionResult, ToolAction, ToolInput } from "../shared/types";
import { elementById, extractText, takeSnapshot } from "./snapshot";

const fail = (detail: string): ActionResult => ({ ok: false, detail });
const succeed = (detail: string): ActionResult => ({ ok: true, detail });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the DOM stops changing: at least minMs, then until no mutation
 * for quietMs, capped at maxMs. Replaces fixed sleeps, which were too long on
 * static pages and too short on slow single-page apps.
 */
function settle(minMs: number, quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    const observer = new MutationObserver(() => {
      last = performance.now();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const tick = () => {
      const now = performance.now();
      if (now - start >= maxMs || (now - start >= minMs && now - last >= quietMs)) {
        observer.disconnect();
        resolve();
        return;
      }
      setTimeout(tick, 40);
    };
    setTimeout(tick, Math.min(minMs, 40));
  });
}

function describeElement(element: Element): string {
  const text = (element as HTMLElement).innerText?.trim().slice(0, 60);
  return `<${element.tagName.toLowerCase()}${text ? ` "${text}"` : ""}>`;
}

function targetOf(input: ToolInput): Element | string {
  const id = input.element_id;
  if (typeof id != "number") return "element_id must be a number";
  return (
    elementById(id) ??
    `No element ${id} on the current page. The page changed since the last read — call read_page and use the new ids.`
  );
}

async function scrollIntoView(element: Element): Promise<void> {
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  await sleep(60);
}

/** Full pointer + mouse sequence; many apps ignore a bare click(). */
function dispatchClick(element: Element): void {
  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    view: window,
  };
  (element as HTMLElement).focus?.({ preventScroll: true });
  element.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mousedown", init));
  element.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mouseup", init));
  element.dispatchEvent(new MouseEvent("click", init));
}

/** Use the native setter so React/Vue controlled inputs notice the change. */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function editableTarget(element: Element): HTMLElement | null {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element.hasAttribute("contenteditable")
  ) {
    return element as HTMLElement;
  }
  const role = element.getAttribute("role");
  if (role === "combobox" || role === "textbox" || role === "searchbox") {
    const inner = element.querySelector(
      "input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable=true]",
    );
    if (inner) return inner as HTMLElement;
  }
  return null;
}

async function typeInto(element: Element, text: string, submit: boolean): Promise<ActionResult> {
  const target = editableTarget(element);
  if (!target) return fail(`${describeElement(element)} is not a text field.`);
  await scrollIntoView(target);
  target.focus({ preventScroll: true });

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    setNativeValue(target, "");
    target.dispatchEvent(new Event("input", { bubbles: true }));
    setNativeValue(target, text);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (target.hasAttribute("contenteditable")) {
    target.textContent = text;
    target.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else {
    return fail(`${describeElement(target)} is not a text field.`);
  }

  if (submit) {
    const init = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    const defaultPrevented = !target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    // Synthetic Enter does not submit forms natively; do it unless the page cancelled the keydown.
    const form = (target as HTMLInputElement).form;
    if (!defaultPrevented && form) form.requestSubmit?.();
    await settle(150, 200, 1200);
  }
  return succeed(`Typed ${JSON.stringify(text)} into ${describeElement(target)}${submit ? " and pressed Enter" : ""}.`);
}

function findVisibleText(query: string): ActionResult {
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const matches: string[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()) && matches.length < 5) {
    const text = node.textContent?.trim();
    if (!text || !text.toLowerCase().includes(needle)) continue;
    const parent = node.parentElement;
    if (parent && parent.offsetParent !== null) matches.push(text.slice(0, 200));
  }
  if (matches.length === 0) return fail(`No visible text matching ${JSON.stringify(query)} on this page.`);
  return succeed(`Found ${matches.length} match(es):\n${matches.map((m) => `- ${m}`).join("\n")}`);
}

export async function performAction(action: ToolAction): Promise<ActionResult> {
  const { name, input } = action;
  try {
    switch (name) {
      case "click": {
        const target = targetOf(input);
        if (typeof target == "string") return fail(target);
        await scrollIntoView(target);
        dispatchClick(target);
        await settle(120, 200, 1000);
        return succeed(`Clicked ${describeElement(target)}.`);
      }
      case "type": {
        const target = targetOf(input);
        if (typeof target == "string") return fail(target);
        return await typeInto(target, typeof input.text == "string" ? input.text : "", input.submit === true);
      }
      case "select": {
        const target = targetOf(input);
        if (typeof target == "string") return fail(target);
        if (!(target instanceof HTMLSelectElement)) return fail(`${describeElement(target)} is not a <select>.`);
        const wanted = String(input.option ?? "");
        const option = Array.from(target.options).find(
          (o) => o.value === wanted || o.textContent?.trim().toLowerCase() === wanted.toLowerCase(),
        );
        if (!option) {
          const available = Array.from(target.options)
            .map((o) => o.textContent?.trim())
            .filter(Boolean)
            .slice(0, 20)
            .join(", ");
          return fail(`No option ${JSON.stringify(wanted)}. Available: ${available}`);
        }
        target.value = option.value;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return succeed(`Selected ${JSON.stringify(option.textContent?.trim())}.`);
      }
      case "scroll": {
        const direction = input.direction === "up" ? -1 : 1;
        const amount = typeof input.amount == "number" ? input.amount : innerHeight * 0.8;
        scrollBy({ top: direction * amount, behavior: "instant" as ScrollBehavior });
        await settle(80, 150, 800);
        const atBottom = scrollY + innerHeight >= document.body.scrollHeight - 4;
        return succeed(
          `Scrolled ${input.direction === "up" ? "up" : "down"}. Now at y=${Math.round(scrollY)}` +
            (atBottom ? " (bottom of page)." : "."),
        );
      }
      case "key": {
        const key = String(input.key ?? "");
        const target = document.activeElement ?? document.body;
        const init = { bubbles: true, cancelable: true, key, code: key };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        await settle(80, 150, 1000);
        return succeed(`Pressed ${key}.`);
      }
      case "find_text":
        return findVisibleText(String(input.query ?? ""));
      case "extract_text": {
        const query = typeof input.query == "string" ? input.query : "";
        const { text, nextOffset, total } = extractText(query, Number(input.offset ?? 0));
        if (!text) return fail(query ? `No text mentioning ${JSON.stringify(query)} on this page.` : "The page has no visible text.");
        const more =
          nextOffset === undefined
            ? ""
            : `
…[${total - nextOffset} more characters; call extract_text with offset=${nextOffset}${query ? " and the same query" : ""}]`;
        return succeed(`Page text${query ? ` mentioning ${JSON.stringify(query)}` : ""}:
${text}${more}`);
      }
      case "wait": {
        const ms = Math.min(Number(input.ms ?? 1000), 10_000);
        await sleep(ms);
        return succeed(`Waited ${ms}ms.`);
      }
      case "read_page": {
        const snapshot = takeSnapshot({
          filter: typeof input.filter == "string" ? input.filter : undefined,
          offset: typeof input.offset == "number" ? input.offset : undefined,
          limit: typeof input.limit == "number" ? input.limit : undefined,
        });
        const filtered = typeof input.filter == "string" && input.filter.trim() !== "";
        if (filtered && snapshot.elements.length === 0) {
          return { ok: false, detail: `No element labelled with ${JSON.stringify(input.filter)}. Try a shorter or different word.`, snapshot };
        }
        return { ok: true, detail: "Read the page.", snapshot };
      }
      default:
        return fail(`Action ${name} is not handled in the page context.`);
    }
  } catch (error) {
    return fail(`${name} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
