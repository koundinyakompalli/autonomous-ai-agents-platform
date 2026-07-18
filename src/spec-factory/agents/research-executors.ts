import { z } from "zod";
import {
  registerRepoFromPath as defaultRegisterRepoFromPath,
  runAgent as defaultRunAgent,
} from "../../claude-sdk/index.js";
import type {
  ClaimedAgentTask,
  CreateAgentTaskInput,
  CreateGeneratedResearchSourceInput,
} from "../compose-database.js";
import type {
  AgentTaskExecutionResult,
  AgentTaskExecutor,
} from "./executor-registry.js";
import { AgentTaskExecutorRegistry } from "./executor-registry.js";
import type {
  ComposeRepoEvidence,
  ComposeSessionSourceSummary,
} from "../compose-types.js";
import {
  redactSensitiveObject,
  redactSensitiveText,
} from "../security/redaction.js";
import { createLogger } from "../../utils/logger.js";
import {
  recordAgentSdkProviderError,
  recordAgentSdkProviderResult,
} from "../telemetry/provider-observation.js";

export type ResearchExecutorMode = "none" | "claude_agent_sdk";

type RunAgent = typeof defaultRunAgent;
type AgentRunResult = Awaited<ReturnType<RunAgent>>;
type RegisterRepo = typeof defaultRegisterRepoFromPath;
type ResearchEvidence = Record<string, unknown>;

interface ComposeSessionForResearch {
  id: number;
  workspacePath: string;
  status?: string | null;
  latestContextVersion?: number | null;
}

interface WorkspaceArtifactRef {
  artifactUri: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}

interface AttachedResearchWorkspace {
  localWorkspacePath: string;
}

interface ResearchWorkspace {
  attach?(input: {
    sessionId: number;
    durableWorkspacePath: string;
    purpose: string;
    taskId?: number | string | null;
    allowMissingDurableWorkspace?: boolean;
  }): Promise<AttachedResearchWorkspace>;
  detach?(input: { localWorkspacePath: string }): Promise<void>;
  attachRepositories?(input: {
    workspacePath: string;
    repositories: Array<{
      repoName: string;
      workspacePath: string;
      headSha?: string | null;
    }>;
  }): Promise<void>;
  writeArtifact(input: {
    workspacePath: string;
    relativePath: string;
    content: string | Buffer;
  }): Promise<WorkspaceArtifactRef>;
}

interface ResearchExecutorRepository {
  getSession(sessionId: number): Promise<ComposeSessionForResearch | null>;
  listSessionSources?(
    sessionId: number,
  ): Promise<ComposeSessionSourceSummary[]>;
  confirmAgentTaskLease(input: {
    agentTaskId: number;
    workerId: string;
    leaseGeneration: number;
  }): Promise<boolean>;
  getGeneratedResearchSourceByTaskId(
    agentTaskId: number,
  ): Promise<ComposeSessionSourceSummary | null>;
  createGeneratedResearchSource(
    input: CreateGeneratedResearchSourceInput,
  ): Promise<number>;
  createAgentTask?(input: CreateAgentTaskInput): Promise<number>;
  appendSessionEvent?(input: {
    sessionId: number;
    eventType: string;
    payload: unknown;
    actorType?: string | null;
    actorId?: string | null;
    turnJobId?: number | null;
    agentTaskId?: number | null;
    contextVersion?: number | null;
  }): Promise<unknown>;
}

interface GroundedResearchRepository {
  repoName: string;
  workspacePath: string;
  headSha: string;
  cleanup?: () => Promise<void>;
}

interface ResearchRepoGrounding {
  groundRepos(input: {
    selectedRepositoryIds: number[];
    sources: Array<{ filename: string; content: string }>;
  }): Promise<{
    repositoriesMarkdown: string;
    manifest: ComposeRepoEvidence[];
    workspaces: GroundedResearchRepository[];
  }>;
}

export interface CodeResearchRunInput {
  sessionId: number;
  taskId: number;
  capability: string;
  question: string;
  workspacePath: string;
  contextVersionUsed: number | null;
  parentSourceIds: number[];
  allowedTools: string[];
  allowedBashCommandPatterns: string[];
  maxTurns: number;
  maxRuntimeSeconds: number;
  maxCostUsd: number;
  toolBudget: number;
}

