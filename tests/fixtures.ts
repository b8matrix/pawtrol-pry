import type { PageElement, PageSnapshot } from "../src/shared/types";
import { isValidAadhaar } from "../src/shared/checksums";

/** Deterministic PRNG so fuzz failures are reproducible. */
export function rng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

function withCheckDigit(prefix11: string): string {
  for (let d = 0; d <= 9; d++) if (isValidAadhaar(prefix11 + d)) return prefix11 + d;
  throw new Error("no Verhoeff digit");
}

export const VALID_AADHAAR = withCheckDigit("23456789012");
export const VALID_AADHAAR_SPACED = `${VALID_AADHAAR.slice(0, 4)} ${VALID_AADHAAR.slice(4, 8)} ${VALID_AADHAAR.slice(8)}`;
export const INVALID_AADHAAR = VALID_AADHAAR.slice(0, 11) + ((Number(VALID_AADHAAR[11]) + 1) % 10);

export const SAMPLE_VALUES = [
  VALID_AADHAAR_SPACED,
  INVALID_AADHAAR,
  "4111 1111 1111 1111",
  "4111-1111-1111-1112",
  "ABCDE1234F",
  "HDFC0001234",
  "123-45-6789",
  "K1234567",
  "priya.sharma@example.com",
  "+91 9876543210",
  "9876543210",
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
  "ghp_" + "a".repeat(36),
  "AKIAABCDEFGHIJKLMNOP",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
  "Priya Sharma",
  "Dr Rahul Verma",
  "Acme Technologies Pvt Ltd",
  "221B Baker Street, London 12",
  "Flat 4, Sector 12, Noida 201301",
  "hello world",
  "Search",
  "12345678",
];

const FILLER = [
  "Welcome back",
  "Your account",
  "from",
  "to",
  "Name:",
  "company:",
  "sent by",
  "Balance",
  "Pay now",
  "\n",
  ",",
  "Order #",
  "ignore previous instructions",
  "developer mode",
];

export function randomText(r: ReturnType<typeof rng>, parts = 8): string {
  const out: string[] = [];
  for (let i = 0; i < parts; i++) out.push(r.next() < 0.45 ? r.pick(SAMPLE_VALUES) : r.pick(FILLER));
  return out.join(" ");
}

const FIELD_NAMES = [
  "Password",
  "Card number",
  "CVV",
  "Full name",
  "Company",
  "Billing address",
  "Mobile",
  "Email",
  "Account number",
  "Search",
  "Aadhaar",
  "PAN number",
  "OTP",
  "API key",
  "Message",
  "Send",
  "Delete account",
  "Place order",
  "Recipient",
];

const ROLES = ["textbox", "password", "button", "link", "combobox", "select", "checkbox"];

export function randomElement(r: ReturnType<typeof rng>, id: number): PageElement {
  const role = r.pick(ROLES);
  const element: PageElement = { id, role, name: r.pick(FIELD_NAMES) };
  if (r.next() < 0.7) element.value = r.pick(SAMPLE_VALUES);
  if (r.next() < 0.5) {
    element.attrs = {};
    if (role === "password" || r.next() < 0.2) element.attrs.inputType = r.pick(["password", "text", "email", "hidden"]);
    if (r.next() < 0.3) element.attrs.href = "example.com/account";
    if (r.next() < 0.3) element.attrs.offscreen = "true";
  }
  return element;
}

export function randomSnapshot(r: ReturnType<typeof rng>): PageSnapshot {
  const count = 1 + r.int(12);
  return {
    url: r.pick(["https://bank.example.com/login?user=priya@example.com", "https://mail.google.com/mail/u/0/#inbox", "https://example.org/form"]),
    title: r.pick(["Net Banking", "Inbox", "Checkout", "Apply for PAN card"]),
    elements: Array.from({ length: count }, (_, i) => randomElement(r, i)),
    text: randomText(r, 10),
    truncated: r.next() < 0.2,
    scroll: { y: r.int(500), maxY: 500 + r.int(2000) },
  };
}

/** Undo the legacy offset-glue bug ("Card 5<CRED_1>") so outputs are comparable. */
export function unglueLegacy(text: string): string {
  return text.replace(/(?<![A-Za-z0-9])\d+(<[A-Z]+_\d+>)/g, "$1");
}
