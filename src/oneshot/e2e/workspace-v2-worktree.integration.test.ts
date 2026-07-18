/**
 * Workspace v2 pinned-worktree E2E.
 *
 * Prerequisites:
 *   CONTAINER_ENGINE=docker scripts/local-oneshot-cluster.sh up --build --no-orchestrator
 *
 * This test uses real MySQL and real local Git repositories. It does not call
 * real LLM, Jira, S3, or GitHub services.
 */
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { OneShotDatabase } from "../database/index.js";
import { OneShotWorkspaceManager } from "../workspaces.js";
import type { CodeRepository } from "../../orchestrator/database.js";

const describeE2E =
  process.env.ONESHOT_E2E === "1" || process.env.ONESHOT_E2E === "true"
    ? describe
    : describe.skip;

const execFileAsync = promisify(execFile);

const MYSQL_PORT = Number.parseInt(
  process.env.MYSQL_PORT ?? process.env.ONESHOT_LOCAL_MYSQL_PORT ?? "3307",
  10,
);
const MYSQL_PASSWORD =
  process.env.MYSQL_PASS ?? process.env.DB_PASSWORD ?? "specter_local";

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function applyWorkspaceV2Migration(pool: Pool): Promise<void> {
  const migrationSql = await fs.readFile(
    path.join(process.cwd(), "db", "migrations", "018_oneshot_workspace_v2.sql"),
    "utf8",
  );
  await pool.query(migrationSql);
}

async function createRemoteRepo(): Promise<{
  remotePath: string;
  baseSha: string;
}> {
  const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), "oneshot-worktree-remote-"));
  await runGit(["init", "-b", "main"], remotePath);
  await runGit(["config", "user.email", "oneshot-e2e@example.com"], remotePath);
  await runGit(["config", "user.name", "OneShot E2E"], remotePath);
  await fs.mkdir(path.join(remotePath, "src"), { recursive: true });
  await fs.writeFile(path.join(remotePath, "src", "Marker.txt"), "base marker\n", "utf8");
  await runGit(["add", "."], remotePath);
  await runGit(["commit", "-m", "seed remote"], remotePath);
  return { remotePath, baseSha: await runGit(["rev-parse", "HEAD"], remotePath) };
}

async function seedRun(pool: Pool, baseSha: string): Promise<{
  runId: number;
  repoId: number;
  jiraKey: string;
}> {
  const [customerRows] = await pool.query<Array<RowDataPacket & { id: number }>>(
    "SELECT id FROM customer_branches WHERE customer = 'MHK' LIMIT 1",
  );
  const customerId = customerRows[0]?.id;
  if (!customerId) {
    throw new Error("Missing MHK customer row. Run local-oneshot setup first.");
  }

  const [repoRows] = await pool.query<Array<RowDataPacket & { id: number }>>(
    "SELECT id FROM code_repositories WHERE repo_name = 'core-app' LIMIT 1",
  );
  const repoId = repoRows[0]?.id;
  if (!repoId) {
    throw new Error("Missing core-app repo row. Run local-oneshot setup first.");
  }

  const [agentRows] = await pool.query<Array<RowDataPacket & { id: number }>>(
    "SELECT id FROM agents WHERE name = 'QUALIFIER' LIMIT 1",
  );
  const agentId = agentRows[0]?.id;
  if (!agentId) {
    throw new Error("Missing QUALIFIER agent row. Run local-oneshot setup first.");
  }

  const jiraKey = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`;
  await pool.query(
    `INSERT INTO task_management
       (jira_number, customer_id, agent_id, related_code, task_type, task_s3_bucket, task_s3_key, status, source)
     VALUES (?, ?, ?, ?, 'qualification', 'specter-results', ?, 'completed', 'jira')`,
    [jiraKey, customerId, agentId, String(repoId), `tasks/${jiraKey}.md`],
  );
  const [tmRows] = await pool.query<Array<RowDataPacket & { id: number }>>(
    "SELECT id FROM task_management WHERE jira_number = ? LIMIT 1",
    [jiraKey],
  );
  const taskManagementId = tmRows[0]?.id;
  if (!taskManagementId) {
    throw new Error("Failed to seed task_management row.");
  }

  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO oneshot_runs (
       workspace_mode,
       jira_key,
       source_task_management_id,
       customer_id,
       repo_id,
       branch_name,
       base_commit_sha,
       state,
       current_plan_version,
       current_review_version,
       current_implementation_version,
       current_implementation_branch,
       current_implementation_commit_sha,
       current_code_review_version,
       current_test_version
     )
     VALUES ('v2', ?, ?, ?, ?, 'main', ?, 'queued_for_implementation', 1, 1, 1, ?, ?, 1, 1)`,
    [
      jiraKey,
      taskManagementId,
      customerId,
      repoId,
      baseSha,
      `oneshot/${jiraKey.toLowerCase()}`,
      baseSha,
    ],
  );
  return { runId: result.insertId, repoId, jiraKey };
}

