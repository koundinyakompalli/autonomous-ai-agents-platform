import { randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import {
  registerRepoFromPath as defaultRegisterRepoFromPath,
  runAgent as defaultRunAgent,
} from "../../claude-sdk/index.js";
import { createLogger } from "../../utils/logger.js";
import { redactSensitiveText } from "../security/redaction.js";
import { currentSpecFactoryCorrelation } from "../telemetry/correlation.js";
import {
  specFactoryMetrics,
  type SpecFactoryMetrics,
  type SpecFactoryProviderOutcome,
} from "../telemetry/metrics.js";
import { providerFailureOutcome } from "../telemetry/provider-observation.js";
import type {
  LlmBudgetStore,
  LlmCallAuditRecord,
  LlmCallAuditPool,
  LlmCallAuditSink,
  LlmPromptLoggingMode,
} from "./llm-audit.js";
import {
  resolveLlmPromptLoggingMode,
  SpecFactoryLlmCallAuditRepository,
  truncateLlmAuditErrorCode,
} from "./llm-audit.js";
import {
  SpecFactoryPromptRegistryRepository,
  validatePromptVersionForPurpose,
  type PromptRegistryPool,
  type PromptVersionResolver,
} from "./prompt-registry.js";
import {
  BedrockConverseProvider,
  DIRECT_BEDROCK_PROVIDER_NAME,
} from "./bedrock-converse-provider.js";

type RunAgent = typeof defaultRunAgent;
type RegisterRepoFromPath = typeof defaultRegisterRepoFromPath;

export type LlmPurpose =
  | "chat_coordinator_fast"
  | "chat_coordinator_strong"
  | "source_distillation"
  | "context_merge"
  | "critic_review"
  | "handoff_synthesis"
  | "conversation_summary";

export interface LlmModelRoute {
  provider: "bedrock";
  model: string;
  requireStructuredOutput: boolean;
}

export interface GenerateTextRequest {
  sessionId?: number | null;
  turnJobId?: number | null;
  agentTaskId?: number | null;
  purpose: LlmPurpose;
  prompt: string;
  promptVersion?: string | null;
  contextVersionUsed?: number | null;
  system?: string;
  cacheSystem?: boolean;
  cacheTtl?: "5m" | "1h";
  maxOutputTokens?: number;
  maxCostUsd?: number;
  timeoutMs?: number;
}

export interface GenerateTextResult {
  text: string;
  modelUsed?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

export interface GenerateObjectRequest<T> extends GenerateTextRequest {
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  directJsonSchema?: Record<string, unknown>;
}

export type LlmStreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; usage?: GenerateTextResult["usage"] };

export interface StreamTextRequest extends GenerateTextRequest {}

export interface LlmGateway {
  generateText(req: GenerateTextRequest): Promise<GenerateTextResult>;
  streamText(req: StreamTextRequest): AsyncIterable<LlmStreamEvent>;
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<T>;
}

export interface LlmGatewayEnvironment {
  NODE_ENV?: string;
  SPEC_FACTORY_MODEL_ID?: string;
  ANTHROPIC_MODEL?: string;
  AWS_REGION?: string;
  SPEC_FACTORY_LLM_MAX_ATTEMPTS?: string;
  SPEC_FACTORY_LLM_RETRY_BASE_MS?: string;
  SPEC_FACTORY_LLM_PROMPT_LOGGING?: string;
  SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE?: string;
  SPEC_FACTORY_LLM_SECURE_DEBUG?: string;
  SPEC_FACTORY_LLM_MODEL_ALLOWLIST?: string;
  SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST?: string;
  SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_STRONG?: string;
  SPEC_FACTORY_LLM_MODEL_SOURCE_DISTILLATION?: string;
  SPEC_FACTORY_LLM_MODEL_CONTEXT_MERGE?: string;
  SPEC_FACTORY_LLM_MODEL_CRITIC_REVIEW?: string;
  SPEC_FACTORY_LLM_MODEL_HANDOFF_SYNTHESIS?: string;
  SPEC_FACTORY_LLM_MODEL_CONVERSATION_SUMMARY?: string;
  SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS?: string;
  SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CHAT_COORDINATOR_FAST?: string;
  SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CHAT_COORDINATOR_STRONG?: string;
  SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_SOURCE_DISTILLATION?: string;
  SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CONTEXT_MERGE?: string;
  SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CRITIC_REVIEW?: string;
  SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_HANDOFF_SYNTHESIS?: string;
  SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CONVERSATION_SUMMARY?: string;
  SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD?: string;
  SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD?: string;
  SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES?: string;
  SPEC_FACTORY_PROMPT_REGISTRY_SOURCE?: string;
}

export interface ResolveLlmModelRouteOptions {
  env?: LlmGatewayEnvironment;
}

export interface ClaudeAgentSdkBedrockLlmGatewayOptions extends ResolveLlmModelRouteOptions {
  defaultTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  auditSink?: LlmCallAuditSink;
  budgetStore?: LlmBudgetStore;
  artifactWriter?: LlmAuditArtifactWriter;
  promptRegistry?: PromptVersionResolver;
  llmScratchRepoPath?: string;
  llmScratchRepoId?: string;
  registerRepoFromPath?: RegisterRepoFromPath;
  metrics?: Pick<SpecFactoryMetrics, "recordProviderCall">;
  directBedrockProvider?: Pick<BedrockConverseProvider, "invoke">;
}

export interface CreateSpecFactoryLlmGatewayOptions extends Omit<
  ClaudeAgentSdkBedrockLlmGatewayOptions,
  "auditSink"
> {
  runAgent?: RunAgent;
  auditSink?: LlmCallAuditSink;
  auditPool?: LlmCallAuditPool;
  promptRegistryPool?: PromptRegistryPool;
}

export interface LlmAuditArtifactWriter {
  writeArtifact(input: {
    relativePath: string;
    content: string;
  }): Promise<{ artifactUri: string }>;
}

const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-sonnet-5";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 25;
const DEFAULT_LLM_SCRATCH_REPO_PATH = "/tmp";
const DEFAULT_LLM_SCRATCH_REPO_ID = "spec-factory-llm-scratch";
const logger = createLogger("spec-factory-llm-gateway");
const STRUCTURED_PURPOSES = new Set<LlmPurpose>([
  "chat_coordinator_fast",
  "chat_coordinator_strong",
  "source_distillation",
  "context_merge",
  "critic_review",
  "handoff_synthesis",
]);
const LLM_PURPOSES: readonly LlmPurpose[] = [
  "chat_coordinator_fast",
  "chat_coordinator_strong",
  "source_distillation",
  "context_merge",
  "critic_review",
  "handoff_synthesis",
  "conversation_summary",
];

interface GatewayProviderResult {
  success: boolean;
  output: string;
  structuredOutput?: unknown;
  error?: string;
  metrics: {
    modelUsed?: string;
    tokensUsed?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    costUsd?: number;
  };
}

class FileSystemLlmAuditArtifactWriter implements LlmAuditArtifactWriter {
  private readonly root: string;

  constructor(root: string) {
    const trimmed = root.trim();
    if (!trimmed) {
      throw new Error("llm_audit_artifact_base_required");
    }
    this.root = path.resolve(trimmed);
  }

  async writeArtifact(input: {
    relativePath: string;
    content: string;
  }): Promise<{ artifactUri: string }> {
    const absolutePath = this.resolveRelativePath(input.relativePath);
    const body = Buffer.from(input.content, "utf8");
    const tmpDir = path.join(this.root, ".tmp");
    const tmpPath = path.join(tmpDir, `${randomUUID()}.tmp`);
    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(tmpPath, body);
      const written = await readFile(tmpPath);
      if (written.length !== body.length || !written.equals(body)) {
        throw new Error("llm_audit_artifact_verification_failed");
      }
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await rename(tmpPath, absolutePath);
      return { artifactUri: pathToFileURL(absolutePath).href };
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  private resolveRelativePath(relativePath: string): string {
    const trimmed = relativePath.trim();
    if (!trimmed || path.isAbsolute(trimmed)) {
      throw new Error("llm_audit_artifact_relative_path_required");
    }
    const absolutePath = path.resolve(this.root, trimmed);
    const relativeToRoot = path.relative(this.root, absolutePath);
    if (
      relativeToRoot === "" ||
      relativeToRoot.startsWith("..") ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new Error("llm_audit_artifact_path_outside_root");
    }
    return absolutePath;
  }
}

export function resolveLlmModelRoute(
  purpose: LlmPurpose,
  options: ResolveLlmModelRouteOptions = {},
): LlmModelRoute {
  const env = options.env ?? process.env;
  const model =
    env[purposeModelEnvKey(purpose)]?.trim() ||
    env.SPEC_FACTORY_MODEL_ID?.trim() ||
    env.ANTHROPIC_MODEL?.trim() ||
    DEFAULT_BEDROCK_MODEL;
  const allowlist = csv(env.SPEC_FACTORY_LLM_MODEL_ALLOWLIST);
  if (allowlist.length > 0 && !allowlist.includes(model)) {
    throw new Error(`llm_model_not_allowed:${model}`);
  }
  return {
    provider: "bedrock",
    model,
    requireStructuredOutput: STRUCTURED_PURPOSES.has(purpose),
  };
}

export function resolveDirectBedrockPurposes(
  env: LlmGatewayEnvironment = process.env,
): ReadonlySet<LlmPurpose> {
  const configured = csv(env.SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES);
  const purposes = new Set<LlmPurpose>();
  for (const value of configured) {
    if (!isLlmPurpose(value)) {
      throw new Error(`invalid_llm_direct_bedrock_purpose:${value}`);
    }
    purposes.add(value);
  }
  return purposes;
}

export function resolveLlmMaxOutputTokens(
  purpose: LlmPurpose,
  options: ResolveLlmModelRouteOptions & {
    requestedMaxOutputTokens?: number;
  } = {},
): number | undefined {
  const env = options.env ?? process.env;
  const configuredMaxOutputTokens = configuredMaxOutputTokensForPurpose(
    purpose,
    env,
  );
  const requestedMaxOutputTokens =
    options.requestedMaxOutputTokens === undefined
      ? null
      : requiredPositiveInteger(
          options.requestedMaxOutputTokens,
          "invalid_llm_max_output_tokens",
        );

  if (
    configuredMaxOutputTokens !== null &&
    requestedMaxOutputTokens !== null &&
    requestedMaxOutputTokens > configuredMaxOutputTokens
  ) {
    throw new Error(
      `llm_max_output_tokens_exceeded:${requestedMaxOutputTokens}:${configuredMaxOutputTokens}`,
    );
  }

  return requestedMaxOutputTokens ?? configuredMaxOutputTokens ?? undefined;
}

export class ClaudeAgentSdkBedrockLlmGateway implements LlmGateway {
  private readonly env?: LlmGatewayEnvironment;
  private readonly defaultTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly auditSink?: LlmCallAuditSink;
  private readonly budgetStore?: LlmBudgetStore;
  private readonly artifactWriter?: LlmAuditArtifactWriter;
  private readonly promptRegistry?: PromptVersionResolver;
  private readonly llmScratchRepoPath: string;
  private readonly llmScratchRepoId: string;
  private readonly registerRepoFromPath: RegisterRepoFromPath;
  private readonly metrics: Pick<SpecFactoryMetrics, "recordProviderCall">;
  private readonly directBedrockPurposes: ReadonlySet<LlmPurpose>;
  private readonly directBedrockProvider?: Pick<
    BedrockConverseProvider,
    "invoke"
  >;

  constructor(
    private readonly runAgent: RunAgent = defaultRunAgent,
    options: ClaudeAgentSdkBedrockLlmGatewayOptions = {},
  ) {
    this.env = options.env;
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs,
      DEFAULT_TIMEOUT_MS,
    );
    this.maxAttempts = positiveInteger(
      options.maxAttempts ??
        optionalPositiveIntegerEnv(options.env?.SPEC_FACTORY_LLM_MAX_ATTEMPTS),
      DEFAULT_MAX_ATTEMPTS,
    );
    this.retryBaseMs = nonNegativeInteger(
      options.retryBaseMs ??
        optionalNonNegativeIntegerEnv(
          options.env?.SPEC_FACTORY_LLM_RETRY_BASE_MS,
        ),
      DEFAULT_RETRY_BASE_MS,
    );
    this.auditSink = options.auditSink;
    this.budgetStore =
      options.budgetStore ??
      (isLlmBudgetStore(options.auditSink) ? options.auditSink : undefined);
    this.artifactWriter = options.artifactWriter;
    this.promptRegistry = options.promptRegistry;
    this.llmScratchRepoPath =
      options.llmScratchRepoPath?.trim() || DEFAULT_LLM_SCRATCH_REPO_PATH;
    this.llmScratchRepoId =
      options.llmScratchRepoId?.trim() || DEFAULT_LLM_SCRATCH_REPO_ID;
    this.registerRepoFromPath =
      options.registerRepoFromPath ?? defaultRegisterRepoFromPath;
    this.metrics = options.metrics ?? specFactoryMetrics;
    this.directBedrockPurposes = resolveDirectBedrockPurposes(
      options.env ?? process.env,
    );
    this.directBedrockProvider =
      options.directBedrockProvider ??
      (this.directBedrockPurposes.size > 0
        ? new BedrockConverseProvider({
            region:
              options.env?.AWS_REGION?.trim() ||
              process.env.AWS_REGION ||
              "us-east-2",
          })
        : undefined);
  }

  async generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
    const result = await this.run(req);
    return {
      text: result.output,
      modelUsed: result.metrics.modelUsed,
      usage: usageFromMetrics(result.metrics),
    };
  }

  async *streamText(req: StreamTextRequest): AsyncIterable<LlmStreamEvent> {
    const result = await this.generateText(req);
    if (result.text.length > 0) {
      yield { type: "text", text: result.text };
    }
    yield { type: "done", usage: result.usage };
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
    const result = await this.run(req);
    if (result.structuredOutput === undefined) {
      throw new Error("llm_gateway_missing_structured_output");
    }
    return req.schema.parse(result.structuredOutput);
  }

  private async run(req: GenerateTextRequest | GenerateObjectRequest<unknown>) {
    const route = resolveLlmModelRoute(req.purpose, { env: this.env });
    const useDirectBedrock = this.directBedrockPurposes.has(req.purpose);
    const providerName = useDirectBedrock
      ? DIRECT_BEDROCK_PROVIDER_NAME
      : route.provider;
    const maxOutputTokens = resolveLlmMaxOutputTokens(req.purpose, {
      env: this.env,
      requestedMaxOutputTokens: req.maxOutputTokens,
    });
    const timeoutMs = positiveInteger(req.timeoutMs, this.defaultTimeoutMs);
    const providerRequestId = randomUUID();
    const prompt = cleanPrompt(req.prompt);
    const promptVersion = await this.resolvePromptVersion({
      purpose: req.purpose,
      promptVersion: req.promptVersion,
    });
    const promptLoggingMode = this.resolvePromptLoggingMode();
    await this.assertBudgetAllowed(req);
    const startedAt = Date.now();
    const baseAudit = {
      sessionId: req.sessionId ?? null,
      turnJobId: req.turnJobId ?? null,
      agentTaskId: req.agentTaskId ?? null,
      requestId: currentSpecFactoryCorrelation().requestId ?? null,
      purpose: req.purpose,
      provider: route.provider,
      model: route.model,
      promptVersion,
      contextVersionUsed: req.contextVersionUsed ?? null,
    } satisfies Omit<
      LlmCallAuditRecord,
      | "status"
      | "inputTokens"
      | "outputTokens"
      | "latencyMs"
      | "estimatedCostUsd"
      | "errorCode"
      | "redactedPromptUri"
      | "redactedResponseUri"
    >;
    let result: GatewayProviderResult | null = null;
    let thrownError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const candidate = await this.invokeProvider({
          req,
          route,
          prompt,
          providerRequestId,
          maxOutputTokens,
          timeoutMs,
          useDirectBedrock,
        });
        result = candidate;
        if (
          candidate.success ||
          !isTransientLlmError(candidate.error || "unknown_error") ||
          attempt >= this.maxAttempts
        ) {
          break;
        }
        result = null;
      } catch (error) {
        thrownError = error;
        if (!isTransientLlmError(error) || attempt >= this.maxAttempts) {
          break;
        }
        thrownError = null;
      }
      await this.retryDelay(attempt);
    }
    if (thrownError && !result) {
      const latencyMs = Date.now() - startedAt;
      const errorCode = errorMessage(thrownError);
      await this.recordAudit({
        ...baseAudit,
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        estimatedCostUsd: null,
        status: "failed",
        errorCode,
        redactedPromptUri: null,
        redactedResponseUri: null,
      });
      this.recordProviderMetric({
        purpose: req.purpose,
        provider: providerName,
        model: route.model,
        outcome: providerFailureOutcome(errorCode),
        latencyMs,
      });
      throw thrownError;
    }
    if (!result) {
      this.recordProviderMetric({
        purpose: req.purpose,
        provider: providerName,
        model: route.model,
        outcome: "failed",
        latencyMs: Date.now() - startedAt,
      });
      throw new Error("llm_gateway_no_provider_result");
    }
    if (!result.success) {
      const errorCode = result.error || "unknown_error";
      const latencyMs = Date.now() - startedAt;
      await this.recordAudit({
        ...baseAudit,
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        estimatedCostUsd: null,
        status: "failed",
        errorCode,
        redactedPromptUri: null,
        redactedResponseUri: null,
      });
      this.recordProviderMetric({
        purpose: req.purpose,
        provider: providerName,
        model: result.metrics.modelUsed || route.model,
        outcome: providerFailureOutcome(errorCode),
        latencyMs,
      });
      throw new Error(`llm_gateway_failed:${errorCode}`);
    }
    const artifacts = await this.writeAuditArtifacts({
      purpose: req.purpose,
      requestId: providerRequestId,
      prompt,
      response: result.output,
      mode: promptLoggingMode,
    });
    const latencyMs = Date.now() - startedAt;
    await this.recordAudit({
      ...baseAudit,
      inputTokens: result.metrics.tokensUsed?.input ?? null,
      outputTokens: result.metrics.tokensUsed?.output ?? null,
      latencyMs,
      estimatedCostUsd: result.metrics.costUsd ?? null,
      status: "succeeded",
      errorCode: null,
      redactedPromptUri: artifacts.redactedPromptUri,
      redactedResponseUri: artifacts.redactedResponseUri,
    });
    this.recordProviderMetric({
      purpose: req.purpose,
      provider: providerName,
      model: result.metrics.modelUsed || route.model,
      outcome: "succeeded",
      latencyMs,
      inputTokens: result.metrics.tokensUsed?.input,
      outputTokens: result.metrics.tokensUsed?.output,
      costUsd: result.metrics.costUsd,
    });
    return result;
  }

  private async invokeProvider(input: {
    req: GenerateTextRequest | GenerateObjectRequest<unknown>;
    route: LlmModelRoute;
    prompt: string;
    providerRequestId: string;
    maxOutputTokens?: number;
    timeoutMs: number;
    useDirectBedrock: boolean;
  }): Promise<GatewayProviderResult> {
    if (input.useDirectBedrock) {
      if (!this.directBedrockProvider) {
        throw new Error("llm_direct_bedrock_provider_required");
      }
      return this.directBedrockProvider.invoke({
        purpose: input.req.purpose,
        requestId: input.providerRequestId,
        model: input.route.model,
        prompt: input.prompt,
        ...(input.req.system ? { system: input.req.system } : {}),
        ...(input.req.cacheSystem
          ? {
              cacheSystem: true,
              cacheTtl: input.req.cacheTtl ?? "1h",
            }
          : {}),
        ...("jsonSchema" in input.req
          ? {
              jsonSchema: input.req.directJsonSchema ?? input.req.jsonSchema,
            }
          : {}),
        ...(input.maxOutputTokens !== undefined
          ? { maxOutputTokens: input.maxOutputTokens }
          : {}),
        timeoutMs: input.timeoutMs,
      });
    }

    const scratchRepoId = this.resolveScratchRepoId();
    return this.runAgent({
      taskId: `spec-factory-llm-${input.req.purpose}-${input.providerRequestId}`,
      taskPrompt: input.prompt,
      repoIds: [scratchRepoId],
      agentType: "custom",
      sdkStage: `spec_factory_llm_${input.req.purpose}`,
      permissionLevel: "read_only",
      allowWrite: false,
      disableTools: true,
      allowedTools: [],
      settingSources: [],
      ...(input.req.purpose === "chat_coordinator_fast"
        ? { thinking: { type: "disabled" as const } }
        : {}),
      ...(input.req.system ? { systemAppend: input.req.system } : {}),
      ...("jsonSchema" in input.req
        ? { outputSchema: input.req.jsonSchema }
        : {}),
      ...(input.req.maxCostUsd ? { maxBudgetUsd: input.req.maxCostUsd } : {}),
      timeoutMs: input.timeoutMs,
      bedrockConfig: {
        region:
          this.env?.AWS_REGION?.trim() || process.env.AWS_REGION || "us-east-2",
        model: input.route.model,
        ...(input.maxOutputTokens !== undefined
          ? { maxOutputTokens: input.maxOutputTokens }
          : {}),
      },
    });
  }

  private recordProviderMetric(input: {
    purpose: LlmPurpose;
    provider: string;
    model: string;
    outcome: SpecFactoryProviderOutcome;
    latencyMs: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
  }): void {
    try {
      this.metrics.recordProviderCall(input);
    } catch (error) {
      logger.warn(
        { err: error, purpose: input.purpose, provider: input.provider },
        "Spec Factory provider metric write failed",
      );
    }
  }

  private async retryDelay(attempt: number): Promise<void> {
    if (this.retryBaseMs <= 0) return;
    await new Promise((resolve) =>
      setTimeout(resolve, this.retryBaseMs * Math.max(1, attempt)),
    );
  }

  private async assertBudgetAllowed(input: {
    sessionId?: number | null;
    purpose: LlmPurpose;
    maxCostUsd?: number;
  }): Promise<void> {
    const env = this.env ?? process.env;
    const sessionCeiling = optionalPositiveNumberEnv(
      env.SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD,
    );
    const globalDailyCeiling = optionalPositiveNumberEnv(
      env.SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD,
    );
    if (sessionCeiling === null && globalDailyCeiling === null) return;
    if (!this.budgetStore) {
      throw new Error("llm_budget_store_required");
    }
    const reservation = optionalPositiveNumber(input.maxCostUsd);
    if (reservation === null) {
      throw new Error("llm_budget_requires_max_cost");
    }
    const usage = await this.budgetStore.getBudgetUsage({
      sessionId: input.sessionId ?? null,
      since: startOfUtcDay(),
    });
    if (
      sessionCeiling !== null &&
      input.sessionId != null &&
      usage.sessionCostUsd + reservation > sessionCeiling
    ) {
      logger.warn(
        {
          purpose: input.purpose,
          sessionId: input.sessionId,
          currentCostUsd: usage.sessionCostUsd,
          reservationCostUsd: reservation,
          ceilingUsd: sessionCeiling,
        },
        "Spec Factory LLM session budget denied",
      );
      throw new Error("llm_budget_exceeded:session");
    }
    if (
      globalDailyCeiling !== null &&
      usage.globalDayCostUsd + reservation > globalDailyCeiling
    ) {
      logger.warn(
        {
          purpose: input.purpose,
          currentCostUsd: usage.globalDayCostUsd,
          reservationCostUsd: reservation,
          ceilingUsd: globalDailyCeiling,
        },
        "Spec Factory LLM global daily budget denied",
      );
      throw new Error("llm_budget_exceeded:global_daily");
    }
  }

  private async recordAudit(input: LlmCallAuditRecord): Promise<void> {
    if (!this.auditSink) return;
    try {
      await this.auditSink.recordCall({
        ...input,
        errorCode: truncateLlmAuditErrorCode(input.errorCode),
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          purpose: input.purpose,
          sessionId: input.sessionId ?? null,
          turnJobId: input.turnJobId ?? null,
          agentTaskId: input.agentTaskId ?? null,
          status: input.status,
        },
        "Spec Factory LLM audit write failed",
      );
    }
  }

  private resolveScratchRepoId(): string {
    return this.registerRepoFromPath(
      this.llmScratchRepoPath,
      this.llmScratchRepoId,
    );
  }

  private async writeAuditArtifacts(input: {
    purpose: LlmPurpose;
    requestId: string;
    prompt: string;
    response: string;
    mode: LlmPromptLoggingMode;
  }): Promise<{
    redactedPromptUri: string | null;
    redactedResponseUri: string | null;
  }> {
    if (input.mode === "none" || !this.artifactWriter) {
      return { redactedPromptUri: null, redactedResponseUri: null };
    }
    const prompt = artifactContent(input.prompt, input.mode);
    const response = artifactContent(input.response, input.mode);
    try {
      const [promptArtifact, responseArtifact] = await Promise.all([
        this.artifactWriter.writeArtifact({
          relativePath: `llm-audit/${input.purpose}/${input.requestId}/prompt.txt`,
          content: prompt,
        }),
        this.artifactWriter.writeArtifact({
          relativePath: `llm-audit/${input.purpose}/${input.requestId}/response.txt`,
          content: response,
        }),
      ]);
      return {
        redactedPromptUri: promptArtifact.artifactUri,
        redactedResponseUri: responseArtifact.artifactUri,
      };
    } catch (error) {
      logger.warn(
        { err: error, purpose: input.purpose },
        "Spec Factory LLM audit artifact write failed",
      );
      return { redactedPromptUri: null, redactedResponseUri: null };
    }
  }

  private resolvePromptLoggingMode(): LlmPromptLoggingMode {
    const mode = this.env
      ? resolveLlmPromptLoggingMode(
          this.env.SPEC_FACTORY_LLM_PROMPT_LOGGING ?? "",
        )
      : resolveLlmPromptLoggingMode();
    if (mode !== "full") return mode;

    const secureDebug = booleanEnvValue(
      this.env?.SPEC_FACTORY_LLM_SECURE_DEBUG ??
        process.env.SPEC_FACTORY_LLM_SECURE_DEBUG,
    );
    if (!secureDebug) {
      throw new Error("llm_full_prompt_logging_requires_secure_debug");
    }

    const nodeEnv = (this.env?.NODE_ENV ?? process.env.NODE_ENV ?? "")
      .trim()
      .toLowerCase();
    if (nodeEnv === "production") {
      throw new Error("llm_full_prompt_logging_forbidden_in_production");
    }
    return mode;
  }

  private async resolvePromptVersion(input: {
    purpose: LlmPurpose;
    promptVersion?: string | null;
  }): Promise<string | null> {
    const source = resolvePromptRegistrySource(this.env);
    if (this.promptRegistry) {
      return this.promptRegistry.resolvePromptVersion({
        purpose: input.purpose,
        requestedVersion: input.promptVersion,
        allowDefault: source === "db",
      });
    }
    if (source === "db") {
      throw new Error("prompt_registry_store_required");
    }
    return validatePromptVersionForPurpose(input);
  }
}

