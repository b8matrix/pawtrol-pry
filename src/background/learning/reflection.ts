// Rule-based reflection over a finished run: turns false positives, misses,
// planner outcomes and OCR leaks into LearnedRules. No model call.

import type { Experience, PIIDetectionRecord } from "./experience-memory";
import type { LearnedRule, ReflectionResults } from "./learned-rules";

export interface ReflectionMetrics {
  falsePositives: number;
  falseNegatives: number;
  strategyOptimizations: number;
  sitePatternsFound: number;
}

export interface Reflection extends ReflectionResults {
  summary: string;
  metrics: ReflectionMetrics;
}

const ruleId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function newRule(
  prefix: string,
  fields: Pick<LearnedRule, "category" | "description" | "pattern" | "confidence"> & { confirmedCount?: number },
): LearnedRule {
  const now = Date.now();
  return {
    id: ruleId(prefix),
    confirmedCount: 0,
    createdAt: now,
    lastConfirmedAt: now,
    ...fields,
  };
}

/**
 * @param visitsBefore  prior runs on this domain (repeat-visit rules need ≥1)
 * @param domainHistory prior experiences on this domain (for repeated-failure rules)
 */
export function reflectOnExperience(
  experience: Experience,
  existingRules: LearnedRule[],
  visitsBefore = 0,
  domainHistory: Experience[] = [],
): Reflection {
  const newRules: LearnedRule[] = [];
  const confirmedRules: string[] = [];
  const contradictedRules: string[] = [];
  let falsePositives = 0;
  let falseNegatives = 0;
  let strategyOptimizations = 0;
  let sitePatternsFound = 0;

  for (const detection of experience.piiDetections) {
    if (detection.outcome === "false_positive") {
      falsePositives++;
      const rule = falsePositiveRule(experience, detection, existingRules);
      if (rule) newRules.push(rule);
    }
    if (detection.outcome === "missed") {
      falseNegatives++;
      const rule = missedDetectionRule(experience, detection, existingRules);
      if (rule) newRules.push(rule);
    }
    if (detection.outcome === "true_positive" && detection.method === "learned_rule") {
      const rule = existingRules.find(
        (r) => r.category === "pii_detection" && r.pattern.condition.includes(detection.kind),
      );
      if (rule) confirmedRules.push(rule.id);
    }
  }

  for (const fired of experience.rulesFired ?? []) {
    const rule = existingRules.find(
      (r) => r.category === "pii_detection" && r.pattern.condition === `false_positive:${fired}`,
    );
    if (rule && !confirmedRules.includes(rule.id)) confirmedRules.push(rule.id);
  }

  const deterministicActions = experience.actions.filter((a) => a.strategy === "deterministic");
  const llmActions = experience.actions.filter((a) => a.strategy === "llm");

  if (deterministicActions.length > 0 && experience.taskSuccess) {
    const rule = strategyRule(experience, "deterministic", existingRules);
    if (rule) {
      newRules.push(rule);
      strategyOptimizations++;
    }
  }
  if (
    llmActions.length > 0 &&
    deterministicActions.length === 0 &&
    experience.taskSuccess &&
    /^(click|fill|scroll|navigate|press)/i.test(experience.task)
  ) {
    const rule = strategyRule(experience, "deterministic", existingRules);
    if (rule) {
      newRules.push(rule);
      strategyOptimizations++;
    }
  }
  if (!experience.taskSuccess && deterministicActions.length > 0) {
    const rule = strategyRule(experience, "llm", existingRules);
    if (rule) {
      newRules.push(rule);
      strategyOptimizations++;
    }
  }

  if (experience.taskSuccess && visitsBefore >= 1 && experience.domain) {
    const usedLLM = llmActions.length > 0;
    const usedDeterministic = deterministicActions.length > 0;
    if (usedLLM || usedDeterministic) {
      const winner =
        usedLLM && (!usedDeterministic || llmActions.length >= deterministicActions.length) ? "llm" : "deterministic";
      const rule = repeatedSuccessRule(experience, winner, existingRules);
      if (rule) {
        newRules.push(rule);
        strategyOptimizations++;
      }
    }
  }

  const failureCauses = new Map<string, number>();
  for (const action of experience.actions) {
    if (!action.success && action.cause && action.strategy === "deterministic") {
      failureCauses.set(action.cause, (failureCauses.get(action.cause) ?? 0) + 1);
    }
  }
  const historicalCauses = new Set<string>();
  for (const past of domainHistory) {
    for (const action of past.actions) if (!action.success && action.cause) historicalCauses.add(action.cause);
  }
  for (const cause of failureCauses.keys()) {
    if (!historicalCauses.has(cause)) continue;
    const rule = repeatedFailureRule(experience, cause, existingRules);
    if (rule) {
      newRules.push(rule);
      strategyOptimizations++;
    }
  }

  if (experience.domain && visitsBefore >= 1 && experience.piiDetections.length >= 3) {
    const kinds = [...new Set(experience.piiDetections.map((d) => d.kind))];
    const rule = sitePatternRule(experience, kinds, existingRules);
    if (rule) {
      newRules.push(rule);
      sitePatternsFound++;
    }
  }

  if (experience.reocrVerified && experience.reocrLeakedPII && experience.reocrLeakedPII.length > 0) {
    for (const leak of experience.reocrLeakedPII) {
      newRules.push(
        newRule("reocr", {
          category: "redaction",
          description: `Re-OCR detected leaked PII "${leak.slice(0, 20)}..." in redacted image. Redaction needs strengthening.`,
          pattern: {
            domain: experience.domain,
            pageType: experience.pageType,
            condition: `reocr_leak:${leak.slice(0, 30)}`,
            action: "strengthen_redaction",
          },
          confidence: 0.7,
        }),
      );
    }
  }

  const metrics = { falsePositives, falseNegatives, strategyOptimizations, sitePatternsFound };
  return {
    newRules,
    confirmedRules,
    contradictedRules,
    summary: summarize(experience, { ...metrics, newRulesCount: newRules.length }),
    metrics,
  };
}

