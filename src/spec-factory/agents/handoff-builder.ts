import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ComposeContextProjection,
  ComposeContextProjectionSummary,
  ComposeReadiness,
  ComposeSessionSourceSummary,
  ComposeSessionSummary,
  ComposeSessionMessageSummary,
} from "../compose-types.js";
import { composeSourceJiraKey } from "../compose-types.js";
import type { ClaimedAgentTask } from "../compose-database.js";
import type { EvidenceManifest } from "../evidence.js";
import type {
  AgentTaskExecutionResult,
  AgentTaskExecutor,
} from "./executor-registry.js";
import { AgentTaskExecutorRegistry } from "./executor-registry.js";
import type { LlmGateway } from "../llm/llm-gateway.js";
import { resolvePromptVersion } from "../llm/prompt-registry.js";
import { isUserFacingClarification } from "../requirements-policy.js";

export const HANDOFF_SOURCE_SUMMARY_MAX_CHARS = 255;
const HANDOFF_SYNTHESIS_PROMPT_VERSION = "handoff_synthesis@v1";
const LOST_AGENT_TASK_LEASE_MESSAGE = "agent_task_lease_lost";

export interface HandoffBundleSource {
  id: number;
  kind: ComposeSessionSourceSummary["kind"];
  filename: string | null;
  sourceUrl: string | null;
  summary: string | null;
  conversionStatus: ComposeSessionSourceSummary["conversionStatus"];
  artifactUri: string | null;
  contextVersionUsed: number | null;
  sourceRevisionId: number | null;
  contentSha256: string | null;
  artifactSha256: string | null;
  artifactBytes: number | null;
}

export interface HandoffBundleJson {
  schemaVersion: 2;
  handoffId: number | null;
  sessionId: number;
  sessionName: string;
  sessionOwner: string | null;
  requestedBy: string | null;
  builtAt: string;
  status: ComposeSessionSummary["status"];
  latestContextVersion: number | null;
  contextVersionUsed: number | null;
  messageHighWatermarkId: number | null;
  messages: ComposeSessionMessageSummary[];
  sourceRevisionSetHash: string;
  repositoryManifestHash: string;
  repositories: NonNullable<ComposeReadiness["repoEvidence"]>;
  narrative: HandoffNarrative | null;
  workingContext: HandoffBundleWorkingContext | null;
  readiness: {
    ready: boolean;
    summary: string | null;
    openQuestions: string[];
    risks: string[];
    assumptions: string[];
    missingEvidence: string[];
  } | null;
  sources: HandoffBundleSource[];
  generatedResearch: HandoffBundleSource[];
}

export interface HandoffNarrative {
  executiveSummary: string;
  implementationBrief: string;
  evidenceMap: HandoffNarrativeEvidence[];
  openQuestions: string[];
}

export interface HandoffNarrativeEvidence {
  claim: string;
  sourceIds: number[];
  notes: string | null;
}

export interface HandoffBundleWorkingContext {
  version: number;
  artifactUri: string | null;
  structuredArtifactUri: string | null;
  summary: ComposeContextProjectionSummary | null;
  facts: unknown[];
  implementationFindings: unknown[];
  requirements: unknown[];
  constraints: unknown[];
  openQuestions: unknown[];
  conflicts: unknown[];
  decisions: unknown[];
  risks: unknown[];
  sourceIds: number[];
  patchIds: number[];
  committedAt: string | null;
}

export interface HandoffBundle {
  sourceSummary: string;
  markdown: string;
  json: HandoffBundleJson;
  jsonText: string;
  truncated: boolean;
}

