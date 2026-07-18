#!/usr/bin/env npx tsx
/**
 * Generate RepoRouter profiles from real repositories.
 *
 * Usage:
 *   npx tsx scripts/generate-repo-profiles.ts \
 *     --repo client-services:/path/to/cp-client-services-monorepo \
 *     --repo interop:/path/to/cp-interoperability-monorepo ...
 *
 *   npx tsx scripts/generate-repo-profiles.ts --from-metadata
 *     (expects clones at $REPO_CLONE_ROOT/<githubSlug>, default ~/GitHub)
 *
 * Writes to config/repo-profiles/<repoName>.yaml. Preserves the `curated:`
 * block of any existing profile. Rewrites the `generated:` block in full.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ONE_SHOT_REPO_METADATA } from "../src/oneshot/repo-metadata.js";
import { REPO_DOMAIN_RULES } from "../src/oneshot/repo-domain-rules.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  repos: Array<{ name: string; path: string }>;
  profileDir: string;
  dryRun: boolean;
  fromMetadata: boolean;
  cloneRoot: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    repos: [],
    profileDir: path.resolve(process.cwd(), "config", "repo-profiles"),
    dryRun: false,
    fromMetadata: false,
    cloneRoot: process.env.REPO_CLONE_ROOT || path.join(os.homedir(), "GitHub"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--repo": {
        const next = argv[++i];
        if (!next) throw new Error("--repo requires NAME:PATH argument");
        const idx = next.indexOf(":");
        if (idx <= 0 || idx === next.length - 1) {
          throw new Error(`--repo expected NAME:PATH, got "${next}"`);
        }
        const name = next.slice(0, idx);
        const repoPath = next.slice(idx + 1);
        opts.repos.push({ name, path: repoPath });
        break;
      }
      case "--profile-dir": {
        const next = argv[++i];
        if (!next) throw new Error("--profile-dir requires a path");
        opts.profileDir = path.resolve(next);
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--from-metadata":
        opts.fromMetadata = true;
        break;
      case "--clone-root": {
        const next = argv[++i];
        if (!next) throw new Error("--clone-root requires a path");
        opts.cloneRoot = path.resolve(next);
        break;
      }
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.fromMetadata && opts.repos.length === 0) {
    for (const metadata of ONE_SHOT_REPO_METADATA) {
      if (!metadata.oneshotEnabled) continue;
      const repoPath = path.join(opts.cloneRoot, metadata.githubSlug);
      if (fs.existsSync(repoPath)) {
        opts.repos.push({ name: metadata.repoName, path: repoPath });
      }
    }
  }

  if (opts.repos.length === 0) {
    throw new Error(
      "No repos specified. Use --repo NAME:PATH or --from-metadata.",
    );
  }

  return opts;
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/generate-repo-profiles.ts --repo NAME:PATH [--repo NAME:PATH ...]
  npx tsx scripts/generate-repo-profiles.ts --from-metadata

Options:
  --repo NAME:PATH    Repo to scan; NAME must match config/repo-profiles/<NAME>.yaml
  --from-metadata     Pull repo list from ONE_SHOT_REPO_METADATA; expect clones at
                      $REPO_CLONE_ROOT/<githubSlug> (default ~/GitHub)
  --profile-dir DIR   Where to write profile YAMLs (default ./config/repo-profiles)
  --clone-root DIR    Root for --from-metadata (default $REPO_CLONE_ROOT)
  --dry-run           Print profiles to stdout; do not write files
  -h, --help          Show this message
`);
}

// ---------------------------------------------------------------------------
// Filesystem walker
// ---------------------------------------------------------------------------

const DIR_STOPLIST = new Set([
  "node_modules",
  "target",
  "build",
  "dist",
  ".git",
  ".idea",
  ".vscode",
  ".agentx",
  ".claude",
  ".playwright-mcp",
  "__pycache__",
  ".venv",
  "venv",
  "bin",
  "obj",
  ".gradle",
  ".terraform",
]);

const PATH_PATTERN_STOPLIST = new Set([
  "src",
  "test",
  "tests",
  "main",
  "java",
  "resources",
  "webapp",
  "docs",
  "images",
  "keys",
  "assets",
  "report",
  "reports",
  "scripts",
  "static",
  "styles",
  "public",
  "memory-bank",
  "outputs",
  "lib",
  "libs",
  "tools",
  "utils",
  "util",
  "common",
  "shared",
  "config",
  "api",
  "cli",
  "doc",
]);

function walk(
  root: string,
  predicate: (
    entry: string,
    isDir: boolean,
    depth: number,
  ) => "keep" | "skip" | "descend",
  maxDepth = 10,
): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DIR_STOPLIST.has(entry.name)) continue;
        const action = predicate(full, true, depth + 1);
        if (action === "skip") continue;
        if (action === "keep") out.push(full);
        if (depth + 1 < maxDepth) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        const action = predicate(full, false, depth + 1);
        if (action === "keep") out.push(full);
      }
    }
  }
  return out;
}

function listTopLevelDirectories(root: string, maxDepth = 2): string[] {
  const dirs: string[] = [];
  walk(
    root,
    (full, isDir, depth) => {
      if (!isDir) return "skip";
      if (depth > maxDepth) return "skip";
      dirs.push(path.relative(root, full));
      return "descend";
    },
    maxDepth,
  );
  return dirs;
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

const SYMBOL_NOISE = new Set([
  "Test",
  "Tests",
  "TestCase",
  "IT",
  "Main",
  "App",
  "Application",
  "Util",
  "Utils",
  "Helper",
  "Helpers",
  "Base",
  "Impl",
  "Default",
  "Bean",
  "Config",
  "Common",
  "Constants",
  "Exception",
  // Generic types that collide across repos and provide no routing signal.
  "Action",
  "Actions",
  "Builder",
  "Factory",
  "Manager",
  "Service",
  "Handler",
  "Processor",
  "Provider",
  "Controller",
  "Request",
  "Response",
  "Event",
  "Events",
  "Level",
  "Source",
  "Data",
  "Entity",
  "Item",
  "Items",
  "Value",
  "Result",
  "Results",
  "Type",
  "Types",
  "Context",
  "Options",
  "Params",
  "Payload",
  "Status",
  "State",
  "Filter",
  "Listener",
  "Callback",
  "Task",
  "Tasks",
  "Job",
  "Jobs",
  "Runner",
  "Reader",
  "Writer",
  "Parser",
  "Validator",
  "Formatter",
  "Serializer",
  "Mapper",
  "Converter",
]);

const SQL_RESERVED = new Set([
  "table",
  "select",
  "from",
  "where",
  "join",
  "inner",
  "outer",
  "left",
  "right",
  "union",
  "insert",
  "update",
  "delete",
  "drop",
  "create",
  "alter",
  "null",
  "true",
  "false",
  "and",
  "or",
  "not",
  "if",
  "else",
  "as",
  "on",
  "in",
  "is",
  "exists",
  "by",
  "order",
  "group",
  "having",
]);

export function extractFilePathPatterns(root: string): string[] {
  const patterns = new Set<string>();
  const baseName = path.basename(root);
  patterns.add(baseName);

  const topDirs = listTopLevelDirectories(root, 1);
  for (const rel of topDirs) {
    const name = path.basename(rel);
    if (DIR_STOPLIST.has(name)) continue;
    if (PATH_PATTERN_STOPLIST.has(name.toLowerCase())) continue;
    if (name.length < 4) continue;
    patterns.add(name);
  }

  const secondDirs = listTopLevelDirectories(root, 2).filter((rel) =>
    rel.includes(path.sep),
  );
  for (const rel of secondDirs) {
    const name = path.basename(rel);
    if (DIR_STOPLIST.has(name)) continue;
    if (PATH_PATTERN_STOPLIST.has(name.toLowerCase())) continue;
    if (name.length < 5) continue;
    if (["target", "build", "dist", "node_modules"].includes(name)) continue;
    patterns.add(name);
  }

  return Array.from(patterns).sort();
}

const PYTHON_STDLIB = new Set([
  "os",
  "sys",
  "re",
  "json",
  "logging",
  "time",
  "datetime",
  "typing",
  "pathlib",
  "argparse",
  "subprocess",
  "functools",
  "itertools",
  "collections",
  "math",
  "random",
  "unittest",
  "abc",
  "asyncio",
  "urllib",
  "http",
  "socket",
  "uuid",
  "hashlib",
  "base64",
  "copy",
  "csv",
  "io",
  "decimal",
  "enum",
  "struct",
  "string",
  "textwrap",
  "traceback",
  "warnings",
  "pytest",
  "boto3",
  "botocore",
  "requests",
  "numpy",
  "pandas",
  "scipy",
  "yaml",
  "setuptools",
]);

export function extractPackages(root: string): string[] {
  const packages = new Map<string, number>();

  const javaFiles = walk(
    root,
    (full, isDir) => {
      if (isDir) return "descend";
      if (!full.endsWith(".java")) return "skip";
      if (!full.includes(path.sep + "src" + path.sep)) return "skip";
      return "keep";
    },
    12,
  ).slice(0, 5000);

  for (const file of javaFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const match = content.match(/^\s*package\s+([\w.]+)\s*;/m);
    if (!match) continue;
    const pkg = match[1];
    const segments = pkg.split(".");
    for (let depth = 2; depth <= Math.min(3, segments.length); depth++) {
      const prefix = segments.slice(0, depth).join(".");
      packages.set(prefix, (packages.get(prefix) ?? 0) + 1);
    }
  }

  // Python: only count import-targets that resolve to an in-repo module.
  // A token resolves in-repo if its first segment matches a directory in the repo
  // that contains at least one .py file (with or without __init__.py).
  const repoTopDirs = new Set<string>();
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (DIR_STOPLIST.has(entry.name)) continue;
      const dirPath = path.join(root, entry.name);
      const hasPy =
        walk(
          dirPath,
          (full, isDir) => {
            if (isDir) return "descend";
            if (full.endsWith(".py")) return "keep";
            return "skip";
          },
          4,
        ).length > 0;
      if (hasPy) repoTopDirs.add(entry.name);
    }
  } catch {
    // ignore
  }

  const pyFiles = walk(
    root,
    (full, isDir) => {
      if (isDir) return "descend";
      if (!full.endsWith(".py")) return "skip";
      return "keep";
    },
    10,
  ).slice(0, 3000);

  for (const file of pyFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const matches = content.matchAll(/^\s*(?:from|import)\s+([a-z_][\w.]*)/gm);
    for (const match of matches) {
      const token = match[1];
      const topSegment = token.split(".")[0];
      if (PYTHON_STDLIB.has(topSegment)) continue;
      if (!repoTopDirs.has(topSegment)) continue;
      if (token.length < 4) continue;
      packages.set(token, (packages.get(token) ?? 0) + 1);
    }
  }

  return Array.from(packages.entries())
    .filter(
      ([pkg]) =>
        pkg.includes(".") || !["com", "org", "net", "io"].includes(pkg),
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([pkg]) => pkg)
    .sort();
}

export function extractSymbols(root: string): string[] {
  const counts = new Map<string, number>();
  const visit = (content: string, regex: RegExp): void => {
    const matches = content.matchAll(regex);
    for (const match of matches) {
      const name = match[1];
      if (!name || name.length < 4) continue;
      if (SYMBOL_NOISE.has(name)) continue;
      if (name.endsWith("Impl") && name.length < 6) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  };

  const files = walk(
    root,
    (full, isDir) => {
      if (isDir) return "descend";
      if (
        full.endsWith(".java") ||
        full.endsWith(".ts") ||
        full.endsWith(".tsx") ||
        full.endsWith(".py")
      ) {
        return "keep";
      }
      return "skip";
    },
    12,
  ).slice(0, 8000);

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const isTestFile =
      /(?:^|[\\/])(?:tests?|testing|e2e|integration|unit-tests?)(?:[\\/]|\.)|(?:Test|Tests|IT|Spec)\.(?:java|ts|tsx|py)$/i.test(
        file,
      );
    if (isTestFile) continue;
    if (file.endsWith(".java")) {
      visit(
        content,
        /^\s*(?:@\w+\s+)?(?:public|protected|private|abstract|final|static|\s)*\s(?:class|interface|enum|record)\s+([A-Z][A-Za-z0-9_]+)/gm,
      );
    } else if (file.endsWith(".py")) {
      visit(content, /^\s*class\s+([A-Z][A-Za-z0-9_]+)/gm);
    } else {
      visit(
        content,
        /^\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|function)\s+([A-Z][A-Za-z0-9_]+)/gm,
      );
    }
  }

  return Array.from(counts.entries())
    .filter(([name]) => !/(?:Test|Tests|TestCase|Spec)$/.test(name))
    .filter(([name]) => !name.startsWith("Abstract") || name.length > 12)
    .map(([name]) => name)
    .sort()
    .slice(0, 250);
}

export function extractEndpoints(root: string): string[] {
  const endpoints = new Set<string>();
  const files = walk(
    root,
    (full, isDir) => {
      if (isDir) return "descend";
      if (
        full.endsWith(".java") ||
        full.endsWith(".py") ||
        full.endsWith(".ts") ||
        full.endsWith(".js")
      ) {
        return "keep";
      }
      return "skip";
    },
    12,
  ).slice(0, 8000);

  const regexes: RegExp[] = [
    /@(?:Request|Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']/g,
    /@Path\s*\(\s*["']([^"']+)["']/g,
    /@Operation\s*\(\s*name\s*=\s*["']([^"']+)["']/g,
    /@\w+\.(?:route|get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g,
    /(?:app|router)\.(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g,
  ];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const regex of regexes) {
      for (const match of content.matchAll(regex)) {
        const raw = match[1];
        if (!raw) continue;
        const trimmed = raw.trim().replace(/^\/+/, "/");
        if (!trimmed || trimmed === "/") continue;
        if (trimmed.length < 3) continue;
        endpoints.add(trimmed);
      }
    }
  }

  return Array.from(endpoints).sort().slice(0, 50);
}

function stripSqlComments(sql: string): string {
  // Strip line comments -- ... end-of-line and block comments /* ... */
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function isTestFixturePath(filePath: string): boolean {
  return /[\\/](test|tests|testing|fixtures?|integration|e2e|mocks?)[\\/]/i.test(
    filePath,
  );
}

