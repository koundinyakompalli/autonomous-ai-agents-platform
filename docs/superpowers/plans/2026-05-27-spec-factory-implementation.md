# Spec Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Louise-first Spec Factory MVP: a new ECS-backed service and a Dashboard page that convert Louise-estimated Jira tickets into previewable Epic bundles, create Jira Epics and child Story/Task tickets on approval, and submit child tickets to OneShot on explicit operator action.

**Architecture:** Add a standalone `src/spec-factory` TypeScript service with an Express API, MySQL persistence, Jira integration through the existing `JiraClient`, a mockable Claude SDK draft generator, and explicit approval/submission state machines. Add a `/spec-factory` Dashboard route whose Louise board fetches `/api/spec-factory/*`; in production the existing Dashboard ALB routes that path to the new Spec Factory ECS service, while local Vite proxies it to the local service port.

**Repository grounding:** Spec Factory owns a dedicated EFS-backed repo area parallel to OneShot and the Specter agents. It inspects `master` for every involved repository, falling back to `main` only when `master` is missing. Louise LOE/code/config attachments are treated as evidence and hints, but draft generation must also use independently collected current-code context before writing OneShot-ready child requirements.

**Tech Stack:** Node 20, TypeScript, Express, MySQL, Zod, Claude Agent SDK through existing `runAgent`, Jira Cloud REST through existing `JiraClient`, React 18, Vite, Vitest, Testing Library, Terraform ECS/Fargate.

---

## File Structure

- Create `db/migrations/032_spec_factory.sql`
  - Adds durable source, draft, child-ticket, and event tables.
- Modify `db/schema.sql`
  - Mirrors migration DDL for fresh local databases.
- Create `src/spec-factory/types.ts`
  - Owns domain states, DTOs, Zod draft schema, and API response types.
- Create `src/spec-factory/renderers.ts`
  - Renders Epic and child Story/Task descriptions in OneShot-ready Markdown.
- Create `src/spec-factory/draft-validator.ts`
  - Validates generated bundles before preview or approval.
- Create `src/spec-factory/draft-validator.test.ts`
  - Covers required child Story/Task structure and warnings.
- Create `src/spec-factory/database.ts`
  - Owns MySQL access, state transitions, idempotency lookups, and mapping rows to DTOs.
- Create `src/spec-factory/database.test.ts`
  - Tests SQL sequencing with mocked pool queries.
- Create `src/spec-factory/evidence.ts`
  - Builds evidence manifests from `JiraClient.fetchTicketData()`.
- Create `src/spec-factory/evidence.test.ts`
  - Tests LOE hours and artifact extraction from descriptions, comments, and attachments.
- Create `src/spec-factory/candidate-ingestor.ts`
  - Runs the Louise JQL, fetches Jira ticket data, and upserts candidate source rows.
- Create `src/spec-factory/candidate-ingestor.test.ts`
  - Tests candidate refresh and submitted-ticket filtering.
- Create `src/spec-factory/draft-generator.ts`
  - Calls `runAgent` with a strict output schema and returns validated draft bundles.
- Create `src/spec-factory/draft-generator.test.ts`
  - Tests structured output parsing and failure handling with a mocked agent runner.
- Create `src/spec-factory/repo-workspace.ts`
  - Manages the Spec Factory EFS repo cache and per-source `master` or `main` branch workspaces.
- Create `src/spec-factory/repo-workspace.test.ts`
  - Tests clone/fetch/worktree behavior with mocked filesystem/git adapters.
- Create `src/spec-factory/repo-context.ts`
  - Extracts repo and file hints from evidence, inspects current `master` or `main`, and builds compact grounding context.
- Create `src/spec-factory/repo-context.test.ts`
  - Tests repo-hint extraction, master/main branch enforcement, and draft-generator prompt context.
- Create `src/spec-factory/jira-publisher.ts`
  - Creates Epics and child Story/Task tickets idempotently through `JiraClient.createIssue()`.
- Create `src/spec-factory/oneshot-submitter.ts`
  - Adds `PFOS` labels and creates OneShot dashboard run requests when supported.
- Create `src/spec-factory/service.ts`
  - Coordinates refresh, draft generation, approval, OneShot submission, and read models.
- Create `src/spec-factory/routes.ts`
  - Exposes Express route handlers for the Spec Factory API.
- Create `src/spec-factory/server.ts`
  - Builds the Express app and health endpoints.
- Create `src/spec-factory/main.ts`
  - Starts the service on `SPEC_FACTORY_PORT` or port `3012`.
- Create `src/spec-factory/routes.test.ts`
  - Tests route status codes and handler wiring with mocked service methods.
- Modify `package.json`
  - Adds `spec-factory`, `spec-factory:dev`, and test-friendly scripts.
- Create `Dockerfile.spec-factory`
  - Builds the standalone service container from the compiled root `dist`.
- Create `dashboard/src/spec-factory/types.ts`
  - Frontend DTOs matching the API response shape.
- Create `dashboard/src/spec-factory/api.ts`
  - Frontend fetch helpers.
- Create `dashboard/src/spec-factory/SpecFactoryPage.tsx`
  - Renders side nav, Louise board, notebook panel, and OneShot submitted-work view.
- Create `dashboard/src/spec-factory/SpecFactoryPage.css`
  - Owns operational page layout, sticky cards, notebook pages, and responsive behavior.
- Create `dashboard/src/spec-factory/SpecFactoryPage.test.tsx`
  - Covers board rendering, notebook selection, approve/submit disabled states, and submitted item visibility.
- Modify `dashboard/src/App.tsx`
  - Adds `/spec-factory` route support.
- Modify `dashboard/src/App.test.tsx`
  - Adds route and nav coverage for Spec Factory.
- Modify `dashboard/src/components/DashboardNav.tsx`
  - Adds the `Spec Factory` top-level nav item.
- Modify `dashboard/vite.config.ts`
  - Proxies `/api/spec-factory` to `VITE_SPEC_FACTORY_API_PROXY_TARGET || http://localhost:3012`.
- Create `terraform/spec-factory-ecs.tf`
  - Adds ECR repository, log group, ECS task/service, target group, listener rule, security group, RDS ingress rule, and outputs.
- Modify `terraform/variables.tf`
  - Adds Spec Factory sizing, desired count, JQL, and model variables.
- Modify `terraform/shared.auto.tfvars`
  - Enables the sandbox Louise JQL defaults.
- Modify `terraform/terraform.tfvars.example`
  - Documents Spec Factory variables.

---

### Task 1: Database Schema And Shared Domain Types

**Files:**
- Create: `db/migrations/032_spec_factory.sql`
- Modify: `db/schema.sql`
- Create: `src/spec-factory/types.ts`
- Create: `src/spec-factory/renderers.ts`
- Create: `src/spec-factory/draft-validator.ts`
- Create: `src/spec-factory/draft-validator.test.ts`

- [ ] **Step 1: Write failing draft validation tests**

Create `src/spec-factory/draft-validator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateDraftBundle } from "./draft-validator.js";
import type { SpecFactoryDraftBundle } from "./types.js";

function validBundle(overrides: Partial<SpecFactoryDraftBundle> = {}): SpecFactoryDraftBundle {
  return {
    sourceJiraKey: "CPDEV-22410",
    loeHours: 38,
    epic: {
      summary: "Automate enrollment sync validation for Client A",
      description: "Client A needs repeatable validation for enrollment sync rules.",
      businessContext: ["Louise estimated this as a cross-repo delivery item."],
      acceptanceCriteria: ["Generated child tickets cover each repo-specific change."],
      assumptions: ["Default branch is used unless the source ticket names a branch."],
      dependencies: ["Config rollout depends on backend validation behavior."],
    },
    childTickets: [
      {
        repoName: "core-app",
        summary: "[core-app] Add enrollment sync validation",
        overview: "Implement backend validation for enrollment sync rules.",
        acceptanceCriteria: [
          "The service rejects enrollment sync payloads that violate Client A rules.",
          "Existing enrollment sync behavior remains unchanged for other clients.",
        ],
        technicalDetails: {
          repo: "core-app",
          branch: "master",
          targetFiles: ["service/EnrollmentSyncValidator.java"],
          implementationNotes: ["Use the existing validation service entry point."],
        },
        outOfScope: ["Do not change UI behavior."],
        testingNotes: ["Run enrollment sync unit tests."],
        loeHours: 20,
        sourceEvidenceRefs: ["attachment:loe-estimate.md"],
      },
    ],
    evidenceSummary: ["loe-estimate.md indicates 38 total hours."],
    warnings: [],
    ...overrides,
  };
}

describe("validateDraftBundle", () => {
  it("accepts a OneShot-ready child ticket with repo and acceptance criteria", () => {
    const result = validateDraftBundle(validBundle());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.normalized.childTickets[0].technicalDetails.repo).toBe("core-app");
  });

  it("rejects child tickets without a repo directive", () => {
    const bundle = validBundle({
      childTickets: [
        {
          ...validBundle().childTickets[0],
          technicalDetails: {
            ...validBundle().childTickets[0].technicalDetails,
            repo: "",
          },
        },
      ],
    });

    const result = validateDraftBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("childTickets[0].technicalDetails.repo is required");
  });

  it("rejects child tickets with fewer than two acceptance criteria", () => {
    const bundle = validBundle({
      childTickets: [
        {
          ...validBundle().childTickets[0],
          acceptanceCriteria: ["Only one criterion"],
        },
      ],
    });

    const result = validateDraftBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("childTickets[0].acceptanceCriteria must contain at least 2 items");
  });
});
```

- [ ] **Step 2: Run the failing validator tests**

Run:

```bash
npm test -- src/spec-factory/draft-validator.test.ts
```

Expected: FAIL because `src/spec-factory/draft-validator.ts` and `src/spec-factory/types.ts` do not exist.

- [ ] **Step 3: Add migration DDL**

Create `db/migrations/032_spec_factory.sql`:

```sql
-- Migration 032: Spec Factory Louise-to-OneShot workflow.

CREATE TABLE IF NOT EXISTS spec_factory_sources (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_jira_key     VARCHAR(50)  NOT NULL,
  source_summary      VARCHAR(255) NOT NULL,
  source_status       VARCHAR(100) NULL,
  source_labels_json  JSON         NULL,
  loe_hours           DECIMAL(8,2) NULL,
  state               ENUM('candidate','drafting','draft_ready','approved','oneshot_submitted','needs_attention','archived') NOT NULL DEFAULT 'candidate',
  approved_epic_key   VARCHAR(50)  NULL,
  last_seen_at        TIMESTAMP(3) NULL,
  submitted_at        TIMESTAMP(3) NULL,
  error_message       TEXT         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_spec_factory_source_key (source_jira_key),
  INDEX idx_spec_factory_sources_state_updated (state, updated_at, id),
  INDEX idx_spec_factory_sources_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_drafts (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id              BIGINT      NOT NULL,
  version                INT         NOT NULL,
  status                 ENUM('generating','ready','approved','superseded','failed') NOT NULL DEFAULT 'generating',
  draft_json             JSON        NULL,
  rendered_markdown      MEDIUMTEXT  NULL,
  evidence_manifest_json JSON        NULL,
  model_metadata_json    JSON        NULL,
  approved_by            VARCHAR(255) NULL,
  approved_at            TIMESTAMP(3) NULL,
  error_message          TEXT        NULL,
  created_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_drafts_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uk_spec_factory_draft_version (source_id, version),
  INDEX idx_spec_factory_drafts_source_status (source_id, status, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_child_tickets (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id           BIGINT       NOT NULL,
  draft_id            BIGINT       NOT NULL,
  repo_id             INT          NULL,
  repo_name           VARCHAR(255) NOT NULL,
  summary             VARCHAR(255) NOT NULL,
  description         MEDIUMTEXT   NOT NULL,
  loe_hours           DECIMAL(8,2) NULL,
  jira_key            VARCHAR(50)  NULL,
  state               ENUM('draft','created','pfos_labeled','oneshot_requested','oneshot_running','oneshot_terminal','failed') NOT NULL DEFAULT 'draft',
  oneshot_request_id  BIGINT       NULL,
  oneshot_run_id      BIGINT       NULL,
  error_message       TEXT         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_child_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  CONSTRAINT fk_spec_factory_child_draft
    FOREIGN KEY (draft_id) REFERENCES spec_factory_drafts(id),
  UNIQUE KEY uk_spec_factory_child_repo (draft_id, repo_name),
  UNIQUE KEY uk_spec_factory_child_jira (jira_key),
  INDEX idx_spec_factory_child_source_state (source_id, state),
  INDEX idx_spec_factory_child_oneshot_request (oneshot_request_id),
  INDEX idx_spec_factory_child_oneshot_run (oneshot_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_events (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id      BIGINT       NOT NULL,
  event_type     VARCHAR(80)  NOT NULL,
  actor          VARCHAR(255) NULL,
  metadata_json  JSON         NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_events_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  INDEX idx_spec_factory_events_source_time (source_id, created_at, id),
  INDEX idx_spec_factory_events_type_time (event_type, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Add the same table definitions to `db/schema.sql` after the OneShot dashboard/run request tables so a fresh schema contains Spec Factory.

- [ ] **Step 4: Add domain types and Zod schema**

Create `src/spec-factory/types.ts`:

```ts
import { z } from "zod";