export interface HandoffArtifactRef {
  artifactUri: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface HandoffArtifactBytes {
  markdown: number;
  json: number;
  total: number;
}

export interface HandoffBuildExecutorRepository {
  getSession(sessionId: number): Promise<ComposeSessionSummary | null>;
  listSessionSources(sessionId: number): Promise<ComposeSessionSourceSummary[]>;
  getContextProjection(
    sessionId: number,
    version: number,
  ): Promise<ComposeContextProjection | null>;
  listMessages(sessionId: number): Promise<ComposeSessionMessageSummary[]>;
  confirmAgentTaskLease(input: {
    agentTaskId: number;
    workerId: string;
    leaseGeneration: number;
  }): Promise<boolean>;
  commitHandoffSnapshot(input: {
    handoffId: number;
    sessionId: number;
    sourceId: number;
    agentTaskId: number;
    workerId: string;
    leaseGeneration: number;
    contextVersionUsed: number | null;
    messageHighWatermarkId: number | null;
    sourceRevisionSetHash: string;
    repositoryManifestHash: string;
    snapshot: unknown;
    artifactUri: string;
    artifactSha256: string;
    artifactBytes: number;
    markdownArtifactUri: string | null;
    markdownArtifactSha256: string | null;
    markdownArtifactBytes: number | null;
    createdBy?: string | null;
  }): Promise<number>;
  markHandoffDraftQueued(input: {
    handoffId: number;
    draftWorkflowId?: number | null;
  }): Promise<void>;
}

export interface HandoffBuildSpecRepository {
  createEvidenceSnapshot(input: {
    sourceId: number;
    manifest: EvidenceManifest;
  }): Promise<number>;
}

export interface HandoffBuildWorkspace {
  writeArtifact(input: {
    workspacePath: string;
    relativePath: string;
    content: string | Buffer;
  }): Promise<HandoffArtifactRef>;
}

export interface HandoffBuildDraftRequester {
  requestDraftGeneration(input: {
    sourceId: number;
    actor?: string | null;
    idempotencyKey?: string | null;
    handoffSnapshotId?: number | null;
    reuseExistingDraft?: boolean;
  }): Promise<unknown>;
}

export interface HandoffBuildExecutorOptions {
  llmGateway?: Pick<LlmGateway, "generateObject">;
  enableLlmNarrative?: boolean;
  promptVersion?: string;
  maxCostUsd?: number;
  timeoutMs?: number;
}

const HandoffNarrativeEvidenceSchema = z
  .object({
    claim: z.string().trim().min(1).max(1000),
    sourceIds: z.array(z.number().int().positive()).default([]),
    notes: z.string().trim().max(1000).nullable().default(null),
  })
  .strict();

const HandoffNarrativeSchema = z
  .object({
    executiveSummary: z.string().trim().min(1).max(2000),
    implementationBrief: z.string().trim().min(1).max(4000),
    evidenceMap: z.array(HandoffNarrativeEvidenceSchema).max(20).default([]),
    openQuestions: z
      .array(z.string().trim().min(1).max(1000))
      .max(20)
      .default([]),
  })
  .strict();

const HANDOFF_NARRATIVE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    executiveSummary: { type: "string", minLength: 1, maxLength: 2000 },
    implementationBrief: { type: "string", minLength: 1, maxLength: 4000 },
    evidenceMap: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string", minLength: 1, maxLength: 1000 },
          sourceIds: {
            type: "array",
            items: { type: "integer", minimum: 1 },
          },
          notes: { type: ["string", "null"], maxLength: 1000 },
        },
        required: ["claim", "sourceIds", "notes"],
      },
    },
    openQuestions: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
  },
  required: [
    "executiveSummary",
    "implementationBrief",
    "evidenceMap",
    "openQuestions",
  ],
};

export function buildHandoffBundle(input: {
  session: ComposeSessionSummary;
  sources: ComposeSessionSourceSummary[];
  contextProjection?: ComposeContextProjection | null;
  narrative?: HandoffNarrative | null;
  handoffId?: number | null;
  requestedBy?: string | null;
  builtAt?: string;
  messages?: ComposeSessionMessageSummary[];
  messageHighWatermarkId?: number | null;
}): HandoffBundle {
  const summary = buildSourceSummary(input.session, input.sources);
  const json = buildJson(
    input.session,
    input.sources,
    input.contextProjection,
    input.narrative,
    input,
  );
  return {
    sourceSummary: summary.value,
    markdown: buildMarkdown(
      input.session,
      input.sources,
      input.contextProjection,
      input.narrative,
      input.messages ?? [],
    ),
    json,
    jsonText: `${JSON.stringify(json, null, 2)}\n`,
    truncated: summary.truncated,
  };
}

