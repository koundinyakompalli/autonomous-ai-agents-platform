import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import type { InvestigationClientTarget } from "../../../src/investigation/index.js";

type AgentRow = mysql.RowDataPacket & {
  id: number;
  task_type: string | null;
};

type CustomerBranchRow = mysql.RowDataPacket & {
  id: number;
};

type TaskManagementRow = mysql.RowDataPacket & {
  id: number;
  status: string;
};

export interface AgentTaskHandoffInput {
  agentName: string;
  jiraKey: string;
  client: InvestigationClientTarget;
  taskType?: string;
  source?: "api" | "jira" | "harvey";
}

export interface AgentTaskHandoffResult {
  status: "created" | "existing" | "skipped" | "failed";
  reason: string;
  taskManagementId?: number;
}

function normalizeAgentName(agentName: string): string {
  return agentName.trim().toUpperCase();
}

async function findAgent(agentName: string): Promise<AgentRow | undefined> {
  const [rows] = await getPool().execute<AgentRow[]>(
    "SELECT id, task_type FROM agents WHERE UPPER(name) = ? LIMIT 1",
    [normalizeAgentName(agentName)],
  );
  return rows[0];
}

async function getOrCreateCustomerBranch(client: InvestigationClientTarget): Promise<number> {
  const candidates = Array.from(new Set([
    client.displayName,
    client.id,
    ...(client.aliases || []),
  ].filter((entry): entry is string => Boolean(entry?.trim()))));

  for (const candidate of candidates) {
    const [rows] = await getPool().execute<CustomerBranchRow[]>(
      "SELECT id FROM customer_branches WHERE LOWER(customer) = LOWER(?) LIMIT 1",
      [candidate],
    );
    if (rows[0]?.id) {
      return rows[0].id;
    }
  }

  const customerName = client.displayName || client.id;
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    "INSERT INTO customer_branches (customer, branch, `default`) VALUES (?, 'master', 0)",
    [customerName],
  );
  return result.insertId;
}

async function findExistingTask(jiraKey: string, agentId: number): Promise<TaskManagementRow | undefined> {
  const [rows] = await getPool().execute<TaskManagementRow[]>(
    "SELECT id, status FROM task_management WHERE jira_number = ? AND agent_id = ? LIMIT 1",
    [jiraKey, agentId],
  );
  return rows[0];
}

export function formatPlatformDbError(error: unknown): string {
  if (error instanceof Error) {
    const errorDetails = error as unknown as Record<string, unknown>;
    const code = typeof errorDetails.code === "string" ? errorDetails.code : undefined;
    const detailParts = [
      error.message || (code === "ECONNREFUSED" ? "connection refused" : ""),
      ...(Object.entries(errorDetails)
        .filter(([key]) => ["code", "errno", "sqlState", "sqlMessage"].includes(key))
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
        .map(([key, value]) => `${key}=${String(value)}`)),
    ].filter((entry) => entry.trim());
    return detailParts.join("; ");
  }

  if (typeof error === "string") {
    return error.trim();
  }

  try {
    const serialized = JSON.stringify(error);
    return serialized === "{}" ? "" : serialized;
  } catch {
    return String(error).trim();
  }
}

export async function createAgentTaskHandoff(input: AgentTaskHandoffInput): Promise<AgentTaskHandoffResult> {
  const agentName = normalizeAgentName(input.agentName);
  try {
    const agent = await findAgent(agentName);
    if (!agent) {
      return { status: "skipped", reason: `${agentName} agent row was not found in the platform DB.` };
    }

    const existing = await findExistingTask(input.jiraKey, agent.id);
    if (existing) {
      return {
        status: "existing",
        taskManagementId: existing.id,
        reason: `${agentName} task already exists for this Jira ticket with status ${existing.status}.`,
      };
    }

    const customerId = await getOrCreateCustomerBranch(input.client);
    const [insertResult] = await getPool().execute<mysql.ResultSetHeader>(
      `
        INSERT INTO task_management (
          jira_number, customer_id, agent_id, related_code, task_type, source, status
        ) VALUES (?, ?, ?, '', ?, ?, 'assigned')
      `,
      [
        input.jiraKey,
        customerId,
        agent.id,
        input.taskType || agent.task_type || agentName.toLowerCase(),
        input.source || "api",
      ],
    );

    return {
      status: "created",
      taskManagementId: insertResult.insertId,
      reason: `${agentName} task queued for worker pickup.`,
    };
  } catch (error) {
    const message = formatPlatformDbError(error)
      || "platform task creation failed without a returned error message";
    return {
      status: "failed",
      reason: `platform DB task creation failed: ${message}`,
    };
  }
}
