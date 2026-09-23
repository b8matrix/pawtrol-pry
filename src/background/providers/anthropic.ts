import Anthropic from "@anthropic-ai/sdk";
import type { ConversationMessage, Planner, StopReason, ToolDefinition } from "./types";
import { ProviderError, parseToolInput, splitDataUrl } from "./types";

function toImageBlock(dataUrl: string): Anthropic.ImageBlockParam {
  const { mediaType, base64 } = splitDataUrl(dataUrl);
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType as Anthropic.Base64ImageSource["media_type"], data: base64 },
  };
}

export function toAnthropicMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === "user") return { role: "user", content: message.content };
    if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      if (content.length === 0) content.push({ type: "text", text: "(no output)" });
      return { role: "assistant", content };
    }
    return {
      role: "user",
      content: message.results.map((result) => ({
        type: "tool_result" as const,
        tool_use_id: result.id,
        content: result.image ? [{ type: "text" as const, text: result.content }, toImageBlock(result.image)] : result.content,
        ...(result.isError ? { is_error: true } : {}),
      })),
    };
  });
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    // Tools and system prompt are identical on every step; cache them.
    ...(index === tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

function toStopReason(reason: string | null): StopReason {
  return reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "max_tokens" : reason === "refusal" ? "refusal" : "end_turn";
}

function friendlyError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderError("Anthropic rejected your API key. Check it in the extension options.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError("Anthropic rate-limited this request. Wait a moment and retry.");
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ProviderError("Anthropic does not recognise that model id. Pick another one in the extension options.");
  }
  if (error instanceof Anthropic.APIError) {
    return new ProviderError(`Anthropic API error ${error.status}: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createAnthropicPlanner(apiKey: string, model: string): Planner {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  return {
    label: `Anthropic ${model}`,
    async run({ system, messages, tools, signal, onText }) {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 8000,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          tools: toAnthropicTools(tools),
          messages: toAnthropicMessages(messages),
        },
        { signal },
      );
      stream.on("text", onText);
      let final: Anthropic.Message;
      try {
        final = await stream.finalMessage();
      } catch (error) {
        throw friendlyError(error);
      }
      const text = final.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls = final.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map((block) => ({ id: block.id, name: block.name, input: parseToolInput(block.input) }));
      return {
        text,
        toolCalls,
        stopReason: toStopReason(final.stop_reason),
        usage: {
          inputTokens:
            final.usage.input_tokens +
            (final.usage.cache_read_input_tokens ?? 0) +
            (final.usage.cache_creation_input_tokens ?? 0),
          outputTokens: final.usage.output_tokens,
        },
        refusal:
          final.stop_reason === "refusal"
            ? ((final as { stop_details?: { category?: string } }).stop_details?.category ?? "unspecified")
            : undefined,
      };
    },
  };
}
