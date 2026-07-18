import type mysql from "mysql2/promise";
import type { JiraClient } from "../orchestrator/JiraClient.js";
import { getDatabase } from "../orchestrator/database.js";
import type { SpecFactoryChildTicketSummary } from "./types.js";
import { PFOS_LABEL } from "./types.js";

type JiraLabelClient = Pick<JiraClient, "updateIssueLabels">;
type PoolLike = Pick<mysql.Pool, "query">;

export interface SpecFactoryActor {
  id: string;
  display: string;
}

export interface OneShotSubmitChildrenInput {
  children: SpecFactoryChildTicketSummary[];
  actor: SpecFactoryActor;
  onChildSubmitted?: (result: OneShotSubmitChildResult) => Promise<void>;
}

export interface OneShotSubmitChildResult {
  childId: number;
  requestId: number | null;
}

type CreateRunRequest = (
  jiraKey: string,
  actor: SpecFactoryActor,
) => Promise<number | null>;

interface RunRequestRow extends mysql.RowDataPacket {
  id: number;
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ER_DUP_ENTRY"
  );
}

async function findExistingRunRequestId(
  pool: PoolLike,
  jiraKey: string,
): Promise<number | null> {
  const [rows] = await pool.query<RunRequestRow[]>(
    `SELECT id
     FROM oneshot_dashboard_run_requests
     WHERE jira_key = ?
       AND status IN ('queued', 'processing', 'task_created')
     ORDER BY id DESC
     LIMIT 1`,
    [jiraKey],
  );

  return rows[0]?.id ?? null;
}

async function defaultCreateRunRequest(
  pool: PoolLike,
  jiraKey: string,
  actor: SpecFactoryActor,
): Promise<number | null> {
  const existingId = await findExistingRunRequestId(pool, jiraKey);
  if (existingId !== null) return existingId;

  try {
    const [result] = await pool.query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_dashboard_run_requests
       (jira_key, requested_by, requested_by_display, status)
       VALUES (?, ?, ?, 'queued')`,
      [jiraKey, actor.id, actor.display],
    );
    return result.insertId;
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
    return findExistingRunRequestId(pool, jiraKey);
  }
}

export class OneShotSubmitter {
  private readonly createRunRequest: CreateRunRequest;

  constructor(
    private readonly jiraClient: JiraLabelClient,
    createRunRequest?: CreateRunRequest,
    pool?: PoolLike,
  ) {
    this.createRunRequest =
      createRunRequest ??
      ((jiraKey, actor) =>
        defaultCreateRunRequest(
          pool ?? getDatabase().getPool(),
          jiraKey,
          actor,
        ));
  }

  async submitChildren(
    input: OneShotSubmitChildrenInput,
  ): Promise<OneShotSubmitChildResult[]> {
    const results: OneShotSubmitChildResult[] = [];

    for (const child of input.children) {
      if (!child.jiraKey) {
        throw new Error(
          `Cannot submit Spec Factory child ${child.id} without a Jira key`,
        );
      }

      // Order matters: create the OneShot run request FIRST, then apply
      // PFOS. The run request is the irreversible side-effect that
      // OneShot's pipeline keys on; if PFOS fails after the run is
      // queued the run still progresses (and a retry is dedupe-safe via
      // findExistingRunRequestId). The reverse order would orphan a
      // PFOS-labeled ticket with no run request behind it on a crash.
      const requestId = await this.createRunRequest(child.jiraKey, input.actor);
      await this.jiraClient.updateIssueLabels(child.jiraKey, {
        add: [PFOS_LABEL],
      });
      const result = { childId: child.id, requestId };
      await input.onChildSubmitted?.(result);
      results.push(result);
    }

    return results;
  }
}