export function buildHandoffEvidenceManifest(input: {
  session: ComposeSessionSummary;
  bundle: HandoffBundle;
  markdownArtifact: HandoffArtifactRef;
  jsonArtifact: HandoffArtifactRef;
}): EvidenceManifest {
  return {
    sourceJiraKey: composeSourceJiraKey(input.session.id),
    sourceSummary: input.bundle.sourceSummary,
    sourceStatus: input.session.status,
    sourceLabels: [],
    descriptionMarkdown: input.bundle.markdown,
    loeHours: null,
    loeSource: null,
    comments: [],
    artifacts: [
      {
        kind: "raw_requirement",
        filename: "handoff-v2.md",
        content: input.bundle.markdown,
        artifactUri: input.markdownArtifact.artifactUri,
        relativePath: input.markdownArtifact.relativePath,
        mimeType: "text/markdown",
        sizeBytes: input.markdownArtifact.bytes,
        sha256: input.markdownArtifact.sha256,
        extractionStatus: "stored",
        isPriority: true,
      },
      {
        kind: "other",
        filename: "handoff-v2.json",
        content: input.bundle.jsonText,
        artifactUri: input.jsonArtifact.artifactUri,
        relativePath: input.jsonArtifact.relativePath,
        mimeType: "application/json",
        sizeBytes: input.jsonArtifact.bytes,
        sha256: input.jsonArtifact.sha256,
        extractionStatus: "stored",
        isPriority: false,
      },
    ],
    warnings: input.bundle.truncated
      ? ["Handoff source summary was truncated to fit source_summary."]
      : [],
  };
}

export class HandoffBuildExecutor implements AgentTaskExecutor {
  readonly executorType = "handoff_build";

  constructor(
    private readonly repository: HandoffBuildExecutorRepository,
    private readonly specRepository: HandoffBuildSpecRepository,
    private readonly workspace: HandoffBuildWorkspace,
    private readonly draftRequester: HandoffBuildDraftRequester,
    private readonly options: HandoffBuildExecutorOptions = {},
  ) {}

  async execute(task: ClaimedAgentTask): Promise<AgentTaskExecutionResult> {
    const handoffId = positiveIntegerInput(task.input, "handoffId");
    const sourceId = positiveIntegerInput(task.input, "sourceId");
    const actor = nullableStringInput(task.input, "actor");
    const contextVersionUsed = nullableNumberInput(
      task.input,
      "contextVersionUsed",
    );
    const messageHighWatermarkId = nullableNumberInput(
      task.input,
      "messageHighWatermarkId",
    );
    const [session, sources, contextProjection, allMessages] =
      await Promise.all([
        this.repository.getSession(task.sessionId),
        this.repository.listSessionSources(task.sessionId),
        contextVersionUsed === null
          ? Promise.resolve(null)
          : this.repository.getContextProjection(
              task.sessionId,
              contextVersionUsed,
            ),
        this.repository.listMessages(task.sessionId),
      ]);
    if (!session) {
      throw new Error(`Compose session ${task.sessionId} was not found`);
    }
    if (session.status === "archived") {
      throw new Error("handoff_build_session_archived");
    }
    if (session.sourceId !== sourceId) {
      throw new Error("handoff_build_source_not_linked");
    }
    if (contextVersionUsed !== null && contextProjection === null) {
      throw new Error(
        `handoff_context_version_missing:${task.sessionId}:${contextVersionUsed}`,
      );
    }
    const messages = allMessages.filter(
      (message) =>
        messageHighWatermarkId === null || message.id <= messageHighWatermarkId,
    );

    let bundle = buildHandoffBundle({
      session,
      sources,
      contextProjection,
      handoffId,
      requestedBy: actor,
      builtAt: nullableStringInput(task.input, "requestedAt") ?? task.queuedAt,
      messages,
      messageHighWatermarkId,
    });
    if (this.options.enableLlmNarrative) {
      await this.assertTaskLease(task);
      const narrative = await this.synthesizeNarrative({
        task,
        session,
        bundle,
        contextVersionUsed,
      });
      bundle = buildHandoffBundle({
        session,
        sources,
        contextProjection,
        narrative,
        handoffId,
        requestedBy: actor,
        builtAt:
          nullableStringInput(task.input, "requestedAt") ?? task.queuedAt,
        messages,
        messageHighWatermarkId,
      });
    }
    await this.assertTaskLease(task);
    const markdownArtifact = await this.workspace.writeArtifact({
      workspacePath: session.workspacePath,
      relativePath: `handoff/${handoffId}/handoff-v2.md`,
      content: bundle.markdown,
    });
    await this.assertTaskLease(task);
    const jsonArtifact = await this.workspace.writeArtifact({
      workspacePath: session.workspacePath,
      relativePath: `handoff/${handoffId}/handoff-v2.json`,
      content: bundle.jsonText,
    });
    await this.assertTaskLease(task);
    const snapshotId = await this.repository.commitHandoffSnapshot({
      handoffId,
      sessionId: task.sessionId,
      sourceId,
      agentTaskId: task.id,
      workerId: task.activeWorkerId!,
      leaseGeneration: task.leaseGeneration,
      contextVersionUsed,
      messageHighWatermarkId,
      sourceRevisionSetHash: bundle.json.sourceRevisionSetHash,
      repositoryManifestHash: bundle.json.repositoryManifestHash,
      snapshot: bundle.json,
      artifactUri: jsonArtifact.artifactUri,
      artifactSha256: jsonArtifact.sha256,
      artifactBytes: jsonArtifact.bytes,
      markdownArtifactUri: markdownArtifact.artifactUri,
      markdownArtifactSha256: markdownArtifact.sha256,
      markdownArtifactBytes: markdownArtifact.bytes,
      createdBy: actor,
    });
    await this.assertTaskLease(task);
    const evidenceSnapshotId = await this.specRepository.createEvidenceSnapshot(
      {
        sourceId,
        manifest: buildHandoffEvidenceManifest({
          session,
          bundle,
          markdownArtifact,
          jsonArtifact,
        }),
      },
    );
    await this.assertTaskLease(task);
    const draftRequest = await this.draftRequester.requestDraftGeneration({
      sourceId,
      actor,
      idempotencyKey: `handoff-${handoffId}`,
      handoffSnapshotId: snapshotId,
      ...(actor === "context-v4-backfill" ? { reuseExistingDraft: true } : {}),
    });
    const workflowId =
      draftRequest &&
      typeof draftRequest === "object" &&
      "workflowId" in draftRequest &&
      typeof (draftRequest as { workflowId?: unknown }).workflowId === "number"
        ? (draftRequest as { workflowId: number }).workflowId
        : null;
    await this.repository.markHandoffDraftQueued({
      handoffId,
      draftWorkflowId: workflowId,
    });
    await this.assertTaskLease(task);

    const artifactBytes: HandoffArtifactBytes = {
      markdown: markdownArtifact.bytes,
      json: jsonArtifact.bytes,
      total: markdownArtifact.bytes + jsonArtifact.bytes,
    };
    return {
      // Handoff source IDs belong to spec_factory_sources, not compose_session_sources.
      outputSourceId: null,
      contextVersionUsed,
      output: {
        sourceId,
        handoffId,
        snapshotId,
        draftWorkflowId: workflowId,
        evidenceSnapshotId,
        sourceSummary: bundle.sourceSummary,
        artifactBytes,
        artifacts: {
          markdown: markdownArtifact.artifactUri,
          json: jsonArtifact.artifactUri,
        },
      },
      runtime: {
        outputArtifactUri: markdownArtifact.artifactUri,
      },
    };
  }

