import { createHash } from "node:crypto";
import { z } from "zod";
import {
  clarificationType,
  isUserFacingClarification,
} from "../requirements-policy.js";

export const CONTEXT_PATCH_SCHEMA_VERSION = 4;
export const CONTEXT_MAX_OPERATIONS = 500;
export const CONTEXT_MAX_ITEMS_PER_SECTION = 500;
export const CONTEXT_MAX_TEXT_CHARS = 8_000;

export const ContextSectionSchema = z.enum([
  "facts",
  "implementationFindings",
  "requirements",
  "constraints",
  "decisions",
  "openQuestions",
  "conflicts",
  "risks",
]);

export type ContextSection = z.infer<typeof ContextSectionSchema>;

const ContextItemSchema = z
  .record(z.string().max(128), z.unknown())
  .superRefine((item, context) => {
    const text = contextItemText(item);
    if (!text) {
      context.addIssue({
        code: "custom",
        message: "context_item_text_required",
      });
    } else if (text.length > CONTEXT_MAX_TEXT_CHARS) {
      context.addIssue({
        code: "custom",
        message: "context_item_text_too_large",
      });
    }
  });

const UpsertOperationSchema = z.object({
  op: z.literal("upsert"),
  section: ContextSectionSchema,
  item: ContextItemSchema,
});

const RemoveOperationSchema = z.object({
  op: z.literal("remove"),
  section: ContextSectionSchema,
  itemId: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1).max(2_000),
});

const ResolveConflictOperationSchema = z.object({
  op: z.literal("resolve_conflict"),
  conflictId: z.string().trim().min(1).max(64),
  resolution: z.string().trim().min(1).max(CONTEXT_MAX_TEXT_CHARS),
  decision: ContextItemSchema.optional(),
});

export const ContextOperationSchema = z.discriminatedUnion("op", [
  UpsertOperationSchema,
  RemoveOperationSchema,
  ResolveConflictOperationSchema,
]);

export const ContextPatchV4Schema = z.object({
  schemaVersion: z.literal(CONTEXT_PATCH_SCHEMA_VERSION),
  kind: z.enum([
    "source_distillation",
    "conversation",
    "source_removal",
    "repair",
  ]),
  operations: z.array(ContextOperationSchema).max(CONTEXT_MAX_OPERATIONS),
  provenance: z
    .object({
      sourceId: z.number().int().positive().nullable().optional(),
      sourceRevisionId: z.number().int().positive().nullable().optional(),
      turnJobId: z.number().int().positive().nullable().optional(),
      messageIds: z.array(z.number().int().positive()).max(100).optional(),
    })
    .default({}),
});

export type ContextPatchV4 = z.infer<typeof ContextPatchV4Schema>;
export type ContextOperation = z.infer<typeof ContextOperationSchema>;

export interface ContextState {
  facts: unknown[];
  implementationFindings: unknown[];
  requirements: unknown[];
  constraints: unknown[];
  decisions: unknown[];
  openQuestions: unknown[];
  conflicts: unknown[];
  risks: unknown[];
}

export interface ContextPatchApplyOptions {
  overflow?: "error" | "compact";
  onCompaction?: (input: {
    section: ContextSection;
    before: number;
    after: number;
    dropped: number;
  }) => void;
}

const CONTEXT_SECTIONS: ContextSection[] = [
  "facts",
  "implementationFindings",
  "requirements",
  "constraints",
  "decisions",
  "openQuestions",
  "conflicts",
  "risks",
];

const CONTEXT_SECTION_TEXT_ALIASES: Record<ContextSection, readonly string[]> =
  {
    facts: ["fact", "statement", "claim", "description", "summary", "content"],
    implementationFindings: [
      "implementationFinding",
      "implementation_finding",
      "statement",
      "description",
      "summary",
      "content",
    ],
    requirements: [
      "requirement",
      "acceptanceCriterion",
      "acceptance_criterion",
      "statement",
      "description",
      "content",
    ],
    constraints: ["constraint", "statement", "description", "content"],
    decisions: ["decision", "statement", "description", "content"],
    openQuestions: [
      "openQuestion",
      "open_question",
      "prompt",
      "statement",
      "description",
    ],
    conflicts: ["conflict", "statement", "description", "content"],
    risks: ["risk", "statement", "description", "content"],
  };

