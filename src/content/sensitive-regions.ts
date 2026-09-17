// Screen-space boxes of sensitive UI (credential inputs and their labels, any
// non-search text input, ID numbers in text, avatar images). The offscreen
// document masks these on the screenshot before any model can see it.

import { isLuhnValid, isValidAadhaar } from "../shared/checksums";
import type { SensitiveRegion } from "../shared/types";
import { isVisible } from "./snapshot";

const CREDENTIAL_INPUTS = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-exp"]',
  'input[autocomplete="cc-csc"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="card"]',
  'input[name*="credit"]',
  'input[name*="cvv"]',
  'input[name*="cvc"]',
  'input[name*="aadhaar"]',
  'input[name*="pan"]',
  'input[name*="ssn"]',
  'input[name*="passport"]',
  'input[name*="apikey"]',
  'input[name*="api_key"]',
  'input[name*="secret"]',
  'input[name*="otp"]',
].join(",");

const TEXT_INPUTS = [
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="image"]):not([type="date"])',
  "textarea",
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"] input',
].join(",");

const AVATAR_IMAGES =
  'img[src*="avatar"], img[src*="profile"], img[src*="photo"], img[alt*="profile"], img[alt*="avatar"], [role="img"][aria-label*="profile"], [role="img"][aria-label*="avatar"]';

const ID_TEXT_PATTERNS: RegExp[] = [
  /\b\d{4}\s?\d{4}\s?\d{4}\b/,
  /\b[A-Z]{5}\d{4}[A-Z]\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  /\b[A-Z]{2}\d{6,8}\b/,
];

function box(rect: DOMRect) {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function credentialKind(input: HTMLInputElement): string {
  if (input.type === "password") return "password";
  const autocomplete = input.autocomplete ?? "";
  if (autocomplete.includes("cc-")) return "credit_card";
  if (autocomplete.includes("one-time")) return "otp";
  const name = (input.name ?? "").toLowerCase();
  if (name.includes("aadhaar") || name.includes("ssn") || name.includes("passport")) return "id_number";
  if (name.includes("pan")) return "pan_card";
  if (name.includes("cvv") || name.includes("cvc")) return "cvv";
  if (name.includes("apikey") || name.includes("api_key") || name.includes("secret") || name.includes("token")) {
    return "api_key";
  }
  return "credential";
}

function labelElement(element: Element): HTMLElement | null {
  const input = element as HTMLInputElement;
  if (input.id) {
    const byFor = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (byFor instanceof HTMLElement) return byFor;
  }
  const wrapping = element.closest("label");
  if (wrapping instanceof HTMLElement) return wrapping;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const target = document.getElementById(id);
      if (target instanceof HTMLElement) return target;
    }
  }
  const previous = element.previousElementSibling;
  return previous instanceof HTMLElement && previous.textContent?.trim() ? previous : null;
}

function describe(element: Element, fallback: string): string {
  const name = (element as HTMLInputElement).name ?? "";
  return (labelElement(element)?.textContent?.trim() ?? "") || name || fallback;
}

/** On-screen text nodes containing an ID-shaped number (checksum lookalikes skipped). */
function idNumbersInText(patterns: RegExp[]): SensitiveRegion[] {
  const regions: SensitiveRegion[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    if (text.length < 8) continue;
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match || match.index === undefined) continue;
      const digits = match[0].replace(/\D/g, "");
      if ((digits.length === 12 && !isValidAadhaar(digits)) || (digits.length === 16 && !isLuhnValid(digits))) continue;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = range.getBoundingClientRect();
      range.detach();
      if (rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0) {
        regions.push({ ...box(rect), kind: "id_text", label: `ID number in text: ${match[0].slice(0, 8)}...` });
      }
      // One region per text node.
      break;
    }
  }
  return regions;
}

export function findSensitiveRegions(): SensitiveRegion[] {
  const regions: SensitiveRegion[] = [];
  const covered = new Set<Element>();

  for (const element of Array.from(document.querySelectorAll(CREDENTIAL_INPUTS))) {
    if (!isVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    covered.add(element);
    const kind = credentialKind(element as HTMLInputElement);
    regions.push({ ...box(rect), kind, label: describe(element, kind) });

    const label = labelElement(element);
    if (label && !covered.has(label)) {
      const labelRect = label.getBoundingClientRect();
      if (labelRect.width > 0 && labelRect.height > 0) {
        covered.add(label);
        regions.push({ ...box(labelRect), kind: "credential_label", label: `Label for ${kind}` });
      }
    }
  }

  // Any other text input except search boxes: user-entered text is presumed personal.
  for (const element of Array.from(document.querySelectorAll(TEXT_INPUTS))) {
    if (covered.has(element) || !isVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 5) continue;
    const input = element as HTMLInputElement;
    const name = input.name?.toLowerCase() ?? "";
    const placeholder = input.placeholder?.toLowerCase() ?? "";
    const role = element.getAttribute("role")?.toLowerCase() ?? "";
    const isSearch = name.includes("search") || name === "q" || placeholder.includes("search") || role === "searchbox";
    if (isSearch) continue;
    covered.add(element);
    regions.push({ ...box(rect), kind: "input_field", label: describe(element, "input_field") });
  }

  regions.push(...idNumbersInText(ID_TEXT_PATTERNS));

  for (const element of Array.from(document.querySelectorAll(AVATAR_IMAGES))) {
    if (!isVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) continue;
    const aspect = rect.width / rect.height;
    if (aspect < 0.5 || aspect > 2) continue;
    covered.add(element);
    regions.push({ ...box(rect), kind: "face", label: "Profile/avatar image" });
  }
  return regions;
}