export interface CodeResearchRunOutput {
  markdown: string;
  evidence: ResearchEvidence[];
  confidence?: string | null;
  runtime?: AgentTaskExecutionResult["runtime"];
}

export interface CodeResearchRunner {
  run(input: CodeResearchRunInput): Promise<CodeResearchRunOutput>;
}

interface CodeResearchExecutorOptions {
  enqueueDistillation?: boolean;
  allowedTools?: string[];
  allowedBashCommandPatterns?: string[];
  maxTurns?: number;
  maxRuntimeSeconds?: number;
  maxCostUsd?: number;
  toolBudget?: number;
  repoGrounding?: ResearchRepoGrounding;
}

interface ResearchExecutorRegistryOptions extends CodeResearchExecutorOptions {
  mode?: ResearchExecutorMode;
}

const DEFAULT_RESEARCH_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];
const DEFAULT_RESEARCH_MAX_TURNS = 12;
export const DEFAULT_RESEARCH_MAX_RUNTIME_SECONDS = 600;
export const DEFAULT_RESEARCH_MAX_COST_USD = 3.0;
const DEFAULT_RESEARCH_TOOL_BUDGET = 80;
const DEFAULT_RESEARCH_TIMEOUT_MS = 600_000;
const LOST_AGENT_TASK_LEASE_MESSAGE = "agent_task_lease_lost";
const logger = createLogger("spec-factory-research-executor");

const CODE_RESEARCH_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    markdown: {
      type: "string",
      description:
        "Evidence-backed markdown research artifact. Include files inspected and findings.",
    },
    evidence: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    confidence: { type: ["string", "null"] },
  },
  required: ["markdown", "evidence", "confidence"],
};

const ResearchOutputSchema = z.object({
  markdown: z.string().min(1),
  evidence: z.array(z.record(z.string(), z.unknown())).default([]),
  confidence: z.string().nullable().optional(),
});

export function resolveResearchExecutorMode(
  raw = process.env.SPEC_FACTORY_RESEARCH_EXECUTOR,
): ResearchExecutorMode {
  const mode = raw?.trim() || "none";
  if (mode === "none" || mode === "claude_agent_sdk") return mode;
  throw new Error(`invalid_research_executor:${mode}`);
}

export function resolveResearchAllowedTools(
  raw = process.env.SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS,
): string[] {
  return normalizeResearchAllowedTools(
    parseCsv(raw, DEFAULT_RESEARCH_ALLOWED_TOOLS),
  );
}

export function resolveResearchAllowedBashCommandPatterns(
  raw = process.env.SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS,
): string[] {
  return parseCsv(raw, []).map(validateResearchBashCommandPattern);
}

export function researchDistillationEnabled(
  raw = process.env.SPEC_FACTORY_RESEARCH_DISTILLATION_ENABLED,
): boolean {
  return ["true", "1", "yes"].includes((raw ?? "").trim().toLowerCase());
}

export function resolveResearchMaxCostUsd(
  raw = process.env.SPEC_FACTORY_RESEARCH_MAX_COST_USD,
): number {
  const value = Number(raw?.trim());
  return positiveNumber(value, DEFAULT_RESEARCH_MAX_COST_USD);
}

export class CodeResearchExecutor implements AgentTaskExecutor {
  readonly executorType = "code_research";
  private readonly enqueueDistillation: boolean;
  private readonly allowedTools: string[];
  private readonly allowedBashCommandPatterns: string[];
  private readonly maxTurns: number;
  private readonly maxRuntimeSeconds: number;
  private readonly maxCostUsd: number;
  private readonly toolBudget: number;
  private readonly repoGrounding?: ResearchRepoGrounding;

