import type {
  ComposeContextProjection,
  ComposeSessionSourceSummary,
  ComposeStory,
} from "../compose-types.js";
import {
  applyContextPatches,
  CONTEXT_MAX_OPERATIONS,
  CONTEXT_MAX_TEXT_CHARS,
  legacyPatchToV4,
  normalizeContextItem,
  type ContextSection,
  type ContextPatchV4,
} from "../context/context-model.js";
import type { LlmGateway } from "../llm/llm-gateway.js";
import { resolvePromptVersion } from "../llm/prompt-registry.js";
import type {
  ClaimedAgentTask,
  ComposeSourceChunk,
  ContextVersionBuild,
} from "../compose-database.js";
import type {
  AgentTaskExecutionResult,
  AgentTaskExecutor,
} from "./executor-registry.js";
import { createLogger } from "../../utils/logger.js";
import { AgentTaskExecutorRegistry } from "./executor-registry.js";
import { z } from "zod";
import {
  clarificationText,
  clarificationType,
  isUserFacingClarification,
} from "../requirements-policy.js";
import { normalizeGherkinCriteria } from "../gherkin.js";

const logger = createLogger("spec-factory-context-executors");
const SOURCE_DISTILLATION_PROMPT_VERSION = resolvePromptVersion({
  purpose: "source_distillation",
});
const CONTEXT_MERGE_PROMPT_VERSION = resolvePromptVersion({
  purpose: "context_merge",
});
const SOURCE_DISTILLATION_PROMPT_MAX_CHARS = 24_000;
const CONTEXT_MERGE_PROMPT_MAX_CHARS = 32_000;

interface ComposeSessionForContext {
  id: number;
  workspacePath: string;
}

interface WorkspaceArtifactRef {
  artifactUri: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}

interface ContextExecutorWorkspace {
  writeArtifact(input: {
    workspacePath: string;
    relativePath: string;
    content: string | Buffer;
  }): Promise<WorkspaceArtifactRef>;
}

interface ReadyContextPatch {
  id: number;
  sessionId: number;
  sourceId?: number | null;
  agentTaskId?: number | null;
  baseContextVersion?: number | null;
  patch: unknown;
}

interface ContextExecutorRepository {
  getSession(sessionId: number): Promise<ComposeSessionForContext | null>;
  getSessionSource(
    sourceId: number,
  ): Promise<ComposeSessionSourceSummary | null>;
  getContextProjection(
    sessionId: number,
    version: number,
  ): Promise<ComposeContextProjection | null>;
  listSourceChunks?(sourceRevisionId: number): Promise<ComposeSourceChunk[]>;
  createReadyContextPatch(input: {
    sessionId: number;
    sourceId?: number | null;
    sourceRevisionId?: number | null;
    agentTaskId?: number | null;
    turnJobId?: number | null;
    baseContextVersion?: number | null;
    schemaVersion?: number;
    patchKind?:
      | "source_distillation"
      | "conversation"
      | "source_removal"
      | "repair";
    idempotencyKey?: string | null;
    messageIds?: number[];
    patch: unknown;
    patchUri?: string | null;
    artifactSha256?: string | null;
    artifactBytes?: number | null;
  }): Promise<number>;
  enqueueContextMergeTaskIfNeeded(input: {
    sessionId: number;
    triggerPatchId?: number | null;
  }): Promise<number | null>;
  listReadyContextPatches(sessionId: number): Promise<ReadyContextPatch[]>;
  beginContextVersionBuild(input: {
    sessionId: number;
    createdByTaskId?: number | null;
  }): Promise<ContextVersionBuild>;
  failContextVersionBuild?(input: {
    sessionId: number;
    contextVersionId: number;
    version: number;
    errorMessage: string;
  }): Promise<boolean>;
  commitContextVersion(input: {
    sessionId: number;
    contextVersionId: number;
    version: number;
    artifactUri: string;
    structuredArtifactUri?: string | null;
    summary?: unknown;
    facts?: unknown;
    implementationFindings?: unknown;
    requirements?: unknown;
    constraints?: unknown;
    openQuestions?: unknown;
    conflicts?: unknown;
    decisions?: unknown;
    risks?: unknown;
    sourceIds?: number[];
    patchIds?: number[];
    artifactSha256: string;
    artifactBytes: number;
  }): Promise<boolean>;
  appendSessionEvent?(input: {
    sessionId: number;
    eventType: string;
    payload: unknown;
    actorType?: string | null;
    actorId?: string | null;
    agentTaskId?: number | null;
    contextVersion?: number | null;
  }): Promise<unknown>;
}

interface DistillationPatch {
  problemStatementAdditions: Array<Record<string, unknown>>;
  sourceId: number;
  sourceKind: string;
  sourceFilename: string | null;
  sourceMarkdownUri: string | null;
  facts: Array<Record<string, unknown>>;
  implementationFindings: Array<Record<string, unknown>>;
  requirements: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  openQuestions: Array<Record<string, unknown>>;
  risks: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
}

type DistillationSection = Exclude<
  keyof DistillationPatch,
  | "problemStatementAdditions"
  | "sourceId"
  | "sourceKind"
  | "sourceFilename"
  | "sourceMarkdownUri"
>;

const DISTILLATION_COMPACTION_ORDER: DistillationSection[] = [
  "requirements",
  "constraints",
  "decisions",
  "conflicts",
  "risks",
  "implementationFindings",
  "openQuestions",
  "facts",
];

const DistillationPatchItemSchema = z
  .object({
    text: z.string().trim().min(1).max(CONTEXT_MAX_TEXT_CHARS),
  })
  .passthrough();

const DISTILLATION_PATCH_ITEM_JSON_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: CONTEXT_MAX_TEXT_CHARS,
    },
  },
  required: ["text"],
  additionalProperties: true,
};