function falsePositiveRule(experience: Experience, detection: PIIDetectionRecord, rules: LearnedRule[]): LearnedRule | null {
  const exists = rules.find(
    (r) =>
      r.category === "pii_detection" &&
      r.pattern.condition.includes(`false_positive:${detection.kind}`) &&
      r.pattern.domain === experience.domain,
  );
  if (exists) return null;
  return newRule("fp", {
    category: "pii_detection",
    description: `False positive: ${detection.kind} detected by ${detection.method} on ${experience.pageType} page is not actually sensitive.`,
    pattern: {
      domain: experience.domain,
      pageType: experience.pageType,
      condition: `false_positive:${detection.kind}:${detection.method}`,
      action: "reduce_confidence",
    },
    confidence: 0.5,
  });
}

function missedDetectionRule(experience: Experience, detection: PIIDetectionRecord, rules: LearnedRule[]): LearnedRule | null {
  if (detection.kind === "pii_text" || detection.kind === "face") return null;
  const exists = rules.find(
    (r) =>
      r.category === "pii_detection" &&
      r.pattern.condition.includes(`missed:${detection.kind}`) &&
      r.pattern.domain === experience.domain,
  );
  if (exists) return null;
  return newRule("miss", {
    category: "pii_detection",
    description: `Missed PII: ${detection.kind} on ${experience.pageType} page was not detected. Add detection for this pattern.`,
    pattern: {
      domain: experience.domain,
      pageType: experience.pageType,
      condition: `missed:${detection.kind}:${detection.method}`,
      action: "add_detection",
    },
    confidence: 0.5,
  });
}

function strategyRule(experience: Experience, strategy: "deterministic" | "llm", rules: LearnedRule[]): LearnedRule | null {
  const exists = rules.find(
    (r) =>
      r.category === "strategy" &&
      r.pattern.condition === `strategy:${strategy}` &&
      r.pattern.pageType === experience.pageType,
  );
  if (exists) return null;
  return newRule("strat", {
    category: "strategy",
    description: `${strategy} planner ${strategy === "deterministic" ? "works" : "is needed"} for ${experience.pageType} pages.`,
    pattern: { pageType: experience.pageType, condition: `strategy:${strategy}`, action: `use_${strategy}` },
    confidence: 0.6,
  });
}

function repeatedSuccessRule(experience: Experience, strategy: string, rules: LearnedRule[]): LearnedRule | null {
  const condition = `repeated_success:${strategy}`;
  const exists = rules.find(
    (r) =>
      r.category === "strategy" &&
      r.pattern.condition === condition &&
      r.pattern.domain === experience.domain &&
      r.pattern.pageType === experience.pageType,
  );
  if (exists) return null;
  return newRule("repsucc", {
    category: "strategy",
    description: `${experience.domain} ${experience.pageType} tasks succeed with the ${strategy} planner (repeated successful visits).`,
    pattern: { domain: experience.domain, pageType: experience.pageType, condition, action: `prefer_${strategy}` },
    confidence: 0.7,
    confirmedCount: 1,
  });
}

function repeatedFailureRule(experience: Experience, cause: string, rules: LearnedRule[]): LearnedRule | null {
  const condition = `repeated_failure:${cause}`;
  const exists = rules.find(
    (r) =>
      r.category === "strategy" &&
      r.pattern.condition === condition &&
      r.pattern.domain === experience.domain &&
      r.pattern.pageType === experience.pageType,
  );
  if (exists) return null;
  return newRule("repfail", {
    category: "strategy",
    description: `${experience.domain} ${experience.pageType} actions keep failing with "${cause}" — prefer the LLM planner, which re-plans instead of repeating the same doomed action.`,
    pattern: { domain: experience.domain, pageType: experience.pageType, condition, action: "use_llm" },
    confidence: 0.6,
  });
}

function sitePatternRule(experience: Experience, kinds: string[], rules: LearnedRule[]): LearnedRule | null {
  const exists = rules.find((r) => r.category === "site_pattern" && r.pattern.domain === experience.domain);
  if (exists) return null;
  return newRule("site", {
    category: "site_pattern",
    description: `${experience.domain} commonly contains: ${kinds.join(", ")}.`,
    pattern: { domain: experience.domain, condition: `site_pii:${kinds.join(",")}`, action: "prioritize_detection" },
    confidence: 0.6,
  });
}

function summarize(experience: Experience, metrics: ReflectionMetrics & { newRulesCount: number }): string {
  const parts = [`Task ${experience.taskSuccess ? "succeeded" : "failed"} on ${experience.pageType} page.`];
  if (metrics.falsePositives > 0) parts.push(`${metrics.falsePositives} false positive(s) identified.`);
  if (metrics.falseNegatives > 0) parts.push(`${metrics.falseNegatives} missed PII item(s) found.`);
  if (metrics.strategyOptimizations > 0) parts.push(`${metrics.strategyOptimizations} strategy optimization(s) noted.`);
  if (metrics.sitePatternsFound > 0) parts.push(`New site pattern recorded for ${experience.domain}.`);
  if (metrics.newRulesCount > 0) parts.push(`${metrics.newRulesCount} new rule(s) generated.`);
  return parts.join(" ");
}