  constructor(
    private readonly repository: ResearchExecutorRepository,
    private readonly workspace: ResearchWorkspace,
    private readonly runner: CodeResearchRunner,
    options: CodeResearchExecutorOptions = {},
  ) {
    this.enqueueDistillation = options.enqueueDistillation ?? false;
    this.allowedTools =
      options.allowedTools === undefined
        ? resolveResearchAllowedTools()
        : normalizeResearchAllowedTools(options.allowedTools);
    this.allowedBashCommandPatterns =
      options.allowedBashCommandPatterns?.filter(Boolean) ??
      resolveResearchAllowedBashCommandPatterns();
    if (
      this.allowedTools.some(
        (tool) => tool === "Bash" || tool === "BashOutput",
      ) &&
      this.allowedBashCommandPatterns.length === 0
    ) {
      throw new Error("research_bash_requires_allowlist");
    }
    this.maxTurns = positiveInteger(
      options.maxTurns,
      DEFAULT_RESEARCH_MAX_TURNS,
    );
    this.maxRuntimeSeconds = positiveInteger(
      options.maxRuntimeSeconds,
      DEFAULT_RESEARCH_MAX_RUNTIME_SECONDS,
    );
    this.maxCostUsd = positiveNumber(
      options.maxCostUsd,
      resolveResearchMaxCostUsd(),
    );
    this.toolBudget = positiveInteger(
      options.toolBudget,
      DEFAULT_RESEARCH_TOOL_BUDGET,
    );
    this.repoGrounding = options.repoGrounding;
  }