export const SourceDistillationPatchSchema = z.object({
  problemStatementAdditions: z.array(DistillationPatchItemSchema).default([]),
  facts: z.array(DistillationPatchItemSchema).default([]),
  implementationFindings: z.array(DistillationPatchItemSchema).default([]),
  requirements: z.array(DistillationPatchItemSchema).default([]),
  constraints: z.array(DistillationPatchItemSchema).default([]),
  decisions: z.array(DistillationPatchItemSchema).default([]),
  openQuestions: z.array(DistillationPatchItemSchema).default([]),
  risks: z.array(DistillationPatchItemSchema).default([]),
  conflicts: z.array(DistillationPatchItemSchema).default([]),
});

export type SourceDistillationPatch = z.infer<
  typeof SourceDistillationPatchSchema
>;

export const SOURCE_DISTILLATION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    problemStatementAdditions: {
      type: "array",
      items: DISTILLATION_PATCH_ITEM_JSON_SCHEMA,
    },
    facts: { type: "array", items: DISTILLATION_PATCH_ITEM_JSON_SCHEMA },
    implementationFindings: {
      type: "array",
      items: DISTILLATION_PATCH_ITEM_JSON_SCHEMA,
    },
    requirements: {
      type: "array",
      items: DISTILLATION_PATCH_ITEM_JSON_SCHEMA,
    },
    constraints: {
      type: "array",
      items: DISTILLATION_PATCH_ITEM_JSON_SCHEMA,
    },
    decisions: {
      type: "array",
      items: DISTILLATION_PATCH_ITEM_JSON_SCHEMA,
    },
    openQuestions: {
      type: "array",
      items: DISTILLATION_PATCH_ITEM_JSON_SCHEMA,
    },
    risks: { type: "array", items: DISTILLATION_PATCH_ITEM_JSON_SCHEMA },
    conflicts: {
      type: "array",
      items: DISTILLATION_PATCH_ITEM_JSON_SCHEMA,
    },
  },
  required: [
    "problemStatementAdditions",
    "facts",
    "implementationFindings",
    "requirements",
    "constraints",
    "decisions",
    "openQuestions",
    "risks",
    "conflicts",
  ],
  additionalProperties: false,
};

export const ContextMergeDraftSchema = z.object({
  objective: z.string().trim().default(""),
  problemStatement: z.string().trim().default(""),
  solution: z.string().trim().default(""),
  businessRequirements: z.array(z.string().trim().min(1)).default([]),
  functionalRequirements: z.array(z.string().trim().min(1)).default([]),
  challenges: z.array(z.string().trim().min(1)).default([]),
  stories: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        title: z.string().trim().min(1),
        userStory: z.string().trim().min(1),
        businessValue: z.string().trim().default(""),
        acceptanceCriteria: z.array(z.string().trim().min(1)).default([]),
        sequence: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  facts: z.array(z.unknown()).default([]),
  implementationFindings: z.array(z.unknown()).default([]),
  requirements: z.array(z.unknown()).default([]),
  constraints: z.array(z.unknown()).default([]),
  decisions: z.array(z.unknown()).default([]),
  openQuestions: z.array(z.unknown()).default([]),
  conflicts: z.array(z.unknown()).default([]),
  risks: z.array(z.unknown()).default([]),
  recommendedNextActions: z.array(z.unknown()).default([]),
});

export type ContextMergeDraft = z.infer<typeof ContextMergeDraftSchema>;

export const CONTEXT_MERGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    objective: { type: "string" },
    problemStatement: { type: "string" },
    solution: { type: "string" },
    businessRequirements: { type: "array", items: { type: "string" } },
    functionalRequirements: { type: "array", items: { type: "string" } },
    challenges: { type: "array", items: { type: "string" } },
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          userStory: { type: "string" },
          businessValue: { type: "string" },
          acceptanceCriteria: {
            type: "array",
            items: { type: "string" },
          },
          sequence: { type: "integer", minimum: 0 },
        },
        required: [
          "id",
          "title",
          "userStory",
          "businessValue",
          "acceptanceCriteria",
          "sequence",
        ],
        additionalProperties: false,
      },
    },
    facts: { type: "array" },
    implementationFindings: { type: "array" },
    requirements: { type: "array" },
    constraints: { type: "array" },
    decisions: { type: "array" },
    openQuestions: { type: "array" },
    conflicts: { type: "array" },
    risks: { type: "array" },
    recommendedNextActions: { type: "array" },
  },
  required: [
    "objective",
    "problemStatement",
    "solution",
    "businessRequirements",
    "functionalRequirements",
    "challenges",
    "stories",
    "facts",
    "implementationFindings",
    "requirements",
    "constraints",
    "decisions",
    "openQuestions",
    "conflicts",
    "risks",
    "recommendedNextActions",
  ],
  additionalProperties: false,
};

export const CONTEXT_MERGE_DIRECT_JSON_SCHEMA: Record<string, unknown> =
  contextMergeDirectJsonSchema();

function contextMergeDirectJsonSchema(): Record<string, unknown> {
  const schema = structuredClone(CONTEXT_MERGE_JSON_SCHEMA);
  const properties = schema.properties as Record<string, unknown>;
  const stories = properties.stories as Record<string, unknown>;
  const items = stories.items as Record<string, unknown>;
  const storyProperties = items.properties as Record<string, unknown>;
  storyProperties.sequence = { type: "integer" };
  return schema;
}

interface WorkingContext {
  objective: string;
  problemStatement: string;
  solution: string;
  businessRequirements: string[];
  functionalRequirements: string[];
  challenges: string[];
  stories: ContextMergeDraft["stories"];
  facts: unknown[];
  implementationFindings: unknown[];
  requirements: unknown[];
  constraints: unknown[];
  decisions: unknown[];
  openQuestions: unknown[];
  conflicts: unknown[];
  risks: unknown[];
  sources: number[];
  generatedResearch: number[];
  recommendedNextActions: string[];
  patchIds: number[];
  parentVersion: number | null;
  version: number;
}

