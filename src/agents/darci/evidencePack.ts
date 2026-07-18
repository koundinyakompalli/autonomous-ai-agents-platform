import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface DarciEvidencePackInput {
  repositoryPath?: string;
  defectDescription: string;
  additionalContext?: string;
  maxTerms?: number;
  maxMatchesPerTerm?: number;
}

interface EvidenceHit {
  term: string;
  file: string;
  line: string;
  preview: string;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "cannot",
  "error",
  "fails",
  "failure",
  "issue",
  "should",
  "ticket",
  "users",
  "with",
]);

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function extractDarciTerms(text: string, maxTerms: number): string[] {
  const quoted = Array.from(text.matchAll(/"([^"\n]{5,100})"/g)).map((match) =>
    match[1]!.trim(),
  );
  const identifiers = Array.from(
    text.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g),
    (match) => match[0],
  );
  const filteredIdentifiers = identifiers.filter((term) => {
    const lower = term.toLowerCase();
    return (
      !STOP_WORDS.has(lower) &&
      (term.length >= 8 ||
        /[A-Z]/.test(term.slice(1)) ||
        term.includes("_") ||
        /(Exception|Error|Service|Controller|Manager|Handler)$/.test(term))
    );
  });

  return unique([...quoted, ...filteredIdentifiers]).slice(0, maxTerms);
}

async function pathExists(value: string): Promise<boolean> {
  return access(value)
    .then(() => true)
    .catch(() => false);
}

async function searchTerm(
  repositoryPath: string,
  term: string,
  maxMatches: number,
): Promise<EvidenceHit[]> {
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
        ".",
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

function formatHits(hits: EvidenceHit[]): string {
  if (hits.length === 0) {
    return "- No deterministic rg hits found for the extracted ticket terms.";
  }
  return hits
    .slice(0, 30)
    .map(
      (hit) =>
        `- \`${hit.file}:${hit.line}\` matched \`${hit.term}\`: ${hit.preview}`,
    )
    .join("\n");
}

function extractErrorSignals(text: string, maxSignals = 12): string[] {
  return unique(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) =>
        /(?:Exception|Error|Caused by|^\s*at\s+[\w.$]+\(.+:\d+\)|Cannot read|timeout|timed out|failed|ORA-\d+|SQLSTATE)/i.test(
          line,
        ),
      ),
  ).slice(0, maxSignals);
}

function formatErrorSignals(signals: string[]): string {
  if (signals.length === 0) {
    return "- No explicit stack trace or error-signature lines were extracted.";
  }
  return signals.map((signal) => `- ${signal}`).join("\n");
}

export async function buildDarciEvidencePack(
  input: DarciEvidencePackInput,
): Promise<string> {
  const combinedText = `${input.defectDescription}\n${input.additionalContext ?? ""}`;
  const terms = extractDarciTerms(combinedText, input.maxTerms ?? 10);
  const errorSignals = extractErrorSignals(combinedText);
  const controls = [
    "Start from the preflight hits before broad repository exploration.",
    "Use git blame/log only after a candidate file or line is identified.",
    "Stop broad searching after repeated low-signal searches; return the best evidence-backed hypothesis instead of exhausting the SDK turn budget.",
    "If evidence is insufficient, set resolution_status to insufficient_evidence and explain what is missing.",
  ];

  if (!input.repositoryPath || !(await pathExists(input.repositoryPath))) {
    return [
      "## DARCI Deterministic Evidence Pack",
      "",
      "Repository preflight scan unavailable. Use the investigation control rules below.",
      "",
      "### Extracted Search Terms",
      terms.length > 0
        ? terms.map((term) => `- \`${term}\``).join("\n")
        : "- None",
      "",
      "### Error Signals",
      formatErrorSignals(errorSignals),
      "",
      "### Investigation Control",
      ...controls.map((control) => `- ${control}`),
      "- Stop broad searching when no deterministic evidence emerges.",
    ].join("\n");
  }

  const hits = (
    await Promise.all(
      terms.map((term) =>
        searchTerm(input.repositoryPath!, term, input.maxMatchesPerTerm ?? 5),
      ),
    )
  ).flat();

  return [
    "## DARCI Deterministic Evidence Pack",
    "",
    `Workspace: \`${path.basename(input.repositoryPath)}\``,
    "",
    "### Extracted Search Terms",
    terms.length > 0
      ? terms.map((term) => `- \`${term}\``).join("\n")
      : "- None",
    "",
    "### Error Signals",
    formatErrorSignals(errorSignals),
    "",
    "### Preflight Evidence Hits",
    formatHits(hits),
    "",
    "### Investigation Control",
    ...controls.map((control) => `- ${control}`),
  ].join("\n");
}
