import { z } from "zod";
import type { ClaimedAgentTask } from "../compose-database.js";
import type { LlmGateway } from "../llm/llm-gateway.js";
import type {
  AgentTaskExecutionResult,
  AgentTaskExecutor,
} from "./executor-registry.js";
import { AgentTaskExecutorRegistry } from "./executor-registry.js";
import { resolvePromptVersion } from "../llm/prompt-registry.js";

const CRITIC_PROMPT_VERSION = resolvePromptVersion({
  purpose: "critic_review",
});

const OptionalCriticTextSchema = z
  .string()
  .trim()
  .nullable()
  .optional();

const CriticInputSchema = z
  .object({
    userMessage: OptionalCriticTextSchema,
    answer: OptionalCriticTextSchema,
    workingContextMarkdown: OptionalCriticTextSchema,
    generatedResearch: z.array(z.unknown()).optional(),
    evidence: z.array(z.unknown()).optional(),
    contextVersionUsed: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (
      !value.answer &&
      !value.workingContextMarkdown &&
      (!value.generatedResearch || value.generatedResearch.length === 0) &&
      (!value.evidence || value.evidence.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "critic_input_missing_review_material",
      });
    }
  });

const CriticFindingSchema = z.object({
  severity: z.enum(["low", "medium", "high"]),
  claim: z.string().trim().min(1),
  issue: z.string().trim().min(1),
  evidence: z.string().trim().optional(),
  recommendation: z.string().trim().optional(),
});

export const CriticReviewSchema = z.object({
  verdict: z.enum(["supported", "needs_revision", "unsupported"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().trim().min(1),
  findings: z.array(CriticFindingSchema),
});

export type CriticReview = z.infer<typeof CriticReviewSchema>;

export const CRITIC_REVIEW_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { enum: ["supported", "needs_revision", "unsupported"] },
    confidence: { enum: ["low", "medium", "high"] },
    summary: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { enum: ["low", "medium", "high"] },
          claim: { type: "string", minLength: 1 },
          issue: { type: "string", minLength: 1 },
          evidence: { type: "string" },
          recommendation: { type: "string" },
        },
        required: ["severity", "claim", "issue"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "confidence", "summary", "findings"],
  additionalProperties: false,
};

export class CriticExecutor implements AgentTaskExecutor {
  readonly executorType = "critic_review";

  constructor(
    private readonly llmGateway: Pick<LlmGateway, "generateObject">,
    private readonly options: { maxCostUsd?: number; timeoutMs?: number } = {},
  ) {}

  async execute(task: ClaimedAgentTask): Promise<AgentTaskExecutionResult> {
    const input = parseCriticInput(task.input);
    const review = await this.llmGateway.generateObject<CriticReview>({
      sessionId: task.sessionId,
      turnJobId: task.turnJobId,
      agentTaskId: task.id,
      purpose: "critic_review",
      prompt: buildCriticPrompt(input),
      promptVersion: CRITIC_PROMPT_VERSION,
      contextVersionUsed: input.contextVersionUsed ?? null,
      schema: CriticReviewSchema,
      jsonSchema: CRITIC_REVIEW_JSON_SCHEMA,
      ...(this.options.maxCostUsd
        ? { maxCostUsd: this.options.maxCostUsd }
        : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    });
    return {
      output: {
        review,
        input: {
          userMessage: input.userMessage ?? null,
          answer: input.answer ?? null,
          contextVersionUsed: input.contextVersionUsed ?? null,
        },
      },
      contextVersionUsed: input.contextVersionUsed ?? null,
    };
  }
}

export function createCriticExecutorRegistry(
  llmGateway: Pick<LlmGateway, "generateObject">,
  options: { maxCostUsd?: number; timeoutMs?: number } = {},
): AgentTaskExecutorRegistry {
  return new AgentTaskExecutorRegistry([new CriticExecutor(llmGateway, options)]);
}

function parseCriticInput(input: unknown): z.infer<typeof CriticInputSchema> {
  const result = CriticInputSchema.safeParse(input);
  if (!result.success) {
    const customIssue = result.error.issues.find(
      (issue) => issue.message === "critic_input_missing_review_material",
    );
    if (customIssue) {
      throw new Error("critic_input_missing_review_material");
    }
    throw new Error("invalid_critic_input");
  }
  return result.data;
}

function buildCriticPrompt(input: z.infer<typeof CriticInputSchema>): string {
  return [
    "You are the Spec Factory Critic.",
    "",
    "Review the answer or context for unsupported claims, missing evidence, contradictions, and risky assumptions.",
    "Return only structured JSON that matches the schema.",
    "",
    "Critic input:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}