export function createSpecFactoryLlmGateway(
  options: CreateSpecFactoryLlmGatewayOptions = {},
): LlmGateway {
  const auditSink =
    options.auditSink ??
    new SpecFactoryLlmCallAuditRepository(options.auditPool);
  const promptRegistry =
    options.promptRegistry ??
    (resolvePromptRegistrySource(options.env) === "db"
      ? new SpecFactoryPromptRegistryRepository(
          options.promptRegistryPool ?? options.auditPool,
        )
      : undefined);
  return new ClaudeAgentSdkBedrockLlmGateway(
    options.runAgent ?? defaultRunAgent,
    {
      env: options.env,
      defaultTimeoutMs: options.defaultTimeoutMs,
      maxAttempts: options.maxAttempts,
      retryBaseMs: options.retryBaseMs,
      auditSink,
      budgetStore:
        options.budgetStore ??
        (isLlmBudgetStore(auditSink) ? auditSink : undefined),
      artifactWriter:
        options.artifactWriter ??
        createDefaultLlmAuditArtifactWriter(options.env),
      promptRegistry,
      llmScratchRepoPath: options.llmScratchRepoPath,
      llmScratchRepoId: options.llmScratchRepoId,
      registerRepoFromPath: options.registerRepoFromPath,
      metrics: options.metrics,
      directBedrockProvider: options.directBedrockProvider,
    },
  );
}

