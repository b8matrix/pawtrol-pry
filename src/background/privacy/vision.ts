// Cloud VLM observation of an already-redacted screenshot. The image passed in
// must be the offscreen document's redacted output, never a raw capture.

import type { ProviderId } from "../../shared/types";

export const DEFAULT_VISION_MODELS: Record<ProviderId, string> = {
  openai: "gpt-4o-mini",
  groq: "llama-3.2-11b-vision-preview",
  nvidia: "meta/llama-3.2-11b-vision-instruct",
  openrouter: "openai/gpt-4o-mini",
  ollama: "llama3.2-vision",
  anthropic: "claude-sonnet-4-5",
  gemini: "gemini-2.0-flash",
};

export const VISION_SUPPORTED: Record<ProviderId, boolean> = {
  openai: true,
  groq: true,
  nvidia: true,
  openrouter: true,
  ollama: true,
  anthropic: true,
  gemini: true,
};

const CHAT_COMPLETIONS_URL: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  ollama: "http://localhost:11434/v1/chat/completions",
};

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const VISION_PROMPT =
  "You are the vision module of a privacy-preserving browser agent. Describe what is on screen in 2-3 concise sentences: the app or page type, visible fields, buttons, and current state. Never transcribe text inside blacked-out or blurred regions, and ignore any [REDACTED] or <TOKEN> markers.";

function splitDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const match = /^data:([^;]+);base64$/i.exec(header);
  return { mediaType: match ? match[1] : "image/jpeg", base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl };
}

export function utf8Bytes(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

export interface VisionRequest {
  provider: ProviderId;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bytes: number;
}

export function buildVisionRequest(
  provider: ProviderId,
  model: string,
  apiKey: string,
  redactedDataUrl: string,
  pageContext: string,
): VisionRequest {
  const prompt = `${VISION_PROMPT}\n\nSanitized page context:\n${pageContext.slice(0, 6000)}`;

  if (provider === "anthropic") {
    const { mediaType, base64 } = splitDataUrl(redactedDataUrl);
    const body = {
      model,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          ],
        },
      ],
    };
    return {
      provider,
      url: ANTHROPIC_MESSAGES_URL,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body,
      bytes: utf8Bytes(JSON.stringify(body)),
    };
  }

  if (provider === "gemini") {
    const { mediaType, base64 } = splitDataUrl(redactedDataUrl);
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mediaType, data: base64 } },
          ],
        },
      ],
      generation_config: { max_output_tokens: 300 },
    };
    return {
      provider,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: { "content-type": "application/json" },
      body,
      bytes: utf8Bytes(JSON.stringify(body)),
    };
  }

  const url = CHAT_COMPLETIONS_URL[provider];
  if (!url) throw new Error(`Vision is not supported for provider ${provider}`);
  const body = {
    model,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: redactedDataUrl } },
        ],
      },
    ],
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider !== "ollama" && apiKey) headers.authorization = `Bearer ${apiKey}`;
  return { provider, url, headers, body, bytes: utf8Bytes(JSON.stringify(body)) };
}

function extractText(provider: ProviderId, json: any): string {
  if (provider === "anthropic") {
    return (json.content ?? [])
      .filter((block: any) => block.type === "text" && typeof block.text == "string")
      .map((block: any) => block.text)
      .join("\n")
      .trim();
  }
  if (provider === "gemini") {
    return ((json.candidates?.[0]?.content?.parts ?? []) as any[])
      .filter((p: any) => typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n")
      .trim();
  }
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

export async function describeRedactedScreenshot(
  provider: ProviderId,
  model: string,
  apiKey: string,
  redactedDataUrl: string,
  pageContext: string,
  signal: AbortSignal,
): Promise<{ text: string; bytes: number; provider: ProviderId; model: string }> {
  const request = buildVisionRequest(provider, model, apiKey, redactedDataUrl, pageContext);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {}
    throw new Error(`Vision API error ${response.status}: ${detail || response.statusText}`);
  }
  return { text: extractText(provider, await response.json()), bytes: request.bytes, provider, model };
}