export function emptyContextState(): ContextState {
  return {
    facts: [],
    implementationFindings: [],
    requirements: [],
    constraints: [],
    decisions: [],
    openQuestions: [],
    conflicts: [],
    risks: [],
  };
}

export function normalizeContextItem(
  section: ContextSection,
  item: unknown,
  provenance: ContextPatchV4["provenance"] = {},
): Record<string, unknown> {
  const record: Record<string, unknown> =
    item && typeof item === "object" && !Array.isArray(item)
      ? { ...(item as Record<string, unknown>) }
      : { text: String(item ?? "").trim() };
  const canonicalText = contextItemText(record);
  const text =
    canonicalText ||
    firstStringField(record, CONTEXT_SECTION_TEXT_ALIASES[section]);
  if (!text) throw new Error(`context_item_text_required:${section}`);
  if (text.length > CONTEXT_MAX_TEXT_CHARS) {
    throw new Error(`context_item_text_too_large:${section}`);
  }
  if (!canonicalText) record.text = text;
  const normalizedProvenance = {
    ...(record.provenance && typeof record.provenance === "object"
      ? (record.provenance as Record<string, unknown>)
      : {}),
    ...(provenance.sourceId ? { sourceId: provenance.sourceId } : {}),
    ...(provenance.sourceRevisionId
      ? { sourceRevisionId: provenance.sourceRevisionId }
      : {}),
    ...(provenance.turnJobId ? { turnJobId: provenance.turnJobId } : {}),
    ...(provenance.messageIds?.length
      ? { messageIds: [...new Set(provenance.messageIds)] }
      : {}),
  };
  const id =
    typeof record.id === "string" && record.id.trim()
      ? record.id.trim().slice(0, 64)
      : stableContextItemId(section, text, normalizedProvenance);
  return {
    ...record,
    id,
    ...(Object.keys(normalizedProvenance).length > 0
      ? { provenance: normalizedProvenance }
      : {}),
  };
}

export function stableContextItemId(
  section: ContextSection,
  text: string,
  provenance: Record<string, unknown> = {},
): string {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  const digest = createHash("sha256")
    .update(`${section}\n${normalized}\n${stableJson(provenance)}`)
    .digest("hex")
    .slice(0, 24);
  return `${section.slice(0, 8)}_${digest}`;
}

export function legacyPatchToV4(input: {
  patch: unknown;
  kind?: ContextPatchV4["kind"];
  sourceId?: number | null;
  sourceRevisionId?: number | null;
  turnJobId?: number | null;
  messageIds?: number[];
}): ContextPatchV4 {
  const existing = ContextPatchV4Schema.safeParse(input.patch);
  if (existing.success) return existing.data;
  const record = asRecord(input.patch);
  const provenance: ContextPatchV4["provenance"] = {
    sourceId: input.sourceId ?? numberValue(record.sourceId),
    sourceRevisionId:
      input.sourceRevisionId ?? numberValue(record.sourceRevisionId),
    turnJobId: input.turnJobId ?? numberValue(record.turnJobId),
    messageIds: input.messageIds,
  };
  const operations: ContextOperation[] = [];
  for (const section of CONTEXT_SECTIONS) {
    for (const item of arrayValue(record[section])) {
      operations.push({
        op: "upsert",
        section,
        item: normalizeContextItem(section, item, provenance),
      });
    }
  }
  return ContextPatchV4Schema.parse({
    schemaVersion: CONTEXT_PATCH_SCHEMA_VERSION,
    kind: input.kind ?? "source_distillation",
    operations,
    provenance,
  });
}

