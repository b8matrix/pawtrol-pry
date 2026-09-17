// Shared data shapes that cross context boundaries (worker <-> content script
// <-> side panel <-> offscreen document). Field names are part of the wire
// protocol with the existing side panel bundle — do not rename them.

export type ProviderId = "anthropic" | "openai" | "openrouter" | "ollama" | "groq" | "nvidia";

export interface Settings {
  provider: ProviderId;
  apiKeys: Record<ProviderId, string>;
  models: Record<ProviderId, string>;
  maxSteps: number;
  confirmRisky: boolean;
  vision: { enabled: boolean; model: string };
  privacy: {
    blurFaces: boolean;
    maskCredentials: boolean;
    tokenizePII: boolean;
    showRedactionLabels: boolean;
  };
}

// ---------------------------------------------------------------------------
// Page snapshot (produced by the content script)
// ---------------------------------------------------------------------------

export interface ElementAttrs {
  checked?: string;
  required?: string;
  inputType?: string;
  disabled?: string;
  expanded?: string;
  selected?: string;
  href?: string;
  offscreen?: string;
  [key: string]: string | undefined;
}

export interface PageElement {
  id: number;
  role: string;
  name: string;
  value?: string;
  attrs?: ElementAttrs;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
  text: string;
  truncated: boolean;
  scroll: { y: number; maxY: number };
}

/** A screen-space box the content script believes is sensitive (CSS pixels). */
export interface SensitiveRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Actions and tool results
// ---------------------------------------------------------------------------

export type ToolInput = Record<string, unknown>;

export interface ToolAction {
  name: string;
  input: ToolInput;
}

export interface ActionResult {
  ok: boolean;
  detail: string;
  snapshot?: PageSnapshot;
}

// ---------------------------------------------------------------------------
// PII detection
// ---------------------------------------------------------------------------

export type DetectionKind =
  | "credential"
  | "id_number"
  | "api_key"
  | "pii_text"
  | "face"
  | "person"
  | "organization";

export interface Detection {
  kind: DetectionKind;
  value?: string;
  elementSelector?: string;
  confidence: number;
  label: string;
}

export type DetectionMethod =
  | "regex"
  | "contextual"
  | "checksum"
  | "visual"
  | "ocr"
  | "user"
  | "learned_rule";

// ---------------------------------------------------------------------------
// Transcript entries pushed to the side panel
// ---------------------------------------------------------------------------

export type EntryRole = "user" | "assistant" | "system" | "error" | "step" | "egress";

export interface TranscriptEntry {
  id: string;
  role: EntryRole;
  text: string;
  action?: string;
  pending?: boolean;
}