function normalizeWorkingContextStory(
  story: ComposeStory,
  index: number,
): ContextMergeDraft["stories"][number] {
  const title = story.title.trim() || `Story ${index + 1}`;
  const userStory = normalizeUserStory(
    story.userStory?.trim() || story.summary?.trim() || title,
    title,
    story.businessValue?.trim() || "",
  );
  return {
    id: story.id || `story-${index + 1}`,
    title,
    userStory,
    businessValue: story.businessValue?.trim() || "",
    acceptanceCriteria: normalizeGherkinCriteria(
      story.acceptanceCriteria ?? [],
      title,
      userStory,
    ),
    sequence: story.sequence ?? index,
  };
}

function normalizeUserStory(
  value: string,
  title: string,
  businessValue: string,
): string {
  const trimmed = value.trim();
  if (/^As (?:an?|the) .+\bI want\b.+\bso that\b.+/i.test(trimmed)) {
    return trimmed;
  }
  const capability = (trimmed || title).replace(/[.]+$/, "");
  const outcome =
    businessValue.replace(/[.]+$/, "") ||
    "the intended business outcome is achieved";
  return `As a product user, I want ${capability.toLowerCase()}, so that ${outcome.toLowerCase()}.`;
}

export class SourceDistillationExecutor implements AgentTaskExecutor {
  readonly executorType = "source_distillation";

  constructor(
    private readonly repository: ContextExecutorRepository,
    private readonly workspace: ContextExecutorWorkspace,
    private readonly options: {
      llmGateway?: Pick<LlmGateway, "generateObject">;
      maxCostUsd?: number;
      timeoutMs?: number;
    } = {},
  ) {}

  async execute(task: ClaimedAgentTask): Promise<AgentTaskExecutionResult> {
    const sourceId = positiveNumberField(task.input, "sourceId");
    const [session, source] = await Promise.all([
      this.repository.getSession(task.sessionId),
      this.repository.getSessionSource(sourceId),
    ]);
    if (!session) {
      throw new Error(`Compose session ${task.sessionId} was not found`);
    }
    if (!source || source.sessionId !== task.sessionId) {
      throw new Error(
        `Compose source ${sourceId} was not found in session ${task.sessionId}`,
      );
    }
    if (source.conversionStatus !== "converted") {
      throw new Error(
        `Compose source ${sourceId} is not converted (${source.conversionStatus})`,
      );
    }

    const baseContextVersion =
      numberField(task.input, "baseContextVersion") ??
      source.contextVersionUsed ??
      null;
    await publishContextExecutorEvent(this.repository, {
      sessionId: task.sessionId,
      eventType: "source.distillation.started",
      payload: {
        sourceId: source.id,
        sourceKind: source.kind,
        baseContextVersion,
      },
      actorType: "system",
      actorId: "source_distillation",
      agentTaskId: task.id,
      contextVersion: baseContextVersion,
    });
    const chunks =
      source.currentRevisionId && this.repository.listSourceChunks
        ? await this.repository.listSourceChunks(source.currentRevisionId)
        : [];
    const sourceSlices =
      chunks.length > 0
        ? chunks.map((chunk) => ({
            ...source,
            markdownContent: chunk.content,
            artifactUri: chunk.artifactUri,
          }))
        : [source];
    const distilledSlices = this.options.llmGateway
      ? await mapWithConcurrency(sourceSlices, 4, (sourceSlice) =>
          buildLlmSourceDistillationPatch({
            llmGateway: this.options.llmGateway!,
            task,
            source: sourceSlice,
            baseContextVersion,
            maxCostUsd: this.options.maxCostUsd,
            timeoutMs: this.options.timeoutMs,
          }),
        )
      : sourceSlices.map((sourceSlice) =>
          buildSourceDistillationPatch(sourceSlice),
        );
    const legacyPatch = mergeDistillationPatches(distilledSlices, source);
    const boundedPatch = compactDistillationPatch(
      legacyPatch,
      source.id,
      CONTEXT_MAX_OPERATIONS,
    );
    const wasCompacted =
      Object.keys(boundedPatch.droppedItemsBySection).length > 0;
    if (wasCompacted) {
      logger.warn(
        {
          taskId: task.id,
          sessionId: task.sessionId,
          sourceId: source.id,
          droppedItemsBySection: boundedPatch.droppedItemsBySection,
        },
        "Spec Factory source distillation patch compacted",
      );
    }
    const patch = legacyPatchToV4({
      patch: boundedPatch.patch,
      kind: "source_distillation",
      sourceId: source.id,
      sourceRevisionId: source.currentRevisionId,
    });
    const artifact = await this.workspace.writeArtifact({
      workspacePath: session.workspacePath,
      relativePath: `context/patches/source-${source.id}-task-${task.id}.json`,
      content: `${JSON.stringify(patch, null, 2)}\n`,
    });
    const patchId = await this.repository.createReadyContextPatch({
      sessionId: task.sessionId,
      sourceId: source.id,
      sourceRevisionId: source.currentRevisionId,
      agentTaskId: task.id,
      turnJobId: task.turnJobId,
      baseContextVersion,
      schemaVersion: 4,
      patchKind: "source_distillation",
      idempotencyKey: `agent-task:${task.id}:source-distillation:v4`,
      patch,
      patchUri: artifact.artifactUri,
      artifactSha256: artifact.sha256,
      artifactBytes: artifact.bytes,
    });
    await publishContextExecutorEvent(this.repository, {
      sessionId: task.sessionId,
      eventType: "context.patch.created",
      payload: {
        patchId,
        sourceId: source.id,
        baseContextVersion,
        artifactUri: artifact.artifactUri,
      },
      actorType: "system",
      actorId: "source_distillation",
      agentTaskId: task.id,
      contextVersion: baseContextVersion,
    });
    const mergeTaskId = await this.repository.enqueueContextMergeTaskIfNeeded({
      sessionId: task.sessionId,
      triggerPatchId: patchId,
    });
    await publishContextExecutorEvent(this.repository, {
      sessionId: task.sessionId,
      eventType: "source.distillation.completed",
      payload: {
        sourceId: source.id,
        patchId,
        mergeTaskId,
        artifactUri: artifact.artifactUri,
        ...(wasCompacted
          ? { droppedItemsBySection: boundedPatch.droppedItemsBySection }
          : {}),
      },
      actorType: "system",
      actorId: "source_distillation",
      agentTaskId: task.id,
      contextVersion: baseContextVersion,
    });
    return {
      output: {
        patchId,
        mergeTaskId,
        sourceId: source.id,
        artifactUri: artifact.artifactUri,
        ...(wasCompacted
          ? {
              compaction: {
                droppedItemsBySection: boundedPatch.droppedItemsBySection,
              },
            }
          : {}),
      },
      contextVersionUsed: baseContextVersion,
    };
  }
}

