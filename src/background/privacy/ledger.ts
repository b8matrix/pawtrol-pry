// Tamper-evident privacy ledger: every snapshot, detection, tokenization,
// redaction, action and verification is appended as a SHA-256 hash chain in
// chrome.storage.local. Entries hold counts and kinds only — never values.

import { readLocal } from "../storage";

const LEDGER_KEY = "pry-privacy-ledger";
const MAX_ENTRIES = 500;
const GENESIS_HASH = "0".repeat(64);

export type LedgerEntryType =
  | "snapshot"
  | "detection"
  | "tokenize"
  | "redact"
  | "action"
  | "verification"
  | "egress-block";

export interface LedgerEntry {
  seq: number;
  timestamp: number;
  type: LedgerEntryType;
  data: Record<string, unknown>;
  hash: string;
  prevHash: string;
}

interface LedgerState {
  entries: LedgerEntry[];
  entryCounter: number;
  lastHash: string;
}

// Appends are serialized so concurrent writers cannot fork the chain.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

async function loadLedger(): Promise<LedgerState> {
  const stored = await readLocal<LedgerState>(LEDGER_KEY);
  return stored && Array.isArray(stored.entries)
    ? stored
    : { entries: [], entryCounter: 0, lastHash: GENESIS_HASH };
}

async function saveLedger(state: LedgerState): Promise<void> {
  if (state.entries.length > MAX_ENTRIES) state.entries = state.entries.slice(state.entries.length - MAX_ENTRIES);
  await chrome.storage.local.set({ [LEDGER_KEY]: state });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function append(type: LedgerEntryType, data: Record<string, unknown>): Promise<LedgerEntry> {
  return serialized(async () => {
    const state = await loadLedger();
    const seq = state.entryCounter + 1;
    const timestamp = Date.now();
    const hash = await sha256Hex(JSON.stringify({ seq, timestamp, type, data, prevHash: state.lastHash }));
    const entry: LedgerEntry = { seq, timestamp, type, data, hash, prevHash: state.lastHash };
    state.lastHash = hash;
    state.entryCounter = seq;
    state.entries.push(entry);
    await saveLedger(state);
    return entry;
  });
}

/** The egress gate stopped a request. Labels and a count only, never values. */
export function logEgressBlock(labels: string[]) {
  return append("egress-block", { labels: [...new Set(labels)], count: labels.length });
}

export function logSnapshot(url: string, title: string, elementCount: number) {
  return append("snapshot", { url, title, elementCount });
}

export function logDetections(detections: { kind: string; method?: string }[]) {
  return append("detection", {
    count: detections.length,
    kinds: [...new Set(detections.map((d) => d.kind))],
    methods: [...new Set(detections.map((d) => d.method))],
  });
}

export function logTokenization(tokens: { kind: string }[]) {
  return append("tokenize", { count: tokens.length, tokenTypes: [...new Set(tokens.map((t) => t.kind))] });
}

export function logRedaction(redactedCount: number, method: string) {
  return append("redact", { redactedCount, method });
}

export function logAction(tool: string, success: boolean, elementId?: number) {
  return append("action", { tool, success, elementId });
}

export function logVerification(passed: boolean, regionsChecked: number, leakedCount: number, extra?: Record<string, unknown>) {
  return append("verification", { passed, regionsChecked, leakedCount, ...extra });
}

export interface LedgerSummary {
  totalEntries: number;
  chainValid: boolean;
  totalSnapshots: number;
  totalDetections: number;
  totalRedactions: number;
  totalActions: number;
  lastEntryType: LedgerEntryType | null;
}

/**
 * Summarize the ledger. Only prevHash linkage is checked here; hashes are not
 * recomputed. (Trimming to MAX_ENTRIES also breaks linkage at the head once
 * the cap is reached — matches the legacy behavior.)
 */
export async function getLedgerSummary(): Promise<LedgerSummary> {
  const { entries } = await loadLedger();
  let snapshots = 0;
  let detections = 0;
  let redactions = 0;
  let actions = 0;
  let chainValid = true;
  let expectedPrev = GENESIS_HASH;
  for (const entry of entries) {
    if (entry.prevHash !== expectedPrev) chainValid = false;
    switch (entry.type) {
      case "snapshot":
        snapshots++;
        break;
      case "detection":
        detections += Number(entry.data.count ?? 0);
        break;
      case "redact":
        redactions += Number(entry.data.redactedCount ?? 0);
        break;
      case "action":
        actions++;
        break;
    }
    expectedPrev = entry.hash;
  }
  return {
    totalEntries: entries.length,
    chainValid,
    totalSnapshots: snapshots,
    totalDetections: detections,
    totalRedactions: redactions,
    totalActions: actions,
    lastEntryType: entries.length > 0 ? entries[entries.length - 1].type : null,
  };
}
