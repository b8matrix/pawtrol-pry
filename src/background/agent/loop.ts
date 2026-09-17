// The agent loop. Each step: sanitize page state → ask the planner → check
// each tool call against policy → resolve tokens locally → execute → feed the
// sanitized result back. Raw values only exist in this worker and the page.

import type { PageSnapshot, Settings, ToolAction, TranscriptEntry } from "../../shared/types";
import { executeAction } from "../browser/executor";
import { isRestrictedUrl } from "../browser/executor";
import { TabController } from "../browser/tab-controller";
import { classifyFailure, classifyPageType, extractDomain, kindFromLeakLabel } from "../learning/classify";
import type { ActionRecord, Experience, PIIDetectionRecord } from "../learning/experience-memory";
import { buildSuppressionKeys, getApplicableRules, recommendsLLMOnly } from "../learning/learned-rules";
import { getLessons, getTrajectories, selectLessons, selectTrajectories } from "../learning/lessons";
import { logAction, logDetections, logRedaction, logSnapshot, logTokenization, logVerification } from "../privacy/ledger";
import { labelDetections, sanitizeSnapshot, type DetectionRecord, type LearningFilters } from "../privacy/sanitize";
import type { CapturedScreenshot, RedactionVerification, VisualDetection } from "../privacy/screenshot";
import { stripDigitsGluedToTokens, vault, type TokenSummary } from "../privacy/vault";
import { DEFAULT_VISION_MODELS, VISION_SUPPORTED, describeRedactedScreenshot } from "../privacy/vision";
import { createPlanner } from "../providers";
import type { ConversationMessage, PlannerResponse, ToolResultContent } from "../providers/types";
import {
  anySignal,
  byteLength,
  fitSnapshot,
  formatBytes,
  formatSnapshot,
  isRetryablePlannerError,
  stripUrlQuery,
  withTimeout,
} from "./context";
import { resolveDeterministically } from "./deterministic";
import { COMPACT_SYSTEM_PROMPT, SYSTEM_PROMPT, taskMessage } from "./prompts";
import { checkActionPolicy, findInjectionText } from "./safety";
import { IN_PAGE_TOOLS, TOOLS, describeToolCall } from "./tools";

export type AgentEvent =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "patch"; id: string; text?: string; pending?: boolean }
  | { kind: "egress"; bytes: number }
  | { kind: "experience"; experience: Experience }
  | { kind: string; [key: string]: unknown };

export interface AuditRecord {
  original: string;
  redacted: string;
  detections: { kind: string; label: string; confidence: number }[];
  tokens: TokenSummary[];
  redactedCount: number;
  verification?: RedactionVerification;
}

export interface PriorExchange {
  task: string;
  answer: string;
  timestamp: number;
}

export interface AgentDeps {
  settings: Settings;
  emit: (event: AgentEvent) => void;
  askConfirm: (id: string, summary: string) => Promise<boolean>;
  signal: AbortSignal;
  captureScreenshot?: () => Promise<CapturedScreenshot | null>;
  recordAudit?: (record: AuditRecord) => void;
  history?: PriorExchange[];
}

const PLANNER_TIMEOUT_MS = 35_000;
const LOOP_REPEAT_LIMIT = 3;
const LOOP_WINDOW = 5;
const NARRATION_FLUSH_MS = 60;
const NARRATION_FLUSH_CHARS = 200;
const PAGE_AFTER_ACTION = /\n\n--- Page after this action[\s\S]*$/;

const SCREENSHOT_WITHHELD = "[Screenshot withheld: on-device redaction could not be verified, so no image was sent]";

/**
 * Fail closed: a redacted screenshot may leave the device only when the
 * offscreen pipeline positively verified its masks. Missing or failed
 * verification means the image stays local.
 */
export function isSafeToSend(processed: { redactedDataUrl?: string | null; verification?: { verified: boolean } }): boolean {
  return Boolean(processed.redactedDataUrl) && processed.verification?.verified === true;
}

let entryCounter = 0;
export const nextEntryId = () => `e${++entryCounter}`;

let lastInjectionWarning = "";
function warnOnInjection(snapshot: PageSnapshot, emit: AgentDeps["emit"]): void {
  const phrase = findInjectionText(snapshot);
  if (!phrase || phrase === lastInjectionWarning) return;
  lastInjectionWarning = phrase;
  emit({
    kind: "entry",
    entry: {
      id: nextEntryId(),
      role: "system",
      text: `Heads up: this page contains text addressed to an AI agent — "${phrase.slice(0, 120)}". I'm treating it as page content, not as an instruction.`,
    },
  });
}