export class ContextMergeExecutor implements AgentTaskExecutor {
  readonly executorType = "context_merge";

  constructor(
    private readonly repository: ContextExecutorRepository,
    private readonly workspace: ContextExecutorWorkspace,
    private readonly options: {
      llmGateway?: Pick<LlmGateway, "generateObject">;
      maxCostUsd?: number;
      timeoutMs?: number;
    } = {},
  ) {}

  async execute(task: ClaimedAgentTask): Promise<AgentTaskExecutionResult> {
    const sessionId = numberField(task.input, "sessionId") ?? task.sessionId;
    const [session, patches] = await Promise.all([
      this.repository.getSession(sessionId),
      this.repository.listReadyContextPatches(sessionId),
    ]);
    if (!session) {
      throw new Error(`Compose session ${sessionId} was not found`);
    }
    if (patches.length === 0) {
      return {
        output: {
          contextVersionSkipped: "no_ready_patches",
          patchIds: [],
        },
      };
    }

    await publishContextExecutorEvent(this.repository, {
      sessionId,
      eventType: "context.merge.started",
      payload: {
        patchIds: patches.map((patch) => patch.id),
      },
      actorType: "system",
      actorId: "context_merge",
      agentTaskId: task.id,
    });
    const build = await this.repository.beginContextVersionBuild({
      sessionId,
      createdByTaskId: task.id,
    });
    try {
      const parent =
        build.parentVersion === null
          ? null
          : await this.repository.getContextProjection(
              sessionId,
              build.parentVersion,
            );
      if (build.parentVersion !== null && !parent) {
        throw new Error(
          `Compose context version ${build.parentVersion} was not found for session ${sessionId}`,
        );
      }
      const deterministicBuild = buildWorkingContext(patches, build, parent);
      const deterministicContext = deterministicBuild.context;
      const wasCompacted =
        Object.keys(deterministicBuild.droppedItemsBySection).length > 0;
      if (wasCompacted) {
        logger.warn(
          {
            taskId: task.id,
            sessionId,
            contextVersion: build.version,
            droppedItemsBySection: deterministicBuild.droppedItemsBySection,
          },
          "Spec Factory merged context compacted",
        );
      }
      let context = deterministicContext;
      let llmRefinement: "not_requested" | "succeeded" | "degraded" =
        "not_requested";
      if (this.options.llmGateway) {
        try {
          context = await buildLlmMergedWorkingContext({
            llmGateway: this.options.llmGateway,
            task,
            patches,
            baseline: deterministicContext,
            maxCostUsd: this.options.maxCostUsd,
            timeoutMs: this.options.timeoutMs,
          });
          llmRefinement = "succeeded";
        } catch (error) {
          llmRefinement = "degraded";
          logger.warn(
            {
              err: error,
              taskId: task.id,
              sessionId,
              contextVersion: build.version,
            },
            "Spec Factory context merge LLM refinement failed; using deterministic context",
          );
          await publishContextExecutorEvent(this.repository, {
            sessionId,
            eventType: "context.merge.degraded",
            payload: {
              contextVersion: build.version,
              patchIds: patches.map((patch) => patch.id),
              fallback: "deterministic_merge",
              errorCode: contextMergeRefinementErrorCode(error),
            },
            actorType: "system",
            actorId: "context_merge",
            agentTaskId: task.id,
            contextVersion: build.version,
          });
        }
      }
      const markdown = renderWorkingContextMarkdown(context);
      const markdownArtifact = await this.workspace.writeArtifact({
        workspacePath: session.workspacePath,
        relativePath: `context/versions/working-context-v${build.version}.md`,
        content: markdown,
      });
      const structuredArtifact = await this.workspace.writeArtifact({
        workspacePath: session.workspacePath,
        relativePath: `context/versions/working-context-v${build.version}.json`,
        content: `${JSON.stringify(context, null, 2)}\n`,
      });
      const committed = await this.repository.commitContextVersion({
        sessionId,
        contextVersionId: build.contextVersionId,
        version: build.version,
        artifactUri: markdownArtifact.artifactUri,
        structuredArtifactUri: structuredArtifact.artifactUri,
        summary: {
          objective: context.objective,
          problemStatement: context.problemStatement,
          solution: context.solution,
          businessRequirements: context.businessRequirements,
          functionalRequirements: context.functionalRequirements,
          challenges: context.challenges,
          stories: context.stories,
          recommendedNextActions: context.recommendedNextActions,
        },
        facts: context.facts,
        implementationFindings: context.implementationFindings,
        requirements: context.requirements,
        constraints: context.constraints,
        openQuestions: context.openQuestions,
        conflicts: context.conflicts,
        decisions: context.decisions,
        risks: context.risks,
        sourceIds: context.sources,
        patchIds: context.patchIds,
        artifactSha256: markdownArtifact.sha256,
        artifactBytes: markdownArtifact.bytes,
      });
      if (!committed) {
        throw new Error(
          `Compose context version ${build.version} was not committed`,
        );
      }
      await publishContextExecutorEvent(this.repository, {
        sessionId,
        eventType: "context.updated",
        payload: {
          contextVersion: build.version,
          patchIds: context.patchIds,
          artifactUri: markdownArtifact.artifactUri,
          structuredArtifactUri: structuredArtifact.artifactUri,
          ...(llmRefinement !== "not_requested" ? { llmRefinement } : {}),
          ...(wasCompacted
            ? {
                droppedItemsBySection: deterministicBuild.droppedItemsBySection,
              }
            : {}),
        },
        actorType: "system",
        actorId: "context_merge",
        agentTaskId: task.id,
        contextVersion: build.version,
      });
      return {
        output: {
          contextVersion: build.version,
          contextVersionId: build.contextVersionId,
          patchIds: context.patchIds,
          artifactUri: markdownArtifact.artifactUri,
          structuredArtifactUri: structuredArtifact.artifactUri,
          ...(llmRefinement !== "not_requested" ? { llmRefinement } : {}),
          ...(wasCompacted
            ? {
                compaction: {
                  droppedItemsBySection:
                    deterministicBuild.droppedItemsBySection,
                },
              }
            : {}),
        },
        contextVersionUsed: build.version,
      };
    } catch (error) {
      if (this.repository.failContextVersionBuild) {
        try {
          await this.repository.failContextVersionBuild({
            sessionId,
            contextVersionId: build.contextVersionId,
            version: build.version,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        } catch (cleanupError) {
          logger.warn(
            {
              err: cleanupError,
              sessionId,
              contextVersionId: build.contextVersionId,
              contextVersion: build.version,
            },
            "Spec Factory failed context build cleanup failed",
          );
        }
      }
      throw error;
    }
  }
}

function contextMergeRefinementErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|aborted/i.test(message)) return "llm_timeout";
  if (/budget/i.test(message)) return "llm_budget_rejected";
  return "llm_refinement_failed";
}

