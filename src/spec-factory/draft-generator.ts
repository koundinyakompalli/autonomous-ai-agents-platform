import { runAgent as defaultRunAgent } from "../claude-sdk/index.js";
import {
  validateDraftBundle,
  type DraftValidationResult,
} from "./draft-validator.js";
import type { SpecFactoryTaskWorkspace } from "./evidence-workspace.js";
import type { EvidenceManifest } from "./evidence.js";
import {
  renderCompactEvidenceSummary,
  renderCompactRepoContextSummary,
  renderTaskWorkspacePromptContext,
} from "./prompt-summary.js";
import type { SpecFactoryRepoContextManifest } from "./repo-context.js";
import { renderDraftMarkdown } from "./renderers.js";
import type { SpecFactoryDraftBundle } from "./types.js";
import {
  recordAgentSdkProviderError,
  recordAgentSdkProviderResult,
} from "./telemetry/provider-observation.js";

type RunAgent = typeof defaultRunAgent;
type AgentRunResult = Awaited<ReturnType<RunAgent>>;

const DEFAULT_DRAFT_TIMEOUT_MS = 20 * 60 * 1000;

const shortStringSchema = { type: "string", maxLength: 420 };

const stringArraySchema = {
  type: "array",
  maxItems: 8,
  items: shortStringSchema,
};

const compactStringArraySchema = {
  type: "array",
  maxItems: 6,
  items: shortStringSchema,
};

const SPEC_FACTORY_DRAFT_BUNDLE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    sourceJiraKey: {
      type: "string",
      pattern: "^[A-Z][A-Z0-9]+-\\d+$",
      maxLength: 32,
    },
    loeHours: {
      type: "number",
      minimum: 0,
    },
    epic: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", maxLength: 180 },
        description: { type: "string", maxLength: 2600 },
        businessContext: compactStringArraySchema,
        acceptanceCriteria: compactStringArraySchema,
        assumptions: compactStringArraySchema,
        dependencies: compactStringArraySchema,
      },
      required: [
        "summary",
        "description",
        "businessContext",
        "acceptanceCriteria",
        "assumptions",
        "dependencies",
      ],
    },
    childTickets: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          repoName: { type: "string", maxLength: 120 },
          repoId: {
            type: "integer",
            minimum: 1,
          },
          summary: { type: "string", maxLength: 180 },
          overview: { type: "string", maxLength: 1100 },
          acceptanceCriteria: {
            type: "array",
            minItems: 2,
            maxItems: 8,
            items: shortStringSchema,
          },
          technicalDetails: {
            type: "object",
            additionalProperties: false,
            properties: {
              repo: { type: "string", maxLength: 120 },
              branch: { type: "string", maxLength: 120 },
              targetFiles: {
                type: "array",
                maxItems: 12,
                items: { type: "string", maxLength: 220 },
              },
              implementationNotes: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                items: shortStringSchema,
              },
            },
            required: ["repo", "targetFiles", "implementationNotes"],
          },
          outOfScope: compactStringArraySchema,
          testingNotes: compactStringArraySchema,
          loeHours: {
            type: "number",
            minimum: 0,
          },
          sourceEvidenceRefs: {
            type: "array",
            maxItems: 12,
            items: { type: "string", maxLength: 220 },
          },
        },
        required: [
          "repoName",
          "summary",
          "overview",
          "acceptanceCriteria",
          "technicalDetails",
          "outOfScope",
          "testingNotes",
          "sourceEvidenceRefs",
        ],
      },
    },
    evidenceSummary: stringArraySchema,
    warnings: compactStringArraySchema,
  },
  required: [
    "sourceJiraKey",
    "epic",
    "childTickets",
    "evidenceSummary",
    "warnings",
  ],
};