function createDefaultLlmAuditArtifactWriter(
  env: LlmGatewayEnvironment | undefined,
): LlmAuditArtifactWriter | undefined {
  const root =
    env?.SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE ??
    process.env.SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE;
  const trimmed = root?.trim();
  return trimmed ? new FileSystemLlmAuditArtifactWriter(trimmed) : undefined;
}

function resolvePromptRegistrySource(
  env: LlmGatewayEnvironment | undefined,
): "static" | "db" {
  const raw =
    env?.SPEC_FACTORY_PROMPT_REGISTRY_SOURCE ??
    process.env.SPEC_FACTORY_PROMPT_REGISTRY_SOURCE ??
    "static";
  const value = raw.trim().toLowerCase() || "static";
  if (value === "static" || value === "db") return value;
  throw new Error(`invalid_prompt_registry_source:${raw}`);
}

function purposeModelEnvKey(purpose: LlmPurpose): keyof LlmGatewayEnvironment {
  return `SPEC_FACTORY_LLM_MODEL_${purpose.toUpperCase()}` as keyof LlmGatewayEnvironment;
}

function purposeMaxOutputTokensEnvKey(
  purpose: LlmPurpose,
): keyof LlmGatewayEnvironment {
  return `SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_${purpose.toUpperCase()}` as keyof LlmGatewayEnvironment;
}

