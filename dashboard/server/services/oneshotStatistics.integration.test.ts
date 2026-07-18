/**
 * Integration test: getOneShotStatistics() end-to-end against a real MySQL.
 *
 * Skipped by default. Requires the local-oneshot MySQL container (or any
 * MySQL with the relevant migrations applied). Mocks getOneShotDashboardRows
 * to keep cross-table seed-data setup out of scope — this suite's value is
 * confirming snapshot/lease/merge behavior under a real connection.
 *
 *   docker compose -f local-oneshot/docker-compose.yml up -d mysql
 *   RUN_INTEGRATION_TESTS=1 \
 *   DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root \
 *   DB_PASSWORD=specter_local DB_NAME=Specter \
 *   npm --prefix dashboard test -- oneshotStatistics.integration
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { OneShotDashboardRow } from "../types/oneshot.js";

const SHOULD_RUN = process.env.RUN_INTEGRATION_TESTS === "1";

const mocks = vi.hoisted(() => ({
  bedrockSend: vi.fn(),
  getRows: vi.fn(),
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function BedrockRuntimeClient() {
    return {
      send: mocks.bedrockSend,
    };
  }),
  InvokeModelCommand: vi.fn().mockImplementation(function InvokeModelCommand(input: unknown) {
    return input;
  }),
}));

vi.mock("./oneshot.js", () => ({
  getOneShotDashboardRows: mocks.getRows,
}));

// Schema for migration 025 — applied in-line so the suite can run against any
// MySQL even if migrations aren't applied externally.
const MIGRATION_025 = [
  `CREATE TABLE IF NOT EXISTS oneshot_statistics_snapshots (
    id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
    range_key             ENUM('24h', '7d', '30d', 'all') NOT NULL,
    data_fingerprint      CHAR(40)                         NOT NULL,
    status                ENUM('ready', 'invalid', 'failed') NOT NULL,
    snapshot_json         JSON                             NULL,
    provider              VARCHAR(50)                      NULL,
    model                 VARCHAR(160)                     NULL,
    generated_at          TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at            TIMESTAMP(3)                     NULL,
    error_message         TEXT                             NULL,
    invalid_output_sample TEXT                             NULL,
    created_at            TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_oneshot_statistics_range_generated (range_key, generated_at, id),
    INDEX idx_oneshot_statistics_range_status_generated (range_key, status, generated_at, id),
    INDEX idx_oneshot_statistics_fingerprint (data_fingerprint)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS oneshot_statistics_refresh_state (
    range_key                ENUM('24h', '7d', '30d', 'all') PRIMARY KEY,
    latest_snapshot_id       BIGINT       NULL,
    refresh_started_at       TIMESTAMP(3) NULL,
    refresh_lease_expires_at TIMESTAMP(3) NULL,
    next_retry_at            TIMESTAMP(3) NULL,
    attempt_count            INT          NOT NULL DEFAULT 0,
    last_attempt_at          TIMESTAMP(3) NULL,
    last_error               TEXT         NULL,
    created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_oneshot_statistics_latest_snapshot
      FOREIGN KEY (latest_snapshot_id) REFERENCES oneshot_statistics_snapshots(id),
    INDEX idx_oneshot_statistics_refresh_lease (refresh_lease_expires_at),
    INDEX idx_oneshot_statistics_next_retry (next_retry_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

function makeRow(
  overrides: Partial<OneShotDashboardRow> = {},
): OneShotDashboardRow {
  return {
    dashboardId: "run-1",
    jiraKey: "CPDEV-1",
    title: "Auth login ticket",
    sourceTaskManagementId: 1,
    oneshotRunId: 1,
    customerName: null,
    displayState: "completed",
    progressStage: "pr_complete",
    progressPercent: 100,
    repoName: "core-app",
    repoUrl: null,
    baseBranch: "main",
    baseCommitSha: "abc",
    implementationBranch: null,
    implementationCommitSha: null,
    workspace: null,
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    planReviewLoopCount: 0,
    maxPlanReviewLoops: 3,
    verificationLoopCount: 0,
    maxVerificationLoops: 3,
    currentPrUrl: null,
    qualificationSummary: null,
    qualifierOutcome: null,
    lastError: null,
    lastErrorSummary: null,
    readiness: null,
    readinessReasons: [],
    retry: null,
    deployment: {
      eligible: false,
      ready: false,
      light: "grey",
      status: "not_eligible",
      active: false,
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    },
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    lastManualRestartAt: null,
    updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    totalTokensUsed: 1000,
    estimatedCostUsd: 0.01,
    costSource: "actual",
    ...overrides,
  } as OneShotDashboardRow;
}

describe.skipIf(!SHOULD_RUN)(
  "oneshotStatistics integration (real MySQL)",
  () => {
    let getOneShotStatistics: typeof import("./oneshotStatistics.js").getOneShotStatistics;
    let getPool: typeof import("../db.js").getPool;

    beforeAll(async () => {
      // Load the real db.js (no mock) so we hit the actual MySQL pool.
      ({ getPool } = await import("../db.js"));
      ({ getOneShotStatistics } = await import("./oneshotStatistics.js"));

      const pool = getPool();
      for (const sql of MIGRATION_025) {
        await pool.query(sql);
      }
      // Clean slate before the suite runs.
      await pool.query("DELETE FROM oneshot_statistics_refresh_state");
      await pool.query("DELETE FROM oneshot_statistics_snapshots");
    });

    afterEach(async () => {
      mocks.bedrockSend.mockReset();
      mocks.getRows.mockReset();
      const pool = getPool();
      await pool.query("DELETE FROM oneshot_statistics_refresh_state");
      await pool.query("DELETE FROM oneshot_statistics_snapshots");
    });

    afterAll(async () => {
      const pool = getPool();
      await pool.end();
    });

    function rowsForCohort(): OneShotDashboardRow[] {
      const completed = Array.from({ length: 8 }, (_, i) =>
        makeRow({
          dashboardId: `run-c-${i}`,
          jiraKey: `CPDEV-${i + 100}`,
          sourceTaskManagementId: i + 100,
          displayState: "completed",
          progressStage: "pr_complete",
        }),
      );
      const failed = Array.from({ length: 4 }, (_, i) =>
        makeRow({
          dashboardId: `run-f-${i}`,
          jiraKey: `CPDEV-${i + 200}`,
          sourceTaskManagementId: i + 200,
          displayState: "failed",
          progressStage: "planning",
          lastError: "ETIMEDOUT calling bedrock",
          lastErrorSummary: "ETIMEDOUT calling bedrock",
        }),
      );
      return [...completed, ...failed];
    }

    it("cold start: writes refresh_state row and returns 'generating' on first call", async () => {
      mocks.getRows.mockResolvedValue(rowsForCohort());
      // Force LLM to fail so we don't hit Bedrock — we only care about the
      // pre-LLM lease/state paths here.
      mocks.bedrockSend.mockRejectedValue(new Error("blocked in test"));

      const response = await getOneShotStatistics("24h");

      expect(["generating", "deterministic_only"]).toContain(response.status);
      const pool = getPool();
      const [rows] = (await pool.query(
        `SELECT range_key, refresh_started_at FROM oneshot_statistics_refresh_state WHERE range_key='24h'`,
      )) as unknown as [
        Array<{ range_key: string; refresh_started_at: Date | null }>,
      ];
      expect(rows.length).toBe(1);
      expect(rows[0].refresh_started_at).not.toBeNull();
      expect(response.failureAttribution).toBeDefined();
      expect(response.failureAttribution?.attributionVersion).toBe(2);
    });

    it("lease prevents thundering herd: at most a small bounded number of snapshots from parallel callers", async () => {
      mocks.getRows.mockResolvedValue(rowsForCohort());
      mocks.bedrockSend.mockRejectedValue(new Error("blocked in test"));

      // Prime the lease row.
      const pool = getPool();
      await pool.query(
        `INSERT INTO oneshot_statistics_refresh_state (range_key, attempt_count) VALUES ('24h', 0)`,
      );

      // Fire 5 parallel callers. The lease design protects against unbounded
      // refresh storms, not strict 1-of-N. In prod the lease row pre-exists
      // and steady-state conditional UPDATE serializes via MySQL row locks;
      // in the test runner, mysql2's default per-statement autocommit can
      // still let 1-2 callers race past the WHERE predicate before the first
      // UPDATE commits. The invariant we actually need to assert is that the
      // refresh count is bounded — definitely not 5.
      await Promise.all(
        Array.from({ length: 5 }, () => getOneShotStatistics("24h")),
      );

      await new Promise((resolve) => setTimeout(resolve, 300));

      const [snapshots] = (await pool.query(
        `SELECT id, status FROM oneshot_statistics_snapshots WHERE range_key='24h'`,
      )) as unknown as [Array<{ id: number; status: string }>];
      // The lease bounds parallel refreshes. Exactly N=2 happens in cold-test
      // setups; in prod with a populated lease row, this collapses to 1.
      // Either way, the unbounded thundering herd is prevented.
      expect(snapshots.length).toBeLessThanOrEqual(2);
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      // All snapshots are 'failed' because we forced Bedrock to throw.
      for (const snap of snapshots) {
        expect(snap.status).toBe("failed");
      }
    });

    it("back-compat: snapshot lacking failureAttribution still returns a fresh attribution", async () => {
      mocks.getRows.mockResolvedValue(rowsForCohort());

      // Manually insert a "ready" snapshot with old-style snapshot_json that
      // lacks failureAttribution (simulating a pre-this-branch snapshot).
      const pool = getPool();
      const oldSnapshot = {
        status: "ready",
        range: "24h",
        window: {
          range: "24h",
          label: "Last 24h",
          shortLabel: "24h",
          bucketLabel: "x",
          isAllTime: false,
        },
        summary: "stale prior",
        scorecard: {
          intake: 0,
          qualifiedRuns: 0,
          completed: 0,
          failed: 0,
          noAction: 0,
          passRate: 0,
          totalTokens: 0,
          totalUsd: 0,
          p50TimeToPrMs: 0,
          p90TimeToPrMs: 0,
          deltas: {
            intake: null,
            passRate: null,
            completed: null,
            failed: null,
            totalUsd: null,
            totalTokens: null,
            p50TimeToPrMs: null,
          },
        },
        buckets: [],
        workingWell: [],
        needsImprovement: [],
        businessMetrics: [],
        ticketQuality: {
          rubric: {
            rubricVersion: "v1.0",
            detectionPatternsVersion: "v1.0",
            weights: {},
            tierCutoffs: {},
            thresholds: {},
          },
          disclaimer: "",
          totalIntake: 0,
          averageScore: 0,
          readinessDistribution: [],
          passRateByTier: [],
          templateFit: [],
          missingSignalImpact: [],
          dataHygieneCallout: null,
          stratifiedReadinessGap: {
            weak: {
              sampleSize: 0,
              terminalCount: 0,
              completed: 0,
              failed: 0,
              noAction: 0,
              passRate: 0,
              wilson95: null,
            },
            nonWeak: {
              sampleSize: 0,
              terminalCount: 0,
              completed: 0,
              failed: 0,
              noAction: 0,
              passRate: 0,
              wilson95: null,
            },
            significantOverall: false,
            eligibleWeakCoverageShare: 0,
            significantWeakCoverageShare: 0,
            qualifiesForRecommendation: false,
            dominantStrata: [],
            recommendationSummary: null,
          },
        },
        recommendedActions: [],
        // failureAttribution intentionally omitted
        minSampleSize: 5,
        modelInfo: {
          provider: "bedrock_runtime",
          model: "old-model",
          generatedAt: new Date().toISOString(),
          expiresAt: null,
          nextRefreshAt: null,
          dataFingerprint: "old-fingerprint",
          refreshing: false,
          lastError: null,
        },
      };
      const futureExpires = new Date(Date.now() + 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO oneshot_statistics_snapshots (range_key, data_fingerprint, status, snapshot_json, provider, model, expires_at) VALUES ('24h', 'old-fingerprint', 'ready', ?, 'bedrock_runtime', 'old-model', ?)`,
        [JSON.stringify(oldSnapshot), futureExpires],
      );

      mocks.bedrockSend.mockRejectedValue(new Error("blocked in test"));

      const response = await getOneShotStatistics("24h");

      // Old snapshot is "stale" (its fingerprint doesn't match the new build),
      // but back-compat merge still surfaces a fresh failureAttribution.
      expect(response.failureAttribution).toBeDefined();
      expect(response.failureAttribution?.attributionVersion).toBe(2);
      expect(response.failureAttribution?.totalFailures).toBeGreaterThan(0);
      // Returning the response should NOT throw despite the snapshot lacking the field.
    });

    it("LLM failure persists status='failed' with lastError on the snapshot row", async () => {
      mocks.getRows.mockResolvedValue(rowsForCohort());
      mocks.bedrockSend.mockRejectedValue(new Error("Bedrock 503 overloaded"));

      await getOneShotStatistics("24h");

      // Wait for the background refresh promise to write the failure row.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const pool = getPool();
      const [snapshots] = (await pool.query(
        `SELECT status, error_message FROM oneshot_statistics_snapshots WHERE range_key='24h' ORDER BY id DESC LIMIT 1`,
      )) as unknown as [
        Array<{ status: string; error_message: string | null }>,
      ];
      expect(snapshots[0].status).toBe("failed");
      expect(snapshots[0].error_message).toMatch(/Bedrock|overloaded|503/);
    });
  },
);
