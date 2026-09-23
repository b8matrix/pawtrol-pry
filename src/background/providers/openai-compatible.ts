// One adapter for every OpenAI-compatible chat-completions API (OpenAI,
// OpenRouter, Groq, NVIDIA, Gemini, Cerebras). The legacy bundle had three copies of this code
// differing only in the options below.

import OpenAI from "openai";
import type { ConversationMessage, Planner, StopReason, TokenUsage, ToolDefinition } from "./types";
import { ProviderError, RateLimitError, parseDurationMs, parseToolInput } from "./types";

export interface OpenAICompatibleOptions {
  displayName: string;
  baseURL: string;
  maxTokens: number;
  /** OpenAI's newer models reject `max_tokens`. */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /**
   * Forward reasoning deltas (Groq/NVIDIA) to the narration stream. Off for all
   * providers: reasoning models (gpt-oss) otherwise dump their chain of thought
   * into the transcript as if it were the answer.
   */
  streamReasoning: boolean;
  defaultHeaders?: Record<string, string>;
  /** Ask for a final usage chunk (`stream_options.include_usage`). */
  includeUsage?: boolean;
  /** Extra top-level request fields, e.g. Gemini's `reasoning_effort`. */
  extraBody?: Record<string, unknown>;
  /** Strip JSON Schema keywords the provider rejects (Gemini). */
  cleanToolSchemas?: boolean;
  /**
   * Replay `extra_content` on tool calls. Gemini 3 answers 400 when a replayed
   * call has no thought signature, so calls without one (the deterministic fast
   * path) get Google's documented skip sentinel.
   */
  thoughtSignatures?: boolean;
}

const SKIP_THOUGHT_SIGNATURE = { google: { thought_signature: "skip_thought_signature_validator" } };

// Keywords Gemini's function-declaration schema subset rejects.
const UNSUPPORTED_SCHEMA_KEYS = new Set(["additionalProperties", "$schema", "$id", "$ref", "$defs", "definitions"]);

export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, cleanSchema(sub)]));
    } else {
      out[key] = cleanSchema(value);
    }
  }
  return out;
}

export function toChatMessages(system: string, messages: ConversationMessage[], thoughtSignatures = false): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text || null,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.input) },
                ...(thoughtSignatures ? { extra_content: call.extraContent ?? SKIP_THOUGHT_SIGNATURE } : {}),
              })),
            }
          : {}),
      });
      continue;
    }
    for (const result of message.results) {
      out.push({
        role: "tool",
        tool_call_id: result.id,
        content: result.isError ? `ERROR: ${result.content}` : result.content,
      });
    }
    // Chat-completions tool messages are text-only, so screenshots follow as a user turn.
    const images = message.results.filter((result) => result.image);
    if (images.length > 0) {
      out.push({
        role: "user",
        content: [
          { type: "text", text: "Screenshot returned by the screenshot tool (masked on device):" },
          ...images.map((result) => ({ type: "image_url", image_url: { url: result.image } })),
        ],
      });
    }
  }
  return out;
}

export function toChatTools(tools: ToolDefinition[], clean = false): any[] {
  return tools.map((tool) => {
    if (!clean) {
      return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
    }
    const parameters = cleanSchema(tool.parameters) as Record<string, any>;
    // Gemini rejects an OBJECT schema with no properties; a parameterless tool omits it.
    const empty = parameters.type === "object" && Object.keys(parameters.properties ?? {}).length === 0;
    return {
      type: "function",
      function: { name: tool.name, description: tool.description, ...(empty ? {} : { parameters }) },
    };
  });
}

function toStopReason(finishReason: string | undefined, hasToolCalls: boolean): StopReason {
  if (finishReason === "tool_calls" || hasToolCalls) return "tool_use";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "content_filter") return "refusal";
  return "end_turn";
}

function describeModelProblem(status: number, message: string): string | null {
  if (status === 410) return "that model has reached its end of life and is no longer served";
  if (status === 404) return "the model id was not found (or your key cannot access it)";
  if (
    status === 400 &&
    /model/i.test(message) &&
    /(not found|not available|no longer|does not exist|invalid|not supported|unavailable|gated|access)/i.test(message)
  ) {
    return "that model id is not available for your key or tier";
  }
  return null;
}

function truncate(text: string, max = 220): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

