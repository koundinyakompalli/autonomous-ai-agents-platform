import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const MHK_ORGANIZATIONAL_CONTEXT_FILENAME =
  "mhk-organizational-context.md";
export const MHK_ORGANIZATIONAL_CONTEXT_VERSION =
  "mhk_organizational_context@2026-07-13";

const DEFAULT_MAX_RELEVANT_CHARS = 24_000;
const DEFAULT_MAX_RELEVANT_SECTIONS = 2;
const MIN_RELEVANCE_SCORE = 4;
const CACHED_PREFIX_SECTION_NUMBERS = new Set(["0", "1", "2", "3", "4", "16"]);
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "business",
  "can",
  "company",
  "context",
  "could",
  "does",
  "for",
  "from",
  "have",
  "how",
  "implementation",
  "into",
  "its",
  "latest",
  "mhk",
  "need",
  "our",
  "product",
  "requirements",
  "session",
  "should",
  "source",
  "sources",
  "spec",
  "system",
  "that",
  "the",
  "their",
  "this",
  "through",
  "user",
  "users",
  "want",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "you",
  "your",
]);

export interface OrganizationalContextSection {
  number: string | null;
  heading: string;
  markdown: string;
}

export interface BuildMhkOrganizationalContextOptions {
  document?: string;
  maxRelevantChars?: number;
  maxRelevantSections?: number;
}

export interface MhkOrganizationalContextMetadata {
  version: string;
  evidenceSnapshot: string | null;
  sha256: string;
  bytes: number;
}

let cachedDocument: string | undefined;

export function loadMhkOrganizationalContext(): string {
  if (cachedDocument !== undefined) return cachedDocument;
  try {
    cachedDocument = readFileSync(
      new URL(
        `./context/${MHK_ORGANIZATIONAL_CONTEXT_FILENAME}`,
        import.meta.url,
      ),
      "utf8",
    );
  } catch (error) {
    throw new Error("spec_factory_organizational_context_missing", {
      cause: error,
    });
  }
  if (!cachedDocument.trim()) {
    throw new Error("spec_factory_organizational_context_empty");
  }
  return cachedDocument;
}

export function getMhkOrganizationalContextMetadata(
  document = loadMhkOrganizationalContext(),
): MhkOrganizationalContextMetadata {
  const evidenceSnapshot =
    /^evidence_snapshot:\s*([^\r\n]+)$/m.exec(document)?.[1]?.trim() ?? null;
  return {
    version: MHK_ORGANIZATIONAL_CONTEXT_VERSION,
    evidenceSnapshot,
    sha256: createHash("sha256").update(document).digest("hex"),
    bytes: Buffer.byteLength(document, "utf8"),
  };
}

