// Loads pure functions straight out of the legacy minified service-worker.js
// (still at the repo root) so the TypeScript port can be tested against the
// code that actually shipped. Regions are located by unique literal markers.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "service-worker.js"), "utf8");

function region(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Legacy marker not found: ${start} … ${end}`);
  return source.slice(from, to);
}

const code = [
  region('var ay="PII"', "function P(r,e,t,n,s){"), // settings, prompts, tools, deterministic, executor, safety, detectors, vault
  region("function Jf(", "function o_("), // extractDomain, classifyPageType
  region("function Xf(", "Eu();var eh="), // classifyFailure, contextual detection
  region("var MS=0", "async function O_("), // stripUrlQuery, formatSnapshot, sanitize
  region("function oh(", "Eu();var gr="), // reflection
].join("\n;\n");

// eslint-disable-next-line @typescript-eslint/no-implied-eval
export const legacy: Record<string, any> = new Function(
  `${code}
  return {
    TokenVault: Ku, stripDigitsGluedToTokens: Mh, maskSample: Ty, vault: Be,
    isValidAadhaar: Th, isLuhnValid: Ch,
    detectElementPII: Ry, detectTextPII: vy, detectSnapshotPII: $h, redactDetections: Oh,
    checkActionPolicy: qu, findInjectionText: vh,
    resolveDeterministically: Sh, resolveSiteShortcut: ra,
    normalizeNavigationUrl: Ph, isRestrictedUrl: Hu, browserErrorOf: Uu,
    normalizeSettings: wh,
    detectContextualPII: c_, toDetections: l_, looksLikePersonName: a_, looksLikeOrganization: mS,
    looksLikeAddress: gS, looksLikePhone: _S,
    classifyFailure: Xf, classifyPageType: Gf, extractDomain: Jf,
    formatSnapshot: Sc, stripUrlQuery: sh, sanitizeSnapshot: Cu,
    reflectOnExperience: oh,
  };`,
)();
