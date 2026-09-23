// Regression tests for legacy bugs fixed during the port. Each test shows the
// legacy output next to the corrected one.

import { describe, expect, test } from "vitest";
import { resolveDeterministically } from "../src/background/agent/deterministic";
import { TokenVault } from "../src/background/privacy/vault";
import { normalizeSettings } from "../src/background/settings";
import type { PageSnapshot } from "../src/shared/types";
import { VALID_AADHAAR_SPACED } from "./fixtures";
import { legacy } from "./legacy";

describe("vault value redaction no longer glues the match offset onto tokens", () => {
  test("card number in the middle of text", () => {
    const text = "Card 4111111111111111 here";
    const ours = new TokenVault();
    const theirs = new legacy.TokenVault();
    ours.tokenize("4111111111111111", "credential");
    theirs.tokenize("4111111111111111", "credential");

    expect(theirs.redactValues(text)).toBe("Card 5<CRED_1> here");
    expect(ours.redactValues(text)).toBe("Card <CRED_1> here");
  });

  test("Aadhaar in page text via tokenizeDetections", () => {
    const snapshot = { elements: [], text: `Aadhaar: ${VALID_AADHAAR_SPACED} verified` };
    const detection = [{ kind: "id_number" as const, value: VALID_AADHAAR_SPACED, confidence: 0.7, label: "Aadhaar" }];
    expect(new legacy.TokenVault().tokenizeDetections(snapshot, detection).text).toBe("Aadhaar: 9<ID_1> verified");
    expect(new TokenVault().tokenizeDetections(snapshot, detection).text).toBe("Aadhaar: <ID_1> verified");
  });

  test("alphabetic values stay word-bounded", () => {
    const vault = new TokenVault();
    vault.tokenize("Priya Sharma", "pii_text");
    expect(vault.redactValues("To Priya Sharma, from Priya Sharmaji")).toBe("To <PII_1>, from Priya Sharmaji");
  });
});

describe("deterministic planner keeps the case of typed values and URLs", () => {
  const snapshot: PageSnapshot = {
    url: "https://example.com",
    title: "Example",
    elements: [{ id: 3, role: "textbox", name: "Recipient" }],
    text: "",
    truncated: false,
    scroll: { y: 0, maxY: 0 },
  };

  test("tokens survive a fill command", () => {
    const legacyResult = legacy.resolveDeterministically("fill recipient with <EMAIL_1>", snapshot);
    expect(legacyResult.action.input.text).toBe("<email_1>");
    const result = resolveDeterministically("fill recipient with <EMAIL_1>", snapshot);
    expect(result.action?.input.text).toBe("<EMAIL_1>");
  });

  test("mixed-case text is typed as written", () => {
    expect(resolveDeterministically("Fill Recipient with Priya Sharma", snapshot).action?.input.text).toBe("Priya Sharma");
  });

  test("URL paths keep their case", () => {
    const legacyUrl = legacy.resolveDeterministically("go to github.com/Anthropics/SDK", snapshot).action.input.url;
    expect(legacyUrl).toBe("https://github.com/anthropics/sdk");
    const url = resolveDeterministically("go to github.com/Anthropics/SDK", snapshot).action?.input.url;
    expect(url).toBe("https://github.com/Anthropics/SDK");
  });

  test("compound commands still defer to the planner regardless of case", () => {
    expect(resolveDeterministically("Open YouTube And search cats", snapshot).resolved).toBe(false);
  });
});

describe("settings know the providers added after legacy", () => {
  test("Gemini and Cerebras get empty keys and default models; stored values win", () => {
    const fresh = normalizeSettings(undefined);
    expect(legacy.normalizeSettings(undefined).apiKeys.gemini).toBeUndefined();
    expect(fresh.apiKeys).toMatchObject({ gemini: "", cerebras: "" });
    expect(fresh.models).toMatchObject({ gemini: "gemini-3.5-flash-lite", cerebras: "gpt-oss-120b" });

    const stored = normalizeSettings({ provider: "gemini", apiKeys: { gemini: "k" }, models: { cerebras: "qwen-3.8-27b" } });
    expect(stored.provider).toBe("gemini");
    expect(stored.apiKeys.gemini).toBe("k");
    expect(stored.models.cerebras).toBe("qwen-3.8-27b");
  });
});
