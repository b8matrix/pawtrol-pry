// The egress gate, the Indian identifiers added after the legacy bundle, and
// field-value tokenization. All are intentional differences from legacy.

import { beforeEach, describe, expect, test } from "vitest";
import { classifyOcrText } from "../src/offscreen/fusion";
import { EgressBlockedError, findLeaks, gatePlanner, type GateOptions } from "../src/background/privacy/egress-gate";
import { detectTextPII } from "../src/background/privacy/detectors";
import { NO_LEARNING, sanitizeForModel, sanitizeSnapshot } from "../src/background/privacy/sanitize";
import { vault } from "../src/background/privacy/vault";
import type { Planner, PlannerRequest } from "../src/background/providers/types";
import { isValidGstin } from "../src/shared/checksums";
import type { PageSnapshot } from "../src/shared/types";
import { INVALID_AADHAAR, VALID_AADHAAR, VALID_AADHAAR_SPACED } from "./fixtures";

const VALID_GSTIN = "27AAPFU0939F1ZV";

function recordingPlanner() {
  const sent: PlannerRequest[] = [];
  const planner: Planner = {
    label: "mock",
    async run(request) {
      sent.push(request);
      return { text: "", toolCalls: [], stopReason: "end_turn" };
    },
  };
  return { planner, sent };
}

function request(toolResult: string, image?: string): PlannerRequest {
  return {
    system: "You are a browser agent.",
    messages: [
      { role: "user", content: "Fill the form with <ID_1>" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_page", input: {} }] },
      { role: "tool", results: [{ id: "c1", content: toolResult, ...(image ? { image } : {}) }] },
    ],
    tools: [],
    signal: new AbortController().signal,
    onText: () => {},
  };
}

const allowAll: GateOptions = {
  redact: (text) => vault.redactValues(text),
  isVerifiedImage: () => true,
  imagesAllowed: () => true,
};

beforeEach(() => vault.clear());

describe("egress gate", () => {
  test("stops a raw Aadhaar in a tool result and never calls the planner", async () => {
    const { planner, sent } = recordingPlanner();
    const blocked: string[] = [];
    const gated = gatePlanner(planner, { ...allowAll, onBlock: (leaks) => blocked.push(...leaks.map((l) => l.label)) });
    await expect(gated.run(request(`Aadhaar: ${VALID_AADHAAR_SPACED}`))).rejects.toBeInstanceOf(EgressBlockedError);
    expect(sent).toHaveLength(0);
    expect(blocked).toEqual(["Aadhaar number"]);
  });

  test("the error names the kind but never the value", async () => {
    const gated = gatePlanner(recordingPlanner().planner, allowAll);
    const err = await gated.run(request(`PAN ABCDE1234F`)).catch((e: Error) => e);
    expect(err.message).toContain("PAN");
    expect(err.message).not.toContain("ABCDE1234F");
  });

  test("swaps vault values back to tokens, then sends", async () => {
    const token = vault.tokenize(VALID_AADHAAR, "id_number");
    const { planner, sent } = recordingPlanner();
    await gatePlanner(planner, allowAll).run(request(`Field value: ${VALID_AADHAAR}`));
    expect(sent).toHaveLength(1);
    const result = sent[0].messages[2];
    expect(result.role === "tool" && result.results[0].content).toBe(`Field value: ${token}`);
  });

  test("does not stop on lookalikes: failed checksums, order numbers, dates, tokens", async () => {
    const { planner, sent } = recordingPlanner();
    const text = `Order #${INVALID_AADHAAR} placed 2026-09-24, card 4111 1111 1111 1112, ref <ID_1> <CRED_2>`;
    await gatePlanner(planner, allowAll).run(request(text));
    expect(sent).toHaveLength(1);
  });

  test("catches Luhn-valid cards, valid GSTINs and API keys", () => {
    expect(findLeaks("4111 1111 1111 1111").map((l) => l.label)).toEqual(["card number"]);
    expect(findLeaks(`GST ${VALID_GSTIN}`).map((l) => l.label)).toEqual(["GSTIN"]);
    expect(findLeaks("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz").map((l) => l.label)).toEqual(["API key"]);
  });

  test("drops an image that was not verified on device", async () => {
    const { planner, sent } = recordingPlanner();
    const dropped: string[] = [];
    const gated = gatePlanner(planner, { ...allowAll, isVerifiedImage: () => false, onImageDropped: (r) => dropped.push(r) });
    await gated.run(request("Screenshot attached", "data:image/png;base64,AAAA"));
    const result = sent[0].messages[2];
    expect(result.role === "tool" && result.results[0].image).toBeUndefined();
    expect(dropped).toEqual(["unverified"]);
  });

  test("text-only site policy drops even a verified image", async () => {
    const { planner, sent } = recordingPlanner();
    await gatePlanner(planner, { ...allowAll, imagesAllowed: () => false }).run(request("shot", "data:image/png;base64,AAAA"));
    const result = sent[0].messages[2];
    expect(result.role === "tool" && result.results[0].image).toBeUndefined();
    expect(result.role === "tool" && result.results[0].content).toContain("text-only");
  });
});

describe("new Indian identifiers", () => {
  test("GSTIN checksum", () => {
    expect(isValidGstin(VALID_GSTIN)).toBe(true);
    expect(isValidGstin("29AAGCB7383J1Z4")).toBe(true);
    expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false);
    expect(isValidGstin("40AAPFU0939F1ZV")).toBe(false);
  });

  test.each([
    [`GSTIN: ${VALID_GSTIN}`, "GSTIN (checksum ✓)"],
    ["Pay to ravi.kumar@okhdfcbank now", "UPI ID"],
    ["EPIC no. ABC1234567", "Voter ID (EPIC)"],
    ["DL MH12 20110012345", "Driving licence number"],
    ["Passport J8369854", "Possible passport number"],
  ])("detects %s", (text, label) => {
    expect(detectTextPII(text).detections.map((d) => d.label)).toContain(label);
  });

  test.each([
    ["GSTIN 27AAPFU0939F1ZW", "GSTIN (checksum ✓)"],
    ["mail ravi@okhdfcbank.com", "UPI ID"],
    ["Ref K0000000", "Possible passport number"],
    ["Code Q1234567", "Possible passport number"],
  ])("does not flag %s", (text, label) => {
    expect(detectTextPII(text).detections.map((d) => d.label)).not.toContain(label);
  });

  test("OCR text from an image is classified as an ID", () => {
    expect(classifyOcrText(`GSTIN ${VALID_GSTIN}`)?.label).toBe("GSTIN (checksum ✓)");
    expect(classifyOcrText("UPI: shop@ybl")?.label).toBe("UPI ID");
  });

  test("the user's task tokenizes them", () => {
    const { task } = vault.tokenizeTask(`File GST for ${VALID_GSTIN} and pay shop@ybl`);
    expect(task).not.toContain(VALID_GSTIN);
    expect(task).not.toContain("shop@ybl");
    expect(findLeaks(task)).toEqual([]);
  });
});