  async execute(task: ClaimedAgentTask): Promise<AgentTaskExecutionResult> {
    const session = await this.repository.getSession(task.sessionId);
    if (!session || session.status === "archived") {
      throw new Error(`Compose session ${task.sessionId} was not found`);
    }

    const contextVersionUsed =
      positiveIntegerOrNull(numberField(task.input, "contextVersionUsed")) ??
      positiveIntegerOrNull(session.latestContextVersion);
    const parentSourceIds = numberArrayField(task.input, "parentSourceIds");
    const question =
      stringField(task.input, "question") ??
      stringField(task.input, "prompt") ??
      stringField(task.input, "query") ??
      "Research the current implementation and produce evidence-backed findings.";
    const maxCostUsd = Math.min(
      positiveNumber(numberField(task.input, "maxCostUsd"), this.maxCostUsd),
      this.maxCostUsd,
    );
    const maxRuntimeSeconds = Math.min(
      positiveInteger(
        numberField(task.input, "maxRuntimeSeconds"),
        this.maxRuntimeSeconds,
      ),
      this.maxRuntimeSeconds,
    );
    await this.assertTaskLease(task);
    const existingSource =
      await this.repository.getGeneratedResearchSourceByTaskId(task.id);
    if (existingSource) {
      return outputFromGeneratedSource(existingSource, contextVersionUsed);
    }

    const grounding = await this.groundResearchRepositories(task.sessionId);
    let attachedWorkspace: AttachedResearchWorkspace | null = null;
    let research: CodeResearchRunOutput;
    try {
      attachedWorkspace = await this.attachResearchWorkspace({
        task,
        durableWorkspacePath: session.workspacePath,
      });
      const researchWorkspacePath =
        attachedWorkspace?.localWorkspacePath ?? session.workspacePath;
      if (grounding?.workspaces.length && this.workspace.attachRepositories) {
        await this.workspace.attachRepositories({
          workspacePath: researchWorkspacePath,
          repositories: grounding.workspaces.map((repository) => ({
            repoName: repository.repoName,
            workspacePath: repository.workspacePath,
            headSha: repository.headSha,
          })),
        });
      }
      research = await this.runner.run({
        sessionId: task.sessionId,
        taskId: task.id,
        capability: task.capability,
        question,
        workspacePath: researchWorkspacePath,
        contextVersionUsed,
        parentSourceIds,
        allowedTools: this.allowedTools,
        allowedBashCommandPatterns: this.allowedBashCommandPatterns,
        maxTurns: this.maxTurns,
        maxRuntimeSeconds,
        maxCostUsd,
        toolBudget: this.toolBudget,
      });
    } finally {
      await this.detachResearchWorkspace(attachedWorkspace);
      await this.cleanupGroundedRepositories(grounding?.workspaces ?? []);
    }
    const markdown = redactSensitiveText(research.markdown.trim());
    if (!markdown) {
      throw new Error("invalid_code_research_output");
    }
    const evidence = redactedEvidenceArray([
      ...research.evidence,
      ...(grounding?.manifest ?? []).map((repository) => ({
        kind: "repository_grounding",
        ...repository,
      })),
    ]);
    const confidence = redactedOptionalText(research.confidence);
    const originalFilename = `${researchArtifactSlug(task.capability)}-task-${task.id}.md`;
    await this.assertTaskLease(task);
    const existingSourceAfterRun =
      await this.repository.getGeneratedResearchSourceByTaskId(task.id);
    if (existingSourceAfterRun) {
      return outputFromGeneratedSource(
        existingSourceAfterRun,
        contextVersionUsed,
      );
    }
    const artifact = await this.workspace.writeArtifact({
      workspacePath: session.workspacePath,
      relativePath: `generated/research/${originalFilename}`,
      content: markdown,
    });
    await this.assertTaskLease(task);
    let sourceId: number;
    try {
      sourceId = await this.repository.createGeneratedResearchSource({
        sessionId: task.sessionId,
        generatedByTaskId: task.id,
        originalFilename,
        markdownContent: markdown,
        artifactUri: artifact.artifactUri,
        artifactSha256: artifact.sha256,
        artifactBytes: artifact.bytes,
        parentSourceIds,
        contextVersionUsed,
        evidence,
        confidence,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existing =
          await this.repository.getGeneratedResearchSourceByTaskId(task.id);
        if (existing) {
          return outputFromGeneratedSource(existing, contextVersionUsed);
        }
      }
      throw error;
    }
    await this.assertTaskLease(task);
    await this.publishResearchEvent({
      sessionId: task.sessionId,
      eventType: "source.added",
      payload: {
        sourceId,
        kind: "generated_research",
        sourceOrigin: "agent",
        artifactUri: artifact.artifactUri,
      },
      actorType: "system",
      actorId: task.capability,
      turnJobId: task.turnJobId,
      agentTaskId: task.id,
    });

    await this.assertTaskLease(task);
    const distillationTaskId = await this.maybeEnqueueDistillation({
      task,
      sourceId,
      contextVersionUsed,
    });
    return {
      output: {
        sourceId,
        artifactUri: artifact.artifactUri,
        ...(distillationTaskId === null ? {} : { distillationTaskId }),
        confidence,
      },
      contextVersionUsed,
      outputSourceId: sourceId,
      runtime: runtimeWithOutputArtifact(
        research.runtime,
        artifact.artifactUri,
      ),
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

  private async groundResearchRepositories(sessionId: number): Promise<{
    repositoriesMarkdown: string;
    manifest: ComposeRepoEvidence[];
    workspaces: GroundedResearchRepository[];
  } | null> {
    if (!this.repoGrounding || !this.repository.listSessionSources) return null;
    try {
      const sources = (await this.repository.listSessionSources(sessionId))
        .filter(
          (source) =>
            source.kind !== "generated_research" &&
            source.conversionStatus === "converted" &&
            Boolean(source.markdownContent?.trim()),
        )
        .map((source) => ({
          filename: source.originalFilename ?? `source-${source.id}.md`,
          content: source.markdownContent ?? "",
        }));
      return await this.repoGrounding.groundRepos({
        selectedRepositoryIds: [],
        sources,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId,
        },
        "Spec Factory research repository grounding failed",
      );
      return null;
    }
  }

  private async cleanupGroundedRepositories(
    repositories: GroundedResearchRepository[],
  ): Promise<void> {
    const results = await Promise.allSettled(
      repositories.map((repository) => repository.cleanup?.()),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.warn(
          {
            err: result.reason,
            repoName: repositories[index]?.repoName,
          },
          "Spec Factory research repository cleanup failed",
        );
      }
    });
  }

  private async attachResearchWorkspace(input: {
    task: ClaimedAgentTask;
    durableWorkspacePath: string;
  }): Promise<AttachedResearchWorkspace | null> {
    if (!this.workspace.attach) return null;
    return this.workspace.attach({
      sessionId: input.task.sessionId,
      durableWorkspacePath: input.durableWorkspacePath,
      purpose: input.task.capability,
      taskId: input.task.id,
      allowMissingDurableWorkspace: true,
    });
  }

  private async detachResearchWorkspace(
    attachedWorkspace: AttachedResearchWorkspace | null,
  ): Promise<void> {
    if (!attachedWorkspace || !this.workspace.detach) return;
    try {
      await this.workspace.detach({
        localWorkspacePath: attachedWorkspace.localWorkspacePath,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          localWorkspacePath: attachedWorkspace.localWorkspacePath,
        },
        "Spec Factory research local workspace detach failed",
      );
    }
  }

  private async maybeEnqueueDistillation(input: {
    task: ClaimedAgentTask;
    sourceId: number;
    contextVersionUsed: number | null;
  }): Promise<number | null> {
    if (!this.enqueueDistillation) return null;
    if (!this.repository.createAgentTask) {
      throw new Error("research_distillation_queue_unavailable");
    }
    const distillationTaskId = await this.repository.createAgentTask({
      sessionId: input.task.sessionId,
      turnJobId: input.task.turnJobId,
      capability: "source_distillation",
      executorType: "source_distillation",
      input: {
        sourceId: input.sourceId,
        baseContextVersion: input.contextVersionUsed,
      },
      priority: 80,
      outputSourceId: null,
    });
    await this.publishResearchEvent({
      sessionId: input.task.sessionId,
      eventType: "task.queued",
      payload: {
        capability: "source_distillation",
        executorType: "source_distillation",
        sourceId: input.sourceId,
        baseContextVersion: input.contextVersionUsed,
      },
      actorType: "system",
      actorId: input.task.capability,
      turnJobId: input.task.turnJobId,
      agentTaskId: distillationTaskId,
      contextVersion: input.contextVersionUsed,
    });
    return distillationTaskId;
  }

  private async publishResearchEvent(input: {
    sessionId: number;
    eventType: string;
    payload: unknown;
    actorType?: string | null;
    actorId?: string | null;
    turnJobId?: number | null;
    agentTaskId?: number | null;
    contextVersion?: number | null;
  }): Promise<void> {
    try {
      await this.repository.appendSessionEvent?.(input);
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          eventType: input.eventType,
          turnJobId: input.turnJobId ?? null,
          agentTaskId: input.agentTaskId ?? null,
        },
        "Spec Factory research lifecycle event write failed",
      );
    }
  }
}