const GENERIC_TABLE_NAMES = new Set([
  "users",
  "user",
  "member",
  "members",
  "provider",
  "providers",
  "audit",
  "log",
  "logs",
  "config",
  "configs",
  "settings",
  "items",
  "item",
  "list",
  "data",
  "record",
  "records",
  "entity",
  "entities",
  "object",
  "objects",
  "value",
  "values",
  "tag",
  "tags",
  "type",
  "types",
  "group",
  "groups",
  "role",
  "roles",
  "session",
  "sessions",
]);

export function extractTables(root: string): string[] {
  const tables = new Set<string>();

  const files = walk(
    root,
    (full, isDir) => {
      if (isDir) return "descend";
      if (
        full.endsWith(".sql") ||
        full.endsWith(".java") ||
        full.endsWith(".xml")
      ) {
        return "keep";
      }
      return "skip";
    },
    12,
  ).slice(0, 6000);

  const sqlTableRegex =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?/gi;
  const javaTableRegex =
    /@Table\s*\(\s*(?:schema\s*=\s*["'][^"']*["'],\s*)?name\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g;
  const liquibaseRegex =
    /<createTable\s+[^>]*tableName\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gi;

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Test fixtures typically contain throwaway tables that don't represent
    // the repo's actual domain. Exclude them to avoid routing noise.
    if (isTestFixturePath(file)) continue;
    if (file.endsWith(".sql")) {
      const stripped = stripSqlComments(content);
      for (const match of stripped.matchAll(sqlTableRegex)) {
        const name = match[1];
        if (!name) continue;
        if (SQL_RESERVED.has(name.toLowerCase())) continue;
        if (GENERIC_TABLE_NAMES.has(name.toLowerCase())) continue;
        if (name.length < 4) continue;
        tables.add(name);
      }
    } else if (file.endsWith(".java")) {
      for (const match of content.matchAll(javaTableRegex)) {
        const name = match[1];
        if (!name) continue;
        if (GENERIC_TABLE_NAMES.has(name.toLowerCase())) continue;
        if (name.length < 4) continue;
        tables.add(name);
      }
    } else if (file.endsWith(".xml")) {
      for (const match of content.matchAll(liquibaseRegex)) {
        const name = match[1];
        if (!name) continue;
        if (GENERIC_TABLE_NAMES.has(name.toLowerCase())) continue;
        if (name.length < 4) continue;
        tables.add(name);
      }
    }
  }

  return Array.from(tables).sort().slice(0, 50);
}