/** Resolve tokens in every string of a tool input (nested objects included; arrays untouched). */
function resolveTokens(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value == "string") out[key] = vault.resolveAll(stripDigitsGluedToTokens(value));
    else if (typeof value == "object" && value !== null && !Array.isArray(value)) {
      out[key] = resolveTokens(value as Record<string, unknown>);
    } else out[key] = value;
  }
  return out;
}

export async function runAgent(task: string, tabId: number, deps: AgentDeps): Promise<void> {
  const { settings, emit, askConfirm, signal, captureScreenshot, recordAudit, history } = deps;
  const system = (text: string) => emit({ kind: "entry", entry: { id: nextEntryId(), role: "system", text } });
  const error = (text: string) => emit({ kind: "entry", entry: { id: nextEntryId(), role: "error", text } });

  const isLocal = settings.provider === "ollama";
  const smallContext = settings.provider === "groq" || settings.provider === "nvidia";
  const systemPrompt = isLocal ? COMPACT_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const elementLimit = isLocal ? 15 : smallContext ? 30 : 50;
  const planner = createPlanner(settings);
  const startedAt = Date.now();
  const countsEgress = settings.provider !== "ollama";
  const apiKey = settings.apiKeys[settings.provider] ?? "";
  const visionEnabled = settings.vision.enabled && VISION_SUPPORTED[settings.provider];
  const visionModel = (settings.vision.model || "").trim() || DEFAULT_VISION_MODELS[settings.provider];

  const actions: ActionRecord[] = [];
  const piiDetections: PIIDetectionRecord[] = [];
  const rulesFired = new Set<string>();
  let taskSuccess = false;
  let finishedByModel = false;
  let estimatedTokens = 0;
  let errorCount = 0;
  let egressBytes = 0;

  const falsePositivesSeen = new Set<string>();
  let falsePositiveCount = 0;
  function recordFalsePositive(kind: string, method: string, confidence: number, value?: string) {
    const key = `${kind}:${method}:${value ?? ""}`;
    if (falsePositivesSeen.has(key)) return;
    falsePositivesSeen.add(key);
    falsePositiveCount++;
    piiDetections.push({ kind, method, outcome: "false_positive", confidence });
  }

  const leaksSeen = new Set<string>();
  let reocrVerified = true;
  const reocrLeakedPII: string[] = [];
  function noteVerification(verification: RedactionVerification | undefined) {
    if (!verification) return;
    if (!verification.verified) reocrVerified = false;
    for (const leak of verification.leakedPatterns ?? []) {
      if (leaksSeen.has(leak)) continue;
      leaksSeen.add(leak);
      reocrLeakedPII.push(leak);
      piiDetections.push({
        kind: kindFromLeakLabel(leak.replace(/^OCR:\s*/, "")),
        method: "ocr",
        outcome: "missed",
        confidence: 0.6,
      });
    }
  }

  let controller = new TabController(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) {
    error(`I can't work on ${tab.url} — Chrome blocks extensions on its own pages. Open a normal website and try again.`);
    return;
  }

  let snapshot: PageSnapshot | undefined | null;

  async function appendVisionObservation(redactedDataUrl: string, text: string): Promise<string> {
    if (!visionEnabled || !apiKey) return text;
    const context = snapshot ? formatSnapshot(snapshot) : `URL: ${stripUrlQuery(tab.url ?? "")}`;
    try {
      const observation = await describeRedactedScreenshot(
        settings.provider,
        visionModel,
        apiKey,
        redactedDataUrl,
        context,
        signal,
      );
      egressBytes += observation.bytes;
      estimatedTokens += Math.ceil(observation.bytes / 4);
      emit({ kind: "egress", bytes: egressBytes });
      return `${text}\n\n[VLM observation (${observation.model}): ${observation.text}]`;
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 140) : "vision unavailable";
      return `${text}\n\n[VLM observation unavailable: ${reason}]`;
    }
  }

  const domain = extractDomain(tab.url ?? "");
  system(`Using ${planner.label}. Privacy pipeline: active.`);
  await controller.waitForLoad();

  snapshot = await controller.snapshot();
  let elementsAtStepStart: PageSnapshot["elements"] = [];
  const pageType = classifyPageType(tab.url ?? "", tab.title ?? "", snapshot?.text ?? "");
  const [rules, lessons, trajectories] = await Promise.all([
    getApplicableRules(domain, pageType),
    getLessons(),
    getTrajectories(),
  ]);
  const filters: LearningFilters = {
    fpKeys: buildSuppressionKeys(rules),
    llmOnly: recommendsLLMOnly(rules),
    ruleCount: rules.length,
  };
  if (rules.length > 0) {
    const fpRules = rules.filter((r) => r.category === "pii_detection").length;
    const strategyRules = rules.filter((r) => r.category === "strategy").length;
    system(
      `Learning: applying ${rules.length} stored rule(s) for ${domain} (${fpRules} false-positive filter${fpRules === 1 ? "" : "s"}, ${strategyRules} strategy rule${strategyRules === 1 ? "" : "s"}${filters.llmOnly ? ", deterministic disabled by learning" : ""}).`,
    );
  }

  let totalRedacted = 0;
  let lastDomDetections: DetectionRecord[] = [];

  function recordSanitizeOutcome(result: ReturnType<typeof sanitizeSnapshot>) {
    for (const d of result.detections) {
      piiDetections.push({ kind: d.kind, method: d.method, outcome: "true_positive", confidence: d.confidence });
    }
    for (const d of result.suppressed) {
      rulesFired.add(`${d.kind}:${d.method}`);
      recordFalsePositive(d.kind, d.method, d.confidence, d.value);
    }
    for (const d of result.rejected) recordFalsePositive(d.kind, d.method, d.confidence, d.value);
  }

  function recordVisualDetections(detections: VisualDetection[]) {
    for (const d of detections) {
      piiDetections.push({ kind: d.kind, method: "visual", outcome: "true_positive", confidence: d.confidence });
    }
  }

  if (snapshot) {
    logSnapshot(snapshot.url, snapshot.title, snapshot.elements.length).catch(() => {});
    const result = sanitizeSnapshot(snapshot, filters);
    snapshot = result.sanitized;
    lastDomDetections = result.detections;
    if (result.detections.length > 0) {
      logDetections(result.detections.map((d) => ({ ...d, label: d.kind }))).catch(() => {});
    }
    const tokens = vault.getTokenSummary();
    if (tokens.length > 0) logTokenization(tokens).catch(() => {});
    if (result.piiCount > 0) logRedaction(result.piiCount, "dom").catch(() => {});
    totalRedacted += result.piiCount;
    recordSanitizeOutcome(result);

    const filtered = result.suppressed.length + result.rejected.length;
    if (filtered > 0) {
      system(
        `Learned filters: rejected ${filtered} false positive(s) (${result.suppressed.length} rule-based, ${result.rejected.length} checksum-verified as lookalikes).`,
      );
    }
    if (result.piiCount > 0) system(`Privacy: detected and redacted ${result.piiCount} sensitive item(s) from page context.`);
  }

  let initialObservation = "";
  if (captureScreenshot) {
    try {
      const capture = await captureScreenshot();
      if (capture) {
        const processed = capture.processed;
        const visual = processed.detections.map((d) => ({ kind: d.kind, label: d.label, confidence: d.confidence }));
        const verification = processed.verification;
        noteVerification(verification);
        if (visual.length > 0) logDetections(visual.map((d) => ({ ...d, method: "visual" }))).catch(() => {});
        if (processed.redactedCount > 0) logRedaction(processed.redactedCount, "visual").catch(() => {});
        if (verification && verification.regionsChecked > 0) {
          logVerification(verification.verified, verification.regionsChecked, verification.leakedPatterns.length).catch(
            () => {},
          );
        }
        recordVisualDetections(visual);
        totalRedacted += processed.redactedCount;
        recordAudit?.({
          original: capture.original,
          redacted: processed.redactedDataUrl,
          detections: [...visual, ...labelDetections(lastDomDetections)],
          tokens: vault.getTokenSummary(),
          redactedCount: processed.redactedCount,
          verification,
        });
        if (visionEnabled && apiKey && !signal.aborted) {
          initialObservation = isSafeToSend(processed)
            ? await appendVisionObservation(processed.redactedDataUrl, "")
            : SCREENSHOT_WITHHELD;
        }
      }
    } catch {}
  }

  const { task: tokenizedTask, tokenCount: taskTokens } = vault.tokenizeTask(task);
  if (taskTokens > 0) system(`Task privacy: tokenized ${taskTokens} PII item(s) in your request.`);

  let previousConversation = "";
  if (history && history.length > 0) {
    const transcript = history.map((h) => `You asked: ${h.task}\nYou answered: ${h.answer}`).join("\n\n");
    const tokenized = vault.tokenizeTask(transcript);
    if (tokenized.tokenCount > 0) {
      system(`Memory: tokenized ${tokenized.tokenCount} PII item(s) from earlier tasks in context.`);
    }
    previousConversation = `--- Previous conversation (earlier tasks) ---\n${tokenized.task}\n--- End previous conversation ---`;
  }

  const relevantLessons = selectLessons(lessons, domain, pageType);
  const lessonsBlock =
    relevantLessons.length === 0
      ? ""
      : `--- Lessons learned on this site (from past runs) ---\n${relevantLessons.map((l) => `- ${l.text}`).join("\n")}\n--- End lessons ---`;
  const pastSuccesses = selectTrajectories(trajectories, domain, pageType);
  const trajectoriesBlock =
    pastSuccesses.length === 0
      ? ""
      : `--- How similar tasks succeeded here before ---\n${pastSuccesses
          .map((t) => `Task: ${t.task}\nSteps: ${t.steps}`)
          .join("\n\n")}\n--- End past successes ---`;

  if (snapshot && snapshot.elements.length > elementLimit) {
    snapshot = fitSnapshot(snapshot, elementLimit, smallContext);
  }

  const messages: ConversationMessage[] = [
    {
      role: "user",
      content:
        (previousConversation ? `${previousConversation}\n\n` : "") +
        (lessonsBlock ? `${lessonsBlock}\n\n` : "") +
        (trajectoriesBlock ? `${trajectoriesBlock}\n\n` : "") +
        taskMessage(tokenizedTask, stripUrlQuery(tab.url ?? ""), tab.title ?? "") +
        (snapshot ? `\n\n--- Current page ---\n${formatSnapshot(snapshot)}` : "") +
        (initialObservation ? `\n\n${initialObservation}` : ""),
    },
  ];
  elementsAtStepStart = snapshot?.elements ?? [];
  if (snapshot) warnOnInjection(snapshot, emit);

  // Loop detection over the last few tool calls (unresolved inputs).
  const recentCalls: { name: string; input: string }[] = [];
  function rememberCall(name: string, input: unknown) {
    recentCalls.push({ name, input: JSON.stringify(input) });
    if (recentCalls.length > LOOP_WINDOW) recentCalls.shift();
  }
  function isLooping(): boolean {
    if (recentCalls.length < LOOP_REPEAT_LIMIT) return false;
    const last = recentCalls[recentCalls.length - 1];
    let repeats = 0;
    for (let i = recentCalls.length - 1; i >= 0 && recentCalls[i].name === last.name && recentCalls[i].input === last.input; i--) {
      repeats++;
    }
    if (repeats >= LOOP_REPEAT_LIMIT) return true;
    if (recentCalls.length >= 4) {
      const [d, c, b, a] = recentCalls.slice(-4);
      // A-B-A-B ping-pong.
      if (a.name === c.name && a.input === c.input && b.name === d.name && b.input === d.input) return true;
    }
    return false;
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    const anySuccess = actions.some((a) => a.success);
    taskSuccess = errorCount === 0 && (anySuccess || actions.length === 0) && finishedByModel;
    system(
      `Task ended. Total PII items redacted: ${totalRedacted}. ` +
        (filters.ruleCount > 0 || falsePositiveCount > 0
          ? `Learning: ${filters.ruleCount} rule(s) consulted, ${falsePositiveCount} false positive(s) filtered. `
          : "") +
        (countsEgress ? `Egress: ${formatBytes(egressBytes)}. ` : "Local planner: zero egress. ") +
        "Token vault cleared.",
    );
    const experience: Experience = {
      id: `exp-${startedAt}`,
      timestamp: startedAt,
      task: tokenizedTask,
      domain,
      pageType,
      piiDetections,
      actions,
      taskSuccess,
      durationMs: Date.now() - startedAt,
      piiRedacted: totalRedacted,
      estimatedTokens,
      rulesApplied: filters.ruleCount,
      egressBytes,
      reocrVerified,
      reocrLeakedPII,
      rulesFired: [...rulesFired],
      rulesGenerated: [],
      userCorrections: [],
    };
    emit({ kind: "experience", experience });
    emit({ kind: "egress", bytes: egressBytes });
    vault.clear();
  }

  for (let step = 0; step < settings.maxSteps; step++) {
    if (signal.aborted) {
      finish();
      return;
    }
    elementsAtStepStart = snapshot?.elements ?? [];
    if (isLooping()) {
      error(
        `Loop detected: repeated "${recentCalls[recentCalls.length - 1].name}" ${LOOP_REPEAT_LIMIT} times. Stopping to prevent infinite loop. The page may need manual interaction.`,
      );
      finish();
      return;
    }

    // Zero-LLM fast path for simple one-shot commands on the first step.
    if (step === 0 && !filters.llmOnly) {
      const resolved = resolveDeterministically(task, snapshot ?? null);
      if (resolved.resolved && resolved.action) {
        const entryId = nextEntryId();
        emit({
          kind: "entry",
          entry: {
            id: entryId,
            role: "step",
            action: resolved.action.name,
            text: resolved.explanation ?? "Deterministic resolution",
            pending: true,
          },
        });
        if (checkActionPolicy(resolved.action, snapshot, settings.confirmRisky).verdict === "allow") {
          rememberCall(resolved.action.name, resolved.action.input);
          const t0 = performance.now();
          const outcome = await executeAction(controller, resolved.action);
          const latencyMs = performance.now() - t0;
          controller = outcome.controller;
          const detail = vault.redactValues(outcome.result.detail);
          actions.push({
            tool: resolved.action.name,
            success: outcome.result.ok,
            latencyMs,
            strategy: "deterministic",
            error: outcome.result.ok ? undefined : detail,
            cause: outcome.result.ok ? undefined : classifyFailure(outcome.result.detail),
          });
          emit({ kind: "patch", id: entryId, text: detail, pending: false });
          if (outcome.result.snapshot) snapshot = sanitizeSnapshot(outcome.result.snapshot, filters).sanitized;
          const callId = `det-${entryId}`;
          messages.push({
            role: "assistant",
            text: resolved.explanation ?? "",
            toolCalls: [{ id: callId, name: resolved.action.name, input: resolved.action.input }],
          });
          messages.push({ role: "tool", results: [{ id: callId, content: detail, isError: !outcome.result.ok }] });
          continue;
        }
      }
    }

    // Stream narration to the panel in small redacted batches.
    const narrationId = nextEntryId();
    let narrationStarted = false;
    let narrationBuffer = "";
    let narrationTimer: ReturnType<typeof setInterval> | null = null;
    const flushNarration = () => {
      if (narrationBuffer.length === 0) return;
      const text = vault.redactValues(narrationBuffer);
      narrationBuffer = "";
      if (narrationStarted) emit({ kind: "patch", id: narrationId, text });
      else {
        narrationStarted = true;
        emit({ kind: "entry", entry: { id: narrationId, role: "assistant", text } });
      }
    };
    const onText = (delta: string) => {
      narrationBuffer += delta;
      if (narrationBuffer.length >= NARRATION_FLUSH_CHARS) {
        flushNarration();
        return;
      }
      if (narrationTimer === null) {
        narrationTimer = setInterval(() => {
          flushNarration();
          if (narrationBuffer.length === 0 && narrationTimer !== null) {
            clearInterval(narrationTimer);
            narrationTimer = null;
          }
        }, NARRATION_FLUSH_MS);
      }
    };

    if (countsEgress) {
      try {
        const bytes = byteLength(JSON.stringify({ system: systemPrompt, messages, tools: TOOLS }));
        egressBytes += bytes;
        estimatedTokens += Math.ceil(bytes / 4);
        emit({ kind: "egress", bytes: egressBytes });
      } catch {}
    }

    const stallMessage = `The planner (${planner.label}) did not respond within ${Math.round(PLANNER_TIMEOUT_MS / 1000)}s. The provider may be overloaded or the network stalled.`;
    const callPlanner = (attempt: AbortController) =>
      withTimeout(
        planner.run({
          system: systemPrompt,
          messages,
          tools: TOOLS,
          signal: anySignal(signal, attempt.signal),
          onText,
        }),
        PLANNER_TIMEOUT_MS,
        stallMessage,
        () => attempt.abort(),
      );

    // Last line of defense: re-redact any vault value that slipped into context.
    for (const message of messages) {
      if (message.role === "user" && typeof message.content == "string") {
        message.content = vault.redactValues(message.content);
      }
      if (message.role === "tool") {
        for (const result of message.results) {
          if (typeof result.content == "string") result.content = vault.redactValues(result.content);
        }
      }
    }

    let response: PlannerResponse;
    try {
      response = await callPlanner(new AbortController());
    } catch (err) {
      if (signal.aborted) {
        finish();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryablePlannerError(message)) {
        errorCount++;
        error(message);
        finish();
        return;
      }
      system(`Planner stalled (${message.slice(0, 120)}) — retrying once…`);
      try {
        response = await callPlanner(new AbortController());
      } catch (retryErr) {
        if (signal.aborted) {
          finish();
          return;
        }
        errorCount++;
        error(
          (retryErr instanceof Error ? retryErr.message : String(retryErr)) +
            " Retried once and failed again — switch to a faster provider/model (Groq openai/gpt-oss-20b) in the options and rerun.",
        );
        finish();
        return;
      }
    } finally {
      flushNarration();
      if (narrationTimer !== null) {
        clearInterval(narrationTimer);
        narrationTimer = null;
      }
    }

    messages.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls });
    if (response.stopReason === "refusal") {
      errorCount++;
      error(`The model declined this request (${response.refusal ?? "unspecified"}).`);
      finish();
      return;
    }
    if (response.toolCalls.length === 0) {
      finishedByModel = true;
      finish();
      return;
    }

    const results: ToolResultContent[] = [];
    for (const call of response.toolCalls) {
      if (signal.aborted) return;
      const action: ToolAction = { name: call.name, input: call.input };
      const stepId = nextEntryId();
      emit({
        kind: "entry",
        entry: { id: stepId, role: "step", action: call.name, text: describeToolCall(call.name, call.input), pending: true },
      });

      const verdict = checkActionPolicy(action, snapshot, settings.confirmRisky);
      if (verdict.verdict === "refuse") {
        emit({ kind: "patch", id: stepId, text: `Blocked — ${verdict.reason}`, pending: false });
        results.push({ id: call.id, content: verdict.reason, isError: true });
        continue;
      }
      if (verdict.verdict === "confirm" && !(await askConfirm(stepId, verdict.summary))) {
        emit({ kind: "patch", id: stepId, text: "Declined by user.", pending: false });
        results.push({
          id: call.id,
          isError: true,
          content:
            "The user declined this action. Do not retry it. Ask them what they want instead, or continue with the rest of the task.",
        });
        continue;
      }

      // Stale element id: re-read the page and, for click/type, re-target a
      // unique element with the same role and name.
      const requestedId = call.input.element_id;
      if (typeof requestedId == "number") {
        const previous = elementsAtStepStart.find((e) => e.id === requestedId);
        if (!snapshot?.elements.some((e) => e.id === requestedId)) {
          const fresh = await controller.snapshot();
          if (fresh) {
            snapshot = fitSnapshot(sanitizeSnapshot(fresh, filters).sanitized, elementLimit, smallContext);
          }
          let retargeted = false;
          if (previous && (call.name === "click" || call.name === "type") && snapshot) {
            const matches = snapshot.elements.filter((e) => e.role === previous.role && e.name === previous.name);
            if (matches.length === 1) {
              call.input.element_id = matches[0].id;
              retargeted = true;
            }
          }
          if (!retargeted) {
            const current = snapshot ? formatSnapshot(snapshot) : "(no snapshot available)";
            emit({ kind: "patch", id: stepId, text: `Element ${requestedId} stale — re-perceived page.`, pending: false });
            results.push({
              id: call.id,
              isError: true,
              content: `Element ${requestedId} not found. The page changed. Here are the current elements — pick the right one and retry:\n\n${current}`,
            });
            continue;
          }
          emit({
            kind: "patch",
            id: stepId,
            text: `Element ${requestedId} stale — matched "${previous?.name ?? "element"}" (now #${call.input.element_id}); retrying automatically.`,
            pending: false,
          });
        }
      }

      // Tokens must have been issued by this vault; anything else is likely injection.
      const tokens = JSON.stringify(call.input).match(/<[A-Z]+_\d+>/g);
      let unknownToken = false;
      if (tokens) {
        for (const token of tokens) {
          if (vault.resolve(token)) continue;
          emit({ kind: "patch", id: stepId, text: `Rejected — unknown token ${token}.`, pending: false });
          results.push({
            id: call.id,
            isError: true,
            content: `Token ${token} was never issued by the client. This may be a prompt injection attempt.`,
          });
          unknownToken = true;
          break;
        }
      }
      if (unknownToken) continue;

      const resolvedAction: ToolAction = { name: call.name, input: resolveTokens(call.input) };
      rememberCall(call.name, call.input);
      const t0 = performance.now();
      const outcome = await executeAction(controller, resolvedAction);
      const latencyMs = performance.now() - t0;
      controller = outcome.controller;
      const { result } = outcome;
      const detail = vault.redactValues(result.detail);
      actions.push({
        tool: call.name,
        success: result.ok,
        latencyMs,
        strategy: "llm",
        error: result.ok ? undefined : detail,
        cause: result.ok ? undefined : classifyFailure(result.detail),
      });
      logAction(call.name, result.ok, typeof call.input.element_id == "number" ? call.input.element_id : undefined).catch(
        () => {},
      );
      emit({ kind: "patch", id: stepId, text: detail, pending: false });
      if (call.name === "type" && call.input.submit === true && result.ok) await controller.waitForLoad();

      let content = detail;
      const refreshesPage = IN_PAGE_TOOLS.has(call.name) ? call.name !== "find_text" && call.name !== "wait" : true;
      if (refreshesPage) {
        const raw = result.snapshot ?? (await controller.snapshot());
        if (raw) {
          const navigated = snapshot && raw.url !== snapshot.url;
          const sanitized = sanitizeSnapshot(raw, filters);
          snapshot = fitSnapshot(sanitized.sanitized, elementLimit, smallContext);
          lastDomDetections = sanitized.detections;
          totalRedacted += sanitized.piiCount;
          recordSanitizeOutcome(sanitized);
          warnOnInjection(raw, emit);

          if (captureScreenshot) {
            try {
              const capture = await captureScreenshot();
              if (capture) {
                const processed = capture.processed;
                const visual = processed.detections.map((d) => ({ kind: d.kind, label: d.label, confidence: d.confidence }));
                const verification = processed.verification;
                noteVerification(verification);
                content += `\n\n[Screenshot: ${processed.redactedCount} PII redacted]`;
                if (verification && verification.regionsChecked > 0) {
                  content += verification.verified
                    ? ` [Re-OCR VERIFIED: ${verification.regionsRedacted}/${verification.regionsChecked} regions confirmed redacted]`
                    : ` [Re-OCR WARNING: ${verification.summary}]`;
                }
                if (visual.length > 0) logDetections(visual.map((d) => ({ ...d, method: "visual" }))).catch(() => {});
                if (processed.redactedCount > 0) logRedaction(processed.redactedCount, "visual").catch(() => {});
                if (verification && verification.regionsChecked > 0) {
                  logVerification(verification.verified, verification.regionsChecked, verification.leakedPatterns.length).catch(
                    () => {},
                  );
                }
                recordVisualDetections(visual);
                totalRedacted += processed.redactedCount;
                recordAudit?.({
                  original: capture.original,
                  redacted: processed.redactedDataUrl,
                  detections: [...visual, ...labelDetections(sanitized.detections)],
                  tokens: vault.getTokenSummary(),
                  redactedCount: processed.redactedCount,
                  verification,
                });
                if (visionEnabled && apiKey && !signal.aborted) {
                  content = isSafeToSend(processed)
                    ? await appendVisionObservation(processed.redactedDataUrl, content)
                    : `${content}\n\n${SCREENSHOT_WITHHELD}`;
                }
              }
            } catch {}
          }

          content +=
            sanitized.piiCount > 0
              ? `\n\n--- Page after this action (redacted ${sanitized.piiCount} PII) ---\n` + formatSnapshot(snapshot)
              : (navigated ? "\n\nThe page navigated." : "") + `\n\n--- Page after this action ---\n${formatSnapshot(snapshot)}`;
        }
      }
      results.push({ id: call.id, content, isError: !result.ok });
    }

    // Only the newest page state stays in context.
    for (const message of messages) {
      if (message.role !== "tool") continue;
      for (const result of message.results) {
        if (result.content.includes("\n\n--- Page after this action")) {
          result.content = result.content.replace(
            PAGE_AFTER_ACTION,
            "\n\n[Previous page snapshot omitted — see latest read]",
          );
        }
      }
    }
    messages.push({ role: "tool", results });
  }
  finish();
}