export interface GenerateDraftInput {
  sourceId: number;
  sourceJiraKey: string;
  repoIds: string[];
  evidenceManifest: EvidenceManifest;
  repoContextManifest?: SpecFactoryRepoContextManifest;
  taskWorkspace?: SpecFactoryTaskWorkspace;
}

export interface GenerateDraftResult {
  bundle: SpecFactoryDraftBundle;
  renderedMarkdown: string;
  validation: DraftValidationResult;
  modelMetadata: {
    provider: "bedrock";
    model: string | undefined;
    metrics: AgentRunResult["metrics"];
  };
}

function artifactBasename(filename: string): string {
  return filename.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function composeHandoffBundleFiles(evidenceManifest: EvidenceManifest): {
  markdown: string | null;
  json: string | null;
} {
  let markdown: string | null = null;
  let json: string | null = null;
  for (const artifact of evidenceManifest.artifacts) {
    const basename = artifactBasename(artifact.filename);
    if (basename === "handoff-v1.md") {
      markdown = artifact.filename;
    } else if (basename === "handoff-v1.json") {
      json = artifact.filename;
    }
  }
  return { markdown, json };
}

function renderComposeHandoffGuidance(
  evidenceManifest: EvidenceManifest,
): string[] {
  const files = composeHandoffBundleFiles(evidenceManifest);
  if (!files.markdown && !files.json) return [];

  const sourceFileList = [files.markdown, files.json]
    .filter((value): value is string => value !== null)
    .join(", ");
  return [
    "",
    "Compose handoff bundle detected:",
    files.markdown
      ? `- Treat ${files.markdown} as the authoritative Compose session synthesis and read it before other attachments.`
      : null,
    files.json
      ? `- Use ${files.json} as structured support for context version, sources, generated research, readiness, and open questions.`
      : null,
    `- Draft from the handoff bundle plus current repo/code evidence; do not invent details absent from ${sourceFileList}.`,
    "- Cite handoff-v1.md and/or handoff-v1.json in sourceEvidenceRefs when their synthesized content shapes an Epic or child ticket.",
  ].filter((line): line is string => line !== null);
}

function buildPrompt(input: GenerateDraftInput): string {
  const stories = input.evidenceManifest.composeStories ?? [];
  const hasStories = stories.length > 0;
  const storyDirective = hasStories
    ? "- Return one Epic. A story breakdown is provided below: create exactly one child ticket per story, preserving each story's title and sequence while keeping each ticket concise; a story may span repositories — set technicalDetails.repo to its primary repo; multiple child tickets may target the same repo; do not collapse or merge stories."
    : "- Return exactly one Epic and as many modular child Story/Task tickets as the implementation needs; multiple child tickets may target the same repo when the work has separable slices.";
  const storySection = hasStories
    ? [
        "",
        "Authoritative story breakdown (one child ticket per story, in sequence):",
        ...[...stories]
          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
          .map((story, index) => {
            const repos = story.repos?.length
              ? ` [repos: ${story.repos.join(", ")}]`
              : "";
            const acceptanceCriteria = story.acceptanceCriteria?.length
              ? `\n   Acceptance criteria:\n${story.acceptanceCriteria
                  .map(
                    (criterion) => `   ${criterion.replaceAll("\n", "\n   ")}`,
                  )
                  .join("\n")}`
              : "";
            return `${index + 1}. ${story.title} — ${story.userStory || story.summary}${repos}${acceptanceCriteria}`;
          }),
      ]
    : [];
  return [
    "Generate a Spec Factory draft bundle from the registered evidence files and repository workspaces.",
    "Do not treat this prompt as the source evidence body. Use it as a map, then read files.",
    "",
    "Evidence synthesis discipline (apply before drafting any Epic or child ticket):",
    "- Build an explicit evidence map for the files you considered. Prefer compact context and index files first; use attachment previews/titles to choose targeted source files.",
    "- Cite the source filename for every factual claim in the Epic description, business context, child overview, and acceptance criteria via `sourceEvidenceRefs` or inline `(source: <filename>)` references. Untraceable claims must be removed or flagged in `warnings`.",
    "- Calibrate reading depth to document type: read authoritative summaries end-to-end; search or selectively read long transcripts and planning docs for disputed or missing details.",
    ...renderComposeHandoffGuidance(input.evidenceManifest),
    "",
    "Requirements:",
    storyDirective,
    "- Child tickets must be self-contained for OneShot QUALIFIER intake.",
    "- Every child ticket must include technicalDetails.repo.",
    "- Every Epic and child acceptanceCriteria entry must be one complete multiline Gherkin scenario containing Scenario:, Given, When, and Then lines. Never return isolated acceptance bullets.",
    "- warnings must always be an array of strings. Use [] when there are no warnings.",
    "- Do not put PFOS on the Epic. PFOS only applies later to approved child tickets.",
    "- Keep the JSON compact: epic.description <= 2,600 characters; child overview <= 1,100 characters; each array should contain only the strongest bullets needed for implementation.",
    "- Do not stream long narrative drafts. The structured JSON schema is the deliverable; finish as soon as the schema is complete.",
    input.taskWorkspace
      ? "- Your current working directory is the Spec Factory task workspace."
      : "- Use the supplied evidence manifest as the source workspace when no task workspace is registered.",
    input.taskWorkspace
      ? "- Mandatory order: read compact evidence/context first, inspect only targeted code second, then write the draft bundle."
      : "- Review the supplied evidence before writing the draft bundle.",
    input.taskWorkspace
      ? "- Start by reading evidence/evidence-summary.json, evidence/attachment-index.md, evidence/repo-references.json, evidence/repo-classifier-index.md, repo-context-summary.json, and evidence/attachments/context.md when present. Read other attachments selectively by title/preview when needed."
      : "- Start from ticket description, comments, and attachment text in Evidence manifest JSON.",
    input.taskWorkspace
      ? "- Do not open full audit manifests directly; if a file is too large, use grep or Read with offset/limit against only the needed section."
      : "- Avoid relying on oversized raw evidence blobs when compact metadata is available.",
    input.taskWorkspace && input.repoContextManifest
      ? "- After evidence review, search and read current code/config under repos/* and the registered repository workspaces."
      : input.repoContextManifest
        ? "- After evidence review, search and read current code/config in the registered repository workspaces."
        : "- Repo code workspaces are not registered for this run.",
    input.repoContextManifest
      ? "- Write child tickets against the selected repository grounding branch from repo-context-summary.json; Spec Factory prefers master and falls back to main only when master is missing."
      : "- Write child tickets against the repo references in the evidence manifest; use master unless the matched repository metadata only supports main.",
    "- Use Louise attachments as evidence and hints.",
    input.repoContextManifest
      ? "- Verify and improve requirements from current code/config context on the selected grounding branch."
      : "- Repo deep-dive is disabled for this run. Use the Louise plan documents and repo references cross-checked against code_repositories.",
    input.repoContextManifest
      ? "- Prefer observed current repo context over stale attachment claims, and surface conflicts as warnings."
      : "- Surface any ambiguity or mismatch in the Louise plan documents as warnings.",
    "- Preserve the source Jira key and LOE estimate when evidence supports them.",
    "- Use repository-specific implementation details, acceptance criteria, testing notes, and source evidence refs.",
    input.taskWorkspace
      ? "- Cite sourceEvidenceRefs using evidence filenames and repo paths that you inspected."
      : "- Cite sourceEvidenceRefs from the evidence manifest.",
    "",
    `Source id: ${input.sourceId}`,
    `Source Jira key: ${input.sourceJiraKey}`,
    ...(input.taskWorkspace
      ? ["", renderTaskWorkspacePromptContext(input.taskWorkspace)]
      : []),
    "",
    renderCompactEvidenceSummary(input.evidenceManifest),
    "",
    renderCompactRepoContextSummary(input.repoContextManifest),
    ...storySection,
  ].join("\n");
}

function parseDraftOutput(result: AgentRunResult): unknown {
  if (result.structuredOutput !== undefined) {
    return result.structuredOutput;
  }

  return JSON.parse(result.output);
}

function normalizeRepoIds(repoIds: string[]): string[] {
  const normalized = repoIds.map((repoId) => repoId.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error(
      "Spec Factory draft generation requires at least one registered repo workspace",
    );
  }

  return normalized;
}

function validateRepoContextRepoIds(
  input: GenerateDraftInput,
  repoIds: string[],
): void {
  const contextRepoIds =
    input.repoContextManifest?.repos
      .map((repo) => repo.repoId?.trim())
      .filter((repoId): repoId is string => Boolean(repoId)) ?? [];
  if (contextRepoIds.length === 0) return;

  const inputSet = new Set(repoIds);
  const contextSet = new Set(contextRepoIds);
  const missing = [...contextSet].filter((repoId) => !inputSet.has(repoId));
  if (missing.length > 0) {
    throw new Error(
      `Spec Factory repo context repoIds must be included in GenerateDraftInput.repoIds; missing from repoIds: ${missing.join(", ")}`,
    );
  }
}

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class DraftGenerator {
  constructor(
    private readonly runAgent: RunAgent = defaultRunAgent,
    private readonly modelId: string | undefined = process.env
      .SPEC_FACTORY_MODEL_ID ||
      process.env.ANTHROPIC_MODEL ||
      "us.anthropic.claude-opus-4-8",
  ) {}

  async generate(input: GenerateDraftInput): Promise<GenerateDraftResult> {
    const repoIds = normalizeRepoIds(input.repoIds);
    validateRepoContextRepoIds(input, repoIds);
    const providerStartedAt = Date.now();
    let result: AgentRunResult;
    try {
      result = await this.runAgent({
        taskId: `spec-factory-${input.sourceJiraKey}-${Date.now()}`,
        taskPrompt: buildPrompt(input),
        repoIds,
        agentType: "custom",
        sdkStage: "draft_generation",
        permissionLevel: "read_only",
        allowWrite: false,
        timeoutMs: positiveNumberEnv(
          "SPEC_FACTORY_DRAFT_TIMEOUT_MS",
          DEFAULT_DRAFT_TIMEOUT_MS,
        ),
        outputSchema: SPEC_FACTORY_DRAFT_BUNDLE_JSON_SCHEMA,
        bedrockConfig: {
          region: process.env.AWS_REGION || "us-east-2",
          model: this.modelId,
        },
        systemAppend:
          "Spec Factory runs must follow an evidence-first workflow. Read compact index files before selected evidence files, then use current repository code/config to refine the OneShot-ready Epic and child stories. Avoid full audit manifests unless using grep or Read offset/limit.",
      });
    } catch (error) {
      recordAgentSdkProviderError({
        purpose: "draft_generation",
        configuredModel: this.modelId,
        startedAt: providerStartedAt,
        error,
      });
      throw error;
    }
    recordAgentSdkProviderResult({
      purpose: "draft_generation",
      configuredModel: this.modelId,
      startedAt: providerStartedAt,
      result,
    });

    if (!result.success) {
      throw new Error(result.error || "Spec Factory draft generation failed");
    }

    const draftOutput = parseDraftOutput(result);
    const validation = validateDraftBundle(draftOutput);
    if (!validation.valid) {
      throw new Error(
        `Draft bundle failed validation: ${validation.errors.join("; ")}`,
      );
    }

    return {
      bundle: validation.normalized,
      renderedMarkdown: renderDraftMarkdown(validation.normalized),
      validation,
      modelMetadata: {
        provider: "bedrock",
        model: result.metrics.modelUsed || this.modelId,
        metrics: result.metrics,
      },
    };
  }
}