export const SPEC_FACTORY_LABEL = "SPEC-FACTORY";
export const SPEC_FACTORY_GENERATED_LABEL = "SPEC-FACTORY-GENERATED";
export const LOUISE_ESTIMATED_LABEL = "louise-estimated";
export const PFOS_LABEL = "PFOS";

export const SPEC_FACTORY_LOUISE_JQL =
  process.env.SPEC_FACTORY_LOUISE_JQL || 'labels = "louise-estimated" ORDER BY updated DESC';

export const SourceStateSchema = z.enum([
  "candidate",
  "drafting",
  "draft_ready",
  "approved",
  "oneshot_submitted",
  "needs_attention",
  "archived",
]);

export const DraftStatusSchema = z.enum([
  "generating",
  "ready",
  "approved",
  "superseded",
  "failed",
]);

export const ChildTicketStateSchema = z.enum([
  "draft",
  "created",
  "pfos_labeled",
  "oneshot_requested",
  "oneshot_running",
  "oneshot_terminal",
  "failed",
]);

export type SourceState = z.infer<typeof SourceStateSchema>;
export type DraftStatus = z.infer<typeof DraftStatusSchema>;
export type ChildTicketState = z.infer<typeof ChildTicketStateSchema>;

export const SpecFactoryChildTicketDraftSchema = z.object({
  repoName: z.string().trim().min(1),
  repoId: z.number().int().positive().optional(),
  summary: z.string().trim().min(1),
  overview: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(2),
  technicalDetails: z.object({
    repo: z.string().trim().min(1),
    branch: z.string().trim().min(1).optional(),
    targetFiles: z.array(z.string().trim().min(1)).default([]),
    implementationNotes: z.array(z.string().trim().min(1)).min(1),
  }),
  outOfScope: z.array(z.string().trim().min(1)).default([]),
  testingNotes: z.array(z.string().trim().min(1)).default([]),
  loeHours: z.number().nonnegative().optional(),
  sourceEvidenceRefs: z.array(z.string().trim().min(1)).default([]),
});

export const SpecFactoryDraftBundleSchema = z.object({
  sourceJiraKey: z.string().trim().regex(/^[A-Z][A-Z0-9]+-\d+$/),
  loeHours: z.number().nonnegative().optional(),
  epic: z.object({
    summary: z.string().trim().min(1),
    description: z.string().trim().min(1),
    businessContext: z.array(z.string().trim().min(1)).min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    assumptions: z.array(z.string().trim().min(1)).default([]),
    dependencies: z.array(z.string().trim().min(1)).default([]),
  }),
  childTickets: z.array(SpecFactoryChildTicketDraftSchema).min(1),
  evidenceSummary: z.array(z.string().trim().min(1)).default([]),
  warnings: z.array(z.string().trim().min(1)).default([]),
});

export type SpecFactoryDraftBundle = z.infer<typeof SpecFactoryDraftBundleSchema>;
export type SpecFactoryChildTicketDraft = z.infer<typeof SpecFactoryChildTicketDraftSchema>;

export interface SpecFactorySourceSummary {
  id: number;
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  loeHours: number | null;
  state: SourceState;
  approvedEpicKey: string | null;
  updatedAt: string;
}

export interface SpecFactoryChildTicketSummary {
  id: number;
  repoName: string;
  summary: string;
  loeHours: number | null;
  jiraKey: string | null;
  state: ChildTicketState;
  oneshotRequestId: number | null;
  oneshotRunId: number | null;
  errorMessage: string | null;
}

export interface SpecFactoryDraftDetail {
  id: number;
  sourceId: number;
  version: number;
  status: DraftStatus;
  draft: SpecFactoryDraftBundle | null;
  renderedMarkdown: string | null;
  evidenceManifest: unknown;
  childTickets: SpecFactoryChildTicketSummary[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 5: Add renderers**

Create `src/spec-factory/renderers.ts`:

```ts
import type {
  SpecFactoryChildTicketDraft,
  SpecFactoryDraftBundle,
} from "./types.js";

function bullet(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

export function renderEpicDescription(bundle: SpecFactoryDraftBundle): string {
  return [
    "## Summary",
    bundle.epic.description,
    "",
    "## Business Context",
    bullet(bundle.epic.businessContext),
    "",
    "## Acceptance Summary",
    bullet(bundle.epic.acceptanceCriteria),
    "",
    "## Dependencies",
    bullet(bundle.epic.dependencies),
    "",
    "## Assumptions",
    bullet(bundle.epic.assumptions),
    "",
    "## Source Evidence",
    bullet(bundle.evidenceSummary),
    "",
    `Generated from ${bundle.sourceJiraKey} by Spec Factory.`,
  ].join("\n");
}

export function renderChildTicketDescription(ticket: SpecFactoryChildTicketDraft): string {
  const details = [
    `Repo: ${ticket.technicalDetails.repo}`,
    ticket.technicalDetails.branch ? `Branch: ${ticket.technicalDetails.branch}` : null,
    ticket.technicalDetails.targetFiles.length
      ? ["Target Files:", bullet(ticket.technicalDetails.targetFiles)].join("\n")
      : null,
    "Implementation Notes:",
    bullet(ticket.technicalDetails.implementationNotes),
  ].filter(Boolean);

  return [
    "## Summary",
    ticket.summary,
    "",
    "## LOE Estimate",
    ticket.loeHours == null ? "Not provided" : `${ticket.loeHours} hours`,
    "",
    "## Overview",
    ticket.overview,
    "",
    "## Acceptance Criteria",
    bullet(ticket.acceptanceCriteria),
    "",
    "## Technical Details",
    details.join("\n"),
    "",
    "## Out of Scope",
    bullet(ticket.outOfScope),
    "",
    "## Testing Notes",
    bullet(ticket.testingNotes),
    "",
    "## Source Evidence",
    bullet(ticket.sourceEvidenceRefs),
  ].join("\n");
}

export function renderDraftMarkdown(bundle: SpecFactoryDraftBundle): string {
  const childSections = bundle.childTickets.map((ticket, index) =>
    [
      `# Child Story ${index + 1}: ${ticket.repoName}`,
      "",
      renderChildTicketDescription(ticket),
    ].join("\n"),
  );

  return [
    `# Epic: ${bundle.epic.summary}`,
    "",
    renderEpicDescription(bundle),
    "",
    ...childSections,
  ].join("\n\n---\n\n");
}
```

- [ ] **Step 6: Add validator implementation**

Create `src/spec-factory/draft-validator.ts`:

```ts
import {
  SpecFactoryDraftBundleSchema,
  type SpecFactoryDraftBundle,
} from "./types.js";

export interface DraftValidationResult {
  valid: boolean;
  normalized: SpecFactoryDraftBundle;
  errors: string[];
  warnings: string[];
}