// ---------------------------------------------------------------------------
// v2: shared text helpers (consumed by docs / git / endpoint / log extractors)
// ---------------------------------------------------------------------------

/**
 * Lowercase words we never want as domain tokens. English function words +
 * structural / commit-message noise. Hand-curated; ~200 entries.
 */
const LOWER_WORD_STOPLIST = new Set<string>([
  // Articles, pronouns, conjunctions, prepositions
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "they",
  "them",
  "their",
  "we",
  "our",
  "you",
  "your",
  "his",
  "her",
  "him",
  "she",
  "he",
  "who",
  "whom",
  "whose",
  "which",
  "what",
  "why",
  "how",
  "when",
  "where",
  "all",
  "any",
  "each",
  "every",
  "some",
  "such",
  "no",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "can",
  "could",
  "should",
  "would",
  "may",
  "might",
  "must",
  "shall",
  "will",
  "just",
  "now",
  "also",
  "also",
  "both",
  "either",
  "neither",
  "few",
  "more",
  "most",
  "other",
  "several",
  "here",
  "there",
  // Verbs / auxiliaries
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "doing",
  "done",
  "use",
  "used",
  "using",
  "make",
  "made",
  "get",
  "got",
  "getting",
  "put",
  "set",
  "take",
  "taken",
  "see",
  "seen",
  "run",
  "ran",
  "running",
  "go",
  "going",
  "went",
  "come",
  "came",
  "add",
  "adds",
  "added",
  "adding",
  "remove",
  "removed",
  "removing",
  "fix",
  "fixes",
  "fixed",
  "fixing",
  "update",
  "updates",
  "updated",
  "updating",
  "change",
  "changes",
  "changed",
  "changing",
  "need",
  "needs",
  "needed",
  "want",
  "wants",
  "wanted",
  "let",
  "check",
  "checks",
  "checked",
  "checking",
  // Prepositions and glue
  "about",
  "above",
  "across",
  "after",
  "against",
  "along",
  "among",
  "around",
  "at",
  "before",
  "behind",
  "below",
  "beneath",
  "beside",
  "between",
  "beyond",
  "but",
  "by",
  "down",
  "during",
  "except",
  "for",
  "from",
  "in",
  "inside",
  "into",
  "near",
  "of",
  "off",
  "on",
  "onto",
  "out",
  "outside",
  "over",
  "past",
  "since",
  "through",
  "throughout",
  "till",
  "to",
  "toward",
  "under",
  "underneath",
  "until",
  "up",
  "upon",
  "via",
  "with",
  "within",
  "without",
  // Conjunctions and discourse markers
  "and",
  "or",
  "nor",
  "if",
  "else",
  "then",
  "because",
  "although",
  "though",
  "while",
  "since",
  "unless",
  "whereas",
  "however",
  "instead",
  // Numbers and generic modifiers
  "one",
  "two",
  "three",
  "first",
  "second",
  "third",
  "last",
  "next",
  "previous",
  "new",
  "old",
  "good",
  "bad",
  "big",
  "small",
  "high",
  "low",
  "best",
  "better",
  "worst",
  "worse",
  // Commit-message structural noise
  "merge",
  "revert",
  "initial",
  "commit",
  "wip",
  "todo",
  "fixme",
  "note",
  "notes",
  "docs",
  "doc",
  "document",
  "documentation",
  "readme",
  "null",
  "true",
  "false",
  "none",
  "bug",
  "issue",
  "feature",
  "task",
  "ticket",
  "branch",
  "pull",
  "request",
  "pr",
  "mr",
  // Code structural noise that slips in via commit prose
  "class",
  "method",
  "function",
  "field",
  "param",
  "params",
  "arg",
  "args",
  "value",
  "values",
  "test",
  "tests",
  "testing",
]);

