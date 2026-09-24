// The single egress choke point. Every request to a planner passes through
// gatePlanner: vault values are swapped back to tokens, then the whole payload
// is re-scanned, and anything that still looks like a real identifier stops
// the request before it leaves the device. Images go out only if the on-device
// pipeline verified them and the current site allows images at all.

import { isLuhnValid, isValidAadhaar, isValidGstin } from "../../shared/checksums";
import { GSTIN } from "../../shared/indian-ids";
import type { ConversationMessage, Planner, PlannerRequest, PlannerResponse } from "../providers/types";
import { ProviderError } from "../providers/types";

export interface EgressLeak {
  label: string;
  /** Last four characters only, for the transcript. Never the value. */
  hint: string;
}

/** Thrown instead of sending. The message is written for the user. */
export class EgressBlockedError extends ProviderError {
  constructor(readonly leaks: EgressLeak[]) {
    super(
      `Egress gate stopped this request: ${describeLeaks(leaks)} was still in the outgoing payload after redaction. Nothing was sent to the model.`,
    );
  }
}

interface StrictPattern {
  pattern: RegExp;
  label: string;
  validate?: (match: string) => boolean;
}

// Only identifiers with a checksum or an unmistakable shape: the gate must
// never stop a run over an order number or a date.
const STRICT_PATTERNS: StrictPattern[] = [
  { pattern: /(?<![\dA-Za-z])\d{4}[ -]?\d{4}[ -]?\d{4}(?![\dA-Za-z])/g, label: "Aadhaar number", validate: isValidAadhaar },
  { pattern: /(?<![\dA-Za-z])(?:\d{4}[ -]?){3}\d{4}(?![\dA-Za-z])/g, label: "card number", validate: isLuhnValid },
  { pattern: /(?<![\dA-Za-z])[A-Z]{5}\d{4}[A-Z](?![\dA-Za-z])/g, label: "PAN" },
  { pattern: new RegExp(GSTIN.source, "g"), label: "GSTIN", validate: isValidGstin },
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, label: "API key" },
  { pattern: /\bgh[pos]_[A-Za-z0-9]{36}\b/g, label: "API key" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: "API key" },
];

/** Real identifiers still present in `text`. Tokens such as <ID_1> never match. */
export function findLeaks(text: string): EgressLeak[] {
  const leaks: EgressLeak[] = [];
  for (const { pattern, label, validate } of STRICT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (validate && !validate(match[0])) continue;
      leaks.push({ label, hint: match[0].replace(/[\s-]/g, "").slice(-4) });
    }
  }
  return leaks;
}

function describeLeaks(leaks: EgressLeak[]): string {
  const labels = [...new Set(leaks.map((l) => l.label))];
  return labels.length === 1 ? `a raw ${labels[0]}` : `raw values (${labels.join(", ")})`;
}

export interface GateOptions {
  /** Swap vault values back to their tokens. */
  redact: (text: string) => string;
  /** True for images the on-device pipeline produced and verified. */
  isVerifiedImage: (image: string) => boolean;
  /** False on sites where no image may leave the device (e.g. banking). */
  imagesAllowed: () => boolean;
  /** Called once per blocked request, before the error is thrown. */
  onBlock?: (leaks: EgressLeak[]) => void;
  /** Called for an image that was removed from the request. */
  onImageDropped?: (reason: "unverified" | "site-policy") => void;
  /** Called with the exact request about to leave, after every check passed. */
  onSend?: (request: PlannerRequest) => void;
}

const IMAGE_DROPPED = {
  unverified: "[Image removed by the egress gate: it was not verified by on-device redaction]",
  "site-policy": "[Image not sent: this site is text-only under the privacy policy (banking)]",
} as const;

/**
 * Redact in place (so history stays clean for later steps), drop images that
 * may not leave, and return every string the model would receive.
 */
function sanitizeRequest(request: PlannerRequest, options: GateOptions): string[] {
  const outgoing: string[] = [];
  request.system = options.redact(request.system);
  outgoing.push(request.system);
  for (const message of request.messages as ConversationMessage[]) {
    if (message.role === "user") {
      message.content = options.redact(message.content);
      outgoing.push(message.content);
    } else if (message.role === "assistant") {
      message.text = options.redact(message.text);
      outgoing.push(message.text);
      for (const call of message.toolCalls) outgoing.push(options.redact(JSON.stringify(call.input)));
    } else {
      for (const result of message.results) {
        result.content = options.redact(result.content);
        if (result.image) {
          const reason = !options.imagesAllowed() ? "site-policy" : !options.isVerifiedImage(result.image) ? "unverified" : null;
          if (reason) {
            delete result.image;
            result.content += `\n${IMAGE_DROPPED[reason]}`;
            options.onImageDropped?.(reason);
          }
        }
        outgoing.push(result.content);
      }
    }
  }
  return outgoing;
}

export function gatePlanner(planner: Planner, options: GateOptions): Planner {
  return {
    label: planner.label,
    async run(request: PlannerRequest): Promise<PlannerResponse> {
      const leaks = sanitizeRequest(request, options).flatMap(findLeaks);
      if (leaks.length > 0) {
        options.onBlock?.(leaks);
        throw new EgressBlockedError(leaks);
      }
      options.onSend?.(request);
      return planner.run(request);
    },
  };
}
