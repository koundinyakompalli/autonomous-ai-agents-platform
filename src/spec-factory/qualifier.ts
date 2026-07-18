import { z } from "zod";
import { runAgent as defaultRunAgent } from "../claude-sdk/index.js";
import type { SpecFactoryTaskWorkspace } from "./evidence-workspace.js";
import type { EvidenceManifest } from "./evidence.js";
import {
  renderCompactEvidenceSummary,
  renderTaskWorkspacePromptContext,
} from "./prompt-summary.js";
import {
  QualificationReasonSchema,
  type QualificationReason,
} from "./types.js";
import {
  recordAgentSdkProviderError,
  recordAgentSdkProviderResult,
} from "./telemetry/provider-observation.js";

type RunAgent = typeof defaultRunAgent;
type AgentRunResult = Awaited<ReturnType<RunAgent>>;

const QUALIFICATION_REASON_VALUES = [
  "config_only",
  "needs_repo",
  "needs_information",
  "attachment_issue",
] as const;

const SpecFactoryQualificationSchema = z.object({
  qualified: z.boolean(),
  nextAction: z.enum(["generate_epic", "not_qualified"]),
  reasons: z.array(z.enum(QUALIFICATION_REASON_VALUES)).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  summary: z.string().trim().min(1),
  evidenceRefs: z.array(z.string().trim().min(1)).default([]),
  repoHints: z
    .array(
      z.object({
        repoName: z.string().trim().min(1),
        evidenceRefs: z.array(z.string().trim().min(1)).default([]),
        confidence: z.enum(["high", "medium", "low"]).default("medium"),
      }),
    )
    .default([]),
  warnings: z.array(z.string().trim().min(1)).default([]),
});

const SPEC_FACTORY_QUALIFICATION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    qualified: { type: "boolean" },
    nextAction: {
      type: "string",
      enum: ["generate_epic", "not_qualified"],
    },
    reasons: {
      type: "array",
      items: {
        type: "string",
        enum: [...QUALIFICATION_REASON_VALUES],
      },
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
    summary: { type: "string" },
    evidenceRefs: {
      type: "array",
      items: { type: "string" },
    },
    repoHints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          repoName: { type: "string" },
          evidenceRefs: {
            type: "array",
            items: { type: "string" },
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
        },
        required: ["repoName", "evidenceRefs", "confidence"],
      },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "qualified",
    "nextAction",
    "reasons",
    "confidence",
    "summary",
    "evidenceRefs",
    "repoHints",
    "warnings",
  ],
};

export interface SpecFactoryQualificationDecision {
  qualified: boolean;
  reasons: QualificationReason[];
  confidence: "high" | "medium" | "low";
  summary: string;
  evidenceRefs: string[];
  repoHints: Array<{
    repoName: string;
    evidenceRefs: string[];
    confidence: "high" | "medium" | "low";
  }>;
  warnings: string[];
  modelMetadata: {
    provider: "bedrock";
    model: string | undefined;
    metrics: AgentRunResult["metrics"];
  };
}

export interface SpecFactoryQualifierInput {
  sourceId: number;
  sourceJiraKey: string;
  evidenceManifest: EvidenceManifest;
  taskWorkspace: SpecFactoryTaskWorkspace;
}

function buildPrompt(input: SpecFactoryQualifierInput): string {
  return [
    "Decide whether this Spec Factory customer request qualifies for Epic generation.",
    "",
    "You are the qualification stage. Use evidence only; do not inspect repository code in this stage.",
    "Do not treat this prompt as the source evidence body. Use the registered task workspace and read files.",
    "",
    "Mandatory workflow:",
    "- Read evidence/ticket.md first.",
    "- Read evidence/evidence-summary.json, evidence/repo-references.json, evidence/repo-classifier-index.md, and evidence/attachment-index.md.",
    "- Read every relevant file under evidence/attachments/ before deciding.",
    "- Do not open full audit manifests directly; if a file is too large, use grep or Read with offset/limit against only the needed section.",
    "- Decide whether this request should continue to code deep-dive and OneShot-ready Epic/story drafting.",
    "",
    "Qualify when:",
    "- The evidence describes application, backend, frontend, API, database, service, batch, integration, or test implementation work.",
    "- The request can plausibly become one Epic with one or more repo-scoped child stories.",
    "- A repo is explicitly identified or can be reasonably inferred from repo references, paths, filenames, classes, modules, or comments.",
    "",
    "Do not qualify when:",
    "- The work is configuration-only and does not require application/code/database/schema changes.",
    "- The customer intent is too vague to produce acceptance criteria or implementation scope.",
    "- No repo can be inferred from the evidence.",
    "- Priority Louise attachments are missing or unreadable enough that the scope cannot be trusted.",
    "",
    "Important guardrails:",
    "- Do not mark a request config-only just because one configuration attachment says no code changes; if a Development Plan or other evidence describes implementation work, qualify it.",
    "- When evidence includes both config and code work, qualify it and call out config-only portions in warnings.",
    "- If uncertain but there is credible development work and a repo hint, prefer qualified with confidence low or medium.",
    "- Use reasons only for not-qualified decisions.",
    "- When returning repoHints, use repoName values from the OneShot Repo Classifier Profiles section whenever possible.",
    "",
    "Reason mapping for not-qualified decisions:",
    "- config_only: evidence is only client/config/rollout/table settings with no development work.",
    "- needs_repo: development work may exist but the repo cannot be inferred.",
    "- needs_information: the intent/scope is not specific enough.",
    "- attachment_issue: priority attachments are missing, unsupported, skipped, or failed and are needed to decide.",
    "",
    `Source id: ${input.sourceId}`,
    `Source Jira key: ${input.sourceJiraKey}`,
    "",
    renderTaskWorkspacePromptContext(input.taskWorkspace),
    "",
    renderCompactEvidenceSummary(input.evidenceManifest),
  ].join("\n");
}

