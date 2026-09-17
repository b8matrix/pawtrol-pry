// One adapter for every OpenAI-compatible chat-completions API (OpenAI,
// OpenRouter, Groq, NVIDIA). The legacy bundle had three copies of this code
// differing only in the options below.

import OpenAI from "openai";
import type { ConversationMessage, Planner, StopReason, ToolDefinition } from "./types";
import { ProviderError, parseToolInput } from "./types";

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
}

export function toChatMessages(system: string, messages: ConversationMessage[]): any[] {
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
  }
  return out;
}

export function toChatTools(tools: ToolDefinition[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
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
    return new ProviderError(
      `${displayName} rate-limited this request (${status ?? "unknown"}). Wait a moment and retry — or switch to a smaller snapshot model in options.`,
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
  });

  return {
    label: `${options.displayName} ${model}`,
    async run({ system, messages, tools, signal, onText }) {
      let stream: AsyncIterable<any>;
      try {
        stream = (await client.chat.completions.create(
          {
            model,
            messages: toChatMessages(system, messages),
            tools: toChatTools(tools),
            stream: true,
            [options.maxTokensParam]: options.maxTokens,
          } as any,
          { signal },
        )) as unknown as AsyncIterable<any>;
      } catch (error) {
        throw friendlyOpenAIError(error, options.displayName);
      }

      let text = "";
      let refusal = "";
      let finishReason: string | undefined;
      const partialCalls = new Map<number, { id: string; name: string; args: string }>();

      try {
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
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
            partialCalls.set(call.index, partial);
          }
        }
      } catch (error) {
        throw friendlyOpenAIError(error, options.displayName);
      }

      const toolCalls = Array.from(partialCalls.entries())
        .sort(([a], [b]) => a - b)
        .filter(([, call]) => call.name)
        .map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, input: parseToolInput(call.args) }));

      if (refusal) return { text: refusal, toolCalls: [], stopReason: "refusal", refusal };
      return { text, toolCalls, stopReason: toStopReason(finishReason, toolCalls.length > 0) };
    },
  };
}