function redactedEvidenceArray(
  evidence: ResearchEvidence[],
): ResearchEvidence[] {
  const redacted = redactSensitiveObject(evidence);
  return Array.isArray(redacted) ? (redacted as ResearchEvidence[]) : [];
}

function redactedOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return redactSensitiveText(value.trim()) || null;
}

function outputFromGeneratedSource(
  source: ComposeSessionSourceSummary,
  fallbackContextVersion: number | null,
): AgentTaskExecutionResult {
  return {
    output: {
      sourceId: source.id,
      ...(source.artifactUri ? { artifactUri: source.artifactUri } : {}),
      deduplicated: true,
    },
    contextVersionUsed: source.contextVersionUsed ?? fallbackContextVersion,
    outputSourceId: source.id,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062;
}

export class ClaudeAgentSdkResearchRunner implements CodeResearchRunner {
  constructor(
    private readonly runAgent: RunAgent = defaultRunAgent,
    private readonly registerRepo: RegisterRepo = defaultRegisterRepoFromPath,
    private readonly modelId: string | undefined = process.env
      .SPEC_FACTORY_RESEARCH_MODEL_ID ||
      process.env.SPEC_FACTORY_MODEL_ID ||
      process.env.ANTHROPIC_MODEL ||
      "us.anthropic.claude-sonnet-5",
    private readonly timeoutMs: number = positiveInteger(
      Number(process.env.SPEC_FACTORY_RESEARCH_TIMEOUT_MS),
      DEFAULT_RESEARCH_TIMEOUT_MS,
    ),
  ) {}

  async run(input: CodeResearchRunInput): Promise<CodeResearchRunOutput> {
    const profile = researchCapabilityProfile(input.capability);
    const repoId = this.registerRepo(
      input.workspacePath,
      `compose-research-${input.sessionId}-${input.taskId}`,
    );
    const providerStartedAt = Date.now();
    let result: AgentRunResult;
    try {
      result = await this.runAgent({
        taskId: `compose-research-${input.sessionId}-${input.taskId}`,
        taskPrompt: buildResearchPrompt(input),
        repoIds: [repoId],
        agentType: "custom",
        sdkStage: profile.sdkStage,
        permissionLevel: "read_only",
        allowWrite: false,
        timeoutMs: Math.min(this.timeoutMs, input.maxRuntimeSeconds * 1000),
        maxTurns: input.maxTurns,
        maxBudgetUsd: input.maxCostUsd,
        allowedTools: input.allowedTools,
        allowedBashCommandPatterns: input.allowedBashCommandPatterns,
        toolGuard: "enabled",
        toolBudgetGuard: { enabled: true, maxCalls: input.toolBudget },
        sdkTraceMode: "failure",
        outputSchema: CODE_RESEARCH_JSON_SCHEMA,
        settingSources: [],
        bedrockConfig: {
          region: process.env.AWS_REGION || "us-east-2",
          model: this.modelId,
        },
        systemAppend: profile.systemAppend,
      });
    } catch (error) {
      recordAgentSdkProviderError({
        purpose: input.capability,
        configuredModel: this.modelId,
        startedAt: providerStartedAt,
        error,
      });
      throw error;
    }
    recordAgentSdkProviderResult({
      purpose: input.capability,
      configuredModel: this.modelId,
      startedAt: providerStartedAt,
      result,
    });
    const metrics = result.metrics;
    const runtime = {
      provider: "bedrock" as const,
      model: metrics?.modelUsed ?? this.modelId ?? null,
      inputTokens: finiteNumberOrNull(metrics?.tokensUsed?.input),
      outputTokens: finiteNumberOrNull(metrics?.tokensUsed?.output),
      estimatedCostUsd: finiteNumberOrNull(metrics?.costUsd),
    };
    if (!result.success) {
      const partial = partialResearchOutputFromFailedRun(result);
      if (partial) {
        return {
          ...partial,
          runtime,
        };
      }
      throw new Error(result.error || `${input.capability} agent failed`);
    }
    const output = parseResearchOutput(
      result.structuredOutput ?? result.output,
    );
    return {
      ...output,
      runtime,
    };
  }
}

export function createResearchExecutorRegistry(
  repository: ResearchExecutorRepository,
  workspace: ResearchWorkspace,
  runner: CodeResearchRunner = new ClaudeAgentSdkResearchRunner(),
  options: ResearchExecutorRegistryOptions = {},
): AgentTaskExecutorRegistry {
  if ((options.mode ?? resolveResearchExecutorMode()) === "none") {
    return new AgentTaskExecutorRegistry();
  }
  return new AgentTaskExecutorRegistry([
    new CodeResearchExecutor(repository, workspace, runner, {
      enqueueDistillation:
        options.enqueueDistillation ?? researchDistillationEnabled(),
      allowedTools: options.allowedTools,
      allowedBashCommandPatterns: options.allowedBashCommandPatterns,
      maxTurns: options.maxTurns,
      maxRuntimeSeconds: options.maxRuntimeSeconds,
      maxCostUsd: options.maxCostUsd,
      toolBudget: options.toolBudget,
      repoGrounding: options.repoGrounding,
    }),
  ]);
}

function buildResearchPrompt(input: CodeResearchRunInput): string {
  const profile = researchCapabilityProfile(input.capability);
  return [
    "Research question:",
    input.question,
    "",
    `Spec Factory session: ${input.sessionId}`,
    `Agent task: ${input.taskId}`,
    `Context version used: ${input.contextVersionUsed ?? "none"}`,
    `Max runtime seconds: ${input.maxRuntimeSeconds}`,
    input.parentSourceIds.length > 0
      ? `Parent source ids: ${input.parentSourceIds.join(", ")}`
      : "Parent source ids: none",
    "",
    "Instructions:",
    "- Inspect only the workspace/repository files available to this run.",
    "- Prefer Read plus the safe rg search surface (Grep); use Bash only when explicitly allowed by policy.",
    profile.promptInstruction,
    "- Return the structured JSON object requested by the schema.",
  ].join("\n");
}

function researchCapabilityProfile(capability: string): {
  sdkStage: string;
  systemAppend: string;
  promptInstruction: string;
} {
  if (capability === "config_research") {
    return {
      sdkStage: "compose_config_research",
      systemAppend:
        "Spec Factory config research is read-only. Use the Grep tool as the safe rg search surface; it is ripgrep-backed and avoids Bash. Inspect workspace files, deployment manifests, Terraform, environment-variable references, and runtime configuration only. Return a markdown research artifact with concrete configuration and deployment evidence.",
      promptInstruction:
        "- Ground every configuration/deployment claim in file, variable, Terraform, manifest, or runtime-config evidence.",
    };
  }
  if (capability === "devops_research") {
    return {
      sdkStage: "compose_devops_research",
      systemAppend:
        "Spec Factory DevOps research is read-only. Use the Grep tool as the safe rg search surface; it is ripgrep-backed and avoids Bash. Inspect workspace files, deployment manifests, Terraform, CI/CD definitions, logging hooks, and operational runbooks only. Return a markdown research artifact with concrete operational evidence.",
      promptInstruction:
        "- Ground every DevOps or operational claim in file, Terraform, CI/CD, logging, runbook, or deployment evidence.",
    };
  }
  return {
    sdkStage: "compose_code_research",
    systemAppend:
      "Spec Factory code research is read-only. Use the Grep tool as the safe rg search surface; it is ripgrep-backed and avoids Bash. Inspect workspace files and attached repositories only. Return a markdown research artifact with concrete file/function evidence.",
    promptInstruction:
      "- Ground every implementation claim in file/function/module evidence.",
  };
}

function researchArtifactSlug(capability: string): string {
  const slug = capability
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "research";
}

function parseResearchOutput(output: unknown): CodeResearchRunOutput {
  const candidate =
    typeof output === "string" ? (safeJsonParse(output) ?? output) : output;
  const parsed = ResearchOutputSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  if (typeof output === "string" && output.trim()) {
    return {
      markdown: output.trim(),
      evidence: [],
      confidence: null,
    };
  }
  throw new Error("invalid_code_research_output");
}

function partialResearchOutputFromFailedRun(
  result: AgentRunResult,
): CodeResearchRunOutput | null {
  if (result.structuredOutput === undefined) return null;
  let output: CodeResearchRunOutput;
  try {
    output = parseResearchOutput(result.structuredOutput);
  } catch {
    return null;
  }
  const reason = result.error?.trim()
    ? `Research stopped before completion: ${result.error.trim()}.`
    : "Research stopped before completion before all questions could be answered.";
  return {
    ...output,
    markdown: `${output.markdown.trim()}\n\n## Open questions\n\n- ${reason}`,
    confidence: output.confidence ?? "partial",
  };
}

function runtimeWithOutputArtifact(
  runtime: AgentTaskExecutionResult["runtime"] | undefined,
  outputArtifactUri: string,
): NonNullable<AgentTaskExecutionResult["runtime"]> {
  return {
    provider: runtime?.provider ?? null,
    model: runtime?.model ?? null,
    traceUri: runtime?.traceUri ?? null,
    outputArtifactUri,
    inputTokens: finiteNumberOrNull(runtime?.inputTokens),
    outputTokens: finiteNumberOrNull(runtime?.outputTokens),
    estimatedCostUsd: finiteNumberOrNull(runtime?.estimatedCostUsd),
  };
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCsv(raw: string | undefined, fallback: string[]): string[] {
  const values = raw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values : [...fallback];
}

function normalizeResearchAllowedTools(values: string[]): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const tool = canonicalResearchToolName(value);
    if (tool && !normalized.includes(tool)) {
      normalized.push(tool);
    }
  }
  return normalized;
}

