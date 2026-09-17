// Builds the element list the planner sees. Each kept element is stored in
// `registry` so later actions can address it by numeric id.

import { stripInvisible } from "../shared/text";
import type { ElementAttrs, PageElement, PageSnapshot } from "../shared/types";

const MAX_ELEMENTS = 80;
const MAX_LABEL_CHARS = 60;
const MAX_TEXT_CHARS = 2000;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable=''],[contenteditable=true]",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=switch]",
  "[role=combobox]",
  "[role=searchbox]",
  "[role=textbox]",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"],[aria-modal="true"]';

let registry: Element[] = [];

export function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(element);
  return !(style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.05);
}

function clean(text: string | null | undefined): string {
  if (!text) return "";
  // Zero-width characters can split an identifier past every detector.
  const collapsed = stripInvisible(text).replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LABEL_CHARS ? `${collapsed.slice(0, MAX_LABEL_CHARS)}…` : collapsed;
}

export function isTextInput(element: Element): boolean {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element.hasAttribute("contenteditable")
  )
    return true;
  const role = element.getAttribute("role");
  return role === "textbox" || role === "searchbox" || role === "combobox" || role === "password";
}

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (clean(text)) return clean(text);
  }
  const ariaLabel = clean(element.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const labels = element.labels;
    if (labels && labels.length > 0) {
      const label = clean(labels[0].textContent);
      if (label) return label;
    }
    const placeholder = clean(element.getAttribute("placeholder"));
    if (placeholder) return placeholder;
  }
  if (element instanceof HTMLImageElement) {
    const alt = clean(element.alt);
    if (alt) return alt;
  }
  const text = clean((element as HTMLElement).innerText ?? element.textContent);
  if (text) return text;
  const title = clean(element.getAttribute("title") || element.getAttribute("name"));
  if (title) return title;
  if (isTextInput(element)) {
    const nearby = nearbyLabel(element);
    if (nearby) return nearby;
  }
  return "";
}

/** For unlabeled inputs: a short preceding sibling, a short ancestor, or the closest label-like text to the left/above. */
function nearbyLabel(element: Element): string {
  const previous = element.previousElementSibling;
  if (previous instanceof HTMLElement) {
    const text = clean(previous.innerText ?? previous.textContent ?? "");
    if (text && text.length <= 40) return text;
  }
  let ancestor = element.parentElement;
  for (let depth = 0; depth < 3 && ancestor; depth++) {
    const text = clean(ancestor.innerText ?? "");
    if (!text) {
      ancestor = ancestor.parentElement;
      continue;
    }
    if (text.length <= 60) return text;
    ancestor = ancestor.parentElement;
  }
  try {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const candidates = document.querySelectorAll("label, span, p, div, th, dt");
      let bestDistance = 120;
      let best = "";
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i] as HTMLElement;
        if (candidate === element || candidate.contains(element)) continue;
        const text = clean(candidate.innerText ?? "");
        if (!text || text.length > 45 || text.length < 2) continue;
        const box = candidate.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const leftOf = box.right <= rect.left && box.bottom >= rect.top - 10 && box.top <= rect.bottom + 10;
        const above = box.bottom <= rect.top && box.right >= rect.left - 20 && box.left <= rect.right + 20;
        if (leftOf || above) {
          const dx = leftOf ? rect.left - box.right : Math.abs(rect.left - box.left);
          const dy = above ? rect.top - box.bottom : Math.abs(rect.top - box.top);
          const distance = Math.hypot(dx, dy);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = text;
          }
        }
      }
      if (best) return best;
    }
  } catch {}
  return "";
}

function roleOf(element: Element): string {
  const role = element.getAttribute("role");
  if (role) return role;
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (element as HTMLInputElement).type;
    if (type === "checkbox" || type === "radio" || type === "submit") return type;
    return type === "password" ? "password" : "textbox";
  }
  return element.hasAttribute("contenteditable") ? "textbox" : tag;
}

function attributesOf(element: Element): ElementAttrs | undefined {
  const attrs: ElementAttrs = {};
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") attrs.checked = String(element.checked);
    if (element.required) attrs.required = "true";
    attrs.inputType = element.type;
  }
  if ((element as HTMLInputElement).disabled) attrs.disabled = "true";
  const expanded = element.getAttribute("aria-expanded");
  if (expanded) attrs.expanded = expanded;
  const selected = element.getAttribute("aria-selected");
  if (selected) attrs.selected = selected;
  if (element instanceof HTMLAnchorElement && element.href) {
    try {
      const url = new URL(element.href);
      // Host + short path only: query strings often carry personal data.
      attrs.href = url.host + (url.pathname === "/" ? "" : url.pathname.slice(0, 40));
    } catch {}
  }
  const rect = element.getBoundingClientRect();
  if (!(rect.top < innerHeight && rect.bottom > 0)) attrs.offscreen = "true";
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function valueOf(element: Element): string | undefined {
  if (element instanceof HTMLInputElement) {
    if (element.type === "password") return element.value ? "••••••" : "";
    if (element.type === "checkbox" || element.type === "radio") return undefined;
    return clean(element.value);
  }
  if (element instanceof HTMLTextAreaElement) return clean(element.value);
  if (element instanceof HTMLSelectElement) return clean(element.selectedOptions[0]?.textContent ?? element.value);
  return undefined;
}

function mainText(): string {
  const root =
    document.querySelector("main") ??
    document.querySelector("[role=main]") ??
    document.querySelector("article") ??
    document.body;
  const fallback = clean(root.innerText ?? "");
  const text = stripInvisible(root.innerText ?? "").replace(/\s*\n\s*/g, "\n").trim();
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…[truncated]` : text || fallback;
}

const inViewport = (rect: DOMRect) => rect.top < innerHeight && rect.bottom > 0;

export function takeSnapshot(): PageSnapshot {
  registry = [];
  const elements: PageElement[] = [];
  // Order: on-screen first, then dialogs, then text inputs, then reading order.
  const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))
    .filter(isVisible)
    .sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const va = inViewport(ra) ? 0 : 1;
      const vb = inViewport(rb) ? 0 : 1;
      if (va !== vb) return va - vb;
      const da = a.closest(DIALOG_SELECTOR) ? 0 : 1;
      const db = b.closest(DIALOG_SELECTOR) ? 0 : 1;
      if (da !== db) return da - db;
      const ia = isTextInput(a) ? 0 : 1;
      const ib = isTextInput(b) ? 0 : 1;
      if (ia !== ib) return ia - ib;
      return ra.top - rb.top || ra.left - rb.left;
    });

  for (const element of candidates) {
    if (elements.length >= MAX_ELEMENTS) break;
    const name = accessibleName(element);
    const role = roleOf(element);
    const value = valueOf(element);
    const fillable = role === "textbox" || role === "select" || role === "combobox" || role === "searchbox" || role === "password";
    if (!name && !value && !fillable) continue;
    const id = registry.push(element) - 1;
    elements.push({ id, role, name, value, attrs: attributesOf(element) });
  }

  return {
    url: location.href,
    title: document.title,
    elements,
    text: mainText(),
    truncated: candidates.length > elements.length,
    scroll: {
      y: Math.round(scrollY),
      maxY: Math.max(0, Math.round(document.body.scrollHeight - innerHeight)),
    },
  };
}

/** The live element for an id from the latest snapshot, if it is still attached. */
export function elementById(id: number): Element | undefined {
  const element = registry[id];
  return element && element.isConnected ? element : undefined;
}
