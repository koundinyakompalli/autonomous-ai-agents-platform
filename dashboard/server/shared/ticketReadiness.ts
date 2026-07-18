import { createHash } from "node:crypto";
import type {
  OneShotTicketQualityRubric,
  OneShotTicketReadinessScore,
  OneShotTicketReadinessSignal,
  OneShotTicketReadinessTier,
  OneShotTicketTemplateFit,
} from "../types/oneshot.js";

export const TICKET_READINESS_SIGNALS: OneShotTicketReadinessSignal[] = [
  "acceptance_criteria",
  "substantive_description",
  "expected_behavior_scope",
  "repo_file_service_hints",
  "testing_notes",
  "out_of_scope_constraints",
];

export const TICKET_READINESS_TIERS: OneShotTicketReadinessTier[] = [
  "strong",
  "adequate",
  "weak",
  "missing_description",
];

export const TICKET_TEMPLATE_FITS: OneShotTicketTemplateFit[] = [
  "cpdev_template",
  "retrofit_template",
  "non_template_clear",
  "non_template_weak",
  "missing_description",
];

export const SIGNAL_LABELS: Record<OneShotTicketReadinessSignal, string> = {
  acceptance_criteria: "Acceptance criteria",
  substantive_description: "Substantive description",
  expected_behavior_scope: "Expected behavior / scope",
  repo_file_service_hints: "Repo, file, or service hints",
  testing_notes: "Testing notes",
  out_of_scope_constraints: "Out-of-scope constraints",
};

export const TIER_LABELS: Record<OneShotTicketReadinessTier, string> = {
  strong: "Strong",
  adequate: "Adequate",
  weak: "Weak",
  missing_description: "Missing description",
};

export const TEMPLATE_FIT_LABELS: Record<OneShotTicketTemplateFit, string> = {
  cpdev_template: "CPDEV template",
  retrofit_template: "Retrofit template",
  non_template_clear: "Clear non-template",
  non_template_weak: "Weak non-template",
  missing_description: "Missing description",
};

type DetectionRule = {
  label: string;
  patterns: RegExp[];
};

