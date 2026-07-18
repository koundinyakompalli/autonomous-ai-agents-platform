import { describe, expect, it, vi } from "vitest";
import { validateRepoRouterSchema } from "./schema-validation.js";

function createPool(options: {
  tables?: string[];
  statusColumnType?: string | null;
} = {}) {
  const tables = options.tables ?? [
    "router_decisions",
    "router_confirmations",
    "historical_ticket_index",
  ];
  const statusColumnType =
    options.statusColumnType ??
    "enum('assigned','in_progress','waiting_repo_confirmation','completed','failed','failed_retries_exhausted','posting_to_jira','posted_to_jira')";
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT DATABASE()")) {
      return [[{ dbName: "Specter" }], undefined];
    }
    if (sql.includes("FROM information_schema.tables")) {
      return [[tables.map((tableName) => ({ tableName })).flat()], undefined];
    }
    if (sql.includes("FROM information_schema.columns")) {
      return [
        statusColumnType ? [{ columnType: statusColumnType }] : [],
        undefined,
      ];
    }
    const tableProbe = sql.match(/SELECT 1 FROM `([^`]+)` LIMIT 0/);
    if (tableProbe && tables.includes(tableProbe[1])) {
      return [[], undefined];
    }
    const error = new Error(`Unexpected SQL in test: ${sql}`) as Error & {
      code?: string;
    };
    if (tableProbe) {
      error.code = "ER_NO_SUCH_TABLE";
    }
    throw error;
  });
  return { query } as never;
}

describe("validateRepoRouterSchema", () => {
  it("passes when migration 016 tables and waiting status enum are present", async () => {
    await expect(validateRepoRouterSchema(createPool())).resolves.toBeUndefined();
  });

  it("fails loudly when a RepoRouter table is missing", async () => {
    await expect(
      validateRepoRouterSchema(
        createPool({
          tables: ["router_decisions", "router_confirmations"],
        }),
      ),
    ).rejects.toThrow(/historical_ticket_index.*migration 016/i);
  });

  it("fails loudly when waiting_repo_confirmation is not in task status", async () => {
    await expect(
      validateRepoRouterSchema(
        createPool({
          statusColumnType:
            "enum('assigned','in_progress','completed','failed','failed_retries_exhausted','posting_to_jira','posted_to_jira')",
        }),
      ),
    ).rejects.toThrow(/waiting_repo_confirmation.*migration 016/i);
  });
});