export function validateDraftBundle(input: unknown): DraftValidationResult {
  const parsed = SpecFactoryDraftBundleSchema.safeParse(input);
  if (!parsed.success) {
    const fallback = input as SpecFactoryDraftBundle;
    return {
      valid: false,
      normalized: fallback,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`.trim()),
      warnings: [],
    };
  }

  const errors: string[] = [];
  const warnings = [...parsed.data.warnings];

  parsed.data.childTickets.forEach((ticket, index) => {
    if (!ticket.technicalDetails.repo.trim()) {
      errors.push(`childTickets[${index}].technicalDetails.repo is required`);
    }
    if (ticket.acceptanceCriteria.length < 2) {
      errors.push(`childTickets[${index}].acceptanceCriteria must contain at least 2 items`);
    }
    if (ticket.technicalDetails.repo !== ticket.repoName) {
      warnings.push(`childTickets[${index}] repoName differs from technicalDetails.repo`);
    }
  });

  const repoNames = new Set<string>();
  parsed.data.childTickets.forEach((ticket, index) => {
    const normalizedRepo = ticket.repoName.trim().toLowerCase();
    if (repoNames.has(normalizedRepo)) {
      errors.push(`childTickets[${index}].repoName duplicates another child ticket`);
    }
    repoNames.add(normalizedRepo);
  });

  return {
    valid: errors.length === 0,
    normalized: parsed.data,
    errors,
    warnings,
  };
}
```

- [ ] **Step 7: Run validator tests**

Run:

```bash
npm test -- src/spec-factory/draft-validator.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit schema and domain checkpoint**

```bash
git add db/migrations/032_spec_factory.sql db/schema.sql src/spec-factory/types.ts src/spec-factory/renderers.ts src/spec-factory/draft-validator.ts src/spec-factory/draft-validator.test.ts
git commit -m "Add Spec Factory schema and draft validation"
```

---

### Task 2: Persistence Layer And Read Models

**Files:**
- Create: `src/spec-factory/database.ts`
- Create: `src/spec-factory/database.test.ts`

- [ ] **Step 1: Write failing database tests**

Create `src/spec-factory/database.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpecFactoryRepository } from "./database.js";

const queryMock = vi.fn();

function repository() {
  return new SpecFactoryRepository({
    query: queryMock,
    execute: queryMock,
    getConnection: vi.fn(),
  } as any);
}

describe("SpecFactoryRepository", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("upserts a Louise source without downgrading a submitted source", async () => {
    queryMock.mockResolvedValueOnce([{ insertId: 12 }]);

    await repository().upsertSource({
      sourceJiraKey: "CPDEV-22410",
      sourceSummary: "Enrollment sync rules",
      sourceStatus: "In Progress",
      sourceLabels: ["louise-estimated"],
      loeHours: 38,
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("ON DUPLICATE KEY UPDATE"),
      expect.arrayContaining(["CPDEV-22410", "Enrollment sync rules", "In Progress"]),
    );
    expect(queryMock.mock.calls[0][0]).toContain("state = IF(state = 'oneshot_submitted', state, state)");
  });

  it("maps Louise board rows into source summaries", async () => {
    queryMock.mockResolvedValueOnce([[
      {
        id: 12,
        source_jira_key: "CPDEV-22410",
        source_summary: "Enrollment sync rules",
        source_status: "In Progress",
        loe_hours: "38.00",
        state: "draft_ready",
        approved_epic_key: null,
        updated_at: new Date("2026-05-27T12:00:00Z"),
      },
    ]]);

    await expect(repository().listLouiseBoardSources()).resolves.toEqual([
      {
        id: 12,
        sourceJiraKey: "CPDEV-22410",
        sourceSummary: "Enrollment sync rules",
        sourceStatus: "In Progress",
        loeHours: 38,
        state: "draft_ready",
        approvedEpicKey: null,
        updatedAt: "2026-05-27T12:00:00.000Z",
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the failing database tests**

Run:

```bash
npm test -- src/spec-factory/database.test.ts
```

Expected: FAIL because `src/spec-factory/database.ts` does not exist.

- [ ] **Step 3: Add repository implementation**

Create `src/spec-factory/database.ts`:

```ts
import type mysql from "mysql2/promise";
import { getDatabase } from "../orchestrator/database.js";
import type {
  SpecFactoryDraftBundle,
  SpecFactoryDraftDetail,
  SpecFactorySourceSummary,
} from "./types.js";

type PoolLike = Pick<mysql.Pool, "query" | "execute" | "getConnection">;

interface SourceRow extends mysql.RowDataPacket {
  id: number;
  source_jira_key: string;
  source_summary: string;
  source_status: string | null;
  loe_hours: string | number | null;
  state: SpecFactorySourceSummary["state"];
  approved_epic_key: string | null;
  updated_at: Date | string;
}

interface DraftRow extends mysql.RowDataPacket {
  id: number;
  source_id: number;
  version: number;
  status: SpecFactoryDraftDetail["status"];
  draft_json: string | SpecFactoryDraftBundle | null;
  rendered_markdown: string | null;
  evidence_manifest_json: string | unknown | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ChildRow extends mysql.RowDataPacket {
  id: number;
  repo_name: string;
  summary: string;
  loe_hours: string | number | null;
  jira_key: string | null;
  state: string;
  oneshot_request_id: number | null;
  oneshot_run_id: number | null;
  error_message: string | null;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mapSource(row: SourceRow): SpecFactorySourceSummary {
  return {
    id: row.id,
    sourceJiraKey: row.source_jira_key,
    sourceSummary: row.source_summary,
    sourceStatus: row.source_status,
    loeHours: numberOrNull(row.loe_hours),
    state: row.state,
    approvedEpicKey: row.approved_epic_key,
    updatedAt: toIso(row.updated_at),
  };
}

function parseJson<T>(value: string | T | null): T | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

export interface UpsertSourceInput {
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  sourceLabels: string[];
  loeHours: number | null;
}

export class SpecFactoryRepository {
  constructor(private readonly pool: PoolLike = getDatabase().getPool()) {}

  async upsertSource(input: UpsertSourceInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO spec_factory_sources
       (source_jira_key, source_summary, source_status, source_labels_json, loe_hours, state, last_seen_at)
       VALUES (?, ?, ?, CAST(? AS JSON), ?, 'candidate', CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         source_summary = VALUES(source_summary),
         source_status = VALUES(source_status),
         source_labels_json = VALUES(source_labels_json),
         loe_hours = VALUES(loe_hours),
         state = IF(state = 'oneshot_submitted', state, state),
         last_seen_at = CURRENT_TIMESTAMP(3),
         error_message = NULL`,
      [
        input.sourceJiraKey,
        input.sourceSummary,
        input.sourceStatus,
        JSON.stringify(input.sourceLabels),
        input.loeHours,
      ],
    );
  }

  async listLouiseBoardSources(): Promise<SpecFactorySourceSummary[]> {
    const [rows] = await this.pool.query<SourceRow[]>(
      `SELECT id, source_jira_key, source_summary, source_status, loe_hours,
              state, approved_epic_key, updated_at
       FROM spec_factory_sources
       WHERE state <> 'oneshot_submitted'
       ORDER BY updated_at DESC, id DESC
       LIMIT 200`,
    );
    return rows.map(mapSource);
  }

  async createDraft(input: {
    sourceId: number;
    version: number;
    bundle: SpecFactoryDraftBundle;
    renderedMarkdown: string;
    evidenceManifest: unknown;
    modelMetadata: unknown;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO spec_factory_drafts
       (source_id, version, status, draft_json, rendered_markdown, evidence_manifest_json, model_metadata_json)
       VALUES (?, ?, 'ready', CAST(? AS JSON), ?, CAST(? AS JSON), CAST(? AS JSON))`,
      [
        input.sourceId,
        input.version,
        JSON.stringify(input.bundle),
        input.renderedMarkdown,
        JSON.stringify(input.evidenceManifest),
        JSON.stringify(input.modelMetadata),
      ],
    );
    await this.pool.query(
      `UPDATE spec_factory_sources
       SET state = 'draft_ready', error_message = NULL
       WHERE id = ?`,
      [input.sourceId],
    );
    return result.insertId;
  }

  async getLatestDraft(sourceId: number): Promise<SpecFactoryDraftDetail | null> {
    const [draftRows] = await this.pool.query<DraftRow[]>(
      `SELECT *
       FROM spec_factory_drafts
       WHERE source_id = ?
       ORDER BY version DESC
       LIMIT 1`,
      [sourceId],
    );
    const draft = draftRows[0];
    if (!draft) return null;

    const [childRows] = await this.pool.query<ChildRow[]>(
      `SELECT *
       FROM spec_factory_child_tickets
       WHERE draft_id = ?
       ORDER BY id ASC`,
      [draft.id],
    );

    return {
      id: draft.id,
      sourceId: draft.source_id,
      version: draft.version,
      status: draft.status,
      draft: parseJson<SpecFactoryDraftBundle>(draft.draft_json),
      renderedMarkdown: draft.rendered_markdown,
      evidenceManifest: parseJson<unknown>(draft.evidence_manifest_json),
      childTickets: childRows.map((child) => ({
        id: child.id,
        repoName: child.repo_name,
        summary: child.summary,
        loeHours: numberOrNull(child.loe_hours),
        jiraKey: child.jira_key,
        state: child.state as any,
        oneshotRequestId: child.oneshot_request_id,
        oneshotRunId: child.oneshot_run_id,
        errorMessage: child.error_message,
      })),
      errorMessage: draft.error_message,
      createdAt: toIso(draft.created_at),
      updatedAt: toIso(draft.updated_at),
    };
  }
}
```

- [ ] **Step 4: Run database tests**

Run:

```bash
npm test -- src/spec-factory/database.test.ts
```

Expected: PASS for `upsertSource` and board-row mapping.

- [ ] **Step 5: Commit persistence checkpoint**

```bash
git add src/spec-factory/database.ts src/spec-factory/database.test.ts
git commit -m "Add Spec Factory persistence repository"
```

---

### Task 3: Evidence Collection And Louise Candidate Ingestion

**Files:**
- Create: `src/spec-factory/evidence.ts`
- Create: `src/spec-factory/evidence.test.ts`
- Create: `src/spec-factory/candidate-ingestor.ts`
- Create: `src/spec-factory/candidate-ingestor.test.ts`

- [ ] **Step 1: Write failing evidence tests**

Create `src/spec-factory/evidence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEvidenceManifest, extractLoeHours } from "./evidence.js";

describe("Spec Factory evidence extraction", () => {
  it("extracts LOE hours from Louise estimate text", () => {
    expect(extractLoeHours("Total LOE: 38 hours")).toBe(38);
    expect(extractLoeHours("Estimated effort - 21.5h")).toBe(21.5);
  });

  it("builds an evidence manifest from comments and attachments", () => {
    const manifest = buildEvidenceManifest({
      issue: {
        key: "CPDEV-22410",
        fields: {
          summary: "Enrollment sync rules",
          status: { name: "In Progress" },
          labels: ["louise-estimated"],
          attachment: [],
        },
      } as any,
      descriptionMarkdown: "Raw requirement body",
      comments: [
        {
          id: "c1",
          author: "Louise",
          created: "2026-05-27T12:00:00.000Z",
          bodyMarkdown: "Total LOE: 38 hours",
        },
      ],
      attachments: [],
      textAttachments: [
        {
          filename: "code-changes.md",
          mimeType: "text/markdown",
          content: "Update EnrollmentSyncValidator.java",
          size: 34,
        },
      ],
      imageAttachments: [],
    });

    expect(manifest.sourceJiraKey).toBe("CPDEV-22410");
    expect(manifest.loeHours).toBe(38);
    expect(manifest.artifacts).toEqual([
      {
        kind: "code_changes",
        filename: "code-changes.md",
        content: "Update EnrollmentSyncValidator.java",
      },
    ]);
  });
});
```

- [ ] **Step 2: Add evidence implementation**

Create `src/spec-factory/evidence.ts`:

```ts
import type { JiraTicketData } from "../orchestrator/JiraClient.js";

export type EvidenceArtifactKind =
  | "loe_estimate"
  | "code_changes"
  | "config_changes"
  | "raw_requirement"
  | "other";

export interface EvidenceArtifact {
  kind: EvidenceArtifactKind;
  filename: string;
  content: string;
}

export interface EvidenceManifest {
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  sourceLabels: string[];
  descriptionMarkdown: string;
  loeHours: number | null;
  comments: Array<{ id: string; author?: string; created?: string; bodyMarkdown: string }>;
  artifacts: EvidenceArtifact[];
  warnings: string[];
}

export function extractLoeHours(text: string): number | null {
  const patterns = [
    /\b(?:total\s+)?loe\s*[:=-]\s*(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i,
    /\bestimated\s+effort\s*[:=-]\s*(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i,
    /\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\s+(?:loe|estimated)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

function artifactKind(filename: string): EvidenceArtifactKind {
  const normalized = filename.toLowerCase();
  if (normalized.includes("loe") || normalized.includes("estimate")) return "loe_estimate";
  if (normalized.includes("code-change") || normalized.includes("code_changes")) return "code_changes";
  if (normalized.includes("config-change") || normalized.includes("config_changes")) return "config_changes";
  if (normalized.includes("requirement") || normalized.includes("prd")) return "raw_requirement";
  return "other";
}

export function buildEvidenceManifest(ticketData: JiraTicketData): EvidenceManifest {
  const sourceLabels = ticketData.issue.fields.labels ?? [];
  const combinedText = [
    ticketData.descriptionMarkdown,
    ...ticketData.comments.map((comment) => comment.bodyMarkdown),
    ...ticketData.textAttachments.map((attachment) => attachment.content),
  ].join("\n\n");

  const artifacts = ticketData.textAttachments.map((attachment) => ({
    kind: artifactKind(attachment.filename),
    filename: attachment.filename,
    content: attachment.content,
  }));

  const warnings: string[] = [];
  if (!artifacts.some((artifact) => artifact.kind === "loe_estimate")) {
    warnings.push("loe-estimate artifact was not found");
  }
  if (!artifacts.some((artifact) => artifact.kind === "code_changes")) {
    warnings.push("code-changes artifact was not found");
  }
  if (!artifacts.some((artifact) => artifact.kind === "config_changes")) {
    warnings.push("config-changes artifact was not found");
  }

  return {
    sourceJiraKey: ticketData.issue.key,
    sourceSummary: ticketData.issue.fields.summary ?? ticketData.issue.key,
    sourceStatus: ticketData.issue.fields.status?.name ?? null,
    sourceLabels,
    descriptionMarkdown: ticketData.descriptionMarkdown,
    loeHours: extractLoeHours(combinedText),
    comments: ticketData.comments,
    artifacts,
    warnings,
  };
}
```

- [ ] **Step 3: Write failing candidate ingestor tests**

Create `src/spec-factory/candidate-ingestor.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateIngestor } from "./candidate-ingestor.js";

const jiraClient = {
  searchIssues: vi.fn(),
  fetchTicketData: vi.fn(),
};

const repository = {
  upsertSource: vi.fn(),
};

describe("CandidateIngestor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("searches Louise JQL and upserts source summaries", async () => {
    jiraClient.searchIssues.mockResolvedValue({
      total: 1,
      issues: [{ key: "CPDEV-22410" }],
    });
    jiraClient.fetchTicketData.mockResolvedValue({
      issue: {
        key: "CPDEV-22410",
        fields: {
          summary: "Enrollment sync rules",
          status: { name: "In Progress" },
          labels: ["louise-estimated"],
          attachment: [],
        },
      },
      descriptionMarkdown: "Total LOE: 38 hours",
      comments: [],
      attachments: [],
      textAttachments: [],
      imageAttachments: [],
    });

    const result = await new CandidateIngestor(jiraClient as any, repository as any).refresh();

    expect(jiraClient.searchIssues).toHaveBeenCalledWith(
      'labels = "louise-estimated" ORDER BY updated DESC',
      "key,summary,status,labels,attachment,updated",
      50,
    );
    expect(repository.upsertSource).toHaveBeenCalledWith({
      sourceJiraKey: "CPDEV-22410",
      sourceSummary: "Enrollment sync rules",
      sourceStatus: "In Progress",
      sourceLabels: ["louise-estimated"],
      loeHours: 38,
    });
    expect(result).toEqual({ scanned: 1, upserted: 1 });
  });
});
```

- [ ] **Step 4: Add candidate ingestor implementation**

Create `src/spec-factory/candidate-ingestor.ts`:

```ts
import type { JiraClient } from "../orchestrator/JiraClient.js";
import type { SpecFactoryRepository } from "./database.js";
import { buildEvidenceManifest } from "./evidence.js";
import { SPEC_FACTORY_LOUISE_JQL } from "./types.js";

export class CandidateIngestor {
  constructor(
    private readonly jiraClient: Pick<JiraClient, "searchIssues" | "fetchTicketData">,
    private readonly repository: Pick<SpecFactoryRepository, "upsertSource">,
    private readonly jql = SPEC_FACTORY_LOUISE_JQL,
  ) {}

  async refresh(): Promise<{ scanned: number; upserted: number }> {
    const search = await this.jiraClient.searchIssues(
      this.jql,
      "key,summary,status,labels,attachment,updated",
      50,
    );

    let upserted = 0;
    for (const issue of search.issues) {
      const ticketData = await this.jiraClient.fetchTicketData(issue.key);
      const evidence = buildEvidenceManifest(ticketData);
      await this.repository.upsertSource({
        sourceJiraKey: evidence.sourceJiraKey,
        sourceSummary: evidence.sourceSummary,
        sourceStatus: evidence.sourceStatus,
        sourceLabels: evidence.sourceLabels,
        loeHours: evidence.loeHours,
      });
      upserted += 1;
    }

    return { scanned: search.total, upserted };
  }
}
```

- [ ] **Step 5: Run ingestion tests**

Run:

```bash
npm test -- src/spec-factory/evidence.test.ts src/spec-factory/candidate-ingestor.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit ingestion checkpoint**

```bash
git add src/spec-factory/evidence.ts src/spec-factory/evidence.test.ts src/spec-factory/candidate-ingestor.ts src/spec-factory/candidate-ingestor.test.ts
git commit -m "Add Spec Factory Louise ingestion"
```

---

### Task 4: Draft Generation And Bundle Persistence

**Files:**
- Create: `src/spec-factory/draft-generator.ts`
- Create: `src/spec-factory/draft-generator.test.ts`
- Modify: `src/spec-factory/database.ts`
- Modify: `src/spec-factory/database.test.ts`

- [ ] **Step 1: Write failing generator tests**

Create `src/spec-factory/draft-generator.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DraftGenerator } from "./draft-generator.js";

describe("DraftGenerator", () => {
  it("returns a validated structured draft bundle", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: {
        sourceJiraKey: "CPDEV-22410",
        loeHours: 38,
        epic: {
          summary: "Automate enrollment sync validation for Client A",
          description: "Client A needs repeatable validation.",
          businessContext: ["Louise estimated the raw requirement."],
          acceptanceCriteria: ["Each involved repo has one child ticket."],
          assumptions: [],
          dependencies: [],
        },
        childTickets: [
          {
            repoName: "core-app",
            summary: "[core-app] Add enrollment sync validation",
            overview: "Implement backend validation.",
            acceptanceCriteria: ["Invalid payloads are rejected.", "Other clients remain unchanged."],
            technicalDetails: {
              repo: "core-app",
              branch: "master",
              targetFiles: ["service/EnrollmentSyncValidator.java"],
              implementationNotes: ["Use existing validation hook."],
            },
            outOfScope: [],
            testingNotes: ["Run unit tests."],
            loeHours: 20,
            sourceEvidenceRefs: ["attachment:loe-estimate.md"],
          },
        ],
        evidenceSummary: ["Total LOE: 38 hours"],
        warnings: [],
      },
      metrics: { durationMs: 10, toolCalls: 0 },
    });

    const generator = new DraftGenerator(runAgent as any);
    const result = await generator.generate({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      evidenceManifest: {
        sourceJiraKey: "CPDEV-22410",
        sourceSummary: "Enrollment sync rules",
        sourceStatus: "In Progress",
        sourceLabels: ["louise-estimated"],
        descriptionMarkdown: "Raw requirement",
        loeHours: 38,
        comments: [],
        artifacts: [],
        warnings: [],
      },
    });

    expect(result.bundle.childTickets[0].technicalDetails.repo).toBe("core-app");
    expect(result.renderedMarkdown).toContain("Repo: core-app");
    expect(result.validation.valid).toBe(true);
  });

  it("throws when Claude returns an invalid child ticket", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: {
        sourceJiraKey: "CPDEV-22410",
        epic: {
          summary: "Bad draft",
          description: "Bad draft",
          businessContext: ["context"],
          acceptanceCriteria: ["summary"],
          assumptions: [],
          dependencies: [],
        },
        childTickets: [],
        evidenceSummary: [],
        warnings: [],
      },
      metrics: { durationMs: 10, toolCalls: 0 },
    });

    await expect(
      new DraftGenerator(runAgent as any).generate({
        sourceId: 12,
        sourceJiraKey: "CPDEV-22410",
        evidenceManifest: {} as any,
      }),
    ).rejects.toThrow("Draft bundle failed validation");
  });
});
```

- [ ] **Step 2: Add generator implementation**

Create `src/spec-factory/draft-generator.ts`:

```ts
import { runAgent as defaultRunAgent } from "../claude-sdk/index.js";
import { renderDraftMarkdown } from "./renderers.js";
import {
  SpecFactoryDraftBundleSchema,
  type SpecFactoryDraftBundle,
} from "./types.js";
import { validateDraftBundle } from "./draft-validator.js";
import type { EvidenceManifest } from "./evidence.js";

type RunAgent = typeof defaultRunAgent;

export interface GenerateDraftInput {
  sourceId: number;
  sourceJiraKey: string;
  evidenceManifest: EvidenceManifest;
}

export interface GenerateDraftResult {
  bundle: SpecFactoryDraftBundle;
  renderedMarkdown: string;
  validation: ReturnType<typeof validateDraftBundle>;
  modelMetadata: unknown;
}

function buildPrompt(input: GenerateDraftInput): string {
  return [
    "Generate a Spec Factory Epic bundle for OneShot.",
    "",
    "Rules:",
    "- Output one Epic and one child Story/Task per repository involved.",
    "- Each child ticket must be self-contained for OneShot QUALIFIER.",
    "- Each child ticket must include technicalDetails.repo.",
    "- Do not put PFOS on the Epic.",
    "",
    "Evidence manifest:",
    JSON.stringify(input.evidenceManifest, null, 2),
  ].join("\n");
}

export class DraftGenerator {
  constructor(
    private readonly runAgent: RunAgent = defaultRunAgent,
    private readonly modelId = process.env.SPEC_FACTORY_MODEL_ID || process.env.ANTHROPIC_MODEL,
  ) {}

  async generate(input: GenerateDraftInput): Promise<GenerateDraftResult> {
    const result = await this.runAgent({
      taskId: `spec-factory-${input.sourceJiraKey}-${Date.now()}`,
      taskPrompt: buildPrompt(input),
      repoIds: [],
      agentType: "custom",
      permissionLevel: "read_only",
      allowWrite: false,
      timeoutMs: Number(process.env.SPEC_FACTORY_DRAFT_TIMEOUT_MS || 600000),
      outputSchema: SpecFactoryDraftBundleSchema,
      bedrockConfig: {
        region: process.env.AWS_REGION || "us-east-2",
        model: this.modelId,
      },
    });

    if (!result.success) {
      throw new Error(result.error || "Spec Factory draft generation failed");
    }

    const parsed = SpecFactoryDraftBundleSchema.parse(result.structuredOutput ?? JSON.parse(result.output));
    const validation = validateDraftBundle(parsed);
    if (!validation.valid) {
      throw new Error(`Draft bundle failed validation: ${validation.errors.join("; ")}`);
    }

    return {
      bundle: validation.normalized,
      renderedMarkdown: renderDraftMarkdown(validation.normalized),
      validation,
      modelMetadata: {
        provider: "claude-sdk",
        model: this.modelId ?? null,
        metrics: result.metrics,
      },
    };
  }
}
```

- [ ] **Step 3: Extend repository to store child draft rows**

Update `SpecFactoryRepository.createDraft()` so it inserts child rows in the same transaction. The transaction body must:

```ts
await connection.beginTransaction();
const [draftResult] = await connection.query<mysql.ResultSetHeader>(
  `INSERT INTO spec_factory_drafts (...) VALUES (...)`,
  draftParams,
);
const draftId = draftResult.insertId;
for (const child of input.bundle.childTickets) {
  await connection.query(
    `INSERT INTO spec_factory_child_tickets
     (source_id, draft_id, repo_id, repo_name, summary, description, loe_hours, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
    [
      input.sourceId,
      draftId,
      child.repoId ?? null,
      child.repoName,
      child.summary,
      renderChildTicketDescription(child),
      child.loeHours ?? null,
    ],
  );
}
await connection.query(
  `UPDATE spec_factory_sources SET state = 'draft_ready', error_message = NULL WHERE id = ?`,
  [input.sourceId],
);
await connection.commit();
```

Add `getLatestDraft(sourceId)` mapping:

```ts
const [draftRows] = await this.pool.query<DraftRow[]>(
  `SELECT * FROM spec_factory_drafts
   WHERE source_id = ?
   ORDER BY version DESC
   LIMIT 1`,
  [sourceId],
);
if (!draftRows[0]) return null;
const [childRows] = await this.pool.query<ChildRow[]>(
  `SELECT * FROM spec_factory_child_tickets
   WHERE draft_id = ?
   ORDER BY id ASC`,
  [draftRows[0].id],
);
```

Map `draft_json`, `evidence_manifest_json`, and child rows to `SpecFactoryDraftDetail`.

- [ ] **Step 4: Add repository tests for child rows**

Extend `src/spec-factory/database.test.ts` with a transaction test asserting `createDraft()` inserts a draft row, one child row, and updates source state. Mock `getConnection()` with `beginTransaction`, `query`, `commit`, `rollback`, and `release`.

- [ ] **Step 5: Run generator and repository tests**

Run:

```bash
npm test -- src/spec-factory/draft-generator.test.ts src/spec-factory/database.test.ts src/spec-factory/draft-validator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit draft generation checkpoint**

```bash
git add src/spec-factory/draft-generator.ts src/spec-factory/draft-generator.test.ts src/spec-factory/database.ts src/spec-factory/database.test.ts
git commit -m "Add Spec Factory draft generation"
```

---

### Task 4A: Dedicated Repo Workspace And Master-Branch Grounding

**Files:**
- Create: `src/spec-factory/repo-workspace.ts`
- Create: `src/spec-factory/repo-workspace.test.ts`
- Create: `src/spec-factory/repo-context.ts`
- Create: `src/spec-factory/repo-context.test.ts`
- Modify: `src/spec-factory/draft-generator.ts`
- Modify: `src/spec-factory/draft-generator.test.ts`

- [ ] **Step 1: Add repo workspace tests**

Create `src/spec-factory/repo-workspace.test.ts` with mocked filesystem and git adapters. Cover:

- Default paths:
  - repo cache base: `process.env.SPEC_FACTORY_REPO_CACHE_BASE || /mnt/efs/specter-repo/oneshot/repos`
  - workspace base: `process.env.SPEC_FACTORY_WORKSPACE_BASE || /mnt/efs/specter-repo/spec-factory/workspaces`
- `prepareMasterWorkspace({ sourceId, repo })` clones or refreshes the repo cache, fetches `origin/master`, resolves the master head SHA, and creates a per-source worktree under `<workspaceBase>/<sourceId>/<repoName>`.
- If `origin/master` is missing, it fetches and resolves `origin/main`.
- The returned workspace metadata reports the selected branch: `"master"` or `"main"`.
- Missing both `origin/master` and `origin/main` rejects with a clear error and does not silently fall back to another branch.

- [ ] **Step 2: Add repo workspace implementation**

Create `src/spec-factory/repo-workspace.ts`:

- Accept dependencies for filesystem and git execution so tests do not shell out.
- Reuse the existing authenticated GitHub URL convention from `src/oneshot/git.ts` where practical.
- Use the dedicated Spec Factory EFS paths, not `ONESHOT_WORKSPACE_BASE`.
- Keep workspaces read-only from the drafting perspective. The collector may read files and run git commands, but it must not make commits, push, or create branches.
- Expose:

```ts
export interface SpecFactoryRepoWorkspace {
  repoName: string;
  branch: "master" | "main";
  headSha: string;
  repoRoot: string;
  workspacePath: string;
}

export class SpecFactoryRepoWorkspaceManager {
  async prepareMasterWorkspace(input: {
    sourceId: number;
    repo: Pick<CodeRepository, "repo_name" | "repo_url">;
  }): Promise<SpecFactoryRepoWorkspace>;
}
```

- [ ] **Step 3: Add repo context tests**

Create `src/spec-factory/repo-context.test.ts` covering:

- Repo hints extracted from Louise evidence artifacts and comments, including `repo: core-app`, `repository core-app`, and file paths that imply a repo when a repository lookup map contains that repo.
- File hints extracted from code-change/config-change artifacts.
- Context collection calls `prepareMasterWorkspace` for each resolved repo and only reports branch `master` or `main`.
- Collected context includes repo name, branch, head SHA, inspected paths, summaries/snippets, and warnings for missing hinted files.
- `DraftGenerator.generate()` includes the repo context manifest in the prompt, and the prompt tells the model that current grounded repo context from `master` or `main` takes precedence over stale attachment claims when they conflict.

- [ ] **Step 4: Add repo context implementation**

Create `src/spec-factory/repo-context.ts`:

- Define a compact `SpecFactoryRepoContextManifest` with:
  - `sourceJiraKey`
  - `repos: Array<{ repoName; branch: "master" | "main"; headSha; workspacePath; inspectedPaths; evidenceRefs; summaries; warnings }>`
  - `unresolvedHints`
  - `warnings`
- Resolve repositories from evidence using explicit repo names first. Use repository metadata from `code_repositories` through an injected lookup dependency; do not hard-code repo lists.
- Inspect only bounded hinted paths and nearby context for the MVP. Avoid broad repository scans by default.
- Produce warnings when evidence mentions a repo or file that cannot be resolved on the selected `master` or `main` branch.

- [ ] **Step 5: Update draft generation to consume repo context**

Modify `src/spec-factory/draft-generator.ts`:

- Extend `GenerateDraftInput` with optional `repoContextManifest`.
- Include a `Repository context JSON:` section in the prompt when present.
- Add prompt rules:
  - Always write child tickets against the selected grounded branch from repo context, preferring `master` with `main` fallback.
  - Use Louise attachments as evidence and hints.
  - Verify and improve requirements from current `master` or `main` code/config context.
  - Prefer observed current repo context over stale attachment claims, and surface conflicts as warnings.
- Keep existing callers working when repo context is absent.

Modify `src/spec-factory/draft-generator.test.ts` to assert repo context is included in the prompt and the master/main branch/current-code rules are present.

- [ ] **Step 6: Run repo grounding tests**

Run:

```bash
npm test -- src/spec-factory/repo-workspace.test.ts src/spec-factory/repo-context.test.ts src/spec-factory/draft-generator.test.ts
npm run type-check
```

- [ ] **Step 7: Commit repo grounding checkpoint**

```bash
git add src/spec-factory/repo-workspace.ts src/spec-factory/repo-workspace.test.ts src/spec-factory/repo-context.ts src/spec-factory/repo-context.test.ts src/spec-factory/draft-generator.ts src/spec-factory/draft-generator.test.ts
git commit -m "Add Spec Factory repo grounding"
```

---

### Task 5: Approval, OneShot Submission, And Service Orchestration

**Files:**
- Create: `src/spec-factory/jira-publisher.ts`
- Create: `src/spec-factory/oneshot-submitter.ts`
- Create: `src/spec-factory/service.ts`
- Create: `src/spec-factory/service.test.ts`
- Modify: `src/spec-factory/database.ts`
- Modify: `src/spec-factory/database.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `src/spec-factory/service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpecFactoryService } from "./service.js";

const repository = {
  listLouiseBoardSources: vi.fn(),
  getSourceById: vi.fn(),
  getLatestDraft: vi.fn(),
  markSourceNeedsAttention: vi.fn(),
  markDraftApproved: vi.fn(),
  updateChildCreated: vi.fn(),
  updateSourceApproved: vi.fn(),
  listApprovedChildren: vi.fn(),
  updateChildSubmitted: vi.fn(),
  markSourceOneShotSubmitted: vi.fn(),
  recordEvent: vi.fn(),
};

const ingestor = { refresh: vi.fn() };
const generator = { generate: vi.fn() };
const evidenceCollector = { collect: vi.fn() };
const publisher = { approveDraft: vi.fn() };
const submitter = { submitChildren: vi.fn() };

describe("SpecFactoryService", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("refreshes Louise candidates before returning board rows", async () => {
    ingestor.refresh.mockResolvedValue({ scanned: 1, upserted: 1 });
    repository.listLouiseBoardSources.mockResolvedValue([{ id: 1, sourceJiraKey: "CPDEV-1" }]);

    const service = new SpecFactoryService(repository as any, ingestor as any, evidenceCollector as any, generator as any, publisher as any, submitter as any);

    await expect(service.refreshLouiseBoard()).resolves.toEqual({
      refresh: { scanned: 1, upserted: 1 },
      sources: [{ id: 1, sourceJiraKey: "CPDEV-1" }],
    });
  });

  it("approves a draft through JiraPublisher and records created keys", async () => {
    repository.getLatestDraft.mockResolvedValue({ id: 7, sourceId: 1, draft: { epic: { summary: "Epic" }, childTickets: [] } });
    publisher.approveDraft.mockResolvedValue({
      epicKey: "CPDEV-23000",
      children: [{ childId: 9, jiraKey: "CPDEV-23001" }],
    });

    const service = new SpecFactoryService(repository as any, ingestor as any, evidenceCollector as any, generator as any, publisher as any, submitter as any);

    await service.approveDraft({ sourceId: 1, draftId: 7, actor: "rmadhukar" });

    expect(repository.markDraftApproved).toHaveBeenCalledWith(7, "rmadhukar");
    expect(repository.updateSourceApproved).toHaveBeenCalledWith(1, "CPDEV-23000");
    expect(repository.updateChildCreated).toHaveBeenCalledWith(9, "CPDEV-23001");
  });

  it("submits approved child tickets to OneShot and marks source submitted", async () => {
    repository.listApprovedChildren.mockResolvedValue([{ id: 9, jiraKey: "CPDEV-23001" }]);
    submitter.submitChildren.mockResolvedValue([{ childId: 9, requestId: 44 }]);

    const service = new SpecFactoryService(repository as any, ingestor as any, evidenceCollector as any, generator as any, publisher as any, submitter as any);

    await service.oneShotNow({ sourceId: 1, actor: "rmadhukar" });

    expect(repository.updateChildSubmitted).toHaveBeenCalledWith(9, 44);
    expect(repository.markSourceOneShotSubmitted).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Add JiraPublisher**

Create `src/spec-factory/jira-publisher.ts`:

```ts
import type { JiraClient } from "../orchestrator/JiraClient.js";
import { renderEpicDescription } from "./renderers.js";
import {
  SPEC_FACTORY_GENERATED_LABEL,
  SPEC_FACTORY_LABEL,
  type SpecFactoryDraftDetail,
} from "./types.js";

export interface ApprovalResult {
  epicKey: string;
  children: Array<{ childId: number; jiraKey: string }>;
}

export class JiraPublisher {
  constructor(
    private readonly jiraClient: Pick<JiraClient, "createIssue">,
    private readonly projectKey = process.env.SPEC_FACTORY_JIRA_PROJECT_KEY || "CPDEV",
  ) {}

  async approveDraft(draft: SpecFactoryDraftDetail): Promise<ApprovalResult> {
    if (!draft.draft) {
      throw new Error(`Draft ${draft.id} has no generated bundle`);
    }

    const epic = await this.jiraClient.createIssue({
      projectKey: this.projectKey,
      summary: draft.draft.epic.summary,
      description: renderEpicDescription(draft.draft),
      issueType: "Epic",
      labels: [SPEC_FACTORY_LABEL, SPEC_FACTORY_GENERATED_LABEL],
    });

    const children: Array<{ childId: number; jiraKey: string }> = [];
    for (const child of draft.childTickets) {
      if (child.jiraKey) {
        children.push({ childId: child.id, jiraKey: child.jiraKey });
        continue;
      }

      const created = await this.jiraClient.createIssue({
        projectKey: this.projectKey,
        summary: child.summary,
        description: child.description,
        issueType: "Story",
        labels: [SPEC_FACTORY_LABEL, SPEC_FACTORY_GENERATED_LABEL],
        parentKey: epic.key,
      });
      children.push({ childId: child.id, jiraKey: created.key });
    }

    return { epicKey: epic.key, children };
  }
}
```

- [ ] **Step 3: Add OneShotSubmitter**

Create `src/spec-factory/oneshot-submitter.ts`:

```ts
import type mysql from "mysql2/promise";
import type { JiraClient } from "../orchestrator/JiraClient.js";
import { getDatabase } from "../orchestrator/database.js";
import { PFOS_LABEL } from "./types.js";

export interface OneShotSubmitChild {
  id: number;
  jiraKey: string | null;
}

export interface OneShotSubmitResult {
  childId: number;
  requestId: number | null;
}

async function createSpecFactoryRunRequest(input: {
  jiraKey: string;
  actor: { id: string; display: string };
}): Promise<number | null> {
  const pool = getDatabase().getPool();
  const [existing] = await pool.query<Array<mysql.RowDataPacket & { id: number }>>(
    `SELECT id
     FROM oneshot_dashboard_run_requests
     WHERE jira_key = ?
       AND status IN ('queued', 'processing', 'task_created')
     ORDER BY id DESC
     LIMIT 1`,
    [input.jiraKey],
  );
  if (existing[0]?.id) return existing[0].id;

  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO oneshot_dashboard_run_requests
     (jira_key, requested_by, requested_by_display, status)
     VALUES (?, ?, ?, 'queued')`,
    [input.jiraKey, input.actor.id, input.actor.display],
  );
  return result.insertId;
}

export class OneShotSubmitter {
  constructor(
    private readonly jiraClient: Pick<JiraClient, "updateIssueLabels">,
    private readonly createRunRequest = createSpecFactoryRunRequest,
  ) {}

  async submitChildren(input: {
    children: OneShotSubmitChild[];
    actor: { id: string; display: string };
  }): Promise<OneShotSubmitResult[]> {
    const results: OneShotSubmitResult[] = [];

    for (const child of input.children) {
      if (!child.jiraKey) {
        throw new Error(`Child ticket ${child.id} has no Jira key`);
      }
      await this.jiraClient.updateIssueLabels(child.jiraKey, { add: [PFOS_LABEL] });

      let requestId: number | null = null;
      try {
        requestId = await this.createRunRequest({
          jiraKey: child.jiraKey,
          actor: input.actor,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("ER_DUP_ENTRY")) {
          throw error;
        }
      }

      results.push({ childId: child.id, requestId });
    }

    return results;
  }
}
```

- [ ] **Step 4: Add service orchestration**

Create `src/spec-factory/service.ts`:

```ts
import type { CandidateIngestor } from "./candidate-ingestor.js";
import type { SpecFactoryRepository } from "./database.js";
import type { DraftGenerator } from "./draft-generator.js";
import type { JiraPublisher } from "./jira-publisher.js";
import type { OneShotSubmitter } from "./oneshot-submitter.js";

export class SpecFactoryService {
  constructor(
    private readonly repository: SpecFactoryRepository,
    private readonly ingestor: CandidateIngestor,
    private readonly evidenceCollector: { collect(sourceId: number): Promise<unknown> },
    private readonly generator: DraftGenerator,
    private readonly publisher: JiraPublisher,
    private readonly submitter: OneShotSubmitter,
  ) {}

  async refreshLouiseBoard() {
    const refresh = await this.ingestor.refresh();
    const sources = await this.repository.listLouiseBoardSources();
    return { refresh, sources };
  }

  async listLouiseBoard() {
    return { sources: await this.repository.listLouiseBoardSources() };
  }

  async generateDraft(input: { sourceId: number }) {
    const source = await this.repository.getSourceById(input.sourceId);
    const evidenceManifest = await this.evidenceCollector.collect(input.sourceId);
    const generated = await this.generator.generate({
      sourceId: input.sourceId,
      sourceJiraKey: source.sourceJiraKey,
      evidenceManifest: evidenceManifest as any,
    });
    const draftId = await this.repository.createDraft({
      sourceId: input.sourceId,
      version: source.nextDraftVersion,
      bundle: generated.bundle,
      renderedMarkdown: generated.renderedMarkdown,
      evidenceManifest,
      modelMetadata: generated.modelMetadata,
    });
    return this.repository.getLatestDraft(input.sourceId);
  }

  async approveDraft(input: { sourceId: number; draftId: number; actor: string }) {
    const draft = await this.repository.getLatestDraft(input.sourceId);
    if (!draft || draft.id !== input.draftId) {
      throw new Error(`Draft ${input.draftId} is not the latest draft for source ${input.sourceId}`);
    }
    const approval = await this.publisher.approveDraft(draft);
    await this.repository.markDraftApproved(input.draftId, input.actor);
    await this.repository.updateSourceApproved(input.sourceId, approval.epicKey);
    for (const child of approval.children) {
      await this.repository.updateChildCreated(child.childId, child.jiraKey);
    }
    await this.repository.recordEvent(input.sourceId, "approved", input.actor, approval);
    return this.repository.getLatestDraft(input.sourceId);
  }

  async oneShotNow(input: { sourceId: number; actor: string }) {
    const children = await this.repository.listApprovedChildren(input.sourceId);
    const results = await this.submitter.submitChildren({
      children,
      actor: { id: input.actor, display: input.actor },
    });
    for (const result of results) {
      await this.repository.updateChildSubmitted(result.childId, result.requestId);
    }
    await this.repository.markSourceOneShotSubmitted(input.sourceId);
    await this.repository.recordEvent(input.sourceId, "oneshot_submitted", input.actor, results);
    return { submitted: results.length, children: results };
  }
}
```

- [ ] **Step 5: Add required repository methods**

Extend `src/spec-factory/database.ts` with:

- `getSourceById(sourceId)` returning source summary plus `nextDraftVersion`.
- `markDraftApproved(draftId, actor)`.
- `updateSourceApproved(sourceId, epicKey)`.
- `updateChildCreated(childId, jiraKey)`.
- `listApprovedChildren(sourceId)`.
- `updateChildSubmitted(childId, requestId)`.
- `markSourceOneShotSubmitted(sourceId)`.
- `markSourceNeedsAttention(sourceId, errorMessage)`.
- `recordEvent(sourceId, eventType, actor, metadata)`.

Use explicit SQL updates such as:

```ts
await this.pool.query(
  `UPDATE spec_factory_child_tickets
   SET jira_key = ?, state = 'created', error_message = NULL
   WHERE id = ? AND jira_key IS NULL`,
  [jiraKey, childId],
);
```

and:

```ts
await this.pool.query(
  `UPDATE spec_factory_sources
   SET state = 'oneshot_submitted', submitted_at = CURRENT_TIMESTAMP(3)
   WHERE id = ?`,
  [sourceId],
);
```

- [ ] **Step 6: Run service tests**

Run:

```bash
npm test -- src/spec-factory/service.test.ts src/spec-factory/database.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit approval/submission checkpoint**

```bash
git add src/spec-factory/jira-publisher.ts src/spec-factory/oneshot-submitter.ts src/spec-factory/service.ts src/spec-factory/service.test.ts src/spec-factory/database.ts src/spec-factory/database.test.ts
git commit -m "Add Spec Factory approval and OneShot submission"
```

---

### Task 6: Spec Factory HTTP Service

**Files:**
- Create: `src/spec-factory/routes.ts`
- Create: `src/spec-factory/routes.test.ts`
- Create: `src/spec-factory/server.ts`
- Create: `src/spec-factory/main.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing route tests**

Create `src/spec-factory/routes.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSpecFactoryRouter } from "./routes.js";

function recorder() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

describe("Spec Factory routes", () => {
  it("returns Louise candidates", async () => {
    const service = {
      listLouiseBoard: vi.fn().mockResolvedValue({ sources: [{ id: 1, sourceJiraKey: "CPDEV-1" }] }),
    };
    const router = createSpecFactoryRouter(service as any);
    const layer = router.stack.find((entry: any) => entry.route?.path === "/louise/candidates");

    const response = recorder();
    await layer.route.stack[0].handle({} as any, response as any);

    expect(response.body).toEqual({ sources: [{ id: 1, sourceJiraKey: "CPDEV-1" }] });
  });

  it("returns 202 for OneShot Now", async () => {
    const service = {
      oneShotNow: vi.fn().mockResolvedValue({ submitted: 1, children: [{ childId: 9, requestId: 44 }] }),
    };
    const router = createSpecFactoryRouter(service as any);
    const layer = router.stack.find((entry: any) => entry.route?.path === "/sources/:sourceId/oneshot");

    const response = recorder();
    await layer.route.stack[0].handle({ params: { sourceId: "1" }, headers: {} } as any, response as any);

    expect(response.statusCode).toBe(202);
    expect(response.body).toEqual({ submitted: 1, children: [{ childId: 9, requestId: 44 }] });
  });
});
```

- [ ] **Step 2: Add route handlers**

Create `src/spec-factory/routes.ts`:

```ts
import { Router, type Request, type Response } from "express";
import type { SpecFactoryService } from "./service.js";

function actorFromRequest(req: Request): string {
  const header = req.header("x-amzn-oidc-identity") || req.header("x-forwarded-user");
  return header?.trim() || "spec-factory-operator";
}

function positiveInt(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function handleError(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("positive integer") ? 400 : 500;
  res.status(status).json({ error: message });
}

export function createSpecFactoryRouter(service: SpecFactoryService): Router {
  const router = Router();

  router.get("/louise/candidates", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listLouiseBoard());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/louise/refresh", async (_req, res) => {
    try {
      res.json(await service.refreshLouiseBoard());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sources/:sourceId/drafts", async (req, res) => {
    try {
      res.status(202).json(await service.generateDraft({
        sourceId: positiveInt(req.params.sourceId, "sourceId"),
      }));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sources/:sourceId/drafts/latest", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      const draft = await service.getLatestDraft(sourceId);
      if (!draft) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      res.json(draft);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/drafts/:draftId/approve", async (req, res) => {
    try {
      res.status(202).json(await service.approveDraft({
        sourceId: positiveInt(String(req.body?.sourceId), "sourceId"),
        draftId: positiveInt(req.params.draftId, "draftId"),
        actor: actorFromRequest(req),
      }));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sources/:sourceId/oneshot", async (req, res) => {
    try {
      res.status(202).json(await service.oneShotNow({
        sourceId: positiveInt(req.params.sourceId, "sourceId"),
        actor: actorFromRequest(req),
      }));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/oneshot/submissions", async (_req, res) => {
    try {
      res.json(await service.listOneShotSubmissions());
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
```

Add `getLatestDraft()` and `listOneShotSubmissions()` pass-through methods to `SpecFactoryService`.

- [ ] **Step 3: Add server and main entrypoint**

Create `src/spec-factory/server.ts`:

```ts
import express from "express";
import { JiraClient } from "../orchestrator/JiraClient.js";
import { getDatabase } from "../orchestrator/database.js";
import { CandidateIngestor } from "./candidate-ingestor.js";
import { SpecFactoryRepository } from "./database.js";
import { DraftGenerator } from "./draft-generator.js";
import { JiraPublisher } from "./jira-publisher.js";
import { OneShotSubmitter } from "./oneshot-submitter.js";
import { createSpecFactoryRouter } from "./routes.js";
import { SpecFactoryService } from "./service.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function buildSpecFactoryApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const jiraClient = new JiraClient({
    baseUrl: requiredEnv("JIRA_BASE_URL"),
    username: process.env.JIRA_USERNAME || process.env.JIRA_EMAIL || "",
    token: requiredEnv("JIRA_TOKEN"),
  });
  const repository = new SpecFactoryRepository(getDatabase().getPool());
  const ingestor = new CandidateIngestor(jiraClient, repository);
  const evidenceCollector = {
    async collect(sourceId: number) {
      const source = await repository.getSourceById(sourceId);
      const ticketData = await jiraClient.fetchTicketData(source.sourceJiraKey);
      const { buildEvidenceManifest } = await import("./evidence.js");
      return buildEvidenceManifest(ticketData);
    },
  };
  const service = new SpecFactoryService(
    repository,
    ingestor,
    evidenceCollector,
    new DraftGenerator(),
    new JiraPublisher(jiraClient),
    new OneShotSubmitter(jiraClient),
  );

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/spec-factory", createSpecFactoryRouter(service));
  return app;
}
```

Create `src/spec-factory/main.ts`:

```ts
import { buildSpecFactoryApp } from "./server.js";

const port = Number(process.env.SPEC_FACTORY_PORT || 3012);
const app = buildSpecFactoryApp();

app.listen(port, () => {
  console.log(`[spec-factory] Server running on port ${port}`);
});
```

- [ ] **Step 4: Add package scripts**

Modify root `package.json` scripts:

```json
"spec-factory": "node dist/spec-factory/main.js",
"spec-factory:dev": "SPEC_FACTORY_PORT=3012 tsx watch src/spec-factory/main.ts"
```

- [ ] **Step 5: Run route and type checks**

Run:

```bash
npm test -- src/spec-factory/routes.test.ts src/spec-factory/service.test.ts
npm run type-check
```

Expected: PASS.

- [ ] **Step 6: Commit HTTP service checkpoint**

```bash
git add src/spec-factory/routes.ts src/spec-factory/routes.test.ts src/spec-factory/server.ts src/spec-factory/main.ts src/spec-factory/service.ts package.json
git commit -m "Add Spec Factory HTTP service"
```

---

### Task 7: Dashboard Route, Louise Board, Notebook, And OneShot View

**Files:**
- Create: `dashboard/src/spec-factory/types.ts`
- Create: `dashboard/src/spec-factory/api.ts`
- Create: `dashboard/src/spec-factory/SpecFactoryPage.tsx`
- Create: `dashboard/src/spec-factory/SpecFactoryPage.css`
- Create: `dashboard/src/spec-factory/SpecFactoryPage.test.tsx`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/App.test.tsx`
- Modify: `dashboard/src/components/DashboardNav.tsx`
- Modify: `dashboard/vite.config.ts`

- [ ] **Step 1: Write failing App route/nav tests**

Update `dashboard/src/App.test.tsx` with:

```tsx
vi.mock("./spec-factory/SpecFactoryPage.js", () => ({
  SpecFactoryPage: () => <main aria-label="Spec Factory">Spec Factory</main>,
}));

describe("App spec factory route", () => {
  it("renders the Spec Factory screen from /spec-factory", () => {
    window.history.pushState({}, "", "/spec-factory");

    render(<App />);

    expect(screen.getByRole("main", { name: "Spec Factory" })).toBeTruthy();
  });

  it("shows Spec Factory in the global dashboard navigation", () => {
    window.history.pushState({}, "", "/");

    render(<App />);

    expect(screen.getByRole("button", { name: "Spec Factory" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Add route/nav wiring**

Modify `dashboard/src/App.tsx`:

```tsx
import { SpecFactoryPage } from "./spec-factory/SpecFactoryPage.js";
```

Add `"/spec-factory"` to `SupportedPath`, add this to `normalizePathname()`:

```tsx
if (pathname.startsWith("/spec-factory")) return "/spec-factory";
```

Add route state and render branch:

```tsx
const isSpecFactory = pathname === "/spec-factory";
```

Include `isSpecFactory` in `isDocumentPage`, then render:

```tsx
) : isSpecFactory ? (
  <SpecFactoryPage />
) : isWatchdogIntro ? (
```

Modify `dashboard/src/components/DashboardNav.tsx` path unions to include `"/spec-factory"` and add:

```tsx
<button
  type="button"
  onClick={() => onNavigate("/spec-factory")}
  disabled={currentPath === "/spec-factory"}
  aria-current={currentPath === "/spec-factory" ? "page" : undefined}
  title={currentPath === "/spec-factory" ? "Current view" : undefined}
  style={navButtonStyle(currentPath === "/spec-factory")}
>
  Spec Factory
</button>
```

- [ ] **Step 3: Add frontend DTOs and API client**

Create `dashboard/src/spec-factory/types.ts`:

```ts
export type SpecFactorySourceState =
  | "candidate"
  | "drafting"
  | "draft_ready"
  | "approved"
  | "oneshot_submitted"
  | "needs_attention"
  | "archived";

export interface SpecFactorySourceSummary {
  id: number;
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  loeHours: number | null;
  state: SpecFactorySourceState;
  approvedEpicKey: string | null;
  updatedAt: string;
}

export interface SpecFactoryChildTicketSummary {
  id: number;
  repoName: string;
  summary: string;
  loeHours: number | null;
  jiraKey: string | null;
  state: string;
  oneshotRequestId: number | null;
  oneshotRunId: number | null;
  errorMessage: string | null;
}

export interface SpecFactoryDraftDetail {
  id: number;
  sourceId: number;
  version: number;
  status: string;
  draft: {
    epic: {
      summary: string;
      description: string;
      businessContext: string[];
      acceptanceCriteria: string[];
      assumptions: string[];
      dependencies: string[];
    };
    childTickets: Array<{ repoName: string; summary: string; loeHours?: number }>;
    evidenceSummary: string[];
    warnings: string[];
  } | null;
  renderedMarkdown: string | null;
  childTickets: SpecFactoryChildTicketSummary[];
  errorMessage: string | null;
}
```

Create `dashboard/src/spec-factory/api.ts`:

```ts
import type { SpecFactoryDraftDetail, SpecFactorySourceSummary } from "./types.js";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function fetchLouiseCandidates() {
  return requestJson<{ sources: SpecFactorySourceSummary[] }>("/api/spec-factory/louise/candidates");
}

export function refreshLouiseCandidates() {
  return requestJson<{ sources: SpecFactorySourceSummary[] }>("/api/spec-factory/louise/refresh", { method: "POST" });
}

export function generateDraft(sourceId: number) {
  return requestJson<SpecFactoryDraftDetail>(`/api/spec-factory/sources/${sourceId}/drafts`, { method: "POST" });
}

export function fetchLatestDraft(sourceId: number) {
  return requestJson<SpecFactoryDraftDetail>(`/api/spec-factory/sources/${sourceId}/drafts/latest`);
}

export function approveDraft(sourceId: number, draftId: number) {
  return requestJson<SpecFactoryDraftDetail>(`/api/spec-factory/drafts/${draftId}/approve`, {
    method: "POST",
    body: JSON.stringify({ sourceId }),
  });
}

export function oneShotNow(sourceId: number) {
  return requestJson<{ submitted: number }>(`/api/spec-factory/sources/${sourceId}/oneshot`, { method: "POST" });
}
```

- [ ] **Step 4: Write failing page tests**

Create `dashboard/src/spec-factory/SpecFactoryPage.test.tsx`:

```tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpecFactoryPage } from "./SpecFactoryPage.js";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sources: [
          {
            id: 1,
            sourceJiraKey: "CPDEV-22410",
            sourceSummary: "Enrollment sync rules",
            sourceStatus: "In Progress",
            loeHours: 38,
            state: "draft_ready",
            approvedEpicKey: null,
            updatedAt: "2026-05-27T12:00:00.000Z",
          },
        ],
      }),
    } as Response),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SpecFactoryPage", () => {
  it("renders Louise sticky notes with LOE hours", async () => {
    render(<SpecFactoryPage />);

    expect(await screen.findByText("CPDEV-22410")).toBeTruthy();
    expect(screen.getByText("38h")).toBeTruthy();
    expect(screen.getByText("Enrollment sync rules")).toBeTruthy();
  });

  it("opens the notebook for a selected sticky note", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(await screen.findByRole("button", { name: /CPDEV-22410/ }));

    expect(screen.getByRole("complementary", { name: "Notebook Preview" })).toBeTruthy();
    expect(screen.getByText("Approve Epic")).toBeTruthy();
    expect(screen.getByText("OneShot Now")).toBeTruthy();
  });

  it("switches to the Compose empty state", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Compose" }));

    expect(screen.getByText("Compose will accept meeting notes, rough ideas, and PRDs in a later phase.")).toBeTruthy();
  });
});
```

- [ ] **Step 5: Add page component and CSS**

Create `dashboard/src/spec-factory/SpecFactoryPage.tsx` with focused subcomponents:

```tsx
import { useEffect, useMemo, useState } from "react";
import {
  approveDraft,
  fetchLatestDraft,
  fetchLouiseCandidates,
  generateDraft,
  oneShotNow,
  refreshLouiseCandidates,
} from "./api.js";
import type { SpecFactoryDraftDetail, SpecFactorySourceSummary } from "./types.js";
import "./SpecFactoryPage.css";

type Tab = "compose" | "louise" | "oneshot";

function SideNav({ active, onSelect }: { active: Tab; onSelect: (tab: Tab) => void }) {
  return (
    <nav className="sf-side-nav" aria-label="Spec Factory sections">
      {(["compose", "louise", "oneshot"] as Tab[]).map((tab) => (
        <button
          key={tab}
          type="button"
          className={active === tab ? "is-active" : ""}
          onClick={() => onSelect(tab)}
        >
          {tab === "compose" ? "Compose" : tab === "louise" ? "Louise" : "OneShot"}
        </button>
      ))}
    </nav>
  );
}

function StickyCard({ source, selected, onSelect }: {
  source: SpecFactorySourceSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`sf-sticky ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      aria-label={`${source.sourceJiraKey} ${source.sourceSummary}`}
    >
      <span className="sf-sticky-key">{source.sourceJiraKey}</span>
      <span className="sf-sticky-loe">{source.loeHours == null ? "LOE n/a" : `${source.loeHours}h`}</span>
      <span className="sf-sticky-summary">{source.sourceSummary}</span>
      <span className="sf-sticky-state">{source.state.replace(/_/g, " ")}</span>
    </button>
  );
}

function Notebook({ source, draft, onGenerate, onApprove, onOneShot, busy }: {
  source: SpecFactorySourceSummary | null;
  draft: SpecFactoryDraftDetail | null;
  onGenerate: () => void;
  onApprove: () => void;
  onOneShot: () => void;
  busy: boolean;
}) {
  if (!source) {
    return <aside className="sf-notebook" aria-label="Notebook Preview">Select a Louise ticket.</aside>;
  }

  const canApprove = Boolean(draft?.id && draft.status === "ready");
  const canOneShot = Boolean(source.approvedEpicKey || draft?.childTickets.some((child) => child.jiraKey));

  return (
    <aside className="sf-notebook" aria-label="Notebook Preview">
      <header>
        <span>{source.sourceJiraKey}</span>
        <strong>{source.loeHours == null ? "LOE n/a" : `${source.loeHours}h`}</strong>
      </header>
      <section className="sf-page">
        <p className="sf-page-label">Generated Epic</p>
        <h2>{draft?.draft?.epic.summary ?? "No draft generated yet"}</h2>
        <p>{draft?.draft?.epic.description ?? source.sourceSummary}</p>
      </section>
      <section className="sf-page">
        <p className="sf-page-label">Child Stories</p>
        {(draft?.childTickets ?? []).map((child) => (
          <div key={child.id} className="sf-child-row">
            <span>{child.repoName}</span>
            <strong>{child.jiraKey ?? "draft"}</strong>
          </div>
        ))}
      </section>
      <footer>
        <button type="button" onClick={onGenerate} disabled={busy}>Generate / Refresh Draft</button>
        <button type="button" onClick={onApprove} disabled={busy || !canApprove}>Approve Epic</button>
        <button type="button" onClick={onOneShot} disabled={busy || !canOneShot}>OneShot Now</button>
      </footer>
    </aside>
  );
}

export function SpecFactoryPage() {
  const [tab, setTab] = useState<Tab>("louise");
  const [sources, setSources] = useState<SpecFactorySourceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<SpecFactoryDraftDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchLouiseCandidates()
      .then((result) => {
        setSources(result.sources);
        setSelectedId((current) => current ?? result.sources[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const selected = useMemo(
    () => sources.find((source) => source.id === selectedId) ?? null,
    [sources, selectedId],
  );

  useEffect(() => {
    if (!selected) return;
    fetchLatestDraft(selected.id).then(setDraft).catch(() => setDraft(null));
  }, [selected]);

  async function runAction(action: () => Promise<unknown>) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      const refreshed = await fetchLouiseCandidates();
      setSources(refreshed.sources);
      if (selectedId) {
        setDraft(await fetchLatestDraft(selectedId).catch(() => null));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="sf-shell" aria-label="Spec Factory">
      <SideNav active={tab} onSelect={setTab} />
      {tab === "compose" ? (
        <section className="sf-empty">Compose will accept meeting notes, rough ideas, and PRDs in a later phase.</section>
      ) : tab === "oneshot" ? (
        <section className="sf-empty">Submitted Spec Factory work will appear here after OneShot Now.</section>
      ) : (
        <section className="sf-workspace">
          <header className="sf-header">
            <div>
              <h1>Louise</h1>
              <p>JQL: labels = "louise-estimated"</p>
            </div>
            <button type="button" onClick={() => runAction(refreshLouiseCandidates)} disabled={busy}>Refresh</button>
          </header>
          {error ? <div className="sf-error">{error}</div> : null}
          <div className="sf-board">
            <section className="sf-column">
              <h2>Louise Estimated</h2>
              {sources.map((source) => (
                <StickyCard
                  key={source.id}
                  source={source}
                  selected={source.id === selectedId}
                  onSelect={() => setSelectedId(source.id)}
                />
              ))}
            </section>
            <Notebook
              source={selected}
              draft={draft}
              busy={busy}
              onGenerate={() => runAction(() => generateDraft(selected!.id))}
              onApprove={() => runAction(() => approveDraft(selected!.id, draft!.id))}
              onOneShot={() => runAction(() => oneShotNow(selected!.id))}
            />
          </div>
        </section>
      )}
    </main>
  );
}
```

Create CSS with stable dimensions:

```css
.sf-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  background: #f4f6f8;
  color: #172033;
}

.sf-side-nav {
  background: #151923;
  padding: 18px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sf-side-nav button,
.sf-header button,
.sf-notebook footer button {
  min-height: 36px;
  border: 1px solid #cfd7e3;
  border-radius: 6px;
  background: #ffffff;
  color: #172033;
  font-weight: 700;
  cursor: pointer;
}

.sf-side-nav button {
  background: transparent;
  color: #c8d1df;
  border-color: transparent;
  text-align: left;
  padding: 0 12px;
}

.sf-side-nav button.is-active {
  background: #ffffff;
  color: #151923;
}

.sf-workspace {
  padding: 20px;
  min-width: 0;
}

.sf-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.sf-header h1 {
  margin: 0;
  font-size: 24px;
}

.sf-header p {
  margin: 4px 0 0;
  color: #64748b;
}

.sf-board {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(360px, 430px);
  gap: 16px;
  align-items: start;
}

.sf-column {
  background: #e8edf4;
  border: 1px solid #d5dde8;
  border-radius: 8px;
  padding: 14px;
  min-height: 620px;
}

.sf-column h2 {
  margin: 0 0 12px;
  font-size: 13px;
  text-transform: uppercase;
  color: #526070;
}

.sf-sticky {
  width: 220px;
  min-height: 150px;
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  gap: 8px;
  text-align: left;
  border: 1px solid #ead36f;
  border-radius: 6px;
  background: #fff3ad;
  color: #172033;
  padding: 12px;
  margin: 0 12px 12px 0;
  vertical-align: top;
  box-shadow: 0 8px 18px rgba(23, 32, 51, 0.12);
}

.sf-sticky.is-selected {
  outline: 3px solid #2563eb;
}

.sf-sticky-key,
.sf-sticky-loe {
  font-weight: 800;
}

.sf-sticky-summary,
.sf-sticky-state {
  font-size: 13px;
}

.sf-notebook {
  background: #ffffff;
  border: 1px solid #d5dde8;
  border-radius: 8px;
  min-height: 620px;
  padding: 16px;
}

.sf-notebook header,
.sf-notebook footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.sf-page {
  background: #fffdf5;
  border: 1px solid #e5dfca;
  border-radius: 6px;
  padding: 14px;
  margin: 14px 0;
}

.sf-page-label {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 800;
  color: #64748b;
  text-transform: uppercase;
}

.sf-child-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid #edf0f4;
}

.sf-error,
.sf-empty {
  border: 1px solid #d5dde8;
  border-radius: 8px;
  background: #ffffff;
  padding: 18px;
}

@media (max-width: 900px) {
  .sf-shell {
    grid-template-columns: 1fr;
  }

  .sf-side-nav {
    flex-direction: row;
    overflow-x: auto;
  }

  .sf-board {
    grid-template-columns: 1fr;
  }

  .sf-sticky {
    width: 100%;
  }
}
```

- [ ] **Step 6: Update Vite proxy**

Modify `dashboard/vite.config.ts`:

```ts
const specFactoryProxyTarget =
  process.env.VITE_SPEC_FACTORY_API_PROXY_TARGET ||
  process.env.SPEC_FACTORY_API_TARGET ||
  "http://localhost:3012";
```

and put the specific proxy before the general `/api` entry:

```ts
proxy: {
  "/api/spec-factory": {
    target: specFactoryProxyTarget,
    changeOrigin: true,
  },
  "/api": {
    target: apiProxyTarget,
    changeOrigin: true,
  },
},
```

- [ ] **Step 7: Run dashboard tests**

Run:

```bash
cd dashboard
npm test -- src/App.test.tsx src/spec-factory/SpecFactoryPage.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit dashboard checkpoint**

```bash
git add dashboard/src/App.tsx dashboard/src/App.test.tsx dashboard/src/components/DashboardNav.tsx dashboard/vite.config.ts dashboard/src/spec-factory
git commit -m "Add Spec Factory dashboard"
```

---

### Task 8: ECS Container And Terraform Wiring

**Files:**
- Create: `Dockerfile.spec-factory`
- Create: `terraform/spec-factory-ecs.tf`
- Modify: `terraform/variables.tf`
- Modify: `terraform/shared.auto.tfvars`
- Modify: `terraform/terraform.tfvars.example`

- [ ] **Step 1: Add service Dockerfile**

Create `Dockerfile.spec-factory`:

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV SPEC_FACTORY_PORT=3012
ENV AWS_REGION=us-east-2
ENV CLAUDE_CODE_USE_BEDROCK=1

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci --production

COPY dist/ ./dist/
COPY config/ ./config/

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD curl -f http://localhost:3012/health || exit 1

CMD ["node", "dist/spec-factory/main.js"]
```

- [ ] **Step 2: Add Terraform variables**

Add to `terraform/variables.tf` near Dashboard variables:

```hcl
variable "enable_spec_factory" {
  description = "Enable Spec Factory ECS service and Dashboard ALB path routing"
  type        = bool
  default     = false
}

variable "spec_factory_cpu" {
  description = "CPU units for Spec Factory"
  type        = string
  default     = "512"
}

variable "spec_factory_memory" {
  description = "Memory in MB for Spec Factory"
  type        = string
  default     = "1024"
}

variable "spec_factory_desired_count" {
  description = "Number of Spec Factory ECS tasks"
  type        = number
  default     = 0
}

variable "spec_factory_louise_jql" {
  description = "JQL used by Spec Factory to find Louise-estimated tickets"
  type        = string
  default     = "labels = \"louise-estimated\" ORDER BY updated DESC"
}

variable "spec_factory_model_id" {
  description = "Bedrock model id used by Spec Factory draft generation"
  type        = string
  default     = ""
}
```

Add to `terraform/shared.auto.tfvars`:

```hcl
enable_spec_factory          = true
spec_factory_desired_count   = 1
spec_factory_louise_jql      = "labels = \"louise-estimated\" ORDER BY updated DESC"
```

Add the same variables with comments to `terraform/terraform.tfvars.example`.

- [ ] **Step 3: Add Terraform ECS resources**

Create `terraform/spec-factory-ecs.tf` with resources guarded by `count = var.enable_spec_factory ? 1 : 0`:

```hcl
resource "aws_ecr_repository" "spec_factory" {
  count                = var.enable_spec_factory ? 1 : 0
  name                 = "specter/spec-factory"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Service = "spec-factory"
  })
}

resource "aws_cloudwatch_log_group" "spec_factory" {
  count             = var.enable_spec_factory ? 1 : 0
  name              = "/ecs/specter/spec-factory"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Service = "spec-factory"
  })
}

resource "aws_lb_target_group" "spec_factory" {
  count       = var.enable_spec_factory ? 1 : 0
  name        = "specter-spec-factory-tg"
  port        = 3012
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    port                = "3012"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  tags = merge(local.common_tags, {
    Name    = "specter-spec-factory-tg"
    Service = "spec-factory"
  })
}
```

Add these resources in the same file:

```hcl
resource "aws_security_group" "spec_factory_tasks" {
  count       = var.enable_spec_factory ? 1 : 0
  name        = "specter-spec-factory-tasks"
  description = "Security group for Spec Factory ECS tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "From Dashboard ALB on port 3012"
    from_port       = 3012
    to_port         = 3012
    protocol        = "tcp"
    security_groups = [aws_security_group.dashboard_alb.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name    = "specter-spec-factory-tasks"
    Service = "spec-factory"
  })
}

resource "aws_security_group_rule" "rds_from_spec_factory" {
  count                    = var.enable_spec_factory ? 1 : 0
  type                     = "ingress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = var.existing_rds_security_group_id
  source_security_group_id = aws_security_group.spec_factory_tasks[0].id
  description              = "MySQL from Spec Factory ECS tasks"
}

resource "aws_ecs_task_definition" "spec_factory" {
  count                    = var.enable_spec_factory ? 1 : 0
  family                   = "specter-spec-factory"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.spec_factory_cpu
  memory                   = var.spec_factory_memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = data.aws_iam_role.existing_task_role.arn

  container_definitions = jsonencode([{
    name  = "spec-factory"
    image = "${aws_ecr_repository.spec_factory[0].repository_url}:latest"

    portMappings = [{
      containerPort = 3012
      hostPort      = 3012
      protocol      = "tcp"
    }]

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:3012/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 45
    }

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "SPEC_FACTORY_PORT", value = "3012" },
      { name = "SPEC_FACTORY_LOUISE_JQL", value = var.spec_factory_louise_jql },
      { name = "SPEC_FACTORY_MODEL_ID", value = var.spec_factory_model_id != "" ? var.spec_factory_model_id : var.bedrock_model_id },
      { name = "DB_HOST", value = var.db_host },
      { name = "DB_PORT", value = var.db_port },
      { name = "DB_NAME", value = var.db_name },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "JIRA_BASE_URL", value = var.jira_base_url },
      { name = "JIRA_USERNAME", value = var.jira_username }
    ]

    secrets = [
      {
        name      = "DB_USER"
        valueFrom = "${data.aws_secretsmanager_secret.db_credentials.arn}:username::"
      },
      {
        name      = "DB_PASSWORD"
        valueFrom = "${data.aws_secretsmanager_secret.db_credentials.arn}:password::"
      },
      {
        name      = "JIRA_TOKEN"
        valueFrom = data.aws_secretsmanager_secret.jira_token.arn
      }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.spec_factory[0].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "spec-factory"
      }
    }
  }])

  tags = merge(local.common_tags, {
    Service = "spec-factory"
  })
}

resource "aws_ecs_service" "spec_factory" {
  count           = var.enable_spec_factory ? 1 : 0
  name            = "SPEC-FACTORY"
  cluster         = aws_ecs_cluster.specter.id
  task_definition = aws_ecs_task_definition.spec_factory[0].arn
  desired_count   = var.spec_factory_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.spec_factory_tasks[0].id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.spec_factory[0].arn
    container_name   = "spec-factory"
    container_port   = 3012
  }

  depends_on = [aws_lb_listener.dashboard_https]

  tags = merge(local.common_tags, {
    Service = "SPEC-FACTORY"
  })
}

resource "aws_lb_listener_rule" "dashboard_spec_factory_api" {
  count        = var.enable_spec_factory ? 1 : 0
  listener_arn = aws_lb_listener.dashboard_https.arn
  priority     = 140

  dynamic "action" {
    for_each = var.dashboard_enable_cognito_auth ? [1] : []
    content {
      type  = "authenticate-cognito"
      order = 1

      authenticate_cognito {
        user_pool_arn       = var.dashboard_cognito_user_pool_arn
        user_pool_client_id = var.dashboard_cognito_user_pool_client_id
        user_pool_domain    = var.dashboard_cognito_user_pool_domain
        scope               = "openid email profile"
      }
    }
  }

  action {
    type             = "forward"
    order            = var.dashboard_enable_cognito_auth ? 2 : 1
    target_group_arn = aws_lb_target_group.spec_factory[0].arn
  }

  condition {
    path_pattern {
      values = ["/api/spec-factory", "/api/spec-factory/*"]
    }
  }
}

output "spec_factory_ecr_url" {
  description = "ECR repository URL for pushing Spec Factory images"
  value       = var.enable_spec_factory ? aws_ecr_repository.spec_factory[0].repository_url : null
}
```

- [ ] **Step 4: Run Terraform formatting and validation**

Run:

```bash
terraform -chdir=terraform fmt
terraform -chdir=terraform validate
```

Expected: PASS. If validation cannot run because backend/provider credentials are unavailable locally, run `terraform -chdir=terraform fmt` and record the validation blocker in the final implementation notes.

- [ ] **Step 5: Run full build checks**

Run:

```bash
npm run build
npm test -- src/spec-factory
cd dashboard && npm run build && npm test -- src/App.test.tsx src/spec-factory/SpecFactoryPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit infra checkpoint**

```bash
git add Dockerfile.spec-factory terraform/spec-factory-ecs.tf terraform/variables.tf terraform/shared.auto.tfvars terraform/terraform.tfvars.example
git commit -m "Add Spec Factory ECS wiring"
```

---

### Task 9: Local End-To-End Smoke Verification

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Build root and dashboard artifacts**

Run:

```bash
npm run build
cd dashboard && npm run build
```

Expected: both builds pass.

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test -- src/spec-factory
cd dashboard && npm test -- src/spec-factory/SpecFactoryPage.test.tsx src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Start local Spec Factory service**

Run:

```bash
SPEC_FACTORY_PORT=3012 \
JIRA_BASE_URL=https://example.atlassian.net \
JIRA_USERNAME=local@example.com \
JIRA_TOKEN=local-token \
ONESHOT_DISABLE_JIRA_MUTATIONS=true \
npm run spec-factory:dev
```

Expected: service logs `[spec-factory] Server running on port 3012`.

- [ ] **Step 4: Start Dashboard dev server**

In a second shell:

```bash
cd dashboard
VITE_SPEC_FACTORY_API_PROXY_TARGET=http://localhost:3012 npm run dev
```

Expected: Vite starts and `/spec-factory` renders. Use mocked DB/Jira credentials for UI-only checks if Jira is not available locally.

- [ ] **Step 5: Verify browser flow**

Open the Vite URL and navigate to `/spec-factory`.

Verify:

- `Compose`, `Louise`, and `OneShot` side-nav items render.
- Louise board displays source cards when the API returns candidates.
- Selecting a sticky note opens the notebook.
- `Approve Epic` stays disabled until a ready draft exists.
- `OneShot Now` stays disabled until child Jira keys exist.

- [ ] **Step 6: Commit final fixes**

If smoke verification required changes:

```bash
git add <changed-files>
git commit -m "Stabilize Spec Factory smoke flow"
```

If no changes were required, skip the commit.

---

## Self-Review Checklist For Implementer

- Every generated child Story/Task includes `Repo:` in `Technical Details`.
- `PFOS` is never added during draft generation or `Approve Epic`.
- `OneShot Now` is the only path that adds `PFOS`.
- Re-running `Approve Epic` does not create duplicate child tickets.
- Re-running `OneShot Now` does not create duplicate active run requests.
- Submitted source tickets disappear from Louise board and appear in the OneShot view.
- `Compose` remains a disabled or empty future workflow in the MVP.
- Dashboard `/api/spec-factory` calls are routed to Spec Factory locally and in Terraform.
- Root `npm run build`, focused root Spec Factory tests, Dashboard build, and Dashboard focused tests pass before handoff.

---

## Gap Checklist: Attachment Archive And Preview Evidence

The current MVP fetches Louise tickets and can download selected text/image attachments during Jira ticket reads, but it does not durably archive all source attachments or track attachment-level processing state. Address this before treating generated Epic previews as complete.

- [ ] **S3 attachment store**
  - Add a dedicated Spec Factory S3 prefix or bucket for raw Jira source attachments.
  - Add ECS task-role permissions for `PutObject`, `GetObject`, `HeadObject`, and `ListBucket` scoped to the Spec Factory attachment prefix.
  - Add environment variables for attachment bucket, prefix, max download size, and allowed content types.

- [ ] **Attachment manifest schema**
  - Add a migration for `spec_factory_attachments`.
  - Track `source_id`, Jira attachment id, filename, MIME type, Jira reported size, author, created timestamp, Jira content URL hash, S3 bucket/key, checksum, download status, processing status, extracted text status, error message, and timestamps.
  - Add uniqueness on source plus Jira attachment id so repeated refreshes are idempotent.

- [ ] **Download all Jira attachments**
  - Change Louise refresh to enumerate every attachment, not only text-like files.
  - Stream attachment bytes from Jira to S3 instead of loading large files fully into memory.
  - Record downloaded, skipped, failed, and retryable statuses per attachment.
  - Preserve Jira metadata even when the file cannot be downloaded.
  - Avoid duplicate downloads when checksum/S3 object already exists.

- [ ] **Attachment processing pipeline**
  - Process S3 objects into preview-ready evidence.
  - Extract text from plain text, Markdown, JSON, XML, YAML, CSV, SQL, properties/config files, logs, DOCX, XLSX/CSV, PDFs, and supported image formats.
  - Store extracted text or summarized structured evidence separately from the raw binary.
  - Redact or flag likely secrets before evidence reaches the Epic generator.
  - Record unsupported file types and oversized files as explicit evidence gaps.

- [ ] **Evidence manifest integration**
  - Build the Spec Factory evidence manifest from persisted attachment records and processed outputs.
  - Include attachment refs as stable S3-backed evidence ids instead of transient `attachment:<filename>` refs only.
  - Preserve LOE, code-change, config-change, raw requirement, screenshot, and other artifact classifications.
  - Include attachment download/processing warnings in the notebook and generator prompt.

- [ ] **Epic preview generation**
  - Block or warn before preview generation when required LOE/code/config attachments are missing, failed, or unprocessed.
  - Generate the Epic preview from persisted processed evidence plus independently grounded repo context.
  - Prefer current repo context over stale attachment claims, but cite the conflicting attachment and show the conflict in the notebook.

- [ ] **Dashboard visibility**
  - Show attachment counts on the Louise sticky note or notebook: total, downloaded, processed, failed, skipped.
  - Add a notebook Evidence page with filenames, statuses, extracted evidence summaries, and retryable errors.
  - Disable or warn on `Generate / Refresh Draft` when attachment processing is incomplete.

- [ ] **Operational controls**
  - Add manual retry for failed attachment downloads and processing.
  - Add refresh concurrency protection so multiple UI loads do not start duplicate attachment crawls.
  - Emit logs and metrics for attachment download counts, bytes, failures, processing duration, and preview generation evidence gaps.

- [ ] **Tests and verification**
  - Unit-test attachment manifest upserts, idempotency, status transitions, and evidence-manifest mapping.
  - Mock-test Jira attachment streaming into S3.
  - Mock-test processor handling for supported, unsupported, oversized, and failed attachments.
  - Add route/service tests for refresh, retry, and notebook evidence status.
  - Verify locally against a real Louise ticket with mutations disabled and confirm S3 objects plus DB manifest rows are created.
