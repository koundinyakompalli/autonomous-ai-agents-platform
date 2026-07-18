import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = "dist/server/dashboard/server/index.js";
const entryPath = path.join(dashboardRoot, entry);

if (!existsSync(entryPath)) {
  console.error(`[dashboard] Missing server entry: ${entry}`);
  console.error("[dashboard] Expected TypeScript server output under dist/server/dashboard/server/.");
  process.exit(1);
}

console.log(`[dashboard] Server entry verified: ${entry}`);