  private async assertTaskLease(task: ClaimedAgentTask): Promise<void> {
    if (!task.activeWorkerId) {
      throw new Error(LOST_AGENT_TASK_LEASE_MESSAGE);
    }
    const ok = await this.repository.confirmAgentTaskLease({
      agentTaskId: task.id,
      workerId: task.activeWorkerId,
      leaseGeneration: task.leaseGeneration,
    });
    if (!ok) {
      throw new Error(LOST_AGENT_TASK_LEASE_MESSAGE);
    }
  }

  private async synthesizeNarrative(input: {
    task: ClaimedAgentTask;
    session: ComposeSessionSummary;
    bundle: HandoffBundle;
    contextVersionUsed: number | null;
  }): Promise<HandoffNarrative> {
    if (!this.options.llmGateway) {
      throw new Error("handoff_synthesis_requires_llm_gateway");
    }
    const narrative =
      await this.options.llmGateway.generateObject<HandoffNarrative>({
        sessionId: input.session.id,
        agentTaskId: input.task.id,
        purpose: "handoff_synthesis",
        promptVersion: resolvePromptVersion({
          purpose: "handoff_synthesis",
          requestedVersion:
            this.options.promptVersion ?? HANDOFF_SYNTHESIS_PROMPT_VERSION,
        }),
        prompt: buildHandoffSynthesisPrompt(input.bundle),
        schema: HandoffNarrativeSchema,
        jsonSchema: HANDOFF_NARRATIVE_JSON_SCHEMA,
        contextVersionUsed: input.contextVersionUsed,
        maxCostUsd: this.options.maxCostUsd,
        timeoutMs: this.options.timeoutMs,
      });
    return {
      ...narrative,
      openQuestions: narrative.openQuestions.filter(isUserFacingClarification),
    };
  }
}

