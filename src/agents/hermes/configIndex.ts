import { access, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface HermesConfigIndexInput {
  repositoryPath?: string;
  query: string;
  additionalContext?: string;
  maxTerms?: number;
  maxMatchesPerTerm?: number;
}

interface ConfigHit {
  scope: "config" | "code";
  term: string;
  file: string;
  line: string;
  preview: string;
}

const STOP_WORDS = new Set([
  "configuration",
  "config",
  "does",
  "find",
  "setting",
  "what",
  "where",
  "with",
]);

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function extractHermesTerms(text: string, maxTerms: number): string[] {
  const exactCodes = Array.from(
    text.matchAll(/[A-Z][A-Z0-9_]{5,}/g),
    (match) => match[0],
  );
  const identifiers = Array.from(
    text.matchAll(/[A-Za-z_][A-Za-z0-9_.-]{4,}/g),
    (match) => match[0],
  );
  const filteredIdentifiers = identifiers.filter((term) => {
    const lower = term.toLowerCase();
    return (
      !STOP_WORDS.has(lower) &&
      (term.includes("_") ||
        term.includes(".") ||
        /[A-Z]/.test(term.slice(1)) ||
        term.length >= 10)
    );
  });
  return unique([...exactCodes, ...filteredIdentifiers]).slice(0, maxTerms);
}

async function pathExists(value: string): Promise<boolean> {
  return access(value)
    .then(() => true)
    .catch(() => false);
}

async function searchTerm(
  repositoryPath: string,
  term: string,
  scope: "config" | "code",
  maxMatches: number,
): Promise<ConfigHit[]> {
  const searchRoot = scope === "config" ? "config" : ".";
  if (!(await pathExists(path.join(repositoryPath, searchRoot)))) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--fixed-strings",
        "--max-count",
        String(maxMatches),
        "--glob",
        "!node_modules/**",
        "--glob",
        "!dist/**",
        "--glob",
        "!target/**",
        "--",
        term,
        searchRoot,
      ],
      {
        cwd: repositoryPath,
        maxBuffer: 256 * 1024,
      },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(":");
        const file = parts.shift() ?? "";
        const lineNumber = parts.shift() ?? "";
        return {
          scope,
          term,
          file,
          line: lineNumber,
          preview: parts.join(":").trim().slice(0, 240),
        };
      })
      .filter((hit) => hit.file && hit.line);
  } catch {
    return [];
  }
}

function formatHits(scope: "config" | "code", hits: ConfigHit[]): string {
  const scopedHits = hits.filter((hit) => hit.scope === scope);
  if (scopedHits.length === 0) {
    return `- No ${scope} hits found for extracted query terms.`;
  }
  return scopedHits
    .slice(0, 25)
    .map(
      (hit) =>
        `- \`${hit.file}:${hit.line}\` matched \`${hit.term}\`: ${hit.preview}`,
    )
    .join("\n");
}

async function collectConfigFileInventory(
  repositoryPath: string,
  maxFiles = 40,
): Promise<string[]> {
  const configRoot = path.join(repositoryPath, "config");
  if (!(await pathExists(configRoot))) {
    return [];
  }
  const files: string[] = [];

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (files.length >= maxFiles || depth > 4) {
      return;
    }
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        break;
      }
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(repositoryPath, absolutePath);
      if (entry.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (
        /\.(md|properties|ya?ml|xml|sql|json|env|ini|conf)$/i.test(entry.name)
      ) {
        files.push(relativePath);
      }
    }
  }

  await walk(configRoot, 0);
  return files.sort();
}

function formatConfigFileInventory(files: string[]): string {
  if (files.length === 0) {
    return "- No config/ file inventory available.";
  }
  return files.map((file) => `- \`${file}\``).join("\n");
}

export async function buildHermesConfigIndex(
  input: HermesConfigIndexInput,
): Promise<string> {
  const terms = extractHermesTerms(
    `${input.query}\n${input.additionalContext ?? ""}`,
    input.maxTerms ?? 10,
  );
  const sourcePrecedence = [
    "config/ documentation and environment-specific override docs",
    "database/HBM/model mappings that define storage",
    "service/repository usages that read or mutate the setting",
    "runtime database value only when explicitly provided by the task context",
  ];

  if (!input.repositoryPath || !(await pathExists(input.repositoryPath))) {
    return [
      "## HERMES Deterministic Config Index",
      "",
      "Repository config index unavailable. Return resolution_status as runtime_value_unverified, not a guessed value.",
      "",
      "### Extracted Query Terms",
      terms.length > 0
        ? terms.map((term) => `- \`${term}\``).join("\n")
        : "- None",
      "",
      "### Config File Inventory",
      "- Repository unavailable.",
      "",
      "### Source precedence",
      ...sourcePrecedence.map((item, index) => `${index + 1}. ${item}`),
      "",
      "Set resolution_status to found, not_found, ambiguous, or runtime_value_unverified.",
    ].join("\n");
  }

  const hits = (
    await Promise.all(
      terms.flatMap((term) => [
        searchTerm(
          input.repositoryPath!,
          term,
          "config",
          input.maxMatchesPerTerm ?? 5,
        ),
        searchTerm(
          input.repositoryPath!,
          term,
          "code",
          input.maxMatchesPerTerm ?? 5,
        ),
      ]),
    )
  ).flat();
  const configFileInventory = await collectConfigFileInventory(
    input.repositoryPath,
  );

  return [
    "## HERMES Deterministic Config Index",
    "",
    `Workspace: \`${path.basename(input.repositoryPath)}\``,
    "",
    "### Extracted Query Terms",
    terms.length > 0
      ? terms.map((term) => `- \`${term}\``).join("\n")
      : "- None",
    "",
    "### Config File Inventory",
    formatConfigFileInventory(configFileInventory),
    "",
    "### Config Documentation Hits",
    formatHits("config", hits),
    "",
    "### Code Usage Hits",
    formatHits("code", hits),
    "",
    "### Source precedence",
    ...sourcePrecedence.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Set resolution_status to found, not_found, ambiguous, or runtime_value_unverified.",
  ].join("\n");
}