/**
 * Strip markdown syntax aggressively so we only keep naked prose words.
 * Removes code fences, inline code, HTML tags, headings, bullets, links,
 * emphasis markers.
 */
export function stripMarkdown(input: string): string {
  let out = input;
  // Fenced code blocks (```...``` and ~~~...~~~)
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/~~~[\s\S]*?~~~/g, " ");
  // Inline code
  out = out.replace(/`[^`]*`/g, " ");
  // HTML tags
  out = out.replace(/<[^>]+>/g, " ");
  // Images / link text: keep label, drop target
  out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Heading / list markers at line start
  out = out.replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)/gm, "");
  // Emphasis markers
  out = out.replace(/[*_~]{1,3}/g, " ");
  // Pipe tables
  out = out.replace(/\|/g, " ");
  return out;
}

/** Break a camelCase / PascalCase identifier into lowercase pieces. */
export function splitCamelCase(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Split an arbitrary token on camelCase, `-`, `_`, `.`, `/`, whitespace. */
export function splitToken(token: string): string[] {
  const rough = token.split(/[-_./\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const piece of rough) {
    out.push(...splitCamelCase(piece));
  }
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// v2: A. README / AGENTS.md / CLAUDE.md domain vocabulary
// ---------------------------------------------------------------------------

const DOC_FILE_PATTERNS = [
  /^readme(\.md|\.mdx|\.rst|\.txt)?$/i,
  /^claude(\.md)?$/i,
  /^agents(\.md)?$/i,
  /^contributing(\.md)?$/i,
  /^architecture(\.md)?$/i,
  /^design(\.md)?$/i,
  /^overview(\.md)?$/i,
];

function isDocFileName(name: string): boolean {
  return DOC_FILE_PATTERNS.some((r) => r.test(name));
}

/**
 * Extract domain vocabulary from README-style and docs/*.md files.
 * Produces multi-word noun phrases + single-word tokens of business importance.
 * Returns lowercase deduped list capped at 40.
 */
export function extractDocumentationDomains(root: string): string[] {
  const candidateFiles: string[] = [];
  // Top-level doc files
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && isDocFileName(entry.name)) {
        candidateFiles.push(path.join(root, entry.name));
      }
    }
  } catch {
    // ignore
  }
  // docs/ depth 1
  const docsDir = path.join(root, "docs");
  if (fs.existsSync(docsDir)) {
    try {
      for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
        if (
          entry.isFile() &&
          /\.(md|mdx|rst|txt)$/i.test(entry.name) &&
          !/changelog|history/i.test(entry.name)
        ) {
          candidateFiles.push(path.join(docsDir, entry.name));
        }
      }
    } catch {
      // ignore
    }
  }

  const phrases = new Set<string>();
  const wordCounts = new Map<string, number>();

  for (const file of candidateFiles.slice(0, 40)) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const stripped = stripMarkdown(content);

    // Match per-line so `\s+` in phrase patterns cannot span newlines
    // (that would glue together unrelated headings and table-of-contents lines).
    for (const rawLine of stripped.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line) continue;

      // Multi-word Title-Case noun phrases, 2-4 words, each ≥ 3 chars.
      for (const match of line.matchAll(
        /\b([A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,}){1,3})\b/g,
      )) {
        const phrase = match[1].trim().toLowerCase();
        if (phrase.split(/\s+/).every((w) => LOWER_WORD_STOPLIST.has(w))) {
          continue;
        }
        phrases.add(phrase);
      }

      // snake_case and hyphen-separated multi-token identifiers (≥ 2 segments)
      for (const match of line.matchAll(
        /\b([a-z][a-z0-9]*(?:[-_][a-z][a-z0-9]*)+)\b/g,
      )) {
        const token = match[1].toLowerCase();
        if (token.length >= 5) phrases.add(token.replace(/_/g, " "));
      }
    }

    // Single-word tokens. Require ≥ 5 occurrences per file and length ≥ 5,
    // so generic English words like "data", "users", "case", "work" don't
    // infiltrate the domain vocabulary.
    const singleCounts = new Map<string, number>();
    const lower = stripped.toLowerCase();
    for (const match of lower.matchAll(/\b([a-z][a-z0-9]{4,})\b/g)) {
      const word = match[1];
      if (LOWER_WORD_STOPLIST.has(word)) continue;
      singleCounts.set(word, (singleCounts.get(word) ?? 0) + 1);
    }
    for (const [word, count] of singleCounts) {
      if (count >= 5) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + count);
      }
    }
  }

  // Merge: phrases first, then single-word tokens by frequency.
  // Prefer phrases — they're rarely noise — and cap singles at a smaller count.
  const merged = new Set<string>();
  for (const phrase of phrases) {
    if (phrase.length >= 5) merged.add(phrase);
  }
  const sortedSingles = Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);
  for (const word of sortedSingles) {
    if (merged.size >= 40) break;
    merged.add(word);
  }

  return Array.from(merged).slice(0, 40).sort();
}

// ---------------------------------------------------------------------------
// v2: B. Git commit subject vocabulary
// ---------------------------------------------------------------------------

const COMMIT_SUBJECT_SKIP_PATTERNS = [
  /^Merge\b/i,
  /^Revert\b/i,
  /^\[maven-release-plugin\]/i,
  /^bot:/i,
  /^bump\s+version\b/i,
  /^release\s+v?\d+/i,
];

const TICKET_KEY_REGEX =
  /\b(?:CPDEV|CPSUP|MPDEV|MPSUP|PFOS|DEVOPS|INFRA)-\d+/gi;

export interface GitVocabularyResult {
  domains: string[];
  symbols: string[];
}

/**
 * Extract domain vocabulary + camelCase symbols from the last N git commit subjects.
 * Returns empty result on non-git directories; never throws.
 */
export function extractGitVocabulary(
  root: string,
  limit = 500,
): GitVocabularyResult {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      ["-C", root, "log", "--pretty=format:%s", `-n`, String(limit)],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return { domains: [], symbols: [] };
  }

  const domainCounts = new Map<string, number>();
  const symbolCounts = new Map<string, number>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const subject = rawLine.trim();
    if (!subject) continue;
    if (COMMIT_SUBJECT_SKIP_PATTERNS.some((r) => r.test(subject))) continue;
    const cleaned = subject.replace(TICKET_KEY_REGEX, " ");

    // camelCase / PascalCase identifiers (e.g. CoreRestClient, ClaimResponse).
    // Require at least one lowercase letter so ALLCAPS words like "WHERE"
    // (SQL keywords, TODO/FIXME, etc.) do not leak into the symbol set.
    for (const match of cleaned.matchAll(
      /\b([A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]+)\b/g,
    )) {
      const sym = match[1];
      if (SYMBOL_NOISE.has(sym)) continue;
      if (sym.length < 5) continue;
      if (!/[a-z]/.test(sym)) continue; // all-uppercase → not a code symbol
      if (SQL_RESERVED.has(sym.toLowerCase())) continue;
      symbolCounts.set(sym, (symbolCounts.get(sym) ?? 0) + 1);
    }

    // Lowercase tokens for domain vocabulary
    for (const match of cleaned
      .toLowerCase()
      .matchAll(/\b([a-z][a-z0-9]{3,})\b/g)) {
      const word = match[1];
      if (LOWER_WORD_STOPLIST.has(word)) continue;
      domainCounts.set(word, (domainCounts.get(word) ?? 0) + 1);
    }
  }

  const domains = Array.from(domainCounts.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word]) => word)
    .sort();

  const symbols = Array.from(symbolCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([name]) => name)
    .sort();

  return { domains, symbols };
}

// ---------------------------------------------------------------------------
// v2: C. Maven artifactId extraction
// ---------------------------------------------------------------------------

const MAVEN_DEPENDENCY_NOISE_PATTERNS: RegExp[] = [
  /^spring(-|$)/i,
  /^junit(-|$)/i,
  /^slf4j(-|$)/i,
  /^jackson(-|$)/i,
  /^commons(-|$)/i,
  /^apache(-|$)/i,
  /^maven(-|$)/i,
  /^groovy(-|$)/i,
  /^logback(-|$)/i,
  /^guava(-|$)/i,
  /^lombok(-|$)/i,
  /^mockito(-|$)/i,
  /^hamcrest(-|$)/i,
  /^log4j(-|$)/i,
  /^hibernate(-|$)/i,
];

const MAVEN_GENERIC_NAMES = new Set([
  "model",
  "parent",
  "common",
  "commons",
  "core",
  "api",
  "util",
  "utils",
  "shared",
  "base",
  "impl",
  "client",
  "server",
  "service",
  "test",
  "tests",
]);

export interface MavenExtractResult {
  artifactIds: string[];
  clientTags: string[];
}

/**
 * Walk pom.xml files under the repo; extract repo-owned artifactIds (the ones
 * that correspond to actual source modules), split `mm-service-<Client>` style
 * module names into individual client tokens.
 */
export function extractMavenArtifacts(root: string): MavenExtractResult {
  const artifactIds = new Set<string>();
  const clientTags = new Set<string>();

  // Collect directory names at depth 1-3 so we can tell module-owning pom.xmls
  // from the parent pom (whose artifactId usually doesn't match a directory).
  const directoryNames = new Set<string>();
  walk(
    root,
    (full, isDir, depth) => {
      if (!isDir) return "skip";
      if (depth > 3) return "skip";
      directoryNames.add(path.basename(full).toLowerCase());
      return "descend";
    },
    3,
  );

  const pomFiles = walk(
    root,
    (full, isDir) => {
      if (isDir) return "descend";
      return path.basename(full) === "pom.xml" ? "keep" : "skip";
    },
    4,
  ).slice(0, 200);

  for (const pom of pomFiles) {
    let content: string;
    try {
      content = fs.readFileSync(pom, "utf8");
    } catch {
      continue;
    }
    // Strip <parent>...</parent> blocks so we don't capture the parent's artifactId.
    const withoutParent = content.replace(/<parent\b[\s\S]*?<\/parent>/gi, " ");
    for (const match of withoutParent.matchAll(
      /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g,
    )) {
      const artifactId = match[1].trim();
      if (!artifactId) continue;
      const lower = artifactId.toLowerCase();
      if (MAVEN_DEPENDENCY_NOISE_PATTERNS.some((r) => r.test(lower))) continue;
      if (MAVEN_GENERIC_NAMES.has(lower)) continue;
      if (artifactId.length < 4) continue;
      // Only keep artifactIds that correspond to an actual directory (repo-owned).
      if (!directoryNames.has(lower)) continue;
      artifactIds.add(artifactId);
      // Split mm-service-<Client>, ext-service-<Client>, etc. into customer tokens.
      const clientMatch = artifactId.match(
        /^(?:mm|ext|ec|cp)-service[s]?-(.+)$/i,
      );
      if (clientMatch) {
        for (const piece of splitToken(clientMatch[1])) {
          if (piece.length < 3) continue;
          if (LOWER_WORD_STOPLIST.has(piece)) continue;
          clientTags.add(piece);
        }
      }
    }
  }

  return {
    artifactIds: Array.from(artifactIds).sort().slice(0, 60),
    clientTags: Array.from(clientTags).sort(),
  };
}

// ---------------------------------------------------------------------------
// v2: D. Endpoint-segment tokenization
// ---------------------------------------------------------------------------

const HTTP_VERB_STOPLIST = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
  "api",
  "v1",
  "v2",
  "v3",
  "v4",
]);

/**
 * Turn endpoint paths into routable domain tokens:
 *   "/getAuthInquiry/{id}" -> ["auth", "inquiry"]
 */
export function tokenizeEndpointSegments(endpoints: string[]): string[] {
  const out = new Set<string>();
  for (const endpoint of endpoints) {
    // Strip leading $, trailing punctuation, path parameters
    const cleaned = endpoint
      .replace(/^\$/, "")
      .replace(/\{[^}]*\}/g, " ")
      .replace(/[()\[\]]/g, " ");
    for (const piece of splitToken(cleaned)) {
      if (piece.length <= 2) continue;
      if (HTTP_VERB_STOPLIST.has(piece)) continue;
      if (LOWER_WORD_STOPLIST.has(piece)) continue;
      out.add(piece);
    }
  }
  return Array.from(out).sort();
}

// ---------------------------------------------------------------------------
// v2: E. Log-category vocabulary
// ---------------------------------------------------------------------------

/**
 * Capture bracketed category labels in log calls:
 *   log.info("[AuthorizationIntake] case accepted")
 */
export function extractLogCategories(root: string): string[] {
  const counts = new Map<string, number>();
  const files = walk(
    root,
    (full, isDir) => {
      if (isDir) return "descend";
      if (full.endsWith(".java") || full.endsWith(".py")) return "keep";
      return "skip";
    },
    12,
  ).slice(0, 8000);

  const javaRegex =
    /log(?:ger)?\s*\.\s*(?:info|warn|error|debug|trace)\s*\(\s*(?:"[^"]*\{\}[^"]*",\s*)?["']\[([A-Za-z][A-Za-z0-9_]+)\]/g;
  const pyRegex =
    /logger\.(?:info|warning|warn|error|debug)\s*\(\s*f?["']\[([A-Za-z][A-Za-z0-9_]+)\]/g;

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (isTestFixturePath(file)) continue;
    const regex = file.endsWith(".java") ? javaRegex : pyRegex;
    for (const match of content.matchAll(regex)) {
      const token = match[1];
      if (!token) continue;
      if (token.length < 4) continue;
      counts.set(
        token.toLowerCase(),
        (counts.get(token.toLowerCase()) ?? 0) + 1,
      );
    }
  }

  return Array.from(counts.entries())
    .filter(([word]) => !LOWER_WORD_STOPLIST.has(word))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([name]) => name)
    .sort();
}

// ---------------------------------------------------------------------------
// v2: F. Client-tag promotion (targeted to client-services)
// ---------------------------------------------------------------------------

export interface ClientTagPromotionResult {
  aliases: string[];
  domains: string[];
}

/**
 * For `client-services` specifically: surface customer-name tokens from
 * `mm-service-<Customer>` top-level directories so tickets like "BCBSMA | ..."
 * match without requiring the full module slug.
 */
export function promoteClientTags(
  repoRoot: string,
  repoName: string,
): ClientTagPromotionResult {
  if (repoName !== "client-services") {
    return { aliases: [], domains: [] };
  }
  const aliases = new Set<string>();
  const domains = new Set<string>();
  try {
    for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^mm-service-(.+)$/);
      if (!match) continue;
      for (const piece of splitToken(match[1])) {
        if (piece.length < 3) continue;
        if (LOWER_WORD_STOPLIST.has(piece)) continue;
        domains.add(piece);
        aliases.add(piece.toUpperCase());
      }
    }
  } catch {
    // ignore
  }
  return {
    aliases: Array.from(aliases).sort(),
    domains: Array.from(domains).sort(),
  };
}

// ---------------------------------------------------------------------------
// v2: G. Cross-profile frequency filter
// ---------------------------------------------------------------------------

const CROSS_PROFILE_FREQUENCY_THRESHOLD = 3;

/**
 * After all profiles are generated, drop tokens from `generated.domains` and
 * `generated.symbols` that appear in ≥ CROSS_PROFILE_FREQUENCY_THRESHOLD of the
 * profiles. Preserve aliases, file_path_patterns, packages.
 */
export function applyCrossProfileFrequencyFilter(
  bundles: ProfileBundle[],
): void {
  const domainFreq = new Map<string, number>();
  const symbolFreq = new Map<string, number>();
  for (const bundle of bundles) {
    for (const d of new Set(bundle.generated.domains)) {
      domainFreq.set(d, (domainFreq.get(d) ?? 0) + 1);
    }
    for (const s of new Set(bundle.generated.symbols)) {
      symbolFreq.set(s, (symbolFreq.get(s) ?? 0) + 1);
    }
  }
  for (const bundle of bundles) {
    bundle.generated.domains = bundle.generated.domains.filter(
      (d) => (domainFreq.get(d) ?? 0) < CROSS_PROFILE_FREQUENCY_THRESHOLD,
    );
    bundle.generated.symbols = bundle.generated.symbols.filter(
      (s) => (symbolFreq.get(s) ?? 0) < CROSS_PROFILE_FREQUENCY_THRESHOLD,
    );
    // Re-emit YAML after filtering so bundle.yaml matches bundle.generated.
    bundle.yaml = emitYaml({
      header: bundle.header,
      generated: bundle.generated,
      curatedBlock: bundle.curatedBlock,
    });
  }
}

export function collectAliasesFor(repoName: string): string[] {
  const metadata = ONE_SHOT_REPO_METADATA.find(
    (entry) => entry.repoName === repoName,
  );
  if (!metadata) return [repoName];
  return Array.from(
    new Set([metadata.repoName, metadata.githubSlug, ...metadata.aliases]),
  ).sort();
}

export function collectDomainsFor(repoName: string): string[] {
  const metadata = ONE_SHOT_REPO_METADATA.find(
    (entry) => entry.repoName === repoName,
  );
  const seeds = new Set<string>(metadata?.domains ?? []);
  const rule = REPO_DOMAIN_RULES.find((entry) => entry.repoName === repoName);
  if (rule) {
    for (const phrase of rule.phrases) seeds.add(phrase);
  }
  return Array.from(seeds).sort();
}

// ---------------------------------------------------------------------------
// YAML emit / curated preservation
// ---------------------------------------------------------------------------

interface GeneratedSection {
  aliases: string[];
  domains: string[];
  packages: string[];
  file_path_patterns: string[];
  symbols: string[];
  endpoints: string[];
  tables: string[];
}

interface ProfileHeader {
  schemaVersion: string;
  profileVersion: string;
  generatedAt: string;
  sourceRepoCommitSha: string;
}

const PROFILE_KEYS: Array<keyof GeneratedSection> = [
  "aliases",
  "domains",
  "packages",
  "file_path_patterns",
  "symbols",
  "endpoints",
  "tables",
];

const EMPTY_CURATED = `curated:
  aliases: []
  domains: []
  packages: []
  file_path_patterns: []
  symbols: []
  endpoints: []
  tables: []
