// Action policy: every tool call is checked here before it runs. Refuses to
// type raw secrets or into credential fields, asks the user before
// irreversible clicks/submits, and spots prompt-injection text on pages.

import type { PageElement, PageSnapshot, ToolAction } from "../../shared/types";

interface LabeledPattern {
  pattern: RegExp;
  label: string;
}

const SENSITIVE_FIELDS: LabeledPattern[] = [
  { pattern: /\bpassword\b/i, label: "Password field" },
  { pattern: /\bpasscode\b/i, label: "Passcode field" },
  { pattern: /\bcvv\b/i, label: "CVV field" },
  { pattern: /\bcvc\b/i, label: "CVC field" },
  { pattern: /\bcard\s*number\b/i, label: "Card number field" },
  { pattern: /\bcredit\s*card\b/i, label: "Credit card field" },
  { pattern: /\bdebit\s*card\b/i, label: "Debit card field" },
  { pattern: /\bexpiry\b/i, label: "Expiry field" },
  { pattern: /\bssn\b/i, label: "SSN field" },
  { pattern: /\bsocial\s*security\b/i, label: "Social security field" },
  { pattern: /\baadhaar\b/i, label: "Aadhaar field" },
  { pattern: /\bpan\s*(card|number)\b/i, label: "PAN card field" },
  { pattern: /\bpassport\b/i, label: "Passport field" },
  { pattern: /\bifsc\b/i, label: "IFSC field" },
  { pattern: /\baccount\s*number\b/i, label: "Account number field" },
  { pattern: /\bone[-\s]?time\s*(code|password)\b/i, label: "One-time code field" },
  { pattern: /\botp\b/i, label: "OTP field" },
  { pattern: /\bapi[-\s]?key\b/i, label: "API key field" },
  { pattern: /\bsecret\b/i, label: "Secret field" },
  { pattern: /\bprivate[-\s]?key\b/i, label: "Private key field" },
  { pattern: /\bsigning[-\s]?key\b/i, label: "Signing key field" },
  { pattern: /\bbank\s*account\b/i, label: "Bank account field" },
  { pattern: /\brouting\s*number\b/i, label: "Routing number field" },
  { pattern: /\bpin\b/i, label: "PIN field" },
];

const SECRET_VALUES: LabeledPattern[] = [
  { pattern: /^sk-ant-[a-zA-Z0-9_-]{20,}/, label: "Anthropic API key" },
  { pattern: /^sk-[a-zA-Z0-9]{20,}/, label: "OpenAI API key" },
  { pattern: /^ghp_[a-zA-Z0-9]{36}/, label: "GitHub personal access token" },
  { pattern: /^gho_[a-zA-Z0-9]{36}/, label: "GitHub OAuth token" },
  { pattern: /^ghs_[a-zA-Z0-9]{36}/, label: "GitHub server-to-server token" },
  { pattern: /^xox[baprs]-[a-zA-Z0-9-]+/, label: "Slack token" },
  { pattern: /^AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { pattern: /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\./, label: "JWT token" },
  { pattern: /^-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, label: "Private key" },
  { pattern: /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}$/, label: "Card number" },
  { pattern: /^\d{4}\s?\d{4}\s?\d{4}$/, label: "Aadhaar number" },
  { pattern: /^[A-Z]{5}\d{4}[A-Z]$/, label: "PAN number" },
  { pattern: /^\d{3}-\d{2}-\d{4}$/, label: "SSN" },
];

const IRREVERSIBLE_CLICKS: RegExp[] = [
  /\b(buy|purchase|place\s*order|checkout|pay|payment)\b/i,
  /\b(send|reply|forward|post|publish|tweet|share)\b/i,
  /\b(delete|remove|discard|erase|deactivate|close\s*account)\b/i,
  /\b(confirm|submit|book\s*now|reserve|apply\s*now)\b/i,
  /\b(transfer|withdraw|donate|subscribe|upgrade)\b/i,
  /\b(sign\s*up|create\s*account|register)\b/i,
  /\b(accept|agree)\b/i,
];

