import { describe, expect, it } from "vitest";
import {
  applyContextPatches,
  buildConversationContextPatch,
  buildSourceRemovalContextPatch,
  CONTEXT_MAX_ITEMS_PER_SECTION,
  legacyPatchToV4,
  stableContextItemId,
} from "./context-model.js";

describe("v4 context reducer", () => {
  it("preserves untouched parent items while applying new patches", () => {
    const parent = {
      facts: [
        { id: "fact-a", text: "A" },
        { id: "fact-b", text: "B" },
      ],
    };
    const patch = legacyPatchToV4({
      patch: { facts: [{ text: "C" }] },
      sourceId: 61,
    });

    const result = applyContextPatches(parent, [patch]);

    expect(result.facts.map((item) => (item as { text: string }).text)).toEqual(
      ["A", "B", "C"],
    );
  });

  it("removes items only through an explicit remove operation", () => {
    const result = applyContextPatches(
      {
        facts: [
          { id: "fact-a", text: "A" },
          { id: "fact-b", text: "B" },
        ],
      },
      [
        {
          schemaVersion: 4,
          kind: "source_removal",
          provenance: { sourceId: 61 },
          operations: [
            {
              op: "remove",
              section: "facts",
              itemId: "fact-a",
              reason: "Source 61 was removed",
            },
          ],
        },
      ],
    );

    expect(result.facts).toEqual([{ id: "fact-b", text: "B" }]);
  });

  it("uses stable item ids for idempotent reapplication", () => {
    const patch = legacyPatchToV4({
      patch: { decisions: [{ text: "Use durable turns" }] },
      turnJobId: 101,
      messageIds: [51, 52],
      kind: "conversation",
    });
    const once = applyContextPatches(null, [patch]);
    const twice = applyContextPatches(once, [patch]);

    expect(twice.decisions).toHaveLength(1);
    expect((twice.decisions[0] as { id: string }).id).toBe(
      stableContextItemId("decisions", "Use durable turns", {
        turnJobId: 101,
        messageIds: [51, 52],
      }),
    );
  });

  it("canonicalizes section-specific legacy text aliases", () => {
    const patch = legacyPatchToV4({
      patch: {
        facts: [{ fact: "Billing owns invoice exports" }],
        requirements: [{ requirement: "Preserve invoice ordering" }],
        constraints: [{ constraint: "Use the existing queue" }],
        decisions: [{ decision: "Keep FIFO semantics" }],
        openQuestions: [{ openQuestion: "Which retry queue is active?" }],
        conflicts: [{ conflict: "Two owners are named" }],
        risks: [{ risk: "Retries can reorder invoices" }],
      },
      sourceId: 61,
    });

    expect(
      patch.operations.map((operation) =>
        operation.op === "upsert"
          ? [operation.section, operation.item.text]
          : null,
      ),
    ).toEqual([
      ["facts", "Billing owns invoice exports"],
      ["requirements", "Preserve invoice ordering"],
      ["constraints", "Use the existing queue"],
      ["decisions", "Keep FIFO semantics"],
      ["openQuestions", "Which retry queue is active?"],
      ["conflicts", "Two owners are named"],
      ["risks", "Retries can reorder invoices"],
    ]);
  });

  it("records conflict resolution and the resulting decision", () => {
    const result = applyContextPatches(
      {
        conflicts: [{ id: "conflict-a", text: "A conflicts with B" }],
      },
      [
        {
          schemaVersion: 4,
          kind: "conversation",
          provenance: { turnJobId: 101 },
          operations: [
            {
              op: "resolve_conflict",
              conflictId: "conflict-a",
              resolution: "B is authoritative",
              decision: { text: "Use B" },
            },
          ],
        },
      ],
    );

    expect(result.conflicts[0]).toMatchObject({
      id: "conflict-a",
      status: "resolved",
      resolution: "B is authoritative",
    });
    expect(result.decisions).toHaveLength(1);
  });

  it("captures authoritative conversation decisions with turn provenance", () => {
    const patch = buildConversationContextPatch({
      turnJobId: 101,
      userMessageId: 51,
      userMessage: "Let's use SQS, but it must preserve per-session order.",
      assistantMessage: "I will design around that decision.",
    });

    expect(patch).not.toBeNull();
    expect(patch?.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "decisions" }),
        expect.objectContaining({ section: "constraints" }),
      ]),
    );
    expect(patch?.provenance).toMatchObject({
      turnJobId: 101,
      messageIds: [51],
    });
  });

  it("builds explicit removals only for items backed by the deleted source", () => {
    const patch = buildSourceRemovalContextPatch({
      sourceId: 61,
      sourceRevisionId: 601,
      parent: {
        facts: [
          { id: "from-61", text: "A", provenance: { sourceId: 61 } },
          { id: "from-62", text: "B", provenance: { sourceId: 62 } },
        ],
      },
    });

    expect(patch.operations).toEqual([
      expect.objectContaining({
        op: "remove",
        section: "facts",
        itemId: "from-61",
      }),
    ]);
  });

  it("keeps strict overflow rejection as the default", () => {
    const patches = [61, 62].map((sourceId) =>
      legacyPatchToV4({
        sourceId,
        patch: {
          facts: Array.from({ length: 300 }, (_, index) => ({
            text: `Source ${sourceId} fact ${index}`,
          })),
        },
      }),
    );

    expect(() => applyContextPatches(null, patches)).toThrow(
      "context_section_limit_exceeded:facts",
    );
  });

  it("compacts runtime overflow fairly across sources and preserves user claims", () => {
    const patches = [61, 62].map((sourceId) =>
      legacyPatchToV4({
        sourceId,
        patch: {
          facts: Array.from({ length: 300 }, (_, index) => ({
            text: `Source ${sourceId} fact ${index}`,
          })),
        },
      }),
    );
    const compacted: Array<{
      section: string;
      before: number;
      after: number;
      dropped: number;
    }> = [];

    const result = applyContextPatches(
      {
        facts: [
          {
            id: "user-fact",
            text: "The user-approved launch date is July 31.",
            authority: "user",
          },
        ],
      },
      patches,
      {
        overflow: "compact",
        onCompaction: (summary) => compacted.push(summary),
      },
    );

    expect(result.facts).toHaveLength(CONTEXT_MAX_ITEMS_PER_SECTION);
    expect(result.facts).toContainEqual(
      expect.objectContaining({ id: "user-fact", authority: "user" }),
    );
    const counts = result.facts.reduce<Record<string, number>>(
      (accumulator, item) => {
        const sourceId = String(
          (item as { provenance?: { sourceId?: number } }).provenance
            ?.sourceId ?? "user",
        );
        accumulator[sourceId] = (accumulator[sourceId] ?? 0) + 1;
        return accumulator;
      },
      {},
    );
    expect(counts).toEqual({ user: 1, "61": 250, "62": 249 });
    expect(compacted).toEqual([
      {
        section: "facts",
        before: 601,
        after: CONTEXT_MAX_ITEMS_PER_SECTION,
        dropped: 101,
      },
    ]);
  });
});
