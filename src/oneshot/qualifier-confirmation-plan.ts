import { createHash } from "node:crypto";
import type { CodeRepository } from "../orchestrator/database.js";
import { isOneShotRepoEnabled } from "./repo-metadata.js";
import type {
  ExtractedTicketSignals,
  RepoCandidateScore,
  RoutingPlan,
  RouterTicketInput,
} from "./repo-router/types.js";

const QUALIFIER_CONFIRMATION_DECISION_SOURCE = "qualifier_llm" as const;

const EMPTY_SIGNALS: ExtractedTicketSignals = {
  filePaths: [],
  identifiers: [],
  tables: [],
  endpoints: [],
  directionalPhrases: [],
  sentences: [],
  customerTags: [],
  businessConcepts: [],
  crossCuttingRisk: "low",
  extractorSchemaVersion: "qualifier_confirmation@v1",
  provider: "fallback",
};

function buildSnapshotHash(jiraKey: string, repoIds: number[]): string {
  const sorted = [...repoIds].sort((a, b) => a - b);
  return createHash("sha1")
    .update(`qualifier-confirmation:${jiraKey}:${sorted.join(",")}`)
    .digest("hex");
}

/**
 * Build a minimal RoutingPlan-shaped object representing "QUALIFIER could
 * not pick — these are the enabled repositories the human can choose from."
 * Used by the confirmation materializer and AgentWorker timeout path so they
 * can persist a router_decisions row + populate router_confirmations
 * candidates without invoking the (deleted) RepoRouter scoring pipeline.
 *
 * The plan's `signals_json`/`scores_json` payload is intentionally empty —
 * QUALIFIER LLM owns the decision. The dashboard renders these rows with
 * empty score panels and full chosen_repo metadata, which is correct.
 */
export function buildQualifierConfirmationPlan(input: {
  ticket: RouterTicketInput;
  availableRepos: CodeRepository[];
  selectedRepoIds?: number[];
}): RoutingPlan {
  const enabledRepos = input.availableRepos.filter(isOneShotRepoEnabled);
  const candidates: RepoCandidateScore[] = enabledRepos.map((repo) => ({
    repo,
    score: 0,
    evidence: [],
  }));
  const repoIds = enabledRepos.map((repo) => repo.id);

  return {
    jiraKey: input.ticket.key,
    outcome: "needs_repo_confirmation",
    decisionSource: QUALIFIER_CONFIRMATION_DECISION_SOURCE,
    selectedRepoIds: input.selectedRepoIds ?? [],
    candidates,
    unsupportedRepoIds: [],
    blockingReasons: [],
    signals: EMPTY_SIGNALS,
    weightsVersion: "qualifier_confirmation@v1",
    profileVersions: {},
    extractorSchemaVersion: "qualifier_confirmation@v1",
    snapshotHash: buildSnapshotHash(input.ticket.key, repoIds),
    tiebreakerUsed: false,
    confirmationRequired: true,
    createdAt: new Date().toISOString(),
    extractorLlmCall: null,
    shortlistLlmCall: null,
    deciderLlmCall: null,
    deciderConfidence: null,
    deciderReasoning: null,
    deciderCitations: [],
    totalLlmCostUsd: null,
  };
}