export function parseMhkOrganizationalContext(
  document: string,
): OrganizationalContextSection[] {
  const headings = [...document.matchAll(/^##\s+(.+)$/gm)];
  const sections: OrganizationalContextSection[] = [];
  const firstHeadingIndex = headings[0]?.index ?? document.length;
  const preamble = document.slice(0, firstHeadingIndex).trim();
  if (preamble) {
    sections.push({
      number: null,
      heading: "Document identity",
      markdown: preamble,
    });
  }
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    const start = match.index ?? 0;
    const end = headings[index + 1]?.index ?? document.length;
    const heading = match[1].trim();
    sections.push({
      number: /^(\d+)\./.exec(heading)?.[1] ?? null,
      heading,
      markdown: document.slice(start, end).trim(),
    });
  }
  return sections;
}

export function buildMhkOrganizationalContext(
  query: string,
  options: BuildMhkOrganizationalContextOptions = {},
): string {
  return [
    buildMhkOrganizationalContextPrefix(options),
    buildMhkRelevantOrganizationalContext(query, options),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildMhkOrganizationalContextPrefix(
  options: BuildMhkOrganizationalContextOptions = {},
): string {
  const document = options.document ?? loadMhkOrganizationalContext();
  const sections = parseMhkOrganizationalContext(document);
  const prefixSections = sections.filter(
    (section) =>
      section.number === null ||
      (section.number !== null &&
        CACHED_PREFIX_SECTION_NUMBERS.has(section.number)),
  );
  const candidates = sections.filter(
    (section) =>
      section.number !== null &&
      !CACHED_PREFIX_SECTION_NUMBERS.has(section.number),
  );
  const metadata = getMhkOrganizationalContextMetadata(document);
  const index = candidates.map((section) => `- ${section.heading}`).join("\n");

  return [
    "# Standard MHK organizational context",
    "",
    `Context version: ${metadata.version}`,
    `Evidence snapshot: ${metadata.evidenceSnapshot ?? "unknown"}`,
    "",
    "Usage rules:",
    "- Use this as organizational orientation and vocabulary, not as proof of current runtime, deployment, client configuration, or contractual behavior.",
    "- Session sources, current code, effective configuration, and verified live runtime evidence override this document.",
    "- Preserve the document's evidence labels and explicitly identify unknowns or inferences.",
    "- Never expose internal organizational detail unless it is relevant to the user's product question.",
    "- Never include PHI, PII, credentials, secrets, private endpoints, or client data in prompts, tickets, or responses.",
    "",
    "## Stable organizational baseline",
    "",
    prefixSections.map((section) => section.markdown).join("\n\n"),
    "",
    "## Available detailed sections",
    "",
    index,
  ].join("\n");
}

export function buildMhkRelevantOrganizationalContext(
  query: string,
  options: BuildMhkOrganizationalContextOptions = {},
): string {
  const document = options.document ?? loadMhkOrganizationalContext();
  const candidates = parseMhkOrganizationalContext(document).filter(
    (section) =>
      section.number !== null &&
      !CACHED_PREFIX_SECTION_NUMBERS.has(section.number),
  );
  const queryTerms = termFrequency(query);
  const ranked = candidates
    .map((section) => ({ section, score: scoreSection(section, queryTerms) }))
    .filter((candidate) => candidate.score >= MIN_RELEVANCE_SCORE)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(left.section.number) - Number(right.section.number),
    );
  const relevant = selectRelevantSections(ranked, {
    maxChars: positiveInteger(
      options.maxRelevantChars,
      DEFAULT_MAX_RELEVANT_CHARS,
    ),
    maxSections: positiveInteger(
      options.maxRelevantSections,
      DEFAULT_MAX_RELEVANT_SECTIONS,
    ),
  });
  if (relevant.length === 0) return "";
  return [
    "## Detailed sections retrieved for this conversation turn",
    "",
    relevant.join("\n\n"),
  ].join("\n");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function terms(value: string): string[] {
  const matches: string[] = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return matches.filter(
    (term) =>
      (term.length >= 3 || /^[a-z]{2}$/.test(term)) && !STOP_WORDS.has(term),
  );
}

function termFrequency(value: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of terms(value)) {
    frequencies.set(term, Math.min(3, (frequencies.get(term) ?? 0) + 1));
  }
  return frequencies;
}

function scoreSection(
  section: OrganizationalContextSection,
  queryTerms: Map<string, number>,
): number {
  if (queryTerms.size === 0) return 0;
  const headingTerms = termFrequency(section.heading);
  const bodyTerms = termFrequency(section.markdown);
  let score = 0;
  for (const [term, queryWeight] of queryTerms) {
    if (headingTerms.has(term)) score += 20 * queryWeight;
    score += Math.min(4, bodyTerms.get(term) ?? 0) * queryWeight;
  }
  return score;
}

function selectRelevantSections(
  ranked: Array<{ section: OrganizationalContextSection; score: number }>,
  limits: { maxChars: number; maxSections: number },
): string[] {
  const selected: string[] = [];
  let remaining = limits.maxChars;
  for (const candidate of ranked.slice(0, limits.maxSections)) {
    if (remaining <= 0) break;
    const markdown = truncateMarkdown(candidate.section.markdown, remaining);
    if (!markdown) break;
    selected.push(markdown);
    remaining -= markdown.length;
  }
  return selected;
}

function truncateMarkdown(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;
  const marker =
    "\n\n_[Section truncated to the configured prompt budget. The complete version is available in the session workspace.]_";
  const contentLimit = Math.max(0, maxChars - marker.length);
  if (contentLimit === 0) return "";
  const paragraphBreak = markdown.lastIndexOf("\n\n", contentLimit);
  const cutAt =
    paragraphBreak >= Math.floor(contentLimit * 0.6)
      ? paragraphBreak
      : contentLimit;
  return `${markdown.slice(0, cutAt).trimEnd()}${marker}`;
}