export function createHandoffExecutorRegistry(
  repository: HandoffBuildExecutorRepository,
  specRepository: HandoffBuildSpecRepository,
  workspace: HandoffBuildWorkspace,
  draftRequester: HandoffBuildDraftRequester,
  options: HandoffBuildExecutorOptions = {},
): AgentTaskExecutorRegistry {
  return new AgentTaskExecutorRegistry([
    new HandoffBuildExecutor(
      repository,
      specRepository,
      workspace,
      draftRequester,
      options,
    ),
  ]);
}

function buildSourceSummary(
  session: ComposeSessionSummary,
  sources: ComposeSessionSourceSummary[],
): { value: string; truncated: boolean } {
  const readiness = session.readiness;
  const sourceCount = sources.length;
  const generatedResearchCount = sources.filter(
    (source) => source.kind === "generated_research",
  ).length;
  const openQuestion = firstOpenQuestion(readiness);
  const parts = [
    session.name,
    readiness ? (readiness.ready ? "ready" : "not ready") : null,
    sourceCount > 0
      ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}`
      : null,
    generatedResearchCount > 0
      ? `${generatedResearchCount} research artifact${generatedResearchCount === 1 ? "" : "s"}`
      : null,
    session.latestContextVersion != null
      ? `context v${session.latestContextVersion}`
      : null,
    openQuestion ? `open: ${openQuestion}` : null,
  ].filter(Boolean);

  return truncateForSourceSummary(parts.join(" - "));
}

function buildMarkdown(
  session: ComposeSessionSummary,
  sources: ComposeSessionSourceSummary[],
  contextProjection?: ComposeContextProjection | null,
  narrative?: HandoffNarrative | null,
  messages: ComposeSessionMessageSummary[] = [],
): string {
  const readiness = session.readiness;
  const lines = [
    `# Handoff: ${session.name}`,
    "",
    `Session: ${session.id}`,
    `Status: ${session.status}`,
  ];
  if (session.latestContextVersion != null) {
    lines.push(`Context version: ${session.latestContextVersion}`);
  }
  if (readiness) {
    lines.push("", "## Readiness", readiness.ready ? "Ready" : "Not ready");
    if (readiness.summary) lines.push("", readiness.summary);
    appendList(
      lines,
      "Business and functional clarifications",
      openQuestions(readiness),
    );
    appendList(lines, "Risks", readiness.risks ?? []);
    appendList(lines, "Assumptions", readiness.assumptions ?? []);
    appendList(lines, "Missing evidence", readiness.missingEvidence ?? []);
  }
  appendWorkingContext(lines, contextProjection);
  appendNarrative(lines, narrative);
  appendList(
    lines,
    "Conversation snapshot",
    messages.map(
      (message) =>
        `${message.id} ${message.role} (${message.createdAt}): ${message.content}`,
    ),
  );
  appendList(lines, "Sources", sources.map(formatSourceLine));
  const generatedResearch = sources
    .filter((source) => source.kind === "generated_research")
    .map(formatSourceLine);
  appendList(lines, "Generated research", generatedResearch);
  return lines.join("\n").trimEnd();
}

