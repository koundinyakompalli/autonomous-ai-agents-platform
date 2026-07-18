import type { LlmPurpose } from "./llm-gateway.js";
import type mysql from "mysql2/promise";
import { getDatabase } from "../../orchestrator/database.js";

export interface PromptRegistryEntry {
  promptVersion: string;
  version: number;
  active: boolean;
  purposes: LlmPurpose[];
  source: string;
  changelog: string[];
  schemaExpectation?: string;
}

export type PromptRegistryPool = Pick<mysql.Pool, "query">;

export interface PromptVersionResolver {
  resolvePromptVersion(input: {
    purpose: LlmPurpose;
    requestedVersion?: string | null;
    allowDefault?: boolean;
  }): Promise<string | null>;
}

export const PROMPT_REGISTRY: readonly PromptRegistryEntry[] = [
  {
    promptVersion: "chat_coordinator@v1",
    version: 1,
    active: false,
    purposes: ["chat_coordinator_fast", "chat_coordinator_strong"],
    source: "src/spec-factory/agents/chat-coordinator.ts",
    changelog: [
      "Initial structured coordinator decision prompt with answer, dispatch_research, ask_clarification, and escalate actions.",
    ],
    schemaExpectation: "CoordinatorDecisionSchema",
  },
  {
    promptVersion: "chat_coordinator@v2",
    version: 2,
    active: true,
    purposes: ["chat_coordinator_fast", "chat_coordinator_strong"],
    source: "src/spec-factory/agents/chat-coordinator.ts",
    changelog: [
      "Add the versioned MHK organizational baseline and deterministic retrieval of relevant detailed sections.",
    ],
    schemaExpectation: "CoordinatorDecisionSchema",
  },
  {
    promptVersion: "critic_review@v1",
    version: 1,
    active: true,
    purposes: ["critic_review"],
    source: "src/spec-factory/agents/critic-agent.ts",
    changelog: [
      "Initial evidence critic prompt for supported, needs_revision, and unsupported verdicts.",
    ],
    schemaExpectation: "CriticReviewSchema",
  },
  {
    promptVersion: "source_distillation@v1",
    version: 1,
    active: false,
    purposes: ["source_distillation"],
    source: "src/spec-factory/agents/context-executors.ts",
    changelog: ["Initial source distillation gateway purpose registration."],
  },
  {
    promptVersion: "source_distillation@v2",
    version: 2,
    active: true,
    purposes: ["source_distillation"],
    source: "src/spec-factory/agents/context-executors.ts",
    changelog: [
      "Require canonical non-empty text on every structured distillation item.",
    ],
    schemaExpectation: "SourceDistillationPatchSchema",
  },
  {
    promptVersion: "context_merge@v1",
    version: 1,
    active: true,
    purposes: ["context_merge"],
    source: "src/spec-factory/agents/context-executors.ts",
    changelog: ["Initial context merge gateway purpose registration."],
  },
  {
    promptVersion: "handoff_synthesis@v1",
    version: 1,
    active: true,
    purposes: ["handoff_synthesis"],
    source: "src/spec-factory/agents/handoff-builder.ts",
    changelog: [
      "Initial handoff synthesis prompt for queued handoff narrative fields.",
    ],
  },
  {
    promptVersion: "conversation_summary@v1",
    version: 1,
    active: true,
    purposes: ["conversation_summary"],
    source: "src/spec-factory/llm/llm-gateway.ts",
    changelog: ["Initial conversation summary gateway purpose registration."],
  },
];

const PROMPT_VERSION_PATTERN = /^[a-z][a-z0-9_]*@v[1-9][0-9]*$/;

export function resolvePromptVersion(input: {
  purpose: LlmPurpose;
  requestedVersion?: string | null;
}): string {
  return resolvePromptVersionFromEntries(PROMPT_REGISTRY, input) ?? failMissing(
    input.purpose,
  );
}

export function resolvePromptVersionFromEntries(
  entries: readonly PromptRegistryEntry[],
  input: {
    purpose: LlmPurpose;
    requestedVersion?: string | null;
  },
): string | null {
  const requested = input.requestedVersion?.trim();
  if (requested) {
    validatePromptVersionFormat(requested);
    const entry = entries.find(
      (candidate) => candidate.promptVersion === requested,
    );
    if (!entry) {
      throw new Error(`prompt_version_not_registered:${requested}`);
    }
    if (!entry.purposes.includes(input.purpose)) {
      throw new Error(
        `prompt_version_purpose_mismatch:${requested}:${input.purpose}`,
      );
    }
    return entry.promptVersion;
  }

  const entry = entries.find(
    (candidate) =>
      candidate.active && candidate.purposes.includes(input.purpose),
  );
  return entry?.promptVersion ?? null;
}