export type PolicyVerdict =
  | { verdict: "allow" }
  | { verdict: "refuse"; reason: string }
  | { verdict: "confirm"; summary: string };

function findElement(snapshot: PageSnapshot | null | undefined, id: unknown): PageElement | undefined {
  if (!snapshot || typeof id != "number") return undefined;
  return snapshot.elements.find((element) => element.id === id);
}

function isSensitiveField(element: PageElement | undefined): boolean {
  if (!element) return false;
  if (element.role === "password" || element.attrs?.inputType === "password") return true;
  const context = `${element.name} ${element.attrs?.inputType ?? ""} ${element.role}`;
  return SENSITIVE_FIELDS.some((field) => field.pattern.test(context));
}

function sensitiveFieldLabel(element: PageElement | undefined): string {
  if (!element) return "credential field";
  const context = `${element.name} ${element.attrs?.inputType ?? ""} ${element.role}`;
  for (const { pattern, label } of SENSITIVE_FIELDS) if (pattern.test(context)) return label;
  return "credential field";
}

function secretValueLabel(text: string): string | undefined {
  for (const secret of SECRET_VALUES) if (secret.pattern.test(text)) return secret.label;
  return undefined;
}

/**
 * Decide whether a proposed action may run. Tool inputs here still contain
 * tokens (not resolved values), so typing "<CRED_1>" passes the secret checks.
 */
export function checkActionPolicy(
  action: ToolAction,
  snapshot: PageSnapshot | null | undefined,
  confirmRisky: boolean,
): PolicyVerdict {
  const target = findElement(snapshot, action.input.element_id);

  if (action.name === "type") {
    if (isSensitiveField(target)) {
      return {
        verdict: "refuse",
        reason: `Refusing to type into ${JSON.stringify(target?.name ?? "this field")} — ${sensitiveFieldLabel(target)}. Tell the user to fill it in themselves, then continue once they confirm they have.`,
      };
    }
    const text = String(action.input.text ?? "");
    const secret = secretValueLabel(text);
    if (secret) {
      return {
        verdict: "refuse",
        reason: `Refusing to type that value — it looks like a ${secret}. The user should enter it themselves.`,
      };
    }
    if (/\b\d{4}\s?\d{4}\s?\d{4}\b/.test(text)) {
      return {
        verdict: "refuse",
        reason:
          "Refusing to type that value — it looks like an Aadhaar number. Sensitive identity documents should be entered by the user directly.",
      };
    }
    if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)) {
      return {
        verdict: "refuse",
        reason:
          "Refusing to type that value — it looks like a PAN number. Tax identification documents should be entered by the user directly.",
      };
    }
  }

  if (!confirmRisky) return { verdict: "allow" };

  if (action.name === "click" && target) {
    const context = `${target.name} ${target.role}`;
    if (IRREVERSIBLE_CLICKS.some((pattern) => pattern.test(context))) {
      return { verdict: "confirm", summary: `Click ${JSON.stringify(target.name)} on ${snapshot?.title ?? "this page"}?` };
    }
  }

  if (
    action.name === "type" &&
    action.input.submit === true &&
    target &&
    !/search|query|find|filter/i.test(`${target.name} ${target.role}`)
  ) {
    return {
      verdict: "confirm",
      summary: `Fill ${JSON.stringify(target.name)} and submit the form on ${snapshot?.title ?? "this page"}?`,
    };
  }
  return { verdict: "allow" };
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /\b(system\s*prompt|you\s+are\s+now)\b/i,
  /\bas\s+an?\s+ai\s+(agent|assistant)[,:]/i,
  /\bdisregard\s+(your|the)\s+(instructions|rules)\b/i,
  /\bpretend\s+(you\s+are|to\s+be)\b/i,
  /\bjailbreak\b/i,
  /\bdo\s+anything\s+now\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bunrestricted\s+mode\b/i,
];

/** The first phrase on the page that reads like instructions to an AI agent. */
export function findInjectionText(snapshot: Pick<PageSnapshot, "text" | "title">): string | undefined {
  const haystack = `${snapshot.text} ${snapshot.title}`;
  for (const pattern of INJECTION_PATTERNS) {
    const match = haystack.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}
