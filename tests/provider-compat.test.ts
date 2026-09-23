import { describe, expect, it } from "vitest";
import { compactHistory } from "../src/background/agent/memory";
import { TOOLS } from "../src/background/agent/tools";
import { MODEL_IMAGE_MAX_EDGE, fitWithin } from "../src/background/privacy/vision";
import { toAnthropicMessages } from "../src/background/providers/anthropic";
import { cleanSchema, toChatMessages, toChatTools } from "../src/background/providers/openai-compatible";
import type { ConversationMessage } from "../src/background/providers/types";

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (value && typeof value === "object") {
    for (const [key, sub] of Object.entries(value)) {
      out.add(key);
      keysDeep(sub, out);
    }
  }
  return out;
}

describe("Gemini tool schema cleanup", () => {
  it("drops additionalProperties everywhere but keeps a property with that name", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        additionalProperties: { type: "string" },
        nested: { type: "object", additionalProperties: false, properties: { x: { type: "number" } } },
        list: { type: "array", items: { type: "object", additionalProperties: false, properties: {} } },
      },
      required: ["nested"],
    };
    expect(cleanSchema(schema)).toEqual({
      type: "object",
      properties: {
        additionalProperties: { type: "string" },
        nested: { type: "object", properties: { x: { type: "number" } } },
        list: { type: "array", items: { type: "object", properties: {} } },
      },
      required: ["nested"],
    });
  });

  it("sends the real tool list without rejected keywords or empty object schemas", () => {
    const tools = toChatTools(TOOLS, true);
    expect(tools).toHaveLength(TOOLS.length);
    for (const tool of tools) {
      const params = tool.function.parameters;
      if (!params) continue;
      expect(keysDeep(params).has("additionalProperties")).toBe(false);
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("leaves schemas untouched for other providers", () => {
    expect(toChatTools(TOOLS)[0].function.parameters).toBe(TOOLS[0].parameters);
  });
});

describe("Gemini thought signatures", () => {
  const messages: ConversationMessage[] = [
    { role: "user", content: "task" },
    {
      role: "assistant",
      text: "",
      toolCalls: [
        { id: "a", name: "click", input: { id: 1 }, extraContent: { google: { thought_signature: "sig-1" } } },
        { id: "b", name: "read_page", input: {} },
      ],
    },
    { role: "tool", results: [{ id: "a", content: "ok" }, { id: "b", content: "ok" }] },
  ];

  it("replays captured signatures and uses the skip sentinel for calls without one", () => {
    const calls = toChatMessages("sys", messages, true)[2].tool_calls;
    expect(calls[0].extra_content).toEqual({ google: { thought_signature: "sig-1" } });
    expect(calls[1].extra_content).toEqual({ google: { thought_signature: "skip_thought_signature_validator" } });
  });

  it("never sends extra_content to other providers", () => {
    const calls = toChatMessages("sys", messages)[2].tool_calls;
    expect(calls.every((call: any) => !("extra_content" in call))).toBe(true);
  });
});

describe("screenshot tool results", () => {
  const image = "data:image/jpeg;base64,AAAA";
  const withShot = (): ConversationMessage[] => [
    { role: "user", content: "task" },
    { role: "assistant", text: "", toolCalls: [{ id: "s", name: "screenshot", input: {} }] },
    { role: "tool", results: [{ id: "s", content: "Screenshot attached.", image }] },
  ];

  it("chat-completions sends the image as a user turn after the tool messages", () => {
    const out = toChatMessages("sys", withShot());
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "s", content: "Screenshot attached." });
    expect(out[4].role).toBe("user");
    expect(out[4].content[1]).toEqual({ type: "image_url", image_url: { url: image } });
  });

  it("an image is sent once, then compacted away", () => {
    const messages = withShot();
    compactHistory(messages);
    const result = (messages[2] as Extract<ConversationMessage, { role: "tool" }>).results[0];
    expect(result.image).toBeUndefined();
    expect(result.content).toContain("[Earlier screenshot omitted]");
    expect(toChatMessages("sys", messages).some((m) => Array.isArray(m.content))).toBe(false);
  });

  it("is offered as a tool and downscales to the model edge", () => {
    expect(TOOLS.some((tool) => tool.name === "screenshot")).toBe(true);
    expect(fitWithin(2560, 1440, MODEL_IMAGE_MAX_EDGE)).toEqual({ width: 1568, height: 882 });
    expect(fitWithin(800, 600, MODEL_IMAGE_MAX_EDGE)).toEqual({ width: 800, height: 600 });
  });
});

describe("Anthropic screenshot tool results", () => {
  it("puts the image inside the tool_result as a base64 block", () => {
    const [, , tool] = toAnthropicMessages([
      { role: "user", content: "task" },
      { role: "assistant", text: "", toolCalls: [{ id: "s", name: "screenshot", input: {} }] },
      { role: "tool", results: [{ id: "s", content: "Screenshot attached.", image: "data:image/jpeg;base64,AAAA" }] },
    ]);
    expect((tool.content as any[])[0].content).toEqual([
      { type: "text", text: "Screenshot attached." },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
    ]);
  });
});