export const READINESS_RUBRIC = {
  rubricVersion: "v1.0",
  detectionPatternsVersion: "v1.0",
  weights: {
    acceptance_criteria: 35,
    substantive_description: 20,
    expected_behavior_scope: 15,
    repo_file_service_hints: 15,
    testing_notes: 10,
    out_of_scope_constraints: 5,
  } satisfies Record<OneShotTicketReadinessSignal, number>,
  tierCutoffs: {
    strong: 80,
    adequate: 60,
    weak: 30,
  },
  thresholds: {
    bucketClaimMinN: 10,
    missingSignalCohortMinN: 10,
    weakRecommendationMinShare: 0.2,
    dataHygieneMissingDescriptionMinShare: 0.15,
    dataHygieneMinN: 10,
    stratifiedCoverageMinShare: 0.6,
  },
  detection: {
    acceptance_criteria: {
      label: "Acceptance criteria",
      patterns: [
        /(^|\n)\s*(?:#{1,6}\s*)?(?:acceptance\s+criteria|acceptance|ac)\s*[:#-]/i,
        /\b(?:given|when|then)\b[\s\S]{0,700}\b(?:given|when|then)\b[\s\S]{0,700}\b(?:given|when|then)\b/i,
        /\b(?:done|accepted|complete)\s+when\b/i,
        /\b(?:verify|ensure)\s+that\b/i,
      ],
    },
    substantive_description: {
      label: "Substantive description",
      patterns: [
        /\b(?:overview|description|summary|problem|background|context)\b/i,
      ],
    },
    expected_behavior_scope: {
      label: "Expected behavior / scope",
      patterns: [
        /\b(?:expected|desired|current)\s+behavior\b/i,
        /\b(?:scope|requirement|requirements|should|must|needs?\s+to|preserve|keep|exclude|include|show|hide)\b/i,
        /\b(?:from|target)\s*[:#-]/i,
        /\b(?:as a|so that)\b/i,
      ],
    },
    repo_file_service_hints: {
      label: "Repo, file, or service hints",
      patterns: [
        /\b(?:repo|repository|service|server|helper|component|module|class|method|endpoint|api|controller|worker|dashboard)\b/i,
        /\b(?:file|path|package)\s*[:#-]/i,
        /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|java|kt|py|sql|xml|yml|yaml|json)\b/i,
        /\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|java|kt|py|sql|xml|yml|yaml|json)\b/i,
        /\b(?:core-app|provider-portal|batch|client-services|interop|fhir|medhok)\b/i,
      ],
    },
    testing_notes: {
      label: "Testing notes",
      patterns: [
        /\b(?:testing\s+notes?|test\s+plan|unit\s+tests?|integration\s+tests?|regression\s+tests?)\b/i,
        /\b(?:unit|integration|regression)\s+coverage\b/i,
        /\b(?:add|create|include|run|write)\b[\s\S]{0,80}\btests?\b/i,
        /\bfixture\s+validation\s+tests?\b/i,
        /\b(?:verify|validated?|run)\s+(?:the\s+)?(?:test|tests|suite|query|job|workflow)\b/i,
      ],
    },
    out_of_scope_constraints: {
      label: "Out-of-scope constraints",
      patterns: [
        /\b(?:out\s+of\s+scope|not\s+in\s+scope|non-?goals?|do\s+not|don't|without\s+(?:changing|altering|modifying|touching)|unchanged|must\s+not)\b/i,
        /\b(?:no|not)\b[\s\S]{0,80}\b(?:behavior|flow|exports?|columns?|policy)\b[\s\S]{0,40}\bchange\b/i,
      ],
    },
  } satisfies Record<OneShotTicketReadinessSignal, DetectionRule>,
  templates: {
    cpdev: {
      label: "CPDEV template",
      patterns: [
        /(^|\n)\s*(?:#{1,6}\s*)?summary\s*[:#-]/i,
        /(^|\n)\s*(?:#{1,6}\s*)?(?:overview|description)\s*[:#-]/i,
        /(^|\n)\s*(?:#{1,6}\s*)?acceptance\s+criteria\s*[:#-]/i,
        /(^|\n)\s*(?:#{1,6}\s*)?technical\s+details?\s*[:#-]/i,
      ],
    },
    retrofit: {
      label: "Retrofit template",
      patterns: [
        /(^|\n)\s*(?:#{1,6}\s*)?retrofit\s*[:#-]/i,
        /(^|\n)\s*(?:#{1,6}\s*)?from\s*[:#-]/i,
        /(^|\n)\s*(?:#{1,6}\s*)?target\s*[:#-]/i,
      ],
    },
  },
} as const;

export function publicReadinessRubric(): OneShotTicketQualityRubric {
  return {
    rubricVersion: READINESS_RUBRIC.rubricVersion,
    detectionPatternsVersion: READINESS_RUBRIC.detectionPatternsVersion,
    weights: { ...READINESS_RUBRIC.weights },
    tierCutoffs: { ...READINESS_RUBRIC.tierCutoffs },
    thresholds: { ...READINESS_RUBRIC.thresholds },
  };
}

export function ticketReadinessSourceHash(input: {
  title?: string | null;
  taskDescription?: string | null;
}): string {
  return createHash("sha1")
    .update(`${input.title ?? ""}\n---\n${input.taskDescription ?? ""}`)
    .digest("hex");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/[#>*_\-|]+/g, " "),
  );
}

function wordCount(value: string): number {
  const words = stripMarkdown(value).split(/\s+/).filter(Boolean);
  return words.length;
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasGivenWhenThen(text: string): boolean {
  return /\bgiven\b/i.test(text) && /\bwhen\b/i.test(text) && /\bthen\b/i.test(text);
}

function hasCpdevTemplate(text: string): boolean {
  const patterns = READINESS_RUBRIC.templates.cpdev.patterns;
  const matchCount = patterns.filter((pattern) => pattern.test(text)).length;
  return matchCount >= 3;
}

function hasRetrofitTemplate(text: string): boolean {
  return READINESS_RUBRIC.templates.retrofit.patterns.every((pattern) =>
    pattern.test(text),
  );
}

function scoreTier(score: number, missingDescription: boolean): OneShotTicketReadinessTier {
  if (missingDescription || score < READINESS_RUBRIC.tierCutoffs.weak) {
    return "missing_description";
  }
  if (score >= READINESS_RUBRIC.tierCutoffs.strong) return "strong";
  if (score >= READINESS_RUBRIC.tierCutoffs.adequate) return "adequate";
  return "weak";
}

function templateFitFor(input: {
  text: string;
  tier: OneShotTicketReadinessTier;
}): OneShotTicketTemplateFit {
  if (input.tier === "missing_description") return "missing_description";
  if (hasRetrofitTemplate(input.text)) return "retrofit_template";
  if (hasCpdevTemplate(input.text)) return "cpdev_template";
  return input.tier === "strong" || input.tier === "adequate"
    ? "non_template_clear"
    : "non_template_weak";
}

export function scoreTicketReadiness(input: {
  title?: string | null;
  taskDescription?: string | null;
  qualifierOutcome?: { acceptanceCriteriaPresent?: boolean } | null;
}): OneShotTicketReadinessScore {
  const title = input.title ?? "";
  const taskDescription = input.taskDescription ?? "";
  const text = `${title}\n${taskDescription}`;
  const plainDescription = stripMarkdown(taskDescription);
  const plainCombined = stripMarkdown(text);
  const descriptionWords = wordCount(taskDescription);
  const combinedWords = wordCount(text);
  const titleWords = wordCount(title);
  const titleOnly =
    plainDescription.length === 0 ||
    plainDescription.toLowerCase() === stripMarkdown(title).toLowerCase();
  const veryShort =
    descriptionWords < 12 &&
    plainDescription.length < 100 &&
    combinedWords <= Math.max(titleWords + 8, 16);
  const missingDescription = titleOnly || veryShort;
  const signals = {} as Record<OneShotTicketReadinessSignal, boolean>;

  for (const signal of TICKET_READINESS_SIGNALS) {
    signals[signal] = matchesAny(text, READINESS_RUBRIC.detection[signal].patterns);
  }

  signals.acceptance_criteria =
    input.qualifierOutcome?.acceptanceCriteriaPresent === true ||
    signals.acceptance_criteria ||
    hasGivenWhenThen(text);
  signals.substantive_description =
    !missingDescription &&
    (descriptionWords >= 25 ||
      plainDescription.length >= 180 ||
      signals.substantive_description);
  signals.expected_behavior_scope =
    signals.expected_behavior_scope ||
    (descriptionWords >= 18 && /\b(?:should|must|needs?|expected|target)\b/i.test(text));

  const breakdown = {} as Record<OneShotTicketReadinessSignal, number>;
  let score = 0;
  for (const signal of TICKET_READINESS_SIGNALS) {
    const value = signals[signal] ? READINESS_RUBRIC.weights[signal] : 0;
    breakdown[signal] = value;
    score += value;
  }

  if (missingDescription) {
    score = Math.min(score, READINESS_RUBRIC.tierCutoffs.weak - 1);
  }

  const tier = scoreTier(score, missingDescription);
  return {
    score,
    tier,
    templateFit: templateFitFor({ text, tier }),
    signals,
    breakdown,
    missingSignals: TICKET_READINESS_SIGNALS.filter((signal) => !signals[signal]),
    rubricVersion: READINESS_RUBRIC.rubricVersion,
    detectionPatternsVersion: READINESS_RUBRIC.detectionPatternsVersion,
    sourceTextSha: ticketReadinessSourceHash({ title, taskDescription }),
  };
}

export function isWeakTicketTier(tier: OneShotTicketReadinessTier): boolean {
  return tier === "weak" || tier === "missing_description";
}
