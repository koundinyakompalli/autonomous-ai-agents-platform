import type { CodeRepository } from "../../orchestrator/database.js";

export type RoutingOutcome =
  | "auto"
  | "multi_repo"
  | "needs_repo_confirmation"
  | "unsupported"
  | "no_match";

export type RoutingDecisionSource =
  | "explicit_repo"
  | "explicit_github_repo"
  | "target_repo"
  | "related_code"
  | "scoring"
  | "fallback"
  | "llm_decider"
  | "llm_abstain"
  | "llm_low_confidence"
  | "qualifier_llm";

export type CrossCuttingRisk = "low" | "medium" | "high";

export interface ExtractedTicketSignals {
  filePaths: string[];
  identifiers: string[];
  tables: string[];
  endpoints: string[];
  directionalPhrases: string[];
  sentences: string[];
  /** Customer / payer / PBM tokens ∈ the known-customer list. */
  customerTags: string[];
  /** 3-15 domain-vocabulary phrases describing the ticket's business work. */
  businessConcepts: string[];
  /** LLM's judgment on whether the ticket spans multiple repos with no clear owner. */
  crossCuttingRisk: CrossCuttingRisk;
  extractorSchemaVersion: string;
  provider: "regex" | "llm" | "fallback";
}

export interface RepoProfileSection {
  aliases: string[];
  domains: string[];
  packages: string[];
  file_path_patterns: string[];
  symbols: string[];
  endpoints: string[];
  tables: string[];
}

export interface RepoProfile {
  repoName: string;
  schema_version: string;
  profile_version: string;
  generated_at: string;
  source_repo_commit_sha: string;
  generated: RepoProfileSection;
  curated: RepoProfileSection;
  merged: RepoProfileSection;
  profileText: string;
  /** Human-authored summary paragraph extracted from the YAML `#` comment block. */
  summary: string;
}

export interface RepoRouterWeights {
  weightsVersion: string;
  scoreMin: number;
  marginAuto: number;
  historicalHalfLifeDays: number;
  historicalDoubleCountCap: number;
  weights: {
    filePath: number;
    packageNamespace: number;
    symbolTableEndpoint: number;
    semanticHistoricalSimilarity: number;
    semanticProfileSimilarity: number;
    directionalPhrase: number;
    actionableSingleRepoAlias: number;
    businessTermProfileHit: number;
    actionableMultiRepoAlias: number;
    contextualAlias: number;
    genericKeywordPenalty: number;
  };
}

/** Test/internal override for the LLM extractor. Production routing uses the
 *  LLM-first extractor path and falls back to regex on provider failure. */
export type RepoRouterLlmExtractorMode = "off" | "on";

/**
 * Usage + cost metadata captured for one LLM invocation. Both roles (extractor
 * and decider) share this shape so the database can persist them uniformly.
 */
export interface LlmCallRecord {
  model: string;
  promptPreview: string;
  input: unknown;
  output: unknown;
  validated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  timestamp: string;
  /** Non-null when validation dropped/normalised fields; null on clean validation. */
  warnings?: string[];
  /** For the decider only: whether the model abstained. */
  abstained?: boolean;
}

export interface RouterEvidence {
  id: string;
  repoId: number;
  repoName: string;
  signal: string;
  score: number;
  detail: string;
  sourceTicketId?: string;
}

export interface RepoCandidateScore {
  repo: CodeRepository;
  score: number;
  evidence: RouterEvidence[];
  semanticScore?: number;
}

export interface RoutingPlan {
  jiraKey: string;
  outcome: RoutingOutcome;
  decisionSource: RoutingDecisionSource;
  selectedRepoIds: number[];
  candidates: RepoCandidateScore[];
  unsupportedRepoIds: number[];
  blockingReasons: string[];
  signals: ExtractedTicketSignals;
  weightsVersion: string;
  profileVersions: Record<string, string>;
  extractorSchemaVersion: string;
  snapshotHash: string;
  tiebreakerUsed: boolean;
  confirmationRequired: boolean;
  createdAt: string;
  /** LLM extractor call record; null when authority bypassed extraction or tests force regex-only. */
  extractorLlmCall: LlmCallRecord | null;
  /** LLM shortlist call record; null when the shortlist did not run (decider off or authority bypass). */
  shortlistLlmCall: LlmCallRecord | null;
  /** LLM decider call record; null when the decider did not run. */
  deciderLlmCall: LlmCallRecord | null;
  /** Decider confidence when the LLM picked; null when it abstained or did not run. */
  deciderConfidence: "high" | "medium" | "low" | null;
  /** Decider reasoning string (≤2 sentences) when LLM picked; null otherwise. */
  deciderReasoning: string | null;
  /** Citations the decider provided; empty when it abstained or did not run. */
  deciderCitations: string[];
  /**
   * Total LLM cost for this routing decision (extractor + shortlist + decider summed).
   * null when no role ran or usage metrics were unavailable for every role that did.
   */
  totalLlmCostUsd: number | null;
}

export interface RouterTicketInput {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    labels?: string[];
    components?: unknown;
    reporter?: { accountId?: string; displayName?: string };
    /** Jira comment block: `{ comments: [{ id, author, created, body (ADF) }] }`. */
    comment?: unknown;
    /** Jira issue links array: `[{ type, inwardIssue, outwardIssue }]`. */
    issuelinks?: unknown;
    /** Jira attachment array: `[{ filename, ... }]`. */
    attachment?: unknown;
    /** Jira parent (epic) object: `{ key, fields: { summary, ... } }`. */
    parent?: unknown;
    [key: string]: unknown;
  };
  names?: Record<string, string>;
}

/**
 * v3.2: enriched ticket-input surface. Built by `buildEnrichedTicketInput`
 * in ticket-input.ts. Produced deterministically from the Jira response; no
 * network I/O. Consumed by the extractor, scorer, and all LLM prompts.
 */
export interface EnrichedTicketInputSection {
  summary: string;
  description: string;
  parentEpicTitle: string | null;
  linkedIssueTitles: string[];
  attachmentFilenames: string[];
  acceptanceCriteria: string | null;
  comments: Array<{
    id: string;
    author: string;
    created: string;
    isPrismPlan: boolean;
    isBotFiltered: boolean;
    included: boolean;
    truncated: boolean;
    bodyExcerpt: string;
  }>;
  labels: string[];
  components: string[];
}

export interface EnrichedTicketInputStats {
  totalCommentsConsidered: number;
  commentsIncluded: number;
  commentsDroppedByBotFilter: number;
  commentsDroppedByBudget: number;
  commentBytesIncluded: number;
}

export interface EnrichedTicketInput {
  ticketText: string;
  sections: EnrichedTicketInputSection;
  stats: EnrichedTicketInputStats;
}

export interface HistoricalTicketRecord {
  ticket_id: string;
  text: string;
  routed_repo_id: number;
  included_reason: "merged_pr" | "explicit_confirmation" | "backfill_seed";
  created_at?: Date | string | null;
}