async function publishContextExecutorEvent(
  repository: ContextExecutorRepository,
  input: {
    sessionId: number;
    eventType: string;
    payload: unknown;
    actorType?: string | null;
    actorId?: string | null;
    agentTaskId?: number | null;
    contextVersion?: number | null;
  },
): Promise<void> {
  if (!repository.appendSessionEvent) return;
  try {
    await repository.appendSessionEvent(input);
  } catch (error) {
    logger.warn(
      {
        err: error,
        sessionId: input.sessionId,
        eventType: input.eventType,
        agentTaskId: input.agentTaskId ?? null,
      },
      "Spec Factory context executor event write failed",
    );
  }
}

export function createContextExecutorRegistry(
  repository: ContextExecutorRepository,
  workspace: ContextExecutorWorkspace,
  options: {
    sourceDistillationLlmGateway?: Pick<LlmGateway, "generateObject">;
    sourceDistillationMaxCostUsd?: number;
    sourceDistillationTimeoutMs?: number;
    contextMergeLlmGateway?: Pick<LlmGateway, "generateObject">;
    contextMergeMaxCostUsd?: number;
    contextMergeTimeoutMs?: number;
  } = {},
): AgentTaskExecutorRegistry {
  return new AgentTaskExecutorRegistry([
    new SourceDistillationExecutor(repository, workspace, {
      llmGateway: options.sourceDistillationLlmGateway,
      maxCostUsd: options.sourceDistillationMaxCostUsd,
      timeoutMs: options.sourceDistillationTimeoutMs,
    }),
    new ContextMergeExecutor(repository, workspace, {
      llmGateway: options.contextMergeLlmGateway,
      maxCostUsd: options.contextMergeMaxCostUsd,
      timeoutMs: options.contextMergeTimeoutMs,
    }),
  ]);
}