export function validatePromptVersionForPurpose(input: {
  purpose: LlmPurpose;
  promptVersion?: string | null;
}): string | null {
  if (!input.promptVersion) return null;
  return resolvePromptVersion({
    purpose: input.purpose,
    requestedVersion: input.promptVersion,
  });
}

function validatePromptVersionFormat(promptVersion: string): void {
  if (!PROMPT_VERSION_PATTERN.test(promptVersion)) {
    throw new Error(`invalid_prompt_version:${promptVersion}`);
  }
}

export class StaticPromptRegistryStore implements PromptVersionResolver {
  constructor(
    private readonly entries: readonly PromptRegistryEntry[] = PROMPT_REGISTRY,
  ) {}

  async resolvePromptVersion(input: {
    purpose: LlmPurpose;
    requestedVersion?: string | null;
    allowDefault?: boolean;
  }): Promise<string | null> {
    if (!input.requestedVersion && !input.allowDefault) return null;
    return resolvePromptVersionFromEntries(this.entries, input) ?? failMissing(
      input.purpose,
    );
  }
}

interface PromptRegistryRow extends mysql.RowDataPacket {
  prompt_version: string;
  version: number | string;
  active: number | boolean;
  purposes_json: unknown;
  source: string;
  changelog_json: unknown;
  schema_expectation: string | null;
}

export class SpecFactoryPromptRegistryRepository
  implements PromptVersionResolver
{
  constructor(
    private readonly pool: PromptRegistryPool = getDatabase().getPool(),
  ) {}

  async resolvePromptVersion(input: {
    purpose: LlmPurpose;
    requestedVersion?: string | null;
    allowDefault?: boolean;
  }): Promise<string | null> {
    const requested = input.requestedVersion?.trim();
    if (requested) {
      validatePromptVersionFormat(requested);
      const [rows] = await this.pool.query<PromptRegistryRow[]>(
        `SELECT prompt_version, version, active, purposes_json, source,
                changelog_json, schema_expectation
         FROM spec_factory_prompt_versions
         WHERE prompt_version = ?
         LIMIT 1`,
        [requested],
      );
      const entry = rows[0] ? mapPromptRegistryRow(rows[0]) : null;
      if (!entry) {
        throw new Error(`prompt_version_not_registered:${requested}`);
      }
      if (!entry.purposes.includes(input.purpose)) {
        throw new Error(
          `prompt_version_purpose_mismatch:${requested}:${input.purpose}`,
        );
      }
      return entry.promptVersion;
    }

    if (!input.allowDefault) return null;
    const [rows] = await this.pool.query<PromptRegistryRow[]>(
      `SELECT prompt_version, version, active, purposes_json, source,
              changelog_json, schema_expectation
       FROM spec_factory_prompt_versions
       WHERE active = 1
         AND JSON_CONTAINS(purposes_json, JSON_QUOTE(?))
       ORDER BY version DESC, id DESC
       LIMIT 1`,
      [input.purpose],
    );
    const entry = rows[0] ? mapPromptRegistryRow(rows[0]) : null;
    return entry?.promptVersion ?? failMissing(input.purpose);
  }
}

function mapPromptRegistryRow(row: PromptRegistryRow): PromptRegistryEntry {
  return {
    promptVersion: row.prompt_version,
    version: Number(row.version),
    active: row.active === true || Number(row.active) === 1,
    purposes: parseLlmPurposeArray(row.purposes_json),
    source: row.source,
    changelog: parseStringArray(row.changelog_json),
    schemaExpectation: row.schema_expectation ?? undefined,
  };
}

function parseLlmPurposeArray(value: unknown): LlmPurpose[] {
  return parseStringArray(value).filter((purpose): purpose is LlmPurpose =>
    [
      "chat_coordinator_fast",
      "chat_coordinator_strong",
      "source_distillation",
      "context_merge",
      "critic_review",
      "handoff_synthesis",
      "conversation_summary",
    ].includes(purpose),
  );
}

function parseStringArray(value: unknown): string[] {
  const parsed =
    typeof value === "string" ? safeJsonParse(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function failMissing(purpose: LlmPurpose): never {
  throw new Error(`prompt_version_not_registered_for_purpose:${purpose}`);
}
