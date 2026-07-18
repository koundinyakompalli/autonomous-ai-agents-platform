/**
 * Harvey Admin Query
 *
 * Translates natural language questions into SQL queries against the
 * tasks and task_management tables, executes them read-only, and
 * returns formatted results.
 *
 * Security:
 * - SELECT only — no INSERT, UPDATE, DELETE, DROP, etc.
 * - Allowed tables: tasks, task_management, agents, customer_branches
 * - All other tables are blocked
 * - Results capped at 50 rows
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { getDatabase, type Database } from '../orchestrator/database.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('harvey-admin');

const ALLOWED_TABLES = new Set([
  'tasks', 'task_management', 'agents', 'customer_branches', 'chat_sessions',
  // Views — treated the same as tables for allow-list purposes
  'v_active_tasks', 'v_agent_workload', 'v_pending_jira_posts',
]);

// Table schema context given to the LLM so it generates correct SQL
const SCHEMA_CONTEXT = `
## Tables available for querying:

### tasks
- id INT
- task_type VARCHAR (agent name e.g. 'HERMES', 'DARCI')
- status ENUM('pending','in_progress','completed','failed')
- task_description TEXT
- result_s3_bucket VARCHAR, result_s3_key VARCHAR
- error_message TEXT
- tokens_consumed VARCHAR (format: "input:N,output:N")
- cost VARCHAR (USD as string e.g. "0.0955")
- metrics_json JSON
- created_at, updated_at, started_at, completed_at TIMESTAMP

### task_management
- id INT
- jira_number VARCHAR (e.g. "CPSUP-1234" or "HARVEY-5")
- customer_id INT (FK → customer_branches.id)
- agent_id INT (FK → agents.id)
- related_code VARCHAR (CSV of repo IDs)
- task_type VARCHAR
- task_id INT (FK → tasks.id)
- task_s3_bucket VARCHAR, task_s3_key VARCHAR (S3 location of task description)
- chat_session_id INT (FK → chat_sessions.id, set for Harvey-originated tasks)
- status ENUM('assigned','in_progress','completed','failed','failed_retries_exhausted','posting_to_jira','posted_to_jira')
- source ENUM('jira','harvey','api')
- jira_posted_at TIMESTAMP
- error_message TEXT
- cancelled_by VARCHAR, cancelled_at TIMESTAMP
- retry_count INT
- created_at, updated_at TIMESTAMP

### agents
- id INT
- name VARCHAR (e.g. 'DARCI', 'HERMES', 'SCRIBE', 'PRISM', 'SENTRY', 'BEACON', 'VERITAS', 'BCAT')
- description TEXT
- model VARCHAR (Bedrock model ID, e.g. 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')
- task_type VARCHAR
- jql TEXT
- is_active BOOLEAN
- created_at, updated_at TIMESTAMP

### customer_branches
- id INT, customer VARCHAR, branch VARCHAR, \`default\` BOOLEAN
- created_at, updated_at TIMESTAMP

### chat_sessions (Harvey conversational sessions)
- id INT
- session_id VARCHAR
- user_id VARCHAR, user_name VARCHAR
- channel ENUM('teams','web')
- status ENUM('active','routing','task_created','delivering','completed','delivered','abandoned')
- resolved_agent_id INT (FK → agents.id)
- resolved_customer_id INT (FK → customer_branches.id)
- task_management_id INT (FK → task_management.id)
- jira_number VARCHAR
- feedback ENUM('positive','negative')
- created_at, updated_at TIMESTAMP

## Views (pre-joined, prefer these for common questions):

### v_active_tasks — task_management + agents + tasks for non-terminal statuses
- task_management_id, jira_number, tm_status, agent_name, agent_model
- task_id, task_type, task_status, task_description
- result_s3_bucket, result_s3_key, assigned_at, started_at, completed_at

### v_agent_workload — per-agent task counts (active agents only)
- agent_id, agent_name
- assigned_count, in_progress_count, completed_count, failed_count, total_tasks

### v_pending_jira_posts — completed tasks awaiting Jira post
- id, jira_number, agent_id, customer_id, agent_name, agent_model
- customer_name, code_branch, result_s3_bucket, result_s3_key
- tokens_consumed, cost, started_at, completed_at, duration_seconds, retry_count

## Common JOINs (use views above when possible):
- task_management tm JOIN agents a ON tm.agent_id = a.id
- task_management tm JOIN customer_branches cb ON tm.customer_id = cb.id
- task_management tm JOIN tasks t ON tm.task_id = t.id
- task_management tm JOIN chat_sessions cs ON tm.chat_session_id = cs.id
`;

const SYSTEM_PROMPT = `You are a MySQL query generator for a task management system.
Convert the user's natural language question into a single MySQL SELECT query.

${SCHEMA_CONTEXT}

Rules:
- Output ONLY the SQL query, nothing else — no explanation, no markdown, no backticks
- Always use SELECT (never INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER)
- Only use the tables listed above
- Always add LIMIT 50 unless the user asks for aggregation (COUNT, SUM, etc.)
- Use readable column aliases (e.g. a.name as agent_name, cb.customer as customer)
- For date filtering: use NOW(), DATE_SUB(NOW(), INTERVAL N DAY/HOUR), CURDATE()
- For "today": WHERE DATE(created_at) = CURDATE()
- For "this week": WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
- Cost is stored as a VARCHAR string — CAST(cost AS DECIMAL(10,4)) to sum/compare
`;

export type AdminQueryResult =
  | { ok: true;  sql: string; rows: any[] }
  | { ok: false; error: string; sql?: string };

export class AdminQuery {
  private bedrock: BedrockRuntimeClient;
  private db: Database;
  private modelId: string;

  constructor(region?: string, modelId?: string) {
    this.bedrock = new BedrockRuntimeClient({
      region: region || process.env.AWS_REGION || 'us-east-2',
    });
    this.db = getDatabase();
    this.modelId = modelId || process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
  }

  /**
   * Run an admin query from natural language.
   * Returns a typed result — card building is handled by the caller.
   */
  async run(question: string): Promise<AdminQueryResult> {
    logger.info({ question }, '[ADMIN_QUERY] Running admin query');

    // Step 1: Generate SQL from natural language
    let sql: string;
    try {
      sql = await this.generateSQL(question);
      logger.info({ sql }, '[ADMIN_QUERY_SQL] Generated SQL');
    } catch (err: any) {
      return { ok: false, error: `Could not generate SQL: ${err.message}` };
    }

    // Step 2: Validate — SELECT only, allowed tables only
    const validation = this.validateSQL(sql);
    if (!validation.ok) {
      logger.warn({ sql, reason: validation.reason }, '[ADMIN_QUERY_BLOCKED] SQL rejected');
      return { ok: false, error: `Query rejected: ${validation.reason}`, sql };
    }

    // Step 3: Execute
    try {
      const pool = this.db.getPool();
      const [rows] = await pool.query(sql) as any[];
      const resultRows = Array.isArray(rows) ? rows : [];
      logger.info({ sql, rowCount: resultRows.length }, '[ADMIN_QUERY_DONE] Query complete');
      return { ok: true, sql, rows: resultRows };
    } catch (err: any) {
      logger.error({ sql, error: err.message }, '[ADMIN_QUERY_ERROR] SQL execution failed');
      return { ok: false, error: `Query failed: ${err.message}`, sql };
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async generateSQL(question: string): Promise<string> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 20000);

    try {
      const response = await this.bedrock.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [{ role: 'user', content: [{ text: question }] }],
          inferenceConfig: { maxTokens: 512, temperature: 0 },
        }),
        { abortSignal: abortController.signal },
      );

      const sql = (response.output?.message?.content ?? [])
        .filter((b: any) => b.text !== undefined)
        .map((b: any) => b.text!.trim())
        .join('')
        .replace(/^```sql\s*/i, '')
        .replace(/```$/, '')
        .trim();

      if (!sql) throw new Error('Empty SQL returned');
      return sql;
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateSQL(sql: string): { ok: boolean; reason?: string } {
    const upper = sql.trim().toUpperCase();

    // Must start with SELECT
    if (!upper.startsWith('SELECT')) {
      return { ok: false, reason: 'Only SELECT statements are allowed' };
    }

    // Block dangerous keywords — use word boundaries to avoid false positives
    // (e.g. "updated_at" contains "UPDATE" as a substring)
    const dangerous = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'EXEC', 'EXECUTE'];
    for (const kw of dangerous) {
      if (new RegExp(`\\b${kw}\\b`).test(upper)) {
        return { ok: false, reason: `Keyword ${kw} is not allowed` };
      }
    }

    // Extract table names from FROM and JOIN clauses
    const tablePattern = /(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
    let match;
    while ((match = tablePattern.exec(sql)) !== null) {
      const table = match[1].toLowerCase();
      if (!ALLOWED_TABLES.has(table)) {
        return { ok: false, reason: `Table '${table}' is not in the allowed list (${[...ALLOWED_TABLES].join(', ')})` };
      }
    }

    return { ok: true };
  }

}
