import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import {
  DOCS_SYNTHESIS_CONTEXT_PROMPT,
  DOCS_SYNTHESIS_SYSTEM_PROMPT,
  isDocumentationSynthesisEnabled,
  synthesizeDocumentationMarkdown,
  validateSynthesizedDocument,
  type DocsSynthesisInput,
} from "./synthesis.js";

const baseInput: DocsSynthesisInput = {
  jiraKey: "CPDEV-30001",
  epicKey: "CPDEV-30000",
  documentTypeLabel: "DOC-TYPE-CONFIG",
  templateKey: "configuration",
  templateTitle: "Configuration Article Template",
  templateMarkdown: "# Template\n\n## Overview\n",
  deterministicDraft: "# Draft\n\n## Overview\n\nDeterministic content.\n",
  evidenceBlocks: [
    {
      id: "ISSUE-CPDEV-30000",
      label: "Epic CPDEV-30000: Add configuration toggle",
      content: "Epic CPDEV-30000 adds a configuration toggle.",
    },
  ],
};

const stubLoader = {
  loadPrompt: vi.fn(async (name: string) => `PROMPT:${name}`),
  loadGuardrail: vi.fn(async (name: string) => `GUARDRAIL:${name}`),
  invalidateCache: vi.fn(),
};

function converseResponse(text: string): ConverseCommandOutput {
  return {
    output: { message: { role: "assistant", content: [{ text }] } },
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    stopReason: "end_turn",
    $metadata: {},
  } as ConverseCommandOutput;
}

describe("isDocumentationSynthesisEnabled", () => {
  const original = process.env.ONESHOT_DOCS_SYNTHESIS_ENABLED;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.ONESHOT_DOCS_SYNTHESIS_ENABLED;
    } else {
      process.env.ONESHOT_DOCS_SYNTHESIS_ENABLED = original;
    }
  });

  it("defaults to disabled", () => {
    delete process.env.ONESHOT_DOCS_SYNTHESIS_ENABLED;
    expect(isDocumentationSynthesisEnabled()).toBe(false);
  });

  it("is enabled only for an explicit true", () => {
    process.env.ONESHOT_DOCS_SYNTHESIS_ENABLED = "TRUE";
    expect(isDocumentationSynthesisEnabled()).toBe(true);
    process.env.ONESHOT_DOCS_SYNTHESIS_ENABLED = "1";
    expect(isDocumentationSynthesisEnabled()).toBe(false);
    process.env.ONESHOT_DOCS_SYNTHESIS_ENABLED = "yes";
    expect(isDocumentationSynthesisEnabled()).toBe(false);
  });
});

describe("synthesizeDocumentationMarkdown", () => {
  beforeEach(() => {
    stubLoader.loadPrompt.mockClear();
  });

  it("loads both real prompts and returns parsed markdown", async () => {
    const send = vi.fn(async () =>
      converseResponse(
        JSON.stringify({
          jiraKey: baseInput.jiraKey,
          markdown: "# Synthesized\n\nGrounded prose citing CPDEV-30000.",
          sectionEvidence: [
            { sectionId: "overview", evidenceIds: ["ISSUE-CPDEV-30000"] },
          ],
          unsupportedClaims: [],
        }),
      ),
    );

    const result = await synthesizeDocumentationMarkdown(baseInput, {
      promptLoader: stubLoader,
      send,
      modelId: "test-model",
      region: "us-east-2",
    });

    expect(stubLoader.loadPrompt).toHaveBeenCalledWith(
      DOCS_SYNTHESIS_SYSTEM_PROMPT,
    );
    expect(stubLoader.loadPrompt).toHaveBeenCalledWith(
      DOCS_SYNTHESIS_CONTEXT_PROMPT,
    );
    expect(result.markdown).toContain("# Synthesized");
    expect(result.modelUsed).toBe("test-model");
    expect(result.tokensUsed).toEqual({ input: 100, output: 200 });
    expect(result.citedEvidenceIds).toEqual(["ISSUE-CPDEV-30000"]);
    expect(result.availableEvidenceIds).toEqual(["ISSUE-CPDEV-30000"]);

    // System prompt is sent in the system slot; evidence/template ride the
    // user turn so untrusted evidence cannot occupy the behavioral slot.
    const command = send.mock.calls[0][0];
    expect(command.input.system?.[0]?.text).toBe(
      `PROMPT:${DOCS_SYNTHESIS_SYSTEM_PROMPT}`,
    );
    const userText = command.input.messages?.[0]?.content?.[0]?.text ?? "";
    expect(userText).toContain(`PROMPT:${DOCS_SYNTHESIS_CONTEXT_PROMPT}`);
    expect(userText).toContain("UNTRUSTED");
    // Evidence is rendered as delimited, ID-labeled blocks the model must cite.
    expect(userText).toContain('<evidence id="ISSUE-CPDEV-30000"');
    expect(userText).toContain(baseInput.evidenceBlocks[0].content);
  });

  it("parses JSON wrapped in a code fence", async () => {
    const send = vi.fn(async () =>
      converseResponse(
        "```json\n" + JSON.stringify({ markdown: "# Fenced\n" }) + "\n```",
      ),
    );
    const result = await synthesizeDocumentationMarkdown(baseInput, {
      promptLoader: stubLoader,
      send,
    });
    expect(result.markdown).toBe("# Fenced\n");
  });

  it("throws when the model returns no output (so callers fall back)", async () => {
    const send = vi.fn(async () => converseResponse(""));
    await expect(
      synthesizeDocumentationMarkdown(baseInput, {
        promptLoader: stubLoader,
        send,
      }),
    ).rejects.toThrow(/no output/);
  });

  it("throws when the JSON contract is missing required markdown", async () => {
    const send = vi.fn(async () =>
      converseResponse(JSON.stringify({ unsupportedClaims: [] })),
    );
    await expect(
      synthesizeDocumentationMarkdown(baseInput, {
        promptLoader: stubLoader,
        send,
      }),
    ).rejects.toThrow();
  });
});

