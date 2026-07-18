import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = path.join(repoRoot, "db", "migrations");
const schemaPath = path.join(repoRoot, "db", "schema.sql");
const tablePrefix = /^(?:compose_|spec_factory_)/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectMatches(input, pattern, valueAt = 1) {
  return [...input.matchAll(pattern)].map((match) => match[valueAt]);
}

function parseCreateTableBlocks(sql) {
  const tables = new Map();
  const pattern =
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?([a-z0-9_]+)`?\s*\(([\s\S]*?)\)\s*ENGINE\s*=/gi;
  for (const match of sql.matchAll(pattern)) {
    tables.set(match[1], match[2]);
  }
  return tables;
}

function assertNoItems(message, values) {
  if (values.length === 0) return;
  throw new Error(`${message}:\n- ${values.join("\n- ")}`);
}

const schemaSql = await readFile(schemaPath, "utf8");
const schemaTables = parseCreateTableBlocks(schemaSql);
const allSchemaTableNames = new Set(schemaTables.keys());
const specFactorySchemaTables = new Set(
  [...schemaTables.keys()].filter((name) => tablePrefix.test(name)),
);

const migrationFiles = (await readdir(migrationsDir))
  .filter(
    (name) =>
      name.endsWith(".sql") &&
      (name.includes("compose") || name.includes("spec_factory")),
  )
  .sort();

assertNoItems(
  "Spec Factory migration filenames must start with a three-digit sequence",
  migrationFiles.filter((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name)),
);

const migrations = await Promise.all(
  migrationFiles.map(async (name) => ({
    name,
    sql: await readFile(path.join(migrationsDir, name), "utf8"),
  })),
);
const combinedMigrationSql = migrations.map(({ sql }) => sql).join("\n");
const migrationCreatedTables = new Set(
  collectMatches(
    combinedMigrationSql,
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?([a-z0-9_]+)`?/gi,
  ).filter((name) => tablePrefix.test(name)),
);

assertNoItems(
  "Tables created by Spec Factory migrations are missing from db/schema.sql",
  [...migrationCreatedTables].filter(
    (name) => !specFactorySchemaTables.has(name),
  ),
);
assertNoItems(
  "Canonical Spec Factory tables have no create-table migration",
  [...specFactorySchemaTables].filter(
    (name) => !migrationCreatedTables.has(name),
  ),
);

const missingColumns = [];
const addColumnPattern =
  /ALTER\s+TABLE\s+`?([a-z0-9_]+)`?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-z0-9_]+)`?/gi;
for (const { name: migrationName, sql } of migrations) {
  for (const match of sql.matchAll(addColumnPattern)) {
    const [, tableName, columnName] = match;
    if (!tablePrefix.test(tableName)) continue;
    const tableBlock = schemaTables.get(tableName);
    if (!tableBlock) {
      missingColumns.push(`${migrationName}: missing table ${tableName}`);
      continue;
    }
    const columnPattern = new RegExp(
      "(?:^|\\n)\\s*`?" + escapeRegExp(columnName) + "`?\\s+",
      "i",
    );
    if (!columnPattern.test(tableBlock)) {
      missingColumns.push(`${migrationName}: ${tableName}.${columnName}`);
    }
  }
}
assertNoItems(
  "Columns added by Spec Factory migrations are missing from db/schema.sql",
  missingColumns,
);

const invalidTimestampSources = [];
for (const { name, sql } of migrations) {
  if (/\bDATETIME\b/i.test(sql)) invalidTimestampSources.push(name);
}
for (const [name, block] of schemaTables) {
  if (tablePrefix.test(name) && /\bDATETIME\b/i.test(block)) {
    invalidTimestampSources.push(`db/schema.sql:${name}`);
  }
}
assertNoItems(
  "Spec Factory persistence must use TIMESTAMP(3), not DATETIME",
  invalidTimestampSources,
);

const missingForeignKeyTargets = [];
for (const [tableName, block] of schemaTables) {
  if (!tablePrefix.test(tableName)) continue;
  const referencedTables = collectMatches(
    block,
    /REFERENCES\s+`?([a-z0-9_]+)`?/gi,
  );
  for (const referencedTable of referencedTables) {
    if (!allSchemaTableNames.has(referencedTable)) {
      missingForeignKeyTargets.push(`${tableName} -> ${referencedTable}`);
    }
  }
}
assertNoItems(
  "Spec Factory foreign keys reference tables missing from db/schema.sql",
  missingForeignKeyTargets,
);

console.log(
  `Spec Factory schema verified: ${migrationFiles.length} migrations, ${specFactorySchemaTables.size} tables.`,
);
