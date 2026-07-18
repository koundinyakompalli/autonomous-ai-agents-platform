import {
  parseJsonFromTextWithRepair,
  registerCustomerWorkspace,
  registerRepoFromPath,
  runAgent,
  type AgentResult,
} from "../../claude-sdk/index.js";
import { createLogger } from "../../utils/logger.js";
import {
  parseQualificationAssessment,
  QUALIFICATION_OUTPUT_SCHEMA,
  type QualificationAssessment,
} from "../../oneshot/schema/qualification.js";

const logger = createLogger("qualifier-agent");

/**
 * Single source of truth for the QUALIFIER LLM model id. The agent and the
 * worker (which records qualificationModel metadata) both consult this so
 * the metadata column always matches the model the agent actually invoked,
 * even when ANTHROPIC_MODEL is unset.
 */
export const DEFAULT_QUALIFIER_MODEL =
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export interface QualifierAgentOptions {
  modelId?: string;
  region?: string;
  timeoutMs?: number;
}

export interface QualifierAssessmentInput {
  jiraKey: string;
  summary: string;
  /** Full ticket body — description, acceptance criteria, labels, components, comments etc. */
  ticketText: string;
  /** Pre-formatted profiled-repo catalog (see formatProfiledRepoSummariesForPrompt). */
  profiledRepoCatalog: string;
  /** Stale related_code repo names, if any. Passed in as non-authoritative history. */
  staleRelatedCodeRepoNames?: string[];
  /** Allowed GitHub owners for explicit_github (default mhk-repos). */
  allowedGithubOwners?: string[];
  /** Optional context describing the customer/branch defaults. */
  customerContext?: string;
  /** Optional ticket-readiness signals to surface to the model as advisory hints. */
  readinessHints?: string;
  /** Hard repo routing override supplied by the caller while readiness remains LLM-owned. */
  repoRoutingOverride?: QualifierRepoRoutingOverride;
  /** Used by the agent runtime to route Claude SDK requests. */
  taskRoutingPath?: string;
}

export interface QualifierRepoRoutingOverride {
  targetRepoId: number;
  targetRepoName: string;
  targetGithubSlug: string;
  reason: string;
}

export type QualifierAssessmentMetrics = AgentResult["metrics"];

export interface QualifierAssessmentResult {
  assessment: QualificationAssessment;
  metrics: QualifierAssessmentMetrics;
}

export function normalizeQualificationAssessment(
  assessment: QualificationAssessment,
): QualificationAssessment {
  // The model is asked to keep blocking reasons + qualified=true mutually
  // exclusive. If they collide, keep `qualified=false` semantically and
  // strip injected repo/branch/SHA so downstream stages don't proceed.
  if (assessment.qualified && assessment.blockingReasons.length > 0) {
    return {
      ...assessment,
      qualified: false,
      repoId: undefined,
      branchName: undefined,
      baseCommitSha: undefined,
    };
  }
  if (!assessment.qualified) {
    return {
      ...assessment,
      repoId: undefined,
      branchName: undefined,
      baseCommitSha: undefined,
    };
  }
  return assessment;
}

export class QualifierAgent {
  private readonly modelId: string;
  private readonly region: string;
  private readonly timeoutMs: number;

  constructor(options: QualifierAgentOptions = {}) {
    this.region = options.region || process.env.AWS_REGION || "us-east-2";
    this.modelId =
      options.modelId || process.env.ANTHROPIC_MODEL || DEFAULT_QUALIFIER_MODEL;
    this.timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  }

  async assessQualification(
    input: QualifierAssessmentInput,
  ): Promise<QualifierAssessmentResult> {
    const taskId = `qualifier-${input.jiraKey}-${Date.now()}`;
    const repoIds = this.resolveRepoIds(input.taskRoutingPath);

    logger.info(
      {
        jiraKey: input.jiraKey,
        modelId: this.modelId,
        repoIds,
      },
      "[QUALIFIER_RUN_AGENT] Starting Claude SDK qualification",
    );

    const result = await runAgent({
      taskId,
      taskPrompt: this.buildPrompt(input),
      repoIds,
      agentType: "custom",
      permissionLevel: "read_only",
      allowWrite: false,
      timeoutMs: this.timeoutMs,
      outputSchema: QUALIFICATION_OUTPUT_SCHEMA,
      bedrockConfig: {
        region: this.region,
        model: this.modelId,
      },
    });

    if (!result.success) {
      throw new Error(result.error || "QUALIFIER Claude SDK execution failed");
    }

    const parsed = normalizeQualificationAssessment(this.parseResult(result));
    return {
      assessment: parsed,
      metrics: result.metrics,
    };
  }