function canonicalResearchToolName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const canonicalByLowerCase: Record<string, string> = {
    read: "Read",
    grep: "Grep",
    rg: "Grep",
    ripgrep: "Grep",
    glob: "Glob",
    ls: "LS",
    bash: "Bash",
    bashoutput: "BashOutput",
  };
  return canonicalByLowerCase[trimmed.toLowerCase()] ?? trimmed;
}

function validateResearchBashCommandPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed.startsWith("^") || !trimmed.endsWith("$")) {
    throw new Error(`invalid_research_bash_allowlist_pattern:${trimmed}`);
  }
  const body = trimmed.slice(1, -1);
  if (!body.trim() || body.includes(".*") || /[;&|`$<>]/.test(body)) {
    throw new Error(`invalid_research_bash_allowlist_pattern:${trimmed}`);
  }
  return trimmed;
}

function safeJsonParse(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(input: unknown, key: string): number | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numberArrayField(input: unknown, key: string): number[] {
  if (!input || typeof input !== "object") return [];
  const value = (input as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (typeof item === "string" && item.trim()) {
        const parsed = Number(item);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((item): item is number => item !== null);
}

function positiveInteger(
  value: number | undefined | null,
  fallback: number,
): number {
  if (
    !Number.isFinite(value) ||
    value === undefined ||
    value === null ||
    value <= 0
  ) {
    return fallback;
  }
  return Math.trunc(value);
}

function positiveIntegerOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc(value);
}

function positiveNumber(
  value: number | undefined | null,
  fallback: number,
): number {
  if (
    !Number.isFinite(value) ||
    value === undefined ||
    value === null ||
    value <= 0
  ) {
    return fallback;
  }
  return value;
}