export function buildConversationContextPatch(input: {
  turnJobId: number;
  userMessageId?: number | null;
  userMessage: string;
  assistantMessage: string;
  clarificationAnswer?: boolean;
}): ContextPatchV4 | null {
  const userMessage = input.userMessage.trim();
  const assistantMessage = input.assistantMessage.trim();
  if (!userMessage) return null;
  const messageIds = input.userMessageId ? [input.userMessageId] : [];
  const provenance = {
    turnJobId: input.turnJobId,
    messageIds,
  };
  const operations: ContextOperation[] = [];
  const add = (section: ContextSection, text: string, kind: string) => {
    operations.push({
      op: "upsert",
      section,
      item: normalizeContextItem(
        section,
        { text, kind, authority: "user" },
        provenance,
      ),
    });
  };

  if (
    input.clarificationAnswer ||
    /\b(actually|correction|to clarify|the answer is|confirmed)\b/i.test(
      userMessage,
    )
  ) {
    add("facts", userMessage, "conversation_clarification");
  }
  if (
    /\b(use|choose|decide|decision|approved|go with|proceed with|we will|let's)\b/i.test(
      userMessage,
    )
  ) {
    add("decisions", userMessage, "user_decision");
  }
  if (
    /\b(must|must not|cannot|can't|do not|don't|only|without|limit|never)\b/i.test(
      userMessage,
    )
  ) {
    add("constraints", userMessage, "user_constraint");
  }
  if (/\b(need|needs|should|require|requires|want|goal)\b/i.test(userMessage)) {
    add("requirements", userMessage, "user_requirement");
  }
  if (assistantMessage.endsWith("?") && assistantMessage.length <= 2_000) {
    const userFacing = isUserFacingClarification(assistantMessage);
    operations.push({
      op: "upsert",
      section: userFacing ? "openQuestions" : "implementationFindings",
      item: normalizeContextItem(
        userFacing ? "openQuestions" : "implementationFindings",
        {
          text: assistantMessage,
          question: assistantMessage,
          kind: userFacing
            ? "assistant_clarification"
            : "implementation_question_for_research",
          questionType: clarificationType(assistantMessage),
          authority: "assistant",
        },
        provenance,
      ),
    });
  }
  if (operations.length === 0) return null;
  return ContextPatchV4Schema.parse({
    schemaVersion: CONTEXT_PATCH_SCHEMA_VERSION,
    kind: "conversation",
    operations,
    provenance,
  });
}

export function buildSourceRemovalContextPatch(input: {
  sourceId: number;
  sourceRevisionId?: number | null;
  parent: Partial<ContextState>;
}): ContextPatchV4 {
  const operations: ContextOperation[] = [];
  for (const section of CONTEXT_SECTIONS) {
    for (const rawItem of arrayValue(input.parent[section])) {
      const item = normalizeContextItem(section, rawItem);
      if (!contextItemReferencesSource(item, input.sourceId)) continue;
      operations.push({
        op: "remove",
        section,
        itemId: String(item.id),
        reason: `Source ${input.sourceId} was removed from the session`,
      });
    }
  }
  return ContextPatchV4Schema.parse({
    schemaVersion: CONTEXT_PATCH_SCHEMA_VERSION,
    kind: "source_removal",
    operations,
    provenance: {
      sourceId: input.sourceId,
      sourceRevisionId: input.sourceRevisionId ?? null,
    },
  });
}

