import { describe, expect, test } from "vitest";
import { LoopGuard, WorkingMemory, compactHistory, pageFingerprint, summarizePageBlock } from "../src/background/agent/memory";
import { READ_ONLY_TOOLS, TOOLS } from "../src/background/agent/tools";
import type { ConversationMessage } from "../src/background/providers/types";
import type { PageSnapshot } from "../src/shared/types";

const page = (overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: "https://shop.example/mice",
  title: "Mice",
  elements: [{ id: 0, role: "link", name: "Logitech G305" }],
  text: "Logitech G305 ₹2,495",
  truncated: false,
  scroll: { y: 0, maxY: 4000 },
  ...overrides,
});

describe("working memory", () => {
  test("keeps plan and notes and formats them as one block", () => {
    const memory = new WorkingMemory();
    expect(memory.format()).toBe("");
    expect(memory.apply("update_plan", { plan: "[ ] search\n[ ] compare" }).ok).toBe(true);
    expect(memory.apply("note", { text: "G305: ₹2,495, 4.5★" }).ok).toBe(true);
    const block = memory.format();
    expect(block).toContain("[ ] search");
    expect(block).toContain("- G305: ₹2,495, 4.5★");
    expect(block.trimEnd().endsWith("--- End working memory ---")).toBe(true);
  });

  test("rejects empty input and caps the number of notes", () => {
    const memory = new WorkingMemory();
    expect(memory.apply("note", { text: "  " }).ok).toBe(false);
    expect(memory.apply("update_plan", {}).ok).toBe(false);
    for (let i = 0; i < 40; i++) memory.apply("note", { text: `n${i}` });
    expect(memory.notes).toHaveLength(30);
    expect(memory.notes[0]).toBe("n10");
  });
});

describe("history compaction", () => {
  test("drops old page snapshots and memory blocks but leaves a trail", () => {
    const memory = new WorkingMemory();
    memory.apply("note", { text: "keep me" });
    const messages: ConversationMessage[] = [
      { role: "user", content: "task" },
      {
        role: "tool",
        results: [
          {
            id: "a",
            content:
              "Clicked <a>.\n\n--- Page after this action ---\nURL: https://shop.example/p/1\nTitle: G305\nElements:\n[0]button \"Buy\"\nText: lots" +
              memory.format(),
          },
        ],
      },
    ];
    compactHistory(messages);
    const content = (messages[1] as { results: { content: string }[] }).results[0].content;
    expect(content).toBe("Clicked <a>.\n\n[Earlier page snapshot omitted: G305 — https://shop.example/p/1]");
  });

  test("stale-element results are compacted too", () => {
    const messages: ConversationMessage[] = [
      {
        role: "tool",
        results: [{ id: "a", content: "Element 4 not found.\n\n--- Page after this action ---\nURL: https://x.example/\nTitle: X\n[1]link" }],
      },
    ];
    compactHistory(messages);
    expect((messages[0] as { results: { content: string }[] }).results[0].content).not.toContain("[1]link");
  });

  test("the starting page in the task message is dropped once a fresh page arrives", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Task: find a mouse\n\n--- Current page ---\nURL: https://a.example/\nTitle: A\n[0]link \"x\"" },
    ];
    compactHistory(messages, false);
    expect((messages[0] as { content: string }).content).toContain("[0]link");
    compactHistory(messages, true);
    expect((messages[0] as { content: string }).content).toBe(
      "Task: find a mouse\n\n[Earlier page snapshot omitted: A — https://a.example/]",
    );
  });

  test("without a fresh page read the last page stays but old memory blocks go", () => {
    const memory = new WorkingMemory();
    memory.apply("note", { text: "n" });
    const content = "Clicked.\n\n--- Page after this action ---\nURL: https://a.example/\n[0]link" + memory.format();
    const messages: ConversationMessage[] = [{ role: "tool", results: [{ id: "a", content }] }];
    compactHistory(messages, false);
    const kept = (messages[0] as { results: { content: string }[] }).results[0].content;
    expect(kept).toContain("[0]link");
    expect(kept).not.toContain("Working memory");
  });

  test("summary falls back when the block has no url or title", () => {
    expect(summarizePageBlock("\n\n--- Page after this action ---\nnothing")).toBe("\n\n[Earlier page snapshot omitted]");
  });
});

describe("loop guard", () => {
  test("repeated scrolls that move the page are not a loop", () => {
    const guard = new LoopGuard();
    for (let y = 0; y < 5; y++) guard.remember("scroll", { direction: "down" }, pageFingerprint(page({ scroll: { y: y * 800, maxY: 4000 } })));
    expect(guard.isLooping()).toBe(false);
  });

  test("the same call on an unchanged page three times is a loop", () => {
    const guard = new LoopGuard();
    const state = pageFingerprint(page({ scroll: { y: 4000, maxY: 4000 } }));
    for (let i = 0; i < 3; i++) guard.remember("scroll", { direction: "down" }, state);
    expect(guard.isLooping()).toBe(true);
    expect(guard.lastName()).toBe("scroll");
  });

  test("A-B-A-B ping-pong on the same pages is a loop", () => {
    const guard = new LoopGuard();
    const one = pageFingerprint(page());
    const two = pageFingerprint(page({ url: "https://shop.example/other" }));
    guard.remember("click", { element_id: 1 }, one);
    guard.remember("go_back", {}, two);
    guard.remember("click", { element_id: 1 }, one);
    guard.remember("go_back", {}, two);
    expect(guard.isLooping()).toBe(true);
  });
});

describe("tool schema", () => {
  test("new tools are declared and read-only tools never refresh the page", () => {
    const names = TOOLS.map((t) => t.name);
    for (const name of ["note", "update_plan", "extract_text", "read_page"]) expect(names).toContain(name);
    expect(READ_ONLY_TOOLS.has("extract_text")).toBe(true);
    expect(READ_ONLY_TOOLS.has("click")).toBe(false);
  });
});