describe("validateSynthesizedDocument", () => {
  const goodDoc = {
    markdown:
      "# Title\n\n## Overview\n\nGrounded.\n\n## Configuration\n\nDetails.\n",
    requiredHeadings: ["Overview", "Configuration"],
    unsupportedClaims: [],
    // Every required section is cleared by a VALID evidence citation.
    sectionEvidence: [
      { sectionId: "overview", evidenceIds: ["ISSUE-CPDEV-30000"] },
      { sectionId: "configuration", evidenceIds: ["ISSUE-CPDEV-30001"] },
    ],
    citedEvidenceIds: ["ISSUE-CPDEV-30000", "ISSUE-CPDEV-30001"],
    availableEvidenceIds: ["ISSUE-CPDEV-30000", "ISSUE-CPDEV-30001"],
  };

  it("passes only when every required section cites valid evidence", () => {
    expect(validateSynthesizedDocument(goodDoc)).toEqual([]);
  });

  it("forces review when a required section is backed ONLY by a declared gap", () => {
    // A declared gap means the model is reporting missing evidence for a
    // required section — it must route to review, not receive DOCS-GENERATED.
    const reasons = validateSynthesizedDocument({
      ...goodDoc,
      sectionEvidence: [
        { sectionId: "overview", evidenceIds: ["ISSUE-CPDEV-30000"] },
        { sectionId: "configuration", gapIds: ["config-values-not-found"] },
      ],
      citedEvidenceIds: ["ISSUE-CPDEV-30000"],
    });
    expect(
      reasons.some((r) => r.includes('"Configuration"') && r.includes("gap")),
    ).toBe(true);
  });

  it("forces review when a required section has BOTH valid evidence and a declared gap", () => {
    // Mixed citation-plus-gap: the section cites real evidence but also reports
    // that some required evidence is missing. It must still route to review.
    const reasons = validateSynthesizedDocument({
      ...goodDoc,
      sectionEvidence: [
        { sectionId: "overview", evidenceIds: ["ISSUE-CPDEV-30000"] },
        {
          sectionId: "configuration",
          evidenceIds: ["ISSUE-CPDEV-30001"],
          gapIds: ["rollback-not-found"],
        },
      ],
    });
    expect(
      reasons.some((r) => r.includes('"Configuration"') && r.includes("gap")),
    ).toBe(true);
    // It is NOT flagged as uncited, since it does carry a valid citation.
    expect(reasons.some((r) => r.includes("no valid evidence citation"))).toBe(
      false,
    );
  });

  it("flags a required section that is present but has no sectionEvidence entry", () => {
    const reasons = validateSynthesizedDocument({
      ...goodDoc,
      sectionEvidence: [
        { sectionId: "overview", evidenceIds: ["ISSUE-CPDEV-30000"] },
      ],
      citedEvidenceIds: ["ISSUE-CPDEV-30000"],
    });
    expect(
      reasons.some(
        (r) =>
          r.includes('"Configuration"') &&
          r.includes("no valid evidence citation"),
      ),
    ).toBe(true);
  });

  it("rejects a section whose only cited ids were never supplied", () => {
    const reasons = validateSynthesizedDocument({
      ...goodDoc,
      sectionEvidence: [
        { sectionId: "overview", evidenceIds: ["ISSUE-CPDEV-30000"] },
        { sectionId: "configuration", evidenceIds: ["ISSUE-CPDEV-99999"] },
      ],
      citedEvidenceIds: ["ISSUE-CPDEV-30000", "ISSUE-CPDEV-99999"],
    });
    // Configuration cited an unsupplied id, so it is both unbacked AND an
    // invalid citation.
    expect(reasons.some((r) => r.includes('"Configuration"'))).toBe(true);
    expect(reasons.some((r) => r.includes("unknown evidence id"))).toBe(true);
  });

  it("flags a nonempty unsupportedClaims list", () => {
    const reasons = validateSynthesizedDocument({
      ...goodDoc,
      unsupportedClaims: ["Invented a config key that has no evidence."],
    });
    expect(reasons.some((r) => r.includes("unsupported claim"))).toBe(true);
  });

  it("flags a missing required section even when prose looks complete", () => {
    const reasons = validateSynthesizedDocument({
      ...goodDoc,
      markdown: "# Title\n\n## Overview\n\nConfident prose, no gap phrases.\n",
    });
    expect(reasons.some((r) => r.includes("missing required section"))).toBe(
      true,
    );
  });

  it("flags citations to evidence ids that were never supplied", () => {
    const reasons = validateSynthesizedDocument({
      ...goodDoc,
      citedEvidenceIds: ["ISSUE-CPDEV-99999"],
    });
    expect(reasons.some((r) => r.includes("unknown evidence id"))).toBe(true);
  });
});

describe("documentation synthesis deployment", () => {
  it("passes the synthesis feature flag to the Orchestrator task", async () => {
    const ecs = await readFile("terraform/ecs.tf", "utf8");
    const orchestratorStart = ecs.indexOf(
      'resource "aws_ecs_task_definition" "orchestrator"',
    );
    const nextResource = ecs.indexOf('\nresource "', orchestratorStart + 1);
    const orchestratorTask = ecs.slice(orchestratorStart, nextResource);

    expect(orchestratorStart).toBeGreaterThanOrEqual(0);
    expect(orchestratorTask).toContain(
      '{ name = "ONESHOT_DOCS_SYNTHESIS_ENABLED", value = tostring(var.oneshot_docs_synthesis_enabled) },',
    );
  });
});
