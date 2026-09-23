// Local Ollama planner via the native /api/chat NDJSON stream. Nothing leaves
// the machine, so the loop reports zero egress for this provider.

import type { ConversationMessage, Planner, TokenUsage, ToolCall, ToolDefinition } from "./types";
import { ProviderError, parseToolInput } from "./types";

const OLLAMA_URL = "http://localhost:11434";
const REQUEST_TIMEOUT_MS = 120_000;
const CHUNK_TIMEOUT_MS = 30_000;

const CORS_FIX = `Fix: Stop Ollama, set env var, restart:
  taskkill /F /IM ollama.exe
  set OLLAMA_ORIGINS=chrome-extension://*
  ollama serve`;

function toOllamaMessages(system: string, messages: ConversationMessage[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const entry: any = { role: "assistant", content: message.text || "" };
      if (message.toolCalls.length > 0) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }));
      }
      out.push(entry);
      continue;
    }
    for (const result of message.results) {
      out.push({
        role: "tool",
        content: result.isError ? `ERROR: ${result.content}` : result.content,
        tool_call_id: result.id,
      });
    }
  }
  return out;
}

function toOllamaTools(tools: ToolDefinition[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

async function streamChat(
  baseUrl: string,
  body: unknown,
  signal: AbortSignal,
  onText: (delta: string) => void,
): Promise<{ text: string; toolCalls: ToolCall[]; usage?: TokenUsage }> {
  const controller = new AbortController();
  const requestTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort);

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(`Ollama returned ${response.status}: ${detail || response.statusText}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError("Ollama returned no response body.");

    let text = "";
    let usage: TokenUsage | undefined;
    const partialCalls = new Map<number, { id: string; name: string; args: string }>();
    let done = false;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      let chunkTimer: ReturnType<typeof setTimeout> | undefined;
      while (!done) {
        const read = reader.read();
        const timeout = new Promise<never>((_, reject) => {
          chunkTimer = setTimeout(() => reject(new Error("Stream chunk timeout")), CHUNK_TIMEOUT_MS);
        });
        const chunk = await Promise.race([read, timeout]);
        if (chunkTimer !== undefined) clearTimeout(chunkTimer);
        chunkTimer = undefined;
        if (chunk.done) break;
        if (!chunk.value) continue;

        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (parsed.done) {
            if (typeof parsed.prompt_eval_count == "number" || typeof parsed.eval_count == "number") {
              usage = { inputTokens: parsed.prompt_eval_count ?? 0, outputTokens: parsed.eval_count ?? 0 };
            }
            done = true;
            break;
          }
          const message = parsed.message;
          if (!message) continue;
          if (message.content) {
            text += message.content;
            onText(message.content);
          }
          if (!message.tool_calls) continue;
          for (const call of message.tool_calls) {
            const index = call.index ?? partialCalls.size;
            const partial = partialCalls.get(index) ?? { id: `call_${index}`, name: "", args: "" };
            if (call.function?.name) partial.name = call.function.name;
            if (call.function?.arguments) {
              const args = call.function.arguments;
              partial.args += typeof args == "object" ? JSON.stringify(args) : String(args);
            }
            partialCalls.set(index, partial);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls = Array.from(partialCalls.entries())
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, input: parseToolInput(call.args) }));
    return { text, toolCalls, usage };
  } finally {
    clearTimeout(requestTimer);
    signal.removeEventListener("abort", onAbort);
  }
}

const OLLAMA_NUM_CTX = 16_384;

export function createOllamaPlanner(model: string): Planner {
  const baseUrl = OLLAMA_URL;
  return {
    label: `Ollama (Local) ${model}`,
    async run({ system, messages, tools, signal, onText }) {
      // Ollama defaults to a 2-4K context and silently drops the start of the
      // prompt (the task) when the tools + page do not fit.
      const body = {
        model,
        messages: toOllamaMessages(system, messages),
        tools: toOllamaTools(tools),
        stream: true,
        options: { num_ctx: OLLAMA_NUM_CTX },
        keep_alive: "30m",
      };
      const finish = (result: { text: string; toolCalls: ToolCall[]; usage?: TokenUsage }) => ({
        text: result.text,
        toolCalls: result.toolCalls,
        usage: result.usage,
        stopReason: result.toolCalls.length > 0 ? ("tool_use" as const) : ("end_turn" as const),
      });

      try {
        return finish(await streamChat(baseUrl, body, signal, onText));
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof ProviderError) {
          if (error.message.includes("403")) {
            console.warn("[PRY] Ollama 403 with tools, retrying without tools.");
            try {
              return finish(await streamChat(baseUrl, { ...body, tools: undefined }, signal, onText));
            } catch {
              throw new ProviderError(`Ollama returned 403 Forbidden. This is likely a CORS issue.\n\n${CORS_FIX}`);
            }
          }
          throw error.message.includes("CORS") ? new ProviderError(`Ollama CORS error.\n\n${CORS_FIX}`) : error;
        }
        if (error instanceof Error && error.message.includes("timeout")) {
          throw new ProviderError(
            `Ollama timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The model "${model}" may be too slow. Try a smaller model or check if Ollama is running.`,
          );
        }
        if (error instanceof TypeError && error.message.includes("fetch")) {
          throw new ProviderError(`Cannot connect to Ollama at ${baseUrl}. Is Ollama running?\nRun: ollama serve`);
        }
        throw error;
      }
    },
  };
}