function buildJson(
  session: ComposeSessionSummary,
  sources: ComposeSessionSourceSummary[],
  contextProjection?: ComposeContextProjection | null,
  narrative?: HandoffNarrative | null,
  snapshot: {
    handoffId?: number | null;
    requestedBy?: string | null;
    builtAt?: string;
    messages?: ComposeSessionMessageSummary[];
    messageHighWatermarkId?: number | null;
  } = {},
): HandoffBundleJson {
  const sourceRefs = sources.map(formatSourceRef);
  const messages = snapshot.messages ?? [];
  const repositories = [...(session.readiness?.repoEvidence ?? [])].sort(
    (a, b) => a.repoName.localeCompare(b.repoName),
  );
  const sourceRevisionSetHash = sha256Canonical(
    sourceRefs.map((source) => ({
      sourceId: source.id,
      sourceRevisionId: source.sourceRevisionId,
      contentSha256: source.contentSha256,
      artifactSha256: source.artifactSha256,
    })),
  );
  const repositoryManifestHash = sha256Canonical(repositories);
  return {
    schemaVersion: 2,
    handoffId: snapshot.handoffId ?? null,
    sessionId: session.id,
    sessionName: session.name,
    sessionOwner: session.createdBy ?? null,
    requestedBy: snapshot.requestedBy ?? null,
    builtAt: snapshot.builtAt ?? session.updatedAt,
    status: session.status,
    latestContextVersion: session.latestContextVersion ?? null,
    contextVersionUsed: contextProjection?.version ?? null,
    messageHighWatermarkId: snapshot.messageHighWatermarkId ?? null,
    messages,
    sourceRevisionSetHash,
    repositoryManifestHash,
    repositories,
    narrative: narrative ?? null,
    workingContext: contextProjection
      ? {
          version: contextProjection.version,
          artifactUri: contextProjection.artifactUri,
          structuredArtifactUri: contextProjection.structuredArtifactUri,
          summary: contextProjection.summary,
          facts: contextProjection.facts ?? [],
          implementationFindings:
            contextProjection.implementationFindings ?? [],
          requirements: contextProjection.requirements ?? [],
          constraints: contextProjection.constraints ?? [],
          openQuestions: contextProjection.openQuestions ?? [],
          conflicts: contextProjection.conflicts ?? [],
          decisions: contextProjection.decisions ?? [],
          risks: contextProjection.risks ?? [],
          sourceIds: contextProjection.sourceIds ?? [],
          patchIds: contextProjection.patchIds ?? [],
          committedAt: contextProjection.committedAt,
        }
      : null,
    readiness: session.readiness
      ? {
          ready: session.readiness.ready,
          summary: session.readiness.summary ?? null,
          openQuestions: openQuestions(session.readiness),
          risks: session.readiness.risks ?? [],
          assumptions: session.readiness.assumptions ?? [],
          missingEvidence: session.readiness.missingEvidence ?? [],
        }
      : null,
    sources: sourceRefs,
    generatedResearch: sourceRefs.filter(
      (source) => source.kind === "generated_research",
    ),
  };
}

function appendWorkingContext(
  lines: string[],
  contextProjection?: ComposeContextProjection | null,
): void {
  if (!contextProjection) return;

  lines.push("", "## Working Context", `Version: ${contextProjection.version}`);
  const summary = contextProjection.summary;
  if (summary?.objective) {
    lines.push("", "Objective:", summary.objective);
  }
  if (summary?.problemStatement) {
    lines.push("", "Problem statement:", summary.problemStatement);
  }
  if (summary?.solution) {
    lines.push("", "Solution intent:", summary.solution);
  }
  appendList(
    lines,
    "Business requirements",
    summary?.businessRequirements ?? [],
  );
  appendList(
    lines,
    "Functional requirements",
    summary?.functionalRequirements ?? [],
  );
  appendList(lines, "Product challenges", summary?.challenges ?? []);
  if ((summary?.stories?.length ?? 0) > 0) {
    lines.push("", "## Product stories");
    for (const [index, story] of (summary?.stories ?? []).entries()) {
      lines.push("", `### ${index + 1}. ${story.title}`);
      lines.push(story.userStory || story.summary);
      if (story.businessValue) {
        lines.push(`Business value: ${story.businessValue}`);
      }
      for (const criterion of story.acceptanceCriteria ?? []) {
        lines.push("", criterion);
      }
    }
  }
  appendList(
    lines,
    "Recommended next actions",
    summary?.recommendedNextActions ?? [],
  );
  appendList(
    lines,
    "Facts",
    (contextProjection.facts ?? []).map(formatUnknown),
  );
  appendList(
    lines,
    "Implementation findings",
    (contextProjection.implementationFindings ?? []).map(formatUnknown),
  );
  appendList(
    lines,
    "Requirements",
    (contextProjection.requirements ?? []).map(formatUnknown),
  );
  appendList(
    lines,
    "Constraints",
    (contextProjection.constraints ?? []).map(formatUnknown),
  );
  appendList(
    lines,
    "Context open questions",
    (contextProjection.openQuestions ?? [])
      .filter(isUserFacingClarification)
      .map(formatUnknown),
  );
  appendList(
    lines,
    "Decisions",
    (contextProjection.decisions ?? []).map(formatUnknown),
  );
  appendList(
    lines,
    "Conflicts",
    (contextProjection.conflicts ?? []).map(formatUnknown),
  );
  appendList(
    lines,
    "Risks",
    (contextProjection.risks ?? []).map(formatUnknown),
  );
}