function configuredMaxOutputTokensForPurpose(
  purpose: LlmPurpose,
  env: LlmGatewayEnvironment,
): number | null {
  const purposeKey = purposeMaxOutputTokensEnvKey(purpose);
  const purposeValue = optionalConfiguredPositiveIntegerEnv(
    env[purposeKey],
    purposeKey,
  );
  if (purposeValue !== null) return purposeValue;
  return optionalConfiguredPositiveIntegerEnv(
    env.SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS,
    "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS",
  );
}

function usageFromMetrics(
  metrics: GatewayProviderResult["metrics"],
): GenerateTextResult["usage"] | undefined {
  if (!metrics.tokensUsed && metrics.costUsd === undefined) return undefined;
  return {
    inputTokens: metrics.tokensUsed?.input,
    outputTokens: metrics.tokensUsed?.output,
    costUsd: metrics.costUsd,
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function optionalPositiveNumberEnv(raw: string | undefined): number | null {
  const value = Number(raw?.trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function optionalPositiveIntegerEnv(raw: string | undefined): number | null {
  const value = optionalPositiveNumberEnv(raw);
  if (value === null || !Number.isInteger(value)) return null;
  return value;
}

function optionalNonNegativeIntegerEnv(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function optionalConfiguredPositiveIntegerEnv(
  raw: string | undefined,
  key: keyof LlmGatewayEnvironment | string,
): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(`invalid_llm_max_output_tokens_config:${key}`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function requiredPositiveInteger(value: unknown, code: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    !Number.isInteger(value)
  ) {
    throw new Error(`${code}:${String(value)}`);
  }
  return value;
}

function booleanEnvValue(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isLlmBudgetStore(value: unknown): value is LlmBudgetStore {
  return (
    Boolean(value) &&
    typeof (value as { getBudgetUsage?: unknown }).getBudgetUsage === "function"
  );
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function cleanPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("llm_gateway_empty_prompt");
  return trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientLlmError(error: unknown): boolean {
  const message = errorMessage(error);
  if (!message) return false;
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof (error as { $metadata?: unknown }).$metadata === "object"
      ? Number(
          (
            error as {
              $metadata?: { httpStatusCode?: unknown };
            }
          ).$metadata?.httpStatusCode,
        )
      : NaN;
  if (statusCode === 429 || statusCode >= 500) return true;
  if (
    /ThrottlingException|ServiceUnavailableException|InternalServerException|ModelTimeoutException|ModelNotReadyException|AbortError/i.test(
      name,
    )
  ) {
    return true;
  }
  if (/throttl|rate.?limit/i.test(message)) return true;
  if (/\b429\b/.test(message)) return true;
  if (/\b5\d\d\b/.test(message)) return true;
  if (/timeout|timed out/i.test(message)) return true;
  if (/temporarily unavailable|service unavailable/i.test(message)) {
    return true;
  }
  return false;
}

function isLlmPurpose(value: string): value is LlmPurpose {
  return (LLM_PURPOSES as readonly string[]).includes(value);
}

function artifactContent(
  content: string,
  mode: Exclude<LlmPromptLoggingMode, "none">,
): string {
  const value = mode === "redacted" ? redactSensitiveText(content) : content;
  return `${value.trimEnd()}\n`;
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