export function friendlyOpenAIError(error: any, displayName: string): Error {
  const status: number | undefined = error?.status;
  const message: string = error?.message ?? String(error);
  if (error instanceof OpenAI.AuthenticationError) {
    return new ProviderError(`${displayName} rejected your API key. Open the extension options and check it.`);
  }
  if (error instanceof OpenAI.RateLimitError) {
    const headers = error.headers as Headers | undefined;
    const retryAfterMs =
      parseDurationMs(headers?.get?.("retry-after")) ?? parseDurationMs(headers?.get?.("x-ratelimit-reset-tokens")) ?? 10_000;
    // Groq says so when waiting will not help (daily quota, or a request larger than the per-minute limit).
    const hopeless = headers?.get?.("x-should-retry") === "false";
    return new RateLimitError(
      `${displayName} rate limit: ${truncate(message.replace(/^\d{3}\s*/, ""), 240)}`,
      hopeless ? Number.POSITIVE_INFINITY : retryAfterMs,
    );
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new ProviderError(
      `${displayName}: ${describeModelProblem(status ?? 404, message) ?? "the model id was not found"}. Open the extension options, press "Test Providers", and pick an available model.`,
    );
  }
  if (error instanceof OpenAI.APIError) {
    const problem = describeModelProblem(status ?? 0, message);
    return problem
      ? new ProviderError(
          `${displayName}: ${problem}. Open the extension options, press "Test Providers", and pick a currently available model.`,
        )
      : new ProviderError(`${displayName} API error ${status ?? "unknown"}: ${truncate(message)}`);
  }
  if (status === 404 || status === 410 || (status === 400 && /model/i.test(message))) {
    return new ProviderError(
      `${displayName}: ${describeModelProblem(status ?? 0, message) ?? "the model id was not found"}. Open the extension options and pick another model.`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createOpenAICompatiblePlanner(apiKey: string, model: string, options: OpenAICompatibleOptions): Planner {
  const client = new OpenAI({
    apiKey,
    baseURL: options.baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: options.defaultHeaders,
    // The agent loop waits out rate limits itself and says so in the transcript;
    // the SDK's silent backoff looked like a stalled planner.
    maxRetries: 0,
  });

  return {
    label: `${options.displayName} ${model}`,
    async run({ system, messages, tools, signal, onText }) {
      let stream: AsyncIterable<any>;
      try {
        stream = (await client.chat.completions.create(
          {
            model,
            messages: toChatMessages(system, messages, options.thoughtSignatures),
            tools: toChatTools(tools, options.cleanToolSchemas),
            stream: true,
            ...(options.includeUsage ? { stream_options: { include_usage: true } } : {}),
            [options.maxTokensParam]: options.maxTokens,
            ...options.extraBody,
          } as any,
          { signal },
        )) as unknown as AsyncIterable<any>;
      } catch (error) {
        throw friendlyOpenAIError(error, options.displayName);
      }

      let text = "";
      let refusal = "";
      let finishReason: string | undefined;
      let usage: TokenUsage | undefined;
      const partialCalls = new Map<number, { id: string; name: string; args: string; extra?: Record<string, unknown> }>();

      try {
        for await (const chunk of stream) {
          // Standard usage chunk (empty choices), or Groq's x_groq.usage on the last chunk.
          const reported = chunk.usage ?? chunk.x_groq?.usage;
          if (reported) usage = { inputTokens: reported.prompt_tokens ?? 0, outputTokens: reported.completion_tokens ?? 0 };
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (options.streamReasoning) {
            const reasoning = delta?.reasoning_content || delta?.reasoning;
            if (reasoning) onText(reasoning);
          }
          if (delta?.content) {
            text += delta.content;
            onText(delta.content);
          }
          if (delta?.refusal) refusal += delta.refusal;
          for (const call of delta?.tool_calls ?? []) {
            const partial = partialCalls.get(call.index) ?? { id: "", name: "", args: "" };
            if (call.id) partial.id = call.id;
            if (call.function?.name) partial.name = call.function.name;
            if (call.function?.arguments) partial.args += call.function.arguments;
            if (call.extra_content) partial.extra = call.extra_content;
            partialCalls.set(call.index, partial);
          }
        }
      } catch (error) {
        throw friendlyOpenAIError(error, options.displayName);
      }

      const toolCalls = Array.from(partialCalls.entries())
        .sort(([a], [b]) => a - b)
        .filter(([, call]) => call.name)
        .map(([index, call]) => ({
          id: call.id || `call_${index}`,
          name: call.name,
          input: parseToolInput(call.args),
          ...(call.extra ? { extraContent: call.extra } : {}),
        }));

      if (refusal) return { text: refusal, toolCalls: [], stopReason: "refusal", refusal, usage };
      return { text, toolCalls, stopReason: toStopReason(finishReason, toolCalls.length > 0), usage };
    },
  };
}
