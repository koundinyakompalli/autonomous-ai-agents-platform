import { describe, expect, it } from "vitest";
import {
  buildEvidenceBlocksForTest,
  buildHumanReviewSummaryForTest,
  isGeneratedDocumentationArtifactForTest,
  renderJiraAttachmentCommentForTest,
  renderDryRunMarkdownForTest,
  runDocumentationArtifactForIssue,
  shouldApplyGeneratedLabelForTest,
  type DocumentationDryRunContext,
  type DocumentationDryRunIssue,
  type JiraConfig,
} from "./generate.js";
import type { DocumentationTemplateSnapshot } from "./templates.js";

const jiraConfig: JiraConfig = {
  baseUrl: "https://mhkjira.atlassian.net",
  username: "docs@example.com",
  token: "token",
};

function issue(
  overrides: Partial<DocumentationDryRunIssue> & { key: string },
): DocumentationDryRunIssue {
  return {
    key: overrides.key,
    summary: overrides.summary ?? `${overrides.key} summary`,
    issueType: overrides.issueType ?? "Story",
    status: overrides.status ?? "Done",
    labels: overrides.labels ?? [],
    parentKey: overrides.parentKey ?? null,
    descriptionMarkdown: overrides.descriptionMarkdown ?? "",
    commentCount: overrides.comments?.length ?? overrides.commentCount ?? 0,
    attachmentCount:
      overrides.attachmentTexts?.length ?? overrides.attachmentCount ?? 0,
    components: overrides.components ?? [],
    fixVersions: overrides.fixVersions ?? [],
    subtasks: overrides.subtasks ?? [],
    comments: overrides.comments ?? [],
    attachmentTexts: overrides.attachmentTexts ?? [],
  };
}

function template(
  documentTypeLabel: "DOC-TYPE-CONFIG" | "DOC-TYPE-TROUBLESHOOTING",
): DocumentationTemplateSnapshot {
  const key =
    documentTypeLabel === "DOC-TYPE-CONFIG"
      ? "configuration"
      : "troubleshooting";
  const title =
    documentTypeLabel === "DOC-TYPE-CONFIG"
      ? "Configuration Article Template"
      : "Troubleshooting Guide Template";

  return {
    definition: {
      key,
      documentTypeLabel,
      sourceMatrixTask:
        documentTypeLabel === "DOC-TYPE-CONFIG"
          ? "Configuration Documentation"
          : "Troubleshooting Guide",
      templateTitle: title,
      templateFile: `templates/${key}.md`,
      confluencePageId:
        documentTypeLabel === "DOC-TYPE-CONFIG" ? "3117482062" : "3054699051",
      confluenceVersion: documentTypeLabel === "DOC-TYPE-CONFIG" ? 2 : 10,
      doc360Target:
        documentTypeLabel === "DOC-TYPE-CONFIG"
          ? "External-general configuration article"
          : "Internal troubleshooting guide",
      targetAudience:
        documentTypeLabel === "DOC-TYPE-CONFIG"
          ? "Client administrators and business consultants"
          : "Internal L2 support, engineering, and product teams",
      writer: "Development",
      signOff: "Product Owner",
      publishesToDoc360: "Tech Writer",
      requiredRule: "Required for documentation tests",
      internalUse: documentTypeLabel === "DOC-TYPE-TROUBLESHOOTING",
      requiredHeadings: [],
    },
    markdown: `# ${title}`,
    contentHash: "0".repeat(64),
    sections: [],
    placeholders: [],
  };
}

