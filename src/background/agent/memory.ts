// Working memory for one run: the model's plan and notes survive while old
// page snapshots are dropped from context. Also the loop guard and the
// compaction that keeps each planner request small.

import type { PageSnapshot } from "../../shared/types";
import type { ConversationMessage } from "../providers/types";

const MAX_NOTES = 30;
const MAX_NOTE_CHARS = 300;
const MAX_PLAN_CHARS = 1500;

export const MEMORY_START = "\n\n--- Working memory (your plan and notes) ---";
const MEMORY_BLOCK = /\n\n--- Working memory \(your plan and notes\) ---[\s\S]*?--- End working memory ---/g;
const PAGE_BLOCK = /\n\n--- Page after this action[\s\S]*$/;
/** Marker the loop puts before the starting page in the first user message. */
export const INITIAL_PAGE = "\n\n--- Current page ---\n";

/** Tools the loop handles itself; they never touch the page. */
export const MEMORY_TOOLS = new Set(["note", "update_plan"]);

export class WorkingMemory {
  plan = "";
  notes: string[] = [];

  /** Apply a note/update_plan call and return the tool result text. */
  apply(name: string, input: Record<string, unknown>): { ok: boolean; detail: string } {
    if (name === "update_plan") {
      const plan = String(input.plan ?? "").trim();
      if (!plan) return { ok: false, detail: "plan must be a non-empty checklist." };
      this.plan = plan.slice(0, MAX_PLAN_CHARS);
      return { ok: true, detail: "Plan saved. It stays visible in working memory." };
    }
    const text = String(input.text ?? "").trim();
    if (!text) return { ok: false, detail: "text must not be empty." };
    this.notes.push(text.slice(0, MAX_NOTE_CHARS));
    if (this.notes.length > MAX_NOTES) this.notes.shift();
    return { ok: true, detail: `Noted (${this.notes.length} note${this.notes.length === 1 ? "" : "s"} kept).` };
  }

  isEmpty(): boolean {
    return !this.plan && this.notes.length === 0;
  }

  /** The block appended to the newest tool result, or "" when there is nothing to show. */
  format(): string {
    if (this.isEmpty()) return "";
    const parts = [MEMORY_START];
    if (this.plan) parts.push(`Plan:\n${this.plan}`);
    if (this.notes.length > 0) parts.push(`Notes:\n${this.notes.map((n) => `- ${n}`).join("\n")}`);
    parts.push("--- End working memory ---");
    return parts.join("\n");
  }
}

/** One-line stand-in for a dropped page snapshot, so the model keeps a trail of where it has been. */
export function summarizePageBlock(block: string): string {
  const url = block.match(/\nURL: ([^\n]*)/)?.[1]?.trim();
  const title = block.match(/\nTitle: ([^\n]*)/)?.[1]?.trim();
  if (!url && !title) return "\n\n[Earlier page snapshot omitted]";
  return `\n\n[Earlier page snapshot omitted: ${[title, url].filter(Boolean).join(" — ")}]`;
}

/** True when a tool result carries a fresh page read. */
export function hasPageBlock(content: string): boolean {
  return PAGE_BLOCK.test(content);
}

/**
 * Before a new step is appended: drop old working memory blocks and, when the
 * new step carries a fresh page read, the old page snapshots too, so only the
 * newest state is sent. Without a fresh read the last page must stay visible.
 */
export function compactHistory(messages: ConversationMessage[], dropPages = true): void {
  for (const message of messages) {
    if (message.role === "user") {
      if (!dropPages) continue;
      // The task message carries the starting page; after the first step it is stale.
      const start = message.content.indexOf(INITIAL_PAGE);
      if (start >= 0) message.content = message.content.slice(0, start) + summarizePageBlock(message.content.slice(start));
      continue;
    }
    if (message.role !== "tool") continue;
    for (const result of message.results) {
      let content = result.content.replace(MEMORY_BLOCK, "");
      const page = dropPages ? content.match(PAGE_BLOCK) : null;
      if (page) content = content.slice(0, page.index) + summarizePageBlock(page[0]);
      result.content = content;
    }
  }
}

/** Cheap fingerprint of what the page looks like, for loop detection. */
export function pageFingerprint(snapshot: PageSnapshot | null | undefined): string {
  if (!snapshot) return "none";
  const source = [
    snapshot.url,
    snapshot.scroll.y,
    snapshot.elements.length,
    ...snapshot.elements.slice(0, 25).map((e) => `${e.role}:${e.name}:${e.value ?? ""}`),
    snapshot.text.slice(0, 300),
  ].join("|");
  let hash = 5381;
  for (let i = 0; i < source.length; i++) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * A call only counts as a repeat when both the call and the page it ran on
 * are unchanged. Scrolling a long list three times is progress, not a loop;
 * scrolling at the bottom of the page three times is.
 */
export class LoopGuard {
  private recent: { key: string; name: string }[] = [];

  constructor(
    private readonly repeatLimit = 3,
    private readonly window = 6,
  ) {}

  remember(name: string, input: unknown, pageState: string): void {
    this.recent.push({ name, key: `${name}|${JSON.stringify(input)}|${pageState}` });
    if (this.recent.length > this.window) this.recent.shift();
  }

  lastName(): string {
    return this.recent[this.recent.length - 1]?.name ?? "";
  }

  isLooping(): boolean {
    const calls = this.recent;
    if (calls.length < this.repeatLimit) return false;
    const last = calls[calls.length - 1].key;
    let repeats = 0;
    for (let i = calls.length - 1; i >= 0 && calls[i].key === last; i--) repeats++;
    if (repeats >= this.repeatLimit) return true;
    if (calls.length >= 4) {
      const [d, c, b, a] = calls.slice(-4).map((call) => call.key);
      // A-B-A-B ping-pong on unchanged pages.
      if (a === c && b === d && a !== b) return true;
    }
    return false;
  }
}
