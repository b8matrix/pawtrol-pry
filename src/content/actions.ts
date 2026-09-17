// In-page tool execution. Inputs arrive with tokens already resolved by the
// worker; results go back through the vault's redactValues before any model sees them.

import type { ActionResult, ToolAction, ToolInput } from "../shared/types";
import { elementById, takeSnapshot } from "./snapshot";

const fail = (detail: string): ActionResult => ({ ok: false, detail });
const succeed = (detail: string): ActionResult => ({ ok: true, detail });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await sleep(400);
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
        await sleep(500);
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
        await sleep(300);
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
        await sleep(200);
        return succeed(`Pressed ${key}.`);
      }
      case "find_text":
        return findVisibleText(String(input.query ?? ""));
      case "wait": {
        const ms = Math.min(Number(input.ms ?? 1000), 10_000);
        await sleep(ms);
        return succeed(`Waited ${ms}ms.`);
      }
      case "read_page":
        return { ok: true, detail: "Read the page.", snapshot: takeSnapshot() };
      default:
        return fail(`Action ${name} is not handled in the page context.`);
    }
  } catch (error) {
    return fail(`${name} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