  private resolveRepoIds(taskRoutingPath: string | undefined): string[] {
    if (!taskRoutingPath) {
      return [];
    }
    if (taskRoutingPath.includes("/tasks/")) {
      const result = registerCustomerWorkspace(taskRoutingPath);
      return result.repoIds.length > 0 ? result.repoIds : [result.workspaceId];
    }
    return [registerRepoFromPath(taskRoutingPath)];
  }

  private buildPrompt(input: QualifierAssessmentInput): string {
    const allowedOwners = (input.allowedGithubOwners ?? ["mhk-repos"]).join(
      ", ",
    );
    const stale = input.staleRelatedCodeRepoNames ?? [];
    const staleBlock =
      stale.length > 0
        ? `Existing task_management.related_code (NON-AUTHORITATIVE history; do not anchor on it): ${stale.join(", ")}`
        : "Existing task_management.related_code: (none)";
    const customerContext = input.customerContext?.trim()
      ? input.customerContext.trim()
      : "(no customer-specific context)";
    const readiness = input.readinessHints?.trim()
      ? input.readinessHints.trim()
      : "(no readiness hints)";
    const repoRoutingOverride = input.repoRoutingOverride
      ? [
          "==============================",
          "HARD REPO ROUTING OVERRIDE",
          "==============================",
          `Reason: ${input.repoRoutingOverride.reason}`,
          `The caller has already locked repository routing to ${input.repoRoutingOverride.targetRepoName} (${input.repoRoutingOverride.targetGithubSlug}).`,
          `For repository selection, output repoSelection.type="profiled_repo" and selectedRepoIds=[${input.repoRoutingOverride.targetRepoId}].`,
          "Do not return needs_confirmation, no_match, multi_repo, or explicit_github for repository ambiguity.",
          "Still reject for real readiness blockers such as missing acceptance criteria, ambiguous scope, no-op/already-complete work, incomplete template fields, or unsupported retrofit scope.",
          "",
        ].join("\n")
      : "";
    return `You are QUALIFIER for Specter's Product Factory OneShotting pipeline.

Your job is to make ONE combined decision from the ticket text alone:
1. Pick the target repository (or ask for human confirmation if genuinely ambiguous).
2. Decide whether the ticket meets one of two ticket templates and is ready for OneShot planning.

You do NOT inspect any codebase. Judge from the ticket text and the profiled repo catalog only.

==============================
REPO SELECTION
==============================
Possible \`repoSelection.type\` values:
- "explicit_github": the ticket names a GitHub URL, owner/repo, or repo slug
  that is not confidently represented by one profiled repo in the catalog.
  Output the exact reference in \`explicitRepoRef\` and leave
  \`selectedRepoIds\` empty so the worker can mechanically bind it after this
  LLM decision. Allowed GitHub owners: ${allowedOwners}.
- "profiled_repo": pick exactly ONE profiled repo whose summary/aliases/domains
  match all required work. Put its id in \`selectedRepoIds\`.
- "needs_confirmation": after walking the catalog, two or more profiled repos
  remain genuinely plausible alternatives for the SAME unresolved work slice.
  Put all candidate ids in \`selectedRepoIds\` and one short reason per candidate
  in \`candidateSummaries\`. Do NOT use this as a fallback for low confidence on
  a single pick. needs_confirmation is for same-slice ambiguity, not for distinct
  repo-owned slices.
- "no_match": no profiled repo plausibly fits and no explicit name is given.
- "multi_repo": the ticket requires independently-buildable changes across 2
  or more repositories from the profiled catalog, AND each repo's changes can
  be planned and built without depending on unmerged sibling changes at compile
  time. Use multi_repo when ticket requirements map cleanly to distinct
  repo-owned slices inferred from the profiled repo catalog, even if the ticket
  does not name the repositories. Put all selected repo ids in
  \`selectedRepoIds\` and populate \`multiRepoPlan\` with one entry per repo.
  Each entry must have: \`repoRef\` (profile name or org/repo slug), a
  repo-scoped objective, repo-scoped acceptanceCriteria, and \`mergeOrder\`
  (1-based integer indicating safe merge sequence, where 1 merges first).
  qualified must be true and multiRepoPlan must have at least 2 entries. Do NOT
  use multi_repo when the ticket only touches one repo or when repos have
  compile-time dependencies on unmerged sibling changes.

Decision ladder:
1. If exactly one profiled repo owns all required work, use "profiled_repo".
2. If different requirements map to distinct repo-owned slices and each slice
   can be planned independently, use "multi_repo".
3. If two or more repos are alternatives for the same unresolved work slice,
   use "needs_confirmation".
4. If no profiled repo plausibly fits, use "no_match".

${repoRoutingOverride}
Example: for an ePA ticket that asks to capture PA Reference ID on inbound
CoverMyMeds transactions and also make the ePA Transaction UI searchable by PA
Reference ID, use "multi_repo" when the catalog says batch-jobs owns
scheduler/CoverMyMeds ingestion and PA Reference ID persistence while core-app
owns ePA Transaction UI search and result-grid display. batch-jobs should get
the ingestion/persistence objective and core-app should get the UI search/grid
objective.

Hard rules:
- Repo mentions are evidence, not authority: explicit repo mentions do not lock repo selection.
- Walk every profiled repo before deciding. For each, write one short reason in your reasoning
  about whether it's a candidate or eliminated. Then pick one — or use
  multi_repo for distinct repo-owned slices, or needs_confirmation only if 2+
  remain plausible alternatives for the same slice after that walk.
- If the ticket names or implies multiple repos with independently scoped work,
  use "multi_repo" and assign each repo only its own objective and acceptance
  criteria.
- Only use "explicit_github" after the catalog walk when the explicit repo ref
  cannot be confidently mapped to exactly one profiled repo id.
- Stale \`related_code\` is history, not a tiebreaker. Match the change against
  repo summaries directly.

Example: for CPDEV-25097 text that says
\`Repo: cp-medhok-monorepo, cp-batch-monorepo\`, use "multi_repo" when the
catalog says core-app aliases include cp-medhok-monorepo and batch-jobs aliases
include cp-batch-monorepo. The core-app slice owns UI guard, server guard,
system variable, and Flyway migration work. The batch-jobs slice owns only the
batch MemberMergeDAO guard/property work. Each multiRepoPlan entry must have
repo-scoped objective and repo-scoped acceptanceCriteria.

==============================
TEMPLATE COMPLETENESS
==============================
Two recognized templates:

1. cpdev_template — requires all of:
   - Summary
   - Description or Overview
   - Acceptance Criteria
   - Technical Details

2. retrofit_template — requires all of:
   - "Retrofit:" line citing a source ticket key (e.g., CPDEV-1234)
   - "From:" line with the source branch
   - "Target:" line with the target branch
   When the ticket is a retrofit, also output \`retrofitContext\` with
   \`{sourceJiraKey, sourceBranch, targetBranch}\` extracted from those lines.
   If the ticket also names an original/source GitHub pull request URL, include
   optional \`sourcePrUrl\` in \`retrofitContext\`. Do not invent this URL.
   For a single-target retrofit, keep using \`retrofitContext\`.
   For a multi-target retrofit where one repo has 2+ comma-separated or repeated
   target branches, output \`multiBranchRetrofitPlan\` instead of
   \`retrofitContext\`. Use the first 7 target branches in ticket order and put
   any overflow branches in \`skippedTargetBranches\`; skipped branches need another ticket
   and must not be included in the selected target list.

Set \`templateMatched\` to whichever template fits, or "none" if neither fits
clearly. A ticket can be qualified=true with templateMatched="none" only if
the ticket is otherwise unambiguous about goal, scope, and acceptance.

\`qualified\`:
- true when the ticket has a clear bounded goal AND template is satisfied
  (or, for templateMatched="none", the ticket is otherwise unambiguous).
- false when the ticket is missing required template fields, has ambiguous
  scope, or is too open-ended for a single OneShot run.

Attachment evidence policy:
- The generated task text may include an "Attachment Review Reference" with
  reviewed files and "Not Reviewed / Metadata Only" files.
- Treat unsupported/skipped attachments, unsupported spreadsheets, file-format
  uncertainty, or missing column details from unreviewed attachments as
  non-blocking evidence gaps when the ticket goal, scope, acceptance, and repo
  selection are otherwise clear.
- Put attachment evidence gaps in \`nonBlockingWarnings\`; do not use blocker
  ids such as "file_format_unspecified" or "column_list_unavailable" by
  themselves to reject an otherwise bounded ticket.
- Still reject for real intake blockers: missing acceptance criteria, ambiguous
  goal/scope, genuinely ambiguous repository, unsupported repo, incomplete
  retrofit block, or work that is too broad for one OneShot run.

When qualified=false, list specific missing items in \`blockingReasons\`
(e.g., "acceptance_criteria_missing", "scope_too_broad", "ambiguous_goal",
"retrofit_block_incomplete: From: branch missing").

==============================
DECISION ORDER
==============================
Think repoSelection -> templateMatched -> qualified.
- A ticket can be qualified=false even when repoSelection is clean (template
  incomplete).
- A ticket can be qualified=true with repoSelection.type=needs_confirmation
  (template fine, repo ambiguous; the system will park for human selection).

==============================
OUTPUT FORMAT
==============================
Respond with JSON only matching this schema:
{
  "repoSelection": {
    "type": "explicit_github" | "profiled_repo" | "needs_confirmation" | "no_match" | "multi_repo",
    "explicitRepoRef": "<owner/repo or URL or slug>",   // only when type=explicit_github
    "selectedRepoIds": [<int>],                          // 1 id for profiled_repo, 2+ for needs_confirmation/multi_repo
    "candidateSummaries": ["<reason per candidate>"],    // only when type=needs_confirmation
    "repoReasoning": "<1-3 sentences walking the catalog>"
  },
  "multiRepoPlan": [                                     // only when type=multi_repo; must have 2+ entries
    {
      "repoRef": "<profile name or org/repo>",
      "objective": "<scoped objective for this repo only>",
      "acceptanceCriteria": ["<AC items assigned to this repo>"],
      "mergeOrder": <1-based integer>
    }
  ],
  "multiBranchRetrofitPlan": {                           // only for one-repo retrofit fan-out with 2+ selected targets
    "sourceJiraKey": "<source ticket from Retrofit:>",
    "repoRef": "<explicit repo or selected profile name>",
    "sourceBranch": "<branch from From:>",
    "targetBranches": ["<first selected target>", "<second selected target>"],
    "skippedTargetBranches": ["<overflow target branch not queued>"]
  },
  "templateMatched": "cpdev_template" | "retrofit_template" | "none",
  "retrofitContext": {                                    // only for single-target retrofit_template
    "sourceJiraKey": "...",
    "sourceBranch": "...",
    "targetBranch": "...",
    "sourcePrUrl": "https://github.com/<owner>/<repo>/pull/<n>" // optional only when ticket provides it
  },
  "qualified": true | false,
  "requirementsSummary": ["<1-4 short bullets distilling the change>"],
  "acceptanceCriteriaPresent": true | false,
  "blockingReasons": ["<missing field or ambiguity>"],
  "nonBlockingWarnings": ["<advisory>"],
  "qualificationReasoning": "<1-3 sentences explaining the qualified verdict>"
}

Do NOT return repoId, branchName, or baseCommitSha. Those are injected by the
system after qualification.

==============================
TICKET
==============================
Jira key: ${input.jiraKey}

Summary:
${input.summary}

Ticket text (description, acceptance criteria, labels, components, comments):
${input.ticketText}

==============================
NON-AUTHORITATIVE CONTEXT
==============================
${staleBlock}

Customer/branch context:
${customerContext}

Readiness hints (advisory; do not anchor on these):
${readiness}

==============================
PROFILED REPO CATALOG
==============================
${input.profiledRepoCatalog}
`;
  }

  private parseResult(result: {
    structuredOutput?: unknown;
    output: string;
  }): QualificationAssessment {
    if (
      result.structuredOutput &&
      typeof result.structuredOutput === "object"
    ) {
      return parseQualificationAssessment(result.structuredOutput);
    }
    logger.debug(
      {
        responsePreview: result.output.substring(0, 500),
      },
      "Parsing QUALIFIER response",
    );
    return parseQualificationAssessment(
      parseJsonFromTextWithRepair(result.output).value,
    );
  }
}
