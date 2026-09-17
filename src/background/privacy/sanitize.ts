// The DOM privacy pipeline: detect → drop learned false positives → tokenize →
// redact leftovers. Every snapshot passes through `sanitizeSnapshot` before it
// is formatted into model context.

import type { Detection, DetectionKind, PageSnapshot } from "../../shared/types";
import { detectContextualPII, toDetections } from "./contextual";
import { detectSnapshotPII, redactDetections } from "./detectors";
import { vault } from "./vault";

export interface LearningFilters {
  /** "<kind>:<method>" pairs that learned rules say are false positives here. */
  fpKeys: Set<string>;
  /** A learned strategy rule says skip the deterministic planner. */
  llmOnly: boolean;
  ruleCount: number;
}

export const NO_LEARNING: LearningFilters = { fpKeys: new Set(), llmOnly: false, ruleCount: 0 };

export interface DetectionRecord {
  kind: DetectionKind;
  method: string;
  confidence: number;
  value?: string;
}

export interface SanitizeResult {
  sanitized: PageSnapshot;
  piiCount: number;
  detections: DetectionRecord[];
  suppressed: DetectionRecord[];
  rejected: DetectionRecord[];
}

export function sanitizeSnapshot(snapshot: PageSnapshot, filters: LearningFilters = NO_LEARNING): SanitizeResult {
  const regexResult = detectSnapshotPII(snapshot);
  const contextual = toDetections(detectContextualPII(snapshot));
  const suppressed: DetectionRecord[] = [];

  const regexKept = regexResult.detections.filter((d) => {
    if (!filters.fpKeys.has(`${d.kind}:regex`)) return true;
    suppressed.push({ kind: d.kind, method: "regex", confidence: d.confidence, value: d.value });
    return false;
  });

  // A contextual hit on an element regex already covered adds nothing.
  const coveredSelectors = new Set(regexKept.filter((d) => d.elementSelector).map((d) => d.elementSelector));
  const contextualKept = contextual
    .filter((d) => !d.elementSelector || !coveredSelectors.has(d.elementSelector))
    .filter((d) => {
      if (!filters.fpKeys.has(`${d.kind}:contextual`)) return true;
      suppressed.push({ kind: d.kind, method: "contextual", confidence: d.confidence, value: d.value });
      return false;
    });

  const all: Detection[] = [...regexKept, ...contextualKept];
  const tokenized = vault.tokenizeDetections(snapshot, all);
  const vaulted = vault.redactVaultValuesInSnapshot({ elements: tokenized.elements, text: tokenized.text });
  const { elements, text, redactedCount } = redactDetections(vaulted, all);

  return {
    sanitized: { ...snapshot, elements, text },
    piiCount: tokenized.tokenCount + redactedCount,
    detections: [
      ...regexKept.map((d) => ({ kind: d.kind, method: "regex", confidence: d.confidence })),
      ...contextualKept.map((d) => ({ kind: d.kind, method: "contextual", confidence: d.confidence })),
    ],
    suppressed,
    rejected: regexResult.rejected.map((d) => ({
      kind: d.kind,
      method: "checksum",
      confidence: d.confidence,
      value: d.value,
    })),
  };
}

const DETECTION_LABELS: Partial<Record<DetectionKind, string>> = {
  credential: "Credential (text)",
  id_number: "ID number (text)",
  api_key: "API key",
  pii_text: "PII text",
  face: "Face",
};

export function labelDetections(detections: DetectionRecord[]) {
  return detections.map((d) => ({ kind: d.kind, label: DETECTION_LABELS[d.kind] ?? d.kind, confidence: d.confidence }));
}
