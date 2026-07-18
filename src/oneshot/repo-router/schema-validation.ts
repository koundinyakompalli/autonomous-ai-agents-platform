import type mysql from "mysql2/promise";

export const REPO_ROUTER_REQUIRED_TABLES = [
  "router_decisions",
  "router_confirmations",
  "historical_ticket_index",
] as const;

function readAliasedValue(
  row: mysql.RowDataPacket | undefined,
  aliases: string[],
): string | null {
  if (!row) {
    return null;
  }
  for (const alias of aliases) {
    const value = row[alias];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function getCurrentDatabaseName(pool: mysql.Pool): Promise<string> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT DATABASE() AS dbName",
  );
  const dbName = readAliasedValue(rows[0], ["dbName", "DATABASE()"]);
  if (!dbName) {
    throw new Error(
      "RepoRouter schema validation failed: could not determine active database name",
    );
  }
  return dbName;
}

async function canQueryTable(
  pool: mysql.Pool,
  tableName: (typeof REPO_ROUTER_REQUIRED_TABLES)[number],
): Promise<boolean> {
  try {
    await pool.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: string }).code;
    if (code === "ER_NO_SUCH_TABLE") {
      return false;
    }
    throw error;
  }
}

function hasWaitingRepoConfirmationEnumValue(columnType: string | null): boolean {
  return (
    typeof columnType === "string" &&
    /'waiting_repo_confirmation'/.test(columnType)
  );
}

export async function validateRepoRouterSchema(pool: mysql.Pool): Promise<void> {
  const dbName = await getCurrentDatabaseName(pool);

  const [tableRows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT table_name AS tableName
       FROM information_schema.tables
      WHERE table_schema = ?
        AND table_name IN (${REPO_ROUTER_REQUIRED_TABLES.map(() => "?").join(", ")})`,
    [dbName, ...REPO_ROUTER_REQUIRED_TABLES],
  );

  const presentTables = new Set(
    tableRows
      .map((row) => readAliasedValue(row, ["tableName", "table_name"]))
      .filter((tableName): tableName is string => Boolean(tableName)),
  );
  for (const table of REPO_ROUTER_REQUIRED_TABLES) {
    if (!presentTables.has(table) && (await canQueryTable(pool, table))) {
      presentTables.add(table);
    }
  }

  const missingTables = REPO_ROUTER_REQUIRED_TABLES.filter(
    (table) => !presentTables.has(table),
  );
  if (missingTables.length > 0) {
    throw new Error(
      `RepoRouter schema validation failed: missing required tables ${missingTables.join(", ")} in schema ${dbName}. ` +
        "Run migration 016 before starting this service.",
    );
  }

  const [statusRows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT column_type AS columnType
       FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'task_management'
        AND column_name = 'status'
      LIMIT 1`,
    [dbName],
  );
  const statusColumnType = readAliasedValue(statusRows[0], [
    "columnType",
    "column_type",
  ]);
  if (!hasWaitingRepoConfirmationEnumValue(statusColumnType)) {
    throw new Error(
      "RepoRouter schema validation failed: task_management.status does not include waiting_repo_confirmation. " +
        "Run migration 016 before starting this service.",
    );
  }
}