`;

export function extractCuratedBlock(yaml: string): string {
  const lines = yaml.split("\n");
  const curatedIdx = lines.findIndex((line) => /^curated\s*:/.test(line));
  if (curatedIdx === -1) return EMPTY_CURATED;

  // Walk backwards from `curated:` to capture any preceding `# ...` comment
  // block. Humans use this to document the profile's purpose; it must survive
  // regeneration. Stop at the first non-comment, non-blank line above.
  let leadingIdx = curatedIdx;
  for (let i = curatedIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) {
      leadingIdx = i;
      continue;
    }
    break;
  }

  let endIdx = lines.length;
  for (let i = curatedIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(leadingIdx, endIdx).join("\n").replace(/\s+$/, "") + "\n";
}

export function readExistingHeader(yamlPath: string): ProfileHeader {
  if (!fs.existsSync(yamlPath)) {
    return {
      schemaVersion: "1",
      profileVersion: "1",
      generatedAt: "",
      sourceRepoCommitSha: "",
    };
  }
  const content = fs.readFileSync(yamlPath, "utf8");
  const schema = content.match(/^schema_version\s*:\s*(\S+)/m)?.[1] ?? "1";
  const profile = content.match(/^profile_version\s*:\s*(\S+)/m)?.[1] ?? "1";
  const generatedAt =
    content
      .match(/^generated_at\s*:\s*(.+)$/m)?.[1]
      .replace(/^["']|["']$/g, "")
      .trim() ?? "";
  const sha =
    content
      .match(/^source_repo_commit_sha\s*:\s*(.+)$/m)?.[1]
      .replace(/^["']|["']$/g, "")
      .trim() ?? "";
  return {
    schemaVersion: schema,
    profileVersion: profile,
    generatedAt,
    sourceRepoCommitSha: sha,
  };
}

export function bumpProfileVersion(current: string): string {
  const numeric = Number.parseInt(current, 10);
  if (!Number.isFinite(numeric)) return "2";
  return String(numeric + 1);
}

function getGitSha(repoRoot: string): string {
  try {
    // execFile (no shell) — repoRoot is a trusted local path supplied by the operator.
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

export function emitYaml(options: {
  header: ProfileHeader;
  generated: GeneratedSection;
  curatedBlock: string;
}): string {
  const { header, generated, curatedBlock } = options;
  const lines: string[] = [];
  lines.push(`schema_version: ${header.schemaVersion}`);
  lines.push(`profile_version: ${header.profileVersion}`);
  lines.push(`generated_at: "${header.generatedAt}"`);
  lines.push(
    `source_repo_commit_sha: ${header.sourceRepoCommitSha || "unknown"}`,
  );
  lines.push("generated:");
  for (const key of PROFILE_KEYS) {
    const values = generated[key];
    if (!values || values.length === 0) {
      lines.push(`  ${key}: []`);
      continue;
    }
    lines.push(`  ${key}:`);
    for (const value of values) {
      lines.push(`    - ${quoteScalar(value)}`);
    }
  }
  const trimmedCurated = curatedBlock.endsWith("\n")
    ? curatedBlock
    : curatedBlock + "\n";
  return lines.join("\n") + "\n" + trimmedCurated;
}

function quoteScalar(value: string): string {
  if (
    /^[\w./@+-]+$/.test(value) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(value)
  ) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ProfileBundle {
  repoName: string;
  repoPath: string;
  yamlPath: string;
  yaml: string;
  generated: GeneratedSection;
  header: ProfileHeader;
  curatedBlock: string;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(
    new Set(Array.from(values).filter((v) => v.length > 0)),
  ).sort();
}

export function buildProfile(opts: {
  repoName: string;
  repoPath: string;
  profileDir: string;
}): ProfileBundle {
  const yamlPath = path.join(opts.profileDir, `${opts.repoName}.yaml`);
  const existing = fs.existsSync(yamlPath)
    ? fs.readFileSync(yamlPath, "utf8")
    : "";
  const existingHeader = readExistingHeader(yamlPath);
  const curatedBlock = existing ? extractCuratedBlock(existing) : EMPTY_CURATED;

  const baseAliases = collectAliasesFor(opts.repoName);
  const baseDomains = collectDomainsFor(opts.repoName);
  const basePackages = extractPackages(opts.repoPath);
  const baseFilePaths = extractFilePathPatterns(opts.repoPath);
  const baseSymbols = extractSymbols(opts.repoPath);
  const baseEndpoints = extractEndpoints(opts.repoPath);
  const baseTables = extractTables(opts.repoPath);

  // v2 signal sources
  const docsDomains = extractDocumentationDomains(opts.repoPath);
  const gitVocab = extractGitVocabulary(opts.repoPath);
  const mavenInfo = extractMavenArtifacts(opts.repoPath);
  const endpointTokens = tokenizeEndpointSegments(baseEndpoints);
  const logCategories = extractLogCategories(opts.repoPath);
  const clientTags = promoteClientTags(opts.repoPath, opts.repoName);

  const generated: GeneratedSection = {
    aliases: uniqueSorted([
      ...baseAliases,
      ...mavenInfo.artifactIds,
      ...clientTags.aliases,
    ]),
    domains: uniqueSorted([
      ...baseDomains,
      ...docsDomains,
      ...gitVocab.domains,
      ...mavenInfo.clientTags,
      ...endpointTokens,
      ...logCategories,
      ...clientTags.domains,
    ]),
    packages: basePackages,
    file_path_patterns: baseFilePaths,
    symbols: uniqueSorted([...baseSymbols, ...gitVocab.symbols]),
    endpoints: baseEndpoints,
    tables: baseTables,
  };

  const header: ProfileHeader = {
    schemaVersion: existingHeader.schemaVersion || "1",
    profileVersion: bumpProfileVersion(existingHeader.profileVersion || "1"),
    generatedAt: new Date().toISOString(),
    sourceRepoCommitSha: getGitSha(opts.repoPath),
  };

  const yaml = emitYaml({ header, generated, curatedBlock });
  return {
    repoName: opts.repoName,
    repoPath: opts.repoPath,
    yamlPath,
    yaml,
    generated,
    header,
    curatedBlock,
  };
}

function summarizeCounts(section: GeneratedSection): string {
  return PROFILE_KEYS.map((key) => `${key}=${section[key].length}`).join(" ");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.profileDir)) {
    throw new Error(`Profile directory does not exist: ${opts.profileDir}`);
  }

  // Pass 1: build all profiles in memory.
  const bundles: ProfileBundle[] = [];
  for (const repo of opts.repos) {
    if (!fs.existsSync(repo.path)) {
      console.error(`[skip] ${repo.name}: path not found: ${repo.path}`);
      continue;
    }
    console.error(`[scan] ${repo.name} <- ${repo.path}`);
    bundles.push(
      buildProfile({
        repoName: repo.name,
        repoPath: repo.path,
        profileDir: opts.profileDir,
      }),
    );
  }

  // Pass 2: cross-profile frequency filter — drops domain/symbol tokens that
  // appear in ≥ CROSS_PROFILE_FREQUENCY_THRESHOLD of the profiles, because
  // a signal that matches most repos is not a routing signal.
  if (bundles.length >= CROSS_PROFILE_FREQUENCY_THRESHOLD) {
    applyCrossProfileFrequencyFilter(bundles);
  }

  // Pass 3: write or dry-run.
  const summaries: string[] = [];
  for (const bundle of bundles) {
    summaries.push(
      `  ${bundle.repoName}: ${summarizeCounts(bundle.generated)} (v${bundle.header.profileVersion}, sha=${bundle.header.sourceRepoCommitSha.slice(0, 8)})`,
    );
    if (opts.dryRun) {
      console.log(`# ${bundle.yamlPath}`);
      console.log(bundle.yaml);
    } else {
      fs.writeFileSync(bundle.yamlPath, bundle.yaml, "utf8");
      console.error(`[write] ${bundle.yamlPath}`);
    }
  }
  console.error("\nSummary:");
  for (const line of summaries) console.error(line);
}

const isDirectRun =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(new URL(import.meta.url).pathname);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