describe("documentation dry-run rendering", () => {
  it("maps configuration docs across epic stories, subtasks, comments, and attachments", () => {
    const context: DocumentationDryRunContext = {
      target: issue({
        key: "CPDEV-21797",
        summary: "Config Instructions",
        issueType: "Sub-task",
        parentKey: "CPDEV-21597",
        labels: ["DOCS-GENERATE", "DOC-TYPE-CONFIG"],
      }),
      documentationStory: issue({
        key: "CPDEV-21597",
        summary: "CPDEV 15669 Documentation",
        parentKey: "CPDEV-15669",
      }),
      epic: issue({
        key: "CPDEV-15669",
        summary: "Concurrent review support in Provider Portal",
        fixVersions: ["4.2"],
        descriptionMarkdown:
          "## Executive Summary\nRelease 4.2 introduces configurable concurrent review automation.",
      }),
      epicChildren: [
        issue({
          key: "CPDEV-20710",
          summary: "Auto Auth Rules for Concurrent Reviews",
          subtasks: ["CPDEV-20710-T1"],
          descriptionMarkdown: [
            "## Quick Reference Table",
            "| Setting | Configuration Location | Default | Impact When Enabled |",
            "|---|---|---|---|",
            "| Global Toggle | Admin > System Variables | ON | Enables concurrent review automation system-wide |",
            "| Per-Rule Checkbox | Admin > UM > Auto Auth Rules | OFF | This rule executes on revision 2+ |",
            "",
            "## Behavior Matrix",
            "| Global Toggle | Per-Rule Checkbox | Revision 1 | Revision 2+ |",
            "|---|---|---|---|",
            "| ON | Checked | Rules run | Rules run |",
            "",
            "## Configuration Steps",
            "Navigate to: Menu > Admin > UM > Auto Auth Rules",
            "1. Expand Auth Rules.",
            "2. Select a rule group.",
            "3. Check Apply to all review lines.",
            "4. Save.",
          ].join("\n"),
          comments: [
            {
              id: "1",
              created: "2026-05-01",
              bodyMarkdown:
                "## Validation Areas:\n- Confirm checkbox persists after save.\n- Confirm rule executes for revision 2.",
            },
          ],
        }),
      ],
      subtaskIssues: [
        issue({
          key: "CPDEV-20710-T1",
          summary: "Add regression tests for Auto Auth Rules",
          parentKey: "CPDEV-20710",
          issueType: "Sub-task",
          descriptionMarkdown:
            "## Verification\n- Unit tests cover checked and unchecked rule behavior.",
          attachmentTexts: [
            {
              filename: "auto-auth-test-notes.md",
              content:
                "## Configuration Examples\n### Example 1: Global ON and rule checked\nRevision 2 runs auth rules.",
            },
          ],
        }),
      ],
      template: template("DOC-TYPE-CONFIG"),
      gaps: [],
    };

    const markdown = renderDryRunMarkdownForTest(context, jiraConfig);

    expect(markdown).toContain("## Epic Evidence Map");
    expect(markdown).toContain("CPDEV-20710-T1");
    expect(markdown).toContain("## Configuration Details");
    expect(markdown).toContain("Global Toggle");
    expect(markdown).toContain("## Behavior Matrix");
    expect(markdown).toContain("Rules run");
    expect(markdown).toContain("## How to Configure");
    expect(markdown).toContain("Expand Auth Rules");
    expect(markdown).toContain("## Configuration Examples");
    expect(markdown).toContain("Global ON and rule checked");
    expect(markdown).toContain("## Verification & Testing");
    expect(markdown).toContain("Confirm checkbox persists after save");
    expect(markdown).toContain("Subtask/task issues reviewed: 1");
  });

  it("uses target-first evidence for troubleshooting instead of unrelated epic configuration rows", () => {
    const context: DocumentationDryRunContext = {
      target: issue({
        key: "CPDEV-21801",
        summary: "Troubleshooting and support Documentation",
        labels: ["DOCS-GENERATE", "DOC-TYPE-TROUBLESHOOTING"],
        parentKey: "CPDEV-21597",
        descriptionMarkdown: [
          "## Problem",
          "- Continue Review procedure selection does not call the PA List engine.",
          "",
          "## Cause",
          "- The procedure selection path bypasses the PA List invocation.",
          "",
          "## Resolution",
          "- Reproduce with an inpatient concurrent review.",
          "- Select a procedure and confirm the PA List request is sent.",
          "- Verify the modal displays returned documentation requirements.",
          "",
          "## Verification",
          "- Confirm PA List engine invocation is logged without PHI.",
          "- Confirm the provider sees expected documentation guidance.",
        ].join("\n"),
      }),
      documentationStory: issue({
        key: "CPDEV-21597",
        summary: "CPDEV 15669 Documentation",
        parentKey: "CPDEV-15669",
      }),
      epic: issue({
        key: "CPDEV-15669",
        summary: "Concurrent review support in Provider Portal",
      }),
      epicChildren: [
        issue({
          key: "CPDEV-20710",
          summary: "Unrelated configuration table",
          descriptionMarkdown: [
            "## Behavior Matrix",
            "| State | Revision 1 | Revision 2+ |",
            "|---|---|---|",
            "| FALSE (disabled) | Rules run | Rules do not run |",
          ].join("\n"),
        }),
      ],
      subtaskIssues: [],
      template: template("DOC-TYPE-TROUBLESHOOTING"),
      gaps: [],
    };

    const markdown = renderDryRunMarkdownForTest(context, jiraConfig);

    expect(markdown).toContain(
      "Continue Review procedure selection does not call the PA List engine",
    );
    expect(markdown).toContain(
      "The procedure selection path bypasses the PA List invocation",
    );
    expect(markdown).toContain("Reproduce with an inpatient concurrent review");
    expect(markdown).toContain("Confirm PA List engine invocation");
    expect(markdown).toContain("## Epic Evidence Map");
    expect(markdown).toContain("CPDEV-20710");
    expect(markdown).not.toContain("FALSE (disabled):");
  });

  it("preserves a detailed authored troubleshooting guide from the target description", () => {
    const authoredGuide = [
      "# Troubleshooting & Support Guide - CPDEV-15669",
      "",
      "This guide supports Provider Portal concurrent reviews with Auto Auth Rules, PA List, external guideline launch, submission-window validation, and prior-review visibility.",
      "",
      "## 1. Feature - Code/DB/Config Map",
      "",
      "| Capability | Story | Portal Code | Backend Code | DB Tables / Config Keys |",
      "| --- | --- | --- | --- | --- |",
      "| External Guidelines | CPDEV-19859 | ProcessGuidelineCallback.java | ContinueReviewBusinessService.java | auth_review_external_guidelines |",
      "| PA List | CPDEV-16171 | GetContinueReviewProcedureDetails.java | PA list services | existing PA rule tables |",
      "",
      "## 2. Key Log Markers to grep",
      "",
      "| Marker | Emitted By | Means |",
      "| --- | --- | --- |",
      "| Continue review created successfully - reviewId: <X> | ContinueReviewBusinessService.java | Happy-path submission complete |",
      "| CPDEV-19859-ORPHAN authId=<X> reason=<R> | MarkConcurrentReviewAbandoned.java | MCG URL fetch failed or user cancelled |",
      "",
      "## 3. Inspection SQL",
      "",
      "```sql",
      "SELECT ar.id AS review_id, ar.auth_id, ar.revision",
      "FROM auth_review ar",
      "WHERE ar.auth_id = :auth_id;",
      "```",
      "",
      "## 4. Common Issues & Troubleshooting",
      "",
      "### 4.1 Provider cannot submit a concurrent review",
      "",
      "**Diagnose**",
      "",
      "1. Check browser console for modal load errors.",
      "2. Verify provider_concurrent_review_config has an active matching rule.",
      "3. Confirm the submission window allows the through date.",
      "",
      "**Common causes**",
      "",
      "- No matching rule.",
      "- Submission window violated.",
      "- Portal cache still has older JavaScript.",
      "",
      "### 4.2 External guidelines never launch",
      "",
      "**Diagnose**",
      "",
      "1. Confirm GetExternalQuestionSetURLPOST returns a guideline URL.",
      "2. Verify fetchExternalGuideline is enabled on the rule outcome.",
      "",
      "## 5. Environment Setup / Deployment Checklist",
      "",
      "1. Configure PROVIDER_PORTAL_GUIDELINE_DOC_ALLOWED_HOSTS.",
      "2. Enable UM_AUTH_RULES_APPLY_CONCURRENT_REVIEWS.",
      "3. Verify provider_concurrent_review_config rules exist.",
      "",
      "## 6. Known Limitations / Open Items",
      "",
      "| Item | Status | Tracker |",
      "| --- | --- | --- |",
      "| Auto Auth Rule outcome after guideline completion | Open | CPDEV-19859 |",
      "",
      "## 7. Escalation Matrix",
      "",
      "| Symptom | First-line owner | Data to collect |",
      "| --- | --- | --- |",
      "| User cannot submit | Support to Portal team | auth number, timestamp, browser console, server log marker |",
      "",
      "## 8. Related Tickets / Documentation",
      "",
      "- CPDEV-15669",
      "- CPDEV-21597",
    ].join("\n");
    const context: DocumentationDryRunContext = {
      target: issue({
        key: "CPDEV-21801",
        summary: "Troubleshooting and support Documentation",
        labels: ["DOCS-GENERATE", "DOC-TYPE-TROUBLESHOOTING"],
        parentKey: "CPDEV-21597",
        descriptionMarkdown: authoredGuide,
      }),
      documentationStory: issue({
        key: "CPDEV-21597",
        summary: "CPDEV 15669 Documentation",
        parentKey: "CPDEV-15669",
      }),
      epic: issue({
        key: "CPDEV-15669",
        summary: "Concurrent review support in Provider Portal",
      }),
      epicChildren: [],
      subtaskIssues: [],
      template: template("DOC-TYPE-TROUBLESHOOTING"),
      gaps: [],
    };

    const markdown = renderDryRunMarkdownForTest(context, jiraConfig);

    expect(markdown).toContain(
      "# Troubleshooting & Support Guide - CPDEV-15669",
    );
    expect(markdown).toContain("## 4. Common Issues & Troubleshooting");
    expect(markdown).toContain(
      "### 4.1 Provider cannot submit a concurrent review",
    );
    expect(markdown).toContain("## Epic Evidence Map");
    expect(
      markdown.indexOf("## 4. Common Issues & Troubleshooting"),
    ).toBeLessThan(markdown.indexOf("## Epic Evidence Map"));
    expect(markdown).not.toContain("## Problem\n\n# Troubleshooting");
    expect(markdown).not.toContain("<cause not found in reviewed evidence>");
  });

  it("does not allow terminal-label bypass while attaching to Jira", async () => {
    await expect(
      runDocumentationArtifactForIssue({
        issueKey: "CPDEV-21801",
        attachToJira: true,
        ignoreTerminalLabels: true,
        jiraConfig,
      }),
    ).rejects.toThrow("--ignore-terminal-labels is only allowed");
  });

  it("excludes prior generated OneShot artifacts from source evidence", () => {
    expect(
      isGeneratedDocumentationArtifactForTest(
        "CPDEV-21801-troubleshooting.md",
        [
          "# Troubleshooting and support Documentation",
          "",
          "Template: Troubleshooting Guide Template (Confluence page 3054699051, version 10)",
          "Document type: DOC-TYPE-TROUBLESHOOTING",
          "Dry-run source: [CPDEV-21801](https://mhkjira.atlassian.net/browse/CPDEV-21801)",
          "Generated at: 2026-05-28T18:39:07.382Z",
          "",
          "## Problem",
          "<cause not found in reviewed evidence>",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(
      isGeneratedDocumentationArtifactForTest(
        "CPDEV-21801-jira-summary.md",
        "# OneShot Documentation Dry Run Summary\n\nDocument type: DOC-TYPE-TROUBLESHOOTING",
      ),
    ).toBe(true);
    // Current (post-rename) markers must be recognized too.
    expect(
      isGeneratedDocumentationArtifactForTest(
        "CPDEV-21801-troubleshooting.md",
        [
          "# Troubleshooting and support Documentation",
          "",
          "Template: Troubleshooting Guide Template (Confluence page 3054699051, version 10)",
          "Document type: DOC-TYPE-TROUBLESHOOTING",
          "Source: [CPDEV-21801](https://mhkjira.atlassian.net/browse/CPDEV-21801)",
          "Generated at: 2026-05-28T18:39:07.382Z",
          "",
          "## Problem",
          "<cause not found in reviewed evidence>",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(
      isGeneratedDocumentationArtifactForTest(
        "CPDEV-21801-jira-summary.md",
        "# OneShot Documentation Generation Summary\n\nDocument type: DOC-TYPE-TROUBLESHOOTING",
      ),
    ).toBe(true);
    expect(
      isGeneratedDocumentationArtifactForTest(
        "CPDEV-21801-summary.json",
        '{ "target": { "key": "CPDEV-21801" } }',
      ),
    ).toBe(true);
    expect(
      isGeneratedDocumentationArtifactForTest(
        "support-troubleshooting-notes.md",
        [
          "# Troubleshooting Notes",
          "",
          "## Problem",
          "Continue Review procedure selection does not call the PA List engine.",
          "",
          "## Cause",
          "Procedure state was not forwarded to the PA List request.",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("withholds the terminal DOCS-GENERATED label when human review is required", () => {
    expect(
      shouldApplyGeneratedLabelForTest({
        humanReviewRequired: true,
        readiness: "review_required",
        reasons: ["One or more template fields could not be filled."],
        recommendedJiraSummary: "draft generated; human review required.",
        recommendedNextAction: "Review before applying a terminal label.",
      }),
    ).toBe(false);
  });

  it("applies the terminal DOCS-GENERATED label when no review gaps remain", () => {
    expect(
      shouldApplyGeneratedLabelForTest({
        humanReviewRequired: false,
        readiness: "ready_for_publish_review",
        reasons: [],
        recommendedJiraSummary: "draft generated; no gaps found.",
        recommendedNextAction: "Proceed with the normal publish flow.",
      }),
    ).toBe(true);
  });

  it("separates attached and skipped Jira artifact filenames in attachment comments", () => {
    const context: DocumentationDryRunContext = {
      target: issue({
        key: "CPDEV-21801",
        summary: "Concurrent review troubleshooting",
        labels: ["DOCS-GENERATE", "DOC-TYPE-TROUBLESHOOTING"],
      }),
      documentationStory: issue({
        key: "CPDEV-21597",
        summary: "CPDEV 15669 Documentation",
      }),
      epic: null,
      epicChildren: [],
      subtaskIssues: [],
      template: template("DOC-TYPE-TROUBLESHOOTING"),
      gaps: [],
    };
    const output = {
      reviewSummary: {
        humanReviewRequired: false,
        reasons: [],
        recommendedJiraSummary: "Ready for documentation review.",
        recommendedNextAction: "Attach artifacts.",
      },
    } as never;

    const comment = renderJiraAttachmentCommentForTest(context, output, {
      attachedFilenames: ["CPDEV-21801-troubleshooting.md"],
      skippedFilenames: ["CPDEV-21801-summary.json"],
    });

    expect(comment).toContain("Attached files:");
    expect(comment).toContain("- CPDEV-21801-troubleshooting.md");
    expect(comment).toContain("Skipped files:");
    expect(comment).toContain("- CPDEV-21801-summary.json");
  });

  it("tells reviewers the ticket moved to DOCS-BLOCKED and how to regenerate when review is required", () => {
    const context: DocumentationDryRunContext = {
      target: issue({
        key: "CPDEV-21801",
        summary: "Concurrent review troubleshooting",
        labels: ["DOCS-GENERATE", "DOC-TYPE-TROUBLESHOOTING"],
      }),
      documentationStory: issue({ key: "CPDEV-21597" }),
      epic: null,
      epicChildren: [],
      subtaskIssues: [],
      template: template("DOC-TYPE-TROUBLESHOOTING"),
      gaps: [],
    };
    const output = {
      reviewSummary: {
        humanReviewRequired: true,
        reasons: ["Rollback procedure evidence was not found."],
        recommendedJiraSummary: "draft generated; human review required.",
        recommendedNextAction: "Resolve gaps then add DOCS-REPLAN.",
      },
    } as never;

    const comment = renderJiraAttachmentCommentForTest(context, output, {
      attachedFilenames: ["CPDEV-21801-troubleshooting.md"],
      skippedFilenames: [],
    });

    expect(comment).toContain("DOCS-BLOCKED");
    expect(comment).toContain("DOCS-IN-PROGRESS was removed");
    expect(comment).toContain("DOCS-REPLAN");
  });

  it("does not add DOCS-BLOCKED regeneration guidance when no review is required", () => {
    const context: DocumentationDryRunContext = {
      target: issue({
        key: "CPDEV-21801",
        labels: ["DOCS-GENERATE", "DOC-TYPE-TROUBLESHOOTING"],
      }),
      documentationStory: issue({ key: "CPDEV-21597" }),
      epic: null,
      epicChildren: [],
      subtaskIssues: [],
      template: template("DOC-TYPE-TROUBLESHOOTING"),
      gaps: [],
    };
    const output = {
      reviewSummary: {
        humanReviewRequired: false,
        reasons: [],
        recommendedJiraSummary: "Ready for documentation review.",
        recommendedNextAction: "Attach artifacts.",
      },
    } as never;

    const comment = renderJiraAttachmentCommentForTest(context, output, {
      attachedFilenames: ["CPDEV-21801-troubleshooting.md"],
      skippedFilenames: [],
    });

    expect(comment).not.toContain("DOCS-BLOCKED");
    expect(comment).not.toContain("DOCS-REPLAN");
  });
});

describe("documentation synthesis safety wiring", () => {
  function contextWithEvidence(): DocumentationDryRunContext {
    return {
      target: issue({
        key: "CPDEV-40001",
        summary: "Config toggle",
        labels: ["DOCS-GENERATE", "DOC-TYPE-CONFIG"],
        descriptionMarkdown: "Adds a configuration toggle for the widget.",
        comments: [
          {
            id: "9001",
            author: "alice",
            created: "2026-06-01T00:00:00.000Z",
            bodyMarkdown: "Toggle defaults to off.",
          },
        ],
        attachmentTexts: [
          { filename: "settings.png.txt", content: "Screenshot text." },
        ],
      }),
      documentationStory: issue({ key: "CPDEV-40000" }),
      epic: null,
      epicChildren: [],
      subtaskIssues: [],
      template: template("DOC-TYPE-CONFIG"),
      gaps: [],
    };
  }

  it("mints stable, provenance-bearing evidence block ids", () => {
    const blocks = buildEvidenceBlocksForTest(contextWithEvidence());
    const ids = blocks.map((block) => block.id);
    expect(ids).toContain("ISSUE-CPDEV-40001");
    expect(ids).toContain("COMMENT-CPDEV-40001-9001");
    expect(ids).toContain("ATTACHMENT-CPDEV-40001-settings.png.txt");
    // The comment block carries author provenance in its label.
    const comment = blocks.find((b) => b.id === "COMMENT-CPDEV-40001-9001");
    expect(comment?.label).toContain("alice");
  });

  it("forces human review when synthesis supplies extra review reasons", () => {
    const context = contextWithEvidence();
    // A document whose prose looks complete (no deterministic gap phrases)
    // must still be routed to review when synthesis validation objects.
    const cleanMarkdown = "# Config\n\n## Overview\n\nConfident prose.\n";
    const withoutReasons = buildHumanReviewSummaryForTest(
      context,
      cleanMarkdown,
    );
    const withReasons = buildHumanReviewSummaryForTest(context, cleanMarkdown, [
      "Model reported an unsupported claim: invented config key.",
    ]);

    expect(withoutReasons.humanReviewRequired).toBe(false);
    expect(withReasons.humanReviewRequired).toBe(true);
    expect(withReasons.reasons).toContain(
      "Model reported an unsupported claim: invented config key.",
    );
    expect(shouldApplyGeneratedLabelForTest(withReasons)).toBe(false);
  });
});