async function buildLlmSourceDistillationPatch(input: {
  llmGateway: Pick<LlmGateway, "generateObject">;
  task: ClaimedAgentTask;
  source: ComposeSessionSourceSummary;
  baseContextVersion: number | null;
  maxCostUsd?: number;
  timeoutMs?: number;
}): Promise<DistillationPatch> {
  const distilled =
    await input.llmGateway.generateObject<SourceDistillationPatch>({
      sessionId: input.task.sessionId,
      turnJobId: input.task.turnJobId,
      agentTaskId: input.task.id,
      purpose: "source_distillation",
      prompt: buildSourceDistillationPrompt(input.source),
      promptVersion: SOURCE_DISTILLATION_PROMPT_VERSION,
      contextVersionUsed: input.baseContextVersion,
      schema: SourceDistillationPatchSchema,
      jsonSchema: SOURCE_DISTILLATION_JSON_SCHEMA,
      ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
  return {
    ...distilled,
    sourceId: input.source.id,
    sourceKind: input.source.kind,
    sourceFilename: input.source.originalFilename,
    sourceMarkdownUri: input.source.artifactUri ?? input.source.markdownPath,
  };
}

async function buildLlmMergedWorkingContext(input: {
  llmGateway: Pick<LlmGateway, "generateObject">;
  task: ClaimedAgentTask;
  patches: ReadyContextPatch[];
  baseline: WorkingContext;
  maxCostUsd?: number;
  timeoutMs?: number;
}): Promise<WorkingContext> {
  const draft = await input.llmGateway.generateObject<ContextMergeDraft>({
    sessionId: input.task.sessionId,
    turnJobId: input.task.turnJobId,
    agentTaskId: input.task.id,
    purpose: "context_merge",
    prompt: buildContextMergePrompt(input.baseline, input.patches),
    promptVersion: CONTEXT_MERGE_PROMPT_VERSION,
    contextVersionUsed: input.baseline.parentVersion,
    schema: ContextMergeDraftSchema,
    jsonSchema: CONTEXT_MERGE_JSON_SCHEMA,
    directJsonSchema: CONTEXT_MERGE_DIRECT_JSON_SCHEMA,
    ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  const userFacingQuestions = draft.openQuestions.filter(
    isUserFacingClarification,
  );
  const implementationQuestions = draft.openQuestions
    .filter((question) => !isUserFacingClarification(question))
    .map((question) => ({
      text: clarificationText(question) ?? JSON.stringify(question),
      kind: "implementation_question_for_research",
      questionType: "implementation",
    }));
  return {
    ...input.baseline,
    objective: draft.objective || input.baseline.objective,
    problemStatement: draft.problemStatement || input.baseline.problemStatement,
    solution: draft.solution || input.baseline.solution,
    businessRequirements:
      (draft.businessRequirements?.length ?? 0) > 0
        ? draft.businessRequirements
        : input.baseline.businessRequirements,
    functionalRequirements:
      (draft.functionalRequirements?.length ?? 0) > 0
        ? draft.functionalRequirements
        : input.baseline.functionalRequirements,
    challenges:
      (draft.challenges?.length ?? 0) > 0
        ? draft.challenges
        : input.baseline.challenges,
    stories:
      (draft.stories?.length ?? 0) > 0
        ? draft.stories.map((story, index) => {
            const userStory = normalizeUserStory(
              story.userStory,
              story.title,
              story.businessValue,
            );
            return {
              ...story,
              userStory,
              acceptanceCriteria: normalizeGherkinCriteria(
                story.acceptanceCriteria,
                story.title,
                userStory,
              ),
              sequence: story.sequence ?? index,
            };
          })
        : input.baseline.stories,
    openQuestions:
      userFacingQuestions.length > 0
        ? userFacingQuestions
        : input.baseline.openQuestions.filter(isUserFacingClarification),
    implementationFindings: [
      ...input.baseline.implementationFindings,
      ...implementationQuestions,
    ],
    recommendedNextActions: (draft.recommendedNextActions ?? []).filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    ),
  };
}

function buildSourceDistillationPatch(
  source: ComposeSessionSourceSummary,
): DistillationPatch {
  const evidence = [
    {
      sourceId: source.id,
      filename: source.originalFilename,
      uri: source.artifactUri ?? source.markdownPath,
    },
  ];
  const summary =
    source.sourceSummary ??
    firstMeaningfulLine(source.markdownContent) ??
    "Converted source evidence";
  return {
    problemStatementAdditions: [],
    sourceId: source.id,
    sourceKind: source.kind,
    sourceFilename: source.originalFilename,
    sourceMarkdownUri: source.artifactUri ?? source.markdownPath,
    facts: [
      {
        text: summary,
        evidence,
        confidence: source.confidence ?? "medium",
      },
    ],
    implementationFindings:
      source.sourceEntities?.files?.map((file) => ({
        text: `Relevant implementation file: ${file}`,
        file,
        evidence,
        confidence: source.confidence ?? "medium",
      })) ?? [],
    requirements: extractRequirementLines(source.markdownContent).map(
      (text) => ({
        text,
        evidence,
        confidence: source.confidence ?? "medium",
      }),
    ),
    constraints: [],
    decisions: [],
    openQuestions: extractOpenQuestions(source.markdownContent).map(
      (question) => ({
        text: question,
        question,
        questionType: clarificationType(question),
        sourceId: source.id,
      }),
    ),
    risks: [],
    conflicts: [],
  };
}

function mergeDistillationPatches(
  patches: DistillationPatch[],
  source: ComposeSessionSourceSummary,
): DistillationPatch {
  const merged = {
    problemStatementAdditions: [],
    facts: [],
    implementationFindings: [],
    requirements: [],
    constraints: [],
    decisions: [],
    openQuestions: [],
    risks: [],
    conflicts: [],
  } satisfies SourceDistillationPatch;
  for (const patch of patches) {
    for (const key of Object.keys(merged) as Array<keyof typeof merged>) {
      merged[key].push(...arrayField<Record<string, unknown>>(patch[key]));
    }
  }
  const problemStatementCandidates = patches.flatMap((patch) =>
    arrayField<Record<string, unknown>>(patch.problemStatementAdditions),
  );
  merged.facts.unshift(
    ...problemStatementCandidates.map((item) => ({
      ...item,
      kind: "problem_statement_candidate",
    })),
  );
  const implementationQuestions: Array<Record<string, unknown>> = [];
  merged.openQuestions = merged.openQuestions.flatMap((item) => {
    const question = clarificationText(item);
    if (!question) return [];
    const questionType = clarificationType(item);
    if (!isUserFacingClarification(item)) {
      implementationQuestions.push({
        ...item,
        text: question,
        kind: "implementation_question_for_research",
        questionType,
      });
      return [];
    }
    return [{ ...item, text: question, questionType }];
  });
  merged.implementationFindings.push(...implementationQuestions);
  return {
    ...merged,
    sourceId: source.id,
    sourceKind: source.kind,
    sourceFilename: source.originalFilename,
    sourceMarkdownUri: source.artifactUri ?? source.markdownPath,
  };
}

function compactDistillationPatch(
  patch: DistillationPatch,
  sourceId: number,
  limit: number,
): {
  patch: DistillationPatch;
  droppedItemsBySection: Partial<Record<DistillationSection, number>>;
} {
  const total = DISTILLATION_COMPACTION_ORDER.reduce(
    (count, section) => count + patch[section].length,
    0,
  );
  if (total <= limit) return { patch, droppedItemsBySection: {} };

  const candidates = Object.fromEntries(
    DISTILLATION_COMPACTION_ORDER.map((section) => {
      const unique = new Map<
        string,
        { id: string; item: Record<string, unknown> }
      >();
      for (const item of patch[section]) {
        const normalized = normalizeContextItem(
          section as ContextSection,
          item,
          { sourceId },
        );
        unique.set(String(normalized.id), {
          id: String(normalized.id),
          item,
        });
      }
      return [section, [...unique.values()]];
    }),
  ) as Record<
    DistillationSection,
    Array<{ id: string; item: Record<string, unknown> }>
  >;
  const selected = Object.fromEntries(
    DISTILLATION_COMPACTION_ORDER.map((section) => [
      section,
      new Set<string>(),
    ]),
  ) as Record<DistillationSection, Set<string>>;
  let selectedCount = 0;
  let index = 0;
  while (selectedCount < limit) {
    let advanced = false;
    for (const section of DISTILLATION_COMPACTION_ORDER) {
      const candidate = candidates[section][index];
      if (!candidate) continue;
      selected[section].add(candidate.id);
      selectedCount += 1;
      advanced = true;
      if (selectedCount === limit) break;
    }
    if (!advanced) break;
    index += 1;
  }

  const droppedItemsBySection: Partial<Record<DistillationSection, number>> =
    {};
  const compacted = { ...patch };
  for (const section of DISTILLATION_COMPACTION_ORDER) {
    const items = candidates[section]
      .filter((candidate) => selected[section].has(candidate.id))
      .map((candidate) => candidate.item);
    compacted[section] = items;
    const dropped = patch[section].length - items.length;
    if (dropped > 0) droppedItemsBySection[section] = dropped;
  }
  return { patch: compacted, droppedItemsBySection };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function buildSourceDistillationPrompt(
  source: ComposeSessionSourceSummary,
): string {
  return [
    "You are the Spec Factory Distillation Agent.",
    "",
    "Extract structured Working Context patch material from the source.",
    "Every array item must include a non-empty `text` field containing the canonical claim, question, finding, or statement.",
    "Preserve provenance in every useful item with sourceId and, when available, uri/file evidence.",
    "Center the extraction on product requirements: what exists today, the business problem, desired outcomes, user-visible behavior, rules, constraints, and measurable acceptance conditions.",
    "Separate business requirements from functional behavior by setting each requirement item's `requirementType` to `business` or `functional`.",
    "Only put unresolved business-policy or user-visible behavior questions in openQuestions. Every open question must set `questionType` to `business` or `functional`.",
    "Never ask a product user to choose methods, classes, repositories, APIs, schemas, frameworks, infrastructure, or implementation approaches. Put those topics in implementationFindings for later developer research.",
    "Populate problemStatementAdditions with concise evidence-backed descriptions of the user or business problem, not proposed technical solutions.",
    "Separate facts, requirements, constraints, decisions, risks, conflicts, and user-facing open questions.",
    "Return at most 50 high-signal items per section for this chunk; prefer concise canonical claims over exhaustive restatement.",
    "Do not treat generated research as unquestionably true; use confidence fields when certainty is unclear.",
    "Return only JSON matching the schema.",
    "",
    "Source metadata:",
    JSON.stringify(
      {
        sourceId: source.id,
        kind: source.kind,
        filename: source.originalFilename,
        sourceSummary: source.sourceSummary,
        usefulness: source.sourceUsefulness,
        contribution: source.sourceContribution,
        origin: source.sourceOrigin,
        generatedByTaskId: source.generatedByTaskId,
        parentSourceIds: source.parentSourceIds,
        contextVersionUsed: source.contextVersionUsed,
        entities: source.sourceEntities,
        evidence: source.evidence,
        confidence: source.confidence,
        uri: source.artifactUri ?? source.markdownPath,
      },
      null,
      2,
    ),
    "",
    "Source markdown:",
    boundedText(
      source.markdownContent ?? "",
      SOURCE_DISTILLATION_PROMPT_MAX_CHARS,
    ),
  ].join("\n");
}

function buildContextMergePrompt(
  baseline: WorkingContext,
  patches: ReadyContextPatch[],
): string {
  return [
    "You are the Spec Factory Context Merger.",
    "",
    "Merge ready context patches into one coherent Working Context.",
    "Write for product owners and non-technical stakeholders. The authoritative focus is requirements: current behavior, business need, desired user-visible behavior, rules, constraints, and measurable outcomes.",
    "Produce a concise problemStatement and solution intent on every version when evidence supports them.",
    "Populate businessRequirements and functionalRequirements separately. Populate challenges with delivery or product risks that matter to a product owner.",
    "Draft professional product stories as `As a <role>, I want <capability>, so that <outcome>` and give every story acceptanceCriteria in Gherkin with Scenario, Given, When, and Then lines.",
    "Open questions are only for unresolved business policy or functional behavior. Do not ask the user about methods, classes, files, repos, APIs, database schemas, frameworks, architecture, infrastructure, or other implementation choices.",
    "Move implementation unknowns into implementationFindings so a development agent can research them after the user grants consent.",
    "Preserve evidence and confidence. Preserve contradictions as conflicts instead of silently resolving them.",
    "Do not invent source ids, patch ids, versions, or parent versions; backend code owns those fields.",
    "Return only JSON matching the schema.",
    "",
    "Deterministic baseline:",
    boundedText(
      JSON.stringify(baseline, null, 2),
      CONTEXT_MERGE_PROMPT_MAX_CHARS,
    ),
    "",
    "Ready patches:",
    boundedText(
      JSON.stringify(
        patches.map((patch) => ({
          id: patch.id,
          sourceId: patch.sourceId,
          agentTaskId: patch.agentTaskId,
          baseContextVersion: patch.baseContextVersion,
          patch: patch.patch,
        })),
        null,
        2,
      ),
      CONTEXT_MERGE_PROMPT_MAX_CHARS,
    ),
  ].join("\n");
}

function buildWorkingContext(
  patches: ReadyContextPatch[],
  build: ContextVersionBuild,
  parent: ComposeContextProjection | null,
): {
  context: WorkingContext;
  droppedItemsBySection: Partial<Record<ContextSection, number>>;
} {
  const normalizedPatches: ContextPatchV4[] = patches.map((patch) =>
    legacyPatchToV4({
      patch: patch.patch,
      sourceId: patch.sourceId,
      kind: "source_distillation",
    }),
  );
  const droppedItemsBySection: Partial<Record<ContextSection, number>> = {};
  const reduced = applyContextPatches(parent, normalizedPatches, {
    overflow: "compact",
    onCompaction: ({ section, dropped }) => {
      droppedItemsBySection[section] = dropped;
    },
  });
  const implementationQuestions = reduced.openQuestions
    .filter((question) => !isUserFacingClarification(question))
    .map((question) => ({
      text: clarificationText(question) ?? JSON.stringify(question),
      kind: "implementation_question_for_research",
      questionType: "implementation",
    }));
  const openQuestions = reduced.openQuestions.filter(isUserFacingClarification);
  const businessRequirements = requirementTexts(
    reduced.requirements,
    "business",
  );
  const functionalRequirements = requirementTexts(
    reduced.requirements,
    "functional",
  );
  return {
    context: {
      objective: parent?.summary?.objective ?? "",
      problemStatement:
        problemStatementCandidate(reduced.facts) ??
        parent?.summary?.problemStatement ??
        "",
      solution: parent?.summary?.solution ?? "",
      businessRequirements: uniqueStrings([
        ...(parent?.summary?.businessRequirements ?? []),
        ...businessRequirements,
      ]),
      functionalRequirements: uniqueStrings([
        ...(parent?.summary?.functionalRequirements ?? []),
        ...functionalRequirements,
      ]),
      challenges: uniqueStrings([
        ...(parent?.summary?.challenges ?? []),
        ...reduced.risks.map(itemText).filter(Boolean),
      ]),
      stories: (parent?.summary?.stories ?? []).map(
        normalizeWorkingContextStory,
      ),
      ...reduced,
      implementationFindings: [
        ...reduced.implementationFindings,
        ...implementationQuestions,
      ],
      openQuestions,
      sources: uniqueNumbers([
        ...(parent?.sourceIds ?? []),
        ...patches.map((patch) => patch.sourceId ?? null),
      ]),
      generatedResearch: uniqueNumbers(
        patches
          .filter((patch) => patch.agentTaskId !== null)
          .map((patch) => patch.sourceId ?? null),
      ),
      recommendedNextActions: parent?.summary?.recommendedNextActions ?? [],
      patchIds: uniqueNumbers([
        ...(parent?.patchIds ?? []),
        ...patches.map((patch) => patch.id),
      ]),
      parentVersion: build.parentVersion,
      version: build.version,
    },
    droppedItemsBySection,
  };
}

function problemStatementCandidate(items: unknown[]): string | null {
  for (const item of [...items].reverse()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.kind !== "problem_statement_candidate") continue;
    const text = clarificationText(item);
    if (text) return text;
  }
  return null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requirementTexts(
  items: unknown[],
  requirementType: "business" | "functional",
): string[] {
  return items.flatMap((item) => {
    const text = clarificationText(item);
    if (!text) return [];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return requirementType === "functional" ? [text] : [];
    }
    const record = item as Record<string, unknown>;
    const declared =
      typeof record.requirementType === "string"
        ? record.requirementType.trim().toLowerCase()
        : typeof record.requirement_type === "string"
          ? record.requirement_type.trim().toLowerCase()
          : null;
    if (declared === requirementType) return [text];
    if (declared === "business" || declared === "functional") return [];
    return requirementType === "functional" ? [text] : [];
  });
}

function renderWorkingContextMarkdown(context: WorkingContext): string {
  return [
    "# Working Context",
    "",
    "## Objective",
    context.objective || "_not established_",
    "",
    "## Problem Statement",
    context.problemStatement || "_not established_",
    "",
    "## Solution Intent",
    context.solution || "_not established_",
    "",
    "## Business Requirements",
    renderItems(context.businessRequirements),
    "",
    "## Functional Requirements",
    renderItems(context.functionalRequirements),
    "",
    "## Product Challenges",
    renderItems(context.challenges),
    "",
    "## Product Stories",
    renderItems(
      context.stories.map((story) =>
        [
          `${story.sequence + 1}. ${story.title}`,
          story.userStory,
          ...story.acceptanceCriteria,
        ].join("\n  "),
      ),
    ),
    "",
    "## Known Facts",
    renderItems(context.facts),
    "",
    "## Current Implementation Findings",
    renderItems(context.implementationFindings),
    "",
    "## Requirement Evidence",
    renderItems(context.requirements),
    "",
    "## Constraints",
    renderItems(context.constraints),
    "",
    "## Decisions",
    renderItems(context.decisions),
    "",
    "## Open Questions",
    renderItems(context.openQuestions),
    "",
    "## Conflicts",
    renderItems(context.conflicts),
    "",
    "## Risks and Unknowns",
    renderItems(context.risks),
    "",
    "## Source Inventory",
    renderItems(context.sources.map((sourceId) => `source ${sourceId}`)),
    "",
    "## Generated Research Inventory",
    renderItems(
      context.generatedResearch.map(
        (sourceId) => `generated source ${sourceId}`,
      ),
    ),
    "",
    "## Recommended Next Actions",
    renderItems(context.recommendedNextActions),
    "",
  ].join("\n");
}

function renderItems(items: unknown[]): string {
  if (items.length === 0) return "- _none_";
  return items.map((item) => `- ${itemText(item)}`).join("\n");
}

function itemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.question === "string") return record.question;
    if (typeof record.file === "string") return record.file;
  }
  return JSON.stringify(item);
}

function firstMeaningfulLine(markdown: string | null): string | null {
  if (!markdown) return null;
  return (
    markdown
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? null
  );
}

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[source markdown truncated]`;
}

function extractRequirementLines(markdown: string | null): string[] {
  if (!markdown) return [];
  return markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => /^(must|should|requirement:)/i.test(line));
}

function extractOpenQuestions(markdown: string | null): string[] {
  if (!markdown) return [];
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^open question:/i.test(line))
    .map((line) => line.replace(/^open question:\s*/i, "").trim())
    .filter((line) => line.length > 0);
}

function patchObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function arrayField<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function uniqueNumbers(values: Array<number | null | undefined>): number[] {
  return [
    ...new Set(
      values.filter(
        (value): value is number => value !== null && value !== undefined,
      ),
    ),
  ];
}

function positiveNumberField(value: unknown, field: string): number {
  const numeric = numberField(value, field);
  if (numeric === null || numeric <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return numeric;
}

function numberField(value: unknown, field: string): number | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[field];
  const numeric = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}