function appendNarrative(
  lines: string[],
  narrative?: HandoffNarrative | null,
): void {
  if (!narrative) return;

  lines.push("", "## LLM Handoff Narrative");
  lines.push("", "Executive summary:", narrative.executiveSummary);
  lines.push("", "Implementation brief:", narrative.implementationBrief);
  appendList(lines, "Narrative open questions", narrative.openQuestions);
  appendList(
    lines,
    "Evidence map",
    narrative.evidenceMap.map((item) => {
      const sourceIds = item.sourceIds.length
        ? `sources ${item.sourceIds.join(", ")}`
        : "no source ids";
      return item.notes
        ? `${item.claim} (${sourceIds}) - ${item.notes}`
        : `${item.claim} (${sourceIds})`;
    }),
  );
}

function buildHandoffSynthesisPrompt(bundle: HandoffBundle): string {
  return [
    "You are preparing a concise handoff narrative for a Spec Factory Compose session.",
    "Use only the supplied deterministic handoff bundle. Do not invent evidence, repositories, files, or implementation details.",
    "The audience is a professional product owner. Center the narrative on the business problem, desired outcomes, functional behavior, challenges, and verifiable requirements.",
    "Only include business or functional clarifications in openQuestions. Never ask the user to choose methods, classes, files, repositories, schemas, frameworks, architecture, or implementation approaches.",
    "Return JSON matching the schema: executiveSummary, implementationBrief, evidenceMap, openQuestions.",
    "Keep executiveSummary operator-friendly, keep implementationBrief specific enough for the draft pipeline, and cite source ids in evidenceMap when available.",
    "",
    "Deterministic handoff bundle:",
    bundle.jsonText,
  ].join("\n");
}

function formatSourceRef(
  source: ComposeSessionSourceSummary,
): HandoffBundleSource {
  return {
    id: source.id,
    kind: source.kind,
    filename: source.originalFilename ?? null,
    sourceUrl: source.sourceUrl ?? null,
    summary: source.sourceSummary ?? null,
    conversionStatus: source.conversionStatus,
    artifactUri: source.artifactUri ?? source.markdownPath ?? null,
    contextVersionUsed: source.contextVersionUsed ?? null,
    sourceRevisionId: source.currentRevisionId ?? null,
    contentSha256: source.contentSha256 ?? null,
    artifactSha256: source.artifactSha256 ?? null,
    artifactBytes: source.artifactBytes ?? null,
  };
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function appendList(lines: string[], heading: string, items: string[]): void {
  const cleanItems = items.map(compactWhitespace).filter(Boolean);
  if (cleanItems.length === 0) return;
  lines.push("", `## ${heading}`);
  for (const item of cleanItems) {
    lines.push(`- ${item}`);
  }
}

function formatSourceLine(source: ComposeSessionSourceSummary): string {
  const label =
    source.originalFilename ??
    source.sourceUrl ??
    source.sourceSummary ??
    `source-${source.id}`;
  const detail = source.sourceSummary ? `: ${source.sourceSummary}` : "";
  return `${label} (${source.kind}, ${source.conversionStatus})${detail}`;
}

function firstOpenQuestion(readiness: ComposeReadiness | null): string | null {
  return openQuestions(readiness)[0] ?? null;
}

function openQuestions(readiness: ComposeReadiness | null): string[] {
  if (!readiness) return [];
  const structured = readiness.questions
    ?.filter(
      (question) => !question.answered && isUserFacingClarification(question),
    )
    .map((question) => question.question)
    .filter(Boolean);
  if (structured && structured.length > 0) return structured;
  return (readiness.openQuestions ?? []).filter(isUserFacingClarification);
}

function truncateForSourceSummary(input: string): {
  value: string;
  truncated: boolean;
} {
  const compacted = compactWhitespace(input);
  if (compacted.length <= HANDOFF_SOURCE_SUMMARY_MAX_CHARS) {
    return { value: compacted, truncated: false };
  }
  return {
    value: `${compacted.slice(0, HANDOFF_SOURCE_SUMMARY_MAX_CHARS - 3)}...`,
    truncated: true,
  };
}

function compactWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}

function positiveIntegerInput(input: unknown, key: string): number {
  const value = inputRecord(input)[key];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`invalid_handoff_build_input:${key}`);
}

function nullableStringInput(input: unknown, key: string): string | null {
  const value = inputRecord(input)[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function nullableNumberInput(input: unknown, key: string): number | null {
  const value = inputRecord(input)[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return null;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