function parseQualificationOutput(result: AgentRunResult): unknown {
  if (result.structuredOutput !== undefined) {
    return result.structuredOutput;
  }

  return JSON.parse(result.output);
}

function uniqueReasons(reasons: readonly string[]): QualificationReason[] {
  const normalized = new Set<QualificationReason>();
  for (const reason of reasons) {
    const parsed = QualificationReasonSchema.safeParse(reason);
    if (parsed.success) normalized.add(parsed.data);
  }
  return [...normalized];
}

function normalizeDecision(
  output: unknown,
  result: AgentRunResult,
  modelId: string | undefined,
): SpecFactoryQualificationDecision {
  const parsed = SpecFactoryQualificationSchema.parse(output);
  const qualified =
    parsed.qualified === true && parsed.nextAction === "generate_epic";
  const parsedReasons = uniqueReasons(parsed.reasons);
  const reasons: QualificationReason[] = qualified
    ? []
    : parsedReasons.length > 0
      ? parsedReasons
      : ["needs_information"];

  return {
    qualified,
    reasons,
    confidence: parsed.confidence,
    summary: parsed.summary,
    evidenceRefs: parsed.evidenceRefs,
    repoHints: parsed.repoHints,
    warnings: parsed.warnings,
    modelMetadata: {
      provider: "bedrock",
      model: result.metrics.modelUsed || modelId,
      metrics: result.metrics,
    },
  };
}

export class SpecFactoryQualifier {
  constructor(
    private readonly runAgent: RunAgent = defaultRunAgent,
    private readonly modelId: string | undefined = process.env
      .SPEC_FACTORY_QUALIFIER_MODEL_ID ||
      process.env.SPEC_FACTORY_MODEL_ID ||
      process.env.ANTHROPIC_MODEL ||
      "us.anthropic.claude-opus-4-8",
  ) {}

  async qualify(
    input: SpecFactoryQualifierInput,
  ): Promise<SpecFactoryQualificationDecision> {
    const providerStartedAt = Date.now();
    let result: AgentRunResult;
    try {
      result = await this.runAgent({
        taskId: `spec-factory-qualify-${input.sourceJiraKey}-${Date.now()}`,
        taskPrompt: buildPrompt(input),
        repoIds: [input.taskWorkspace.repoId],
        agentType: "custom",
        sdkStage: "qualification",
        permissionLevel: "read_only",
        allowWrite: false,
        timeoutMs: Number(
          process.env.SPEC_FACTORY_QUALIFIER_TIMEOUT_MS || 300000,
        ),
        outputSchema: SPEC_FACTORY_QUALIFICATION_JSON_SCHEMA,
        bedrockConfig: {
          region: process.env.AWS_REGION || "us-east-2",
          model: this.modelId,
        },
        systemAppend:
          "Spec Factory qualification is evidence-only. Read compact evidence index files first, then selected attachment files. Avoid full audit manifests unless using grep or Read offset/limit. Return the structured qualification decision.",
      });
    } catch (error) {
      recordAgentSdkProviderError({
        purpose: "qualification",
        configuredModel: this.modelId,
        startedAt: providerStartedAt,
        error,
      });
      throw error;
    }
    recordAgentSdkProviderResult({
      purpose: "qualification",
      configuredModel: this.modelId,
      startedAt: providerStartedAt,
      result,
    });

    if (!result.success) {
      throw new Error(result.error || "Spec Factory qualification failed");
    }

    return normalizeDecision(
      parseQualificationOutput(result),
      result,
      this.modelId,
    );
  }
}