describe("field values are tokenized before the model sees them", () => {
  const snapshot: PageSnapshot = {
    url: "https://portal.example.gov.in/apply",
    title: "Apply",
    text: "Application form",
    truncated: false,
    scroll: { y: 0, maxY: 0 },
    elements: [
      { id: 1, role: "textbox", name: "Aadhaar number", value: VALID_AADHAAR },
      { id: 2, role: "textbox", name: "GSTIN", value: VALID_GSTIN },
      { id: 3, role: "textbox", name: "City", value: "Pune" },
    ],
  };

  test("legacy sanitizeSnapshot leaves them raw", () => {
    const values = sanitizeSnapshot(snapshot, NO_LEARNING).sanitized.elements.map((e) => e.value);
    expect(values).toContain(VALID_AADHAAR);
  });

  test("sanitizeForModel tokenizes them and leaves ordinary values alone", () => {
    const result = sanitizeForModel(snapshot, NO_LEARNING);
    const values = result.sanitized.elements.map((e) => e.value ?? "");
    expect(values[0]).toMatch(/^<ID_\d+>$/);
    expect(values[1]).toMatch(/^<ID_\d+>$/);
    expect(values[2]).toBe("Pune");
    expect(findLeaks(values.join(" "))).toEqual([]);
    expect(vault.resolve(values[0])).toBe(VALID_AADHAAR);
  });

  test("respects learned false-positive suppression", () => {
    const result = sanitizeForModel(snapshot, { fpKeys: new Set(["id_number:regex"]), llmOnly: false, ruleCount: 1 });
    expect(result.sanitized.elements[1].value).toBe(VALID_GSTIN);
  });
});