export function applyContextPatches(
  parent: Partial<ContextState> | null | undefined,
  patches: ContextPatchV4[],
  options: ContextPatchApplyOptions = {},
): ContextState {
  const maps = Object.fromEntries(
    CONTEXT_SECTIONS.map((section) => [
      section,
      new Map(
        arrayValue(parent?.[section]).map((item) => {
          const normalized = normalizeContextItem(section, item);
          return [String(normalized.id), normalized];
        }),
      ),
    ]),
  ) as Record<ContextSection, Map<string, Record<string, unknown>>>;

  for (const patch of patches) {
    const parsed = ContextPatchV4Schema.parse(patch);
    for (const operation of parsed.operations) {
      if (operation.op === "upsert") {
        const item = normalizeContextItem(
          operation.section,
          operation.item,
          parsed.provenance,
        );
        maps[operation.section].set(String(item.id), item);
      } else if (operation.op === "remove") {
        maps[operation.section].delete(operation.itemId);
      } else {
        const conflict = maps.conflicts.get(operation.conflictId);
        if (conflict) {
          maps.conflicts.set(operation.conflictId, {
            ...conflict,
            status: "resolved",
            resolution: operation.resolution,
          });
        }
        if (operation.decision) {
          const decision = normalizeContextItem(
            "decisions",
            operation.decision,
            parsed.provenance,
          );
          maps.decisions.set(String(decision.id), decision);
        }
      }
    }
  }

  return Object.fromEntries(
    CONTEXT_SECTIONS.map((section) => {
      const items = [...maps[section].values()];
      if (
        items.length > CONTEXT_MAX_ITEMS_PER_SECTION &&
        options.overflow !== "compact"
      ) {
        throw new Error(`context_section_limit_exceeded:${section}`);
      }
      const boundedItems =
        items.length > CONTEXT_MAX_ITEMS_PER_SECTION
          ? compactContextSection(items, CONTEXT_MAX_ITEMS_PER_SECTION)
          : items;
      if (boundedItems.length < items.length) {
        options.onCompaction?.({
          section,
          before: items.length,
          after: boundedItems.length,
          dropped: items.length - boundedItems.length,
        });
      }
      return [section, boundedItems];
    }),
  ) as unknown as ContextState;
}

function compactContextSection(
  items: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  const protectedItems = items.filter(isProtectedContextItem);
  if (protectedItems.length > limit) {
    throw new Error("context_protected_section_limit_exceeded");
  }

  const selected = new Set(protectedItems.map((item) => String(item.id)));
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const item of items) {
    if (selected.has(String(item.id))) continue;
    const key = contextItemSourceKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort(compareContextSourceKeys);
  let index = 0;
  while (selected.size < limit) {
    let advanced = false;
    for (const key of keys) {
      const item = groups.get(key)?.[index];
      if (!item) continue;
      selected.add(String(item.id));
      advanced = true;
      if (selected.size === limit) break;
    }
    if (!advanced) break;
    index += 1;
  }
  return items.filter((item) => selected.has(String(item.id)));
}

function isProtectedContextItem(item: Record<string, unknown>): boolean {
  if (item.authority === "user") return true;
  const provenance =
    item.provenance && typeof item.provenance === "object"
      ? (item.provenance as Record<string, unknown>)
      : null;
  return (
    Array.isArray(provenance?.messageIds) && provenance.messageIds.length > 0
  );
}

function contextItemSourceKey(item: Record<string, unknown>): string {
  const provenance =
    item.provenance && typeof item.provenance === "object"
      ? (item.provenance as Record<string, unknown>)
      : null;
  const sourceId = provenance?.sourceId;
  return typeof sourceId === "number" && Number.isFinite(sourceId)
    ? String(sourceId)
    : "unattributed";
}

function compareContextSourceKeys(left: string, right: string): number {
  if (left === "unattributed") return right === "unattributed" ? 0 : 1;
  if (right === "unattributed") return -1;
  return Number(left) - Number(right);
}

export function contextItemText(item: Record<string, unknown>): string {
  for (const key of ["text", "question", "file", "finding", "resolution"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstStringField(
  item: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function contextItemReferencesSource(
  item: Record<string, unknown>,
  sourceId: number,
): boolean {
  if (numberValue(item.sourceId) === sourceId) return true;
  const provenance = asRecord(item.provenance);
  if (numberValue(provenance.sourceId) === sourceId) return true;
  return arrayValue(item.evidence).some(
    (evidence) => numberValue(asRecord(evidence).sourceId) === sourceId,
  );
}
