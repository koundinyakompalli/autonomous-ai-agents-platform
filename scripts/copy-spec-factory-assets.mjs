import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(
  repoRoot,
  "src",
  "spec-factory",
  "context",
  "mhk-organizational-context.md",
);
const destination = path.join(
  repoRoot,
  "dist",
  "spec-factory",
  "context",
  "mhk-organizational-context.md",
);

await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