describeE2E("workspace v2 pinned worktree E2E", () => {
  let pool: Pool;
  let oneShotDb: OneShotDatabase;
  let repoBasePath: string;
  let workspaceBasePath: string;
  let oldGitHubRepoToken: string | undefined;
  const seededRunIds: number[] = [];
  const seededJiraKeys: string[] = [];

  beforeAll(async () => {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST ?? "127.0.0.1",
      port: MYSQL_PORT,
      user: process.env.MYSQL_USER ?? "root",
      password: MYSQL_PASSWORD,
      database: process.env.MYSQL_DB ?? process.env.DB_NAME ?? "Specter",
      waitForConnections: true,
      connectionLimit: 5,
      multipleStatements: true,
    });
    oneShotDb = new OneShotDatabase(pool);
    await applyWorkspaceV2Migration(pool);
    repoBasePath = await fs.mkdtemp(path.join(os.tmpdir(), "oneshot-worktree-cache-"));
    workspaceBasePath = await fs.mkdtemp(path.join(os.tmpdir(), "oneshot-worktree-runs-"));
    oldGitHubRepoToken = process.env.GITHUB_REPO_TOKEN;
    process.env.GITHUB_REPO_TOKEN = "local-test-token";
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      for (const runId of seededRunIds) {
        await pool.query("DELETE FROM oneshot_notifications WHERE oneshot_run_id = ?", [
          runId,
        ]);
        await pool.query("DELETE FROM oneshot_artifacts WHERE oneshot_run_id = ?", [
          runId,
        ]);
        await pool.query("DELETE FROM oneshot_runs WHERE id = ?", [runId]);
      }
      for (const jiraKey of seededJiraKeys) {
        await pool.query("DELETE FROM task_management WHERE jira_number = ?", [
          jiraKey,
        ]);
      }
      await pool.end();
    }
    await Promise.allSettled([
      repoBasePath ? fs.rm(repoBasePath, { recursive: true, force: true }) : Promise.resolve(),
      workspaceBasePath
        ? fs.rm(workspaceBasePath, { recursive: true, force: true })
        : Promise.resolve(),
    ]);
    if (oldGitHubRepoToken === undefined) {
      delete process.env.GITHUB_REPO_TOKEN;
    } else {
      process.env.GITHUB_REPO_TOKEN = oldGitHubRepoToken;
    }
  });

  it("prepares, records, finalizes, reuses local candidate SHA, and cleans a v2 worktree", async () => {
    const remote = await createRemoteRepo();
    const seeded = await seedRun(pool, remote.baseSha);
    seededRunIds.push(seeded.runId);
    seededJiraKeys.push(seeded.jiraKey);
    const repo: Pick<CodeRepository, "repo_name" | "repo_url"> = {
      repo_name: `core-app-${randomUUID().slice(0, 8)}`,
      repo_url: remote.remotePath,
    };
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: oneShotDb.workspaceLeases,
      workspaceStateStore: oneShotDb.workspaceState,
      leaseOwnerTaskArn: "local-worktree-e2e",
      leaseTtlSeconds: 60,
      leaseHeartbeatSeconds: 1,
      repoCacheFreshnessTtlMs: 60_000,
    });

    const implementationBranch = `oneshot/e2e-${seeded.runId}`;
    const buildWorkspace = await manager.prepareImplementerWorkspace(
      seeded.runId,
      repo,
      remote.baseSha,
      implementationBranch,
      "main",
    );
    expect(buildWorkspace.workspacePath).toBe(
      path.join(workspaceBasePath, String(seeded.runId), "worktree"),
    );
    expect(await runGit(["rev-parse", "HEAD"], buildWorkspace.workspacePath)).toBe(
      remote.baseSha,
    );
    expect(buildWorkspace.lease).toBeDefined();

    const [leaseRows] = await pool.query<
      Array<RowDataPacket & { owner_task_arn: string | null; owner_stage: string | null }>
    >(
      "SELECT owner_task_arn, owner_stage FROM oneshot_workspace_leases WHERE scope = ?",
      [`run-worktree:${seeded.runId}`],
    );
    expect(leaseRows[0]?.owner_task_arn).toBe("local-worktree-e2e");
    expect(leaseRows[0]?.owner_stage).toBe("implementer");

    const [initialStateRows] = await pool.query<
      Array<
        RowDataPacket & {
          workspace_path: string;
          workspace_phase: string;
          workspace_head_sha: string;
          last_repo_fetch_at: Date | null;
          last_remote_head_sha: string | null;
          metadata_json: string | Record<string, unknown> | null;
        }
      >
    >(
      `SELECT workspace_path,
              workspace_phase,
              workspace_head_sha,
              last_repo_fetch_at,
              last_remote_head_sha,
              metadata_json
         FROM oneshot_workspace_state
        WHERE oneshot_run_id = ?`,
      [seeded.runId],
    );
    expect(initialStateRows[0]?.workspace_path).toBe(buildWorkspace.workspacePath);
    expect(initialStateRows[0]?.workspace_phase).toBe("implementer");
    expect(initialStateRows[0]?.workspace_head_sha).toBe(remote.baseSha);
    expect(initialStateRows[0]?.last_repo_fetch_at).toBeTruthy();
    expect(initialStateRows[0]?.last_remote_head_sha).toBe(remote.baseSha);

    const finalized = await oneShotDb.candidateVersions.finalizeCandidate({
      oneshotRunId: seeded.runId,
      candidateVersion: 1,
      candidateCommitSha: remote.baseSha,
      previousCandidateCommitSha: null,
      targetFiles: ["src/Marker.txt"],
      metadata: { source: "workspace-v2-worktree-e2e" },
      leaseScope: buildWorkspace.lease!.scope,
      fencingToken: buildWorkspace.lease!.fencingToken,
    });
    expect(finalized).toBe(true);

    const stateUpdated = await oneShotDb.workspaceState.conditionalUpdateWithLease({
      oneshotRunId: seeded.runId,
      leaseScope: buildWorkspace.lease!.scope,
      fencingToken: buildWorkspace.lease!.fencingToken,
      currentCandidateVersion: 1,
      currentCandidateSha: remote.baseSha,
    });
    expect(stateUpdated).toBe(true);
    await buildWorkspace.cleanup();

    const currentCandidate = await oneShotDb.candidateVersions.getCurrentCandidate(
      seeded.runId,
    );
    expect(currentCandidate?.candidateVersion).toBe(1);
    expect(currentCandidate?.candidateCommitSha).toBe(remote.baseSha);
    expect(currentCandidate?.targetFiles).toEqual(["src/Marker.txt"]);

    const testerWorkspace = await manager.prepareTesterWorkspace(
      seeded.runId,
      repo,
      remote.baseSha,
      implementationBranch,
      "main",
    );
    expect(await runGit(["rev-parse", "HEAD"], testerWorkspace.workspacePath)).toBe(
      remote.baseSha,
    );

    const [freshStateRows] = await pool.query<
      Array<RowDataPacket & { metadata_json: string | Record<string, unknown> | null }>
    >(
      "SELECT metadata_json FROM oneshot_workspace_state WHERE oneshot_run_id = ?",
      [seeded.runId],
    );
    const metadata =
      typeof freshStateRows[0]?.metadata_json === "string"
        ? JSON.parse(freshStateRows[0].metadata_json)
        : freshStateRows[0]?.metadata_json;
    expect(metadata?.repoCacheFetchReason).toBe("candidate_sha_local");
    await testerWorkspace.cleanup();

    const cleanupStatus = await manager.cleanupRunWorkspace(seeded.runId);
    expect(cleanupStatus).toBe("cleaned");
    await expect(
      fs.access(path.join(workspaceBasePath, String(seeded.runId))),
    ).rejects.toThrow();

    const worktreeList = await runGit(["worktree", "list", "--porcelain"], buildWorkspace.repoRoot);
    expect(worktreeList).not.toContain(testerWorkspace.workspacePath);
  }, 45_000);
});
