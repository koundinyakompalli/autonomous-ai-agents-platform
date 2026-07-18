/**
 * Enriched ticket-input surface (v3.2).
 *
 * Pure, deterministic function that produces the ticket text consumed by
 * the extractor, deterministic scorer, and all three LLM prompts
 * (extractor, shortlist, decider). Given a Jira issue response, it flattens:
 *
 *   - summary, description, labels, components              (v3 baseline)
 *   - parent epic title, linked-issue titles,
 *     attachment filenames, acceptance criteria             (v3.2 additions)
 *   - comments, with PRISM Implementation Plan comments     (v3.2 key addition)
 *     always retained and remaining budget filled newest-first
 *
 * Every comment is wrapped in `[COMMENT n by AUTHOR]...[/COMMENT n]`. This
 * doubles as both a human-readable audit hint and an anti-prompt-injection
 * signal to the LLMs: each comment block is data, not instruction.
 *
 * All logic is pure: no Jira fetch, no side effects. The caller provides the
 * raw Jira response (already fetched by the orchestrator).
 */
import type {
  EnrichedTicketInput,
  EnrichedTicketInputSection,
  EnrichedTicketInputStats,
  RouterTicketInput,
} from "./types.js";

/** Default comment budget in characters. Override with the
 *  `ONESHOT_REPO_ROUTER_COMMENT_BUDGET_CHARS` env var or the options param. */
export const DEFAULT_COMMENT_BUDGET_CHARS = 12_000;

/** Safety valve: if a single PRISM plan comment exceeds this many chars,
 *  truncate it. Each PRISM plan is valuable but pathological sizes must not
 *  starve the rest of the input. */
const PRISM_PLAN_MAX_CHARS = 6_000;

/** Bot-author prefix signatures (case-insensitive, matched on the first
 *  200 chars of the comment body after ADF-to-text). PRISM plan detection
 *  runs BEFORE this filter, so PRISM plans are never dropped as bot output. */
const BOT_PREFIX_SIGNATURES: ReadonlyArray<string> = [
  "OneShot |",
  "OneShot Qualification",
  "QUALIFIER",
  "PRISM Error",
  "Specter AI Agent",
];

/** Bot author displayName exact matches. */
const BOT_AUTHOR_DISPLAY_NAMES: ReadonlyArray<string> = [
  "Specter bot",
  "OneShot bot",
  "QUALIFIER bot",
];

/** Jira custom field IDs commonly used for Acceptance Criteria. Different
 *  Jira projects use different IDs, so we probe a handful. */
const ACCEPTANCE_CRITERIA_FIELD_IDS: ReadonlyArray<string> = [
  "customfield_10000", // common default
  "customfield_10100",
  "customfield_10200",
  "customfield_10600",
  "customfield_10700",
  "customfield_11200",
];

/** Jira `names` map entries that indicate an acceptance-criteria field. */
const ACCEPTANCE_CRITERIA_NAME_PATTERN = /acceptance\s*criteria/i;

/**
 * Entry point. Produces a single text blob + structured audit record from
 * the Jira ticket. Deterministic — same input always produces same output.
 */
export function buildEnrichedTicketInput(
  ticket: RouterTicketInput,
  options: { commentBudgetChars?: number } = {},
): EnrichedTicketInput {
  const fields = ticket.fields ?? {};
  const budget =
    options.commentBudgetChars ??
    resolveBudgetFromEnv() ??
    DEFAULT_COMMENT_BUDGET_CHARS;

  const summary =
    typeof fields.summary === "string" ? fields.summary.trim() : "";
  const description = adfToText(fields.description).trim();
  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((v): v is string => typeof v === "string")
    : [];
  const components = flattenComponents(fields.components);

  const parentEpicTitle = extractParentEpicTitle(fields.parent);
  const linkedIssueTitles = extractLinkedIssueTitles(fields.issuelinks);
  const attachmentFilenames = extractAttachmentFilenames(fields.attachment);
  const acceptanceCriteria = extractAcceptanceCriteria(ticket);

  const commentClassification = classifyAndSelectComments(
    fields.comment,
    budget,
  );

  // Assemble the final ticket text.
  const lines: string[] = [];
  if (ticket.key) lines.push(ticket.key);
  if (summary) lines.push(summary);
  if (description) lines.push(description);
  if (labels.length > 0) lines.push("[LABELS] " + labels.join(", "));
  if (components.length > 0)
    lines.push("[COMPONENTS] " + components.join(", "));
  if (parentEpicTitle) lines.push("[PARENT EPIC] " + parentEpicTitle);
  if (linkedIssueTitles.length > 0) {
    lines.push("[LINKED]");
    for (const title of linkedIssueTitles) lines.push(title);
  }
  if (attachmentFilenames.length > 0) {
    lines.push("[ATTACHMENTS]");
    for (const filename of attachmentFilenames) lines.push(filename);
  }
  if (acceptanceCriteria) {
    lines.push("[ACCEPTANCE CRITERIA]");
    lines.push(acceptanceCriteria);
  }
  for (const c of commentClassification.ordered) {
    if (!c.included) continue;
    lines.push(`[COMMENT ${c.ordinal} by ${c.author} on ${c.created}]`);
    lines.push(c.body);
    lines.push(`[/COMMENT ${c.ordinal}]`);
  }

  const ticketText = lines.filter((line) => line.length > 0).join("\n");

  const sections: EnrichedTicketInputSection = {
    summary,
    description,
    parentEpicTitle,
    linkedIssueTitles,
    attachmentFilenames,
    acceptanceCriteria,
    comments: commentClassification.ordered.map((c) => ({
      id: c.id,
      author: c.author,
      created: c.created,
      isPrismPlan: c.isPrismPlan,
      isBotFiltered: c.isBotFiltered,
      included: c.included,
      truncated: c.truncated,
      bodyExcerpt: c.body.slice(0, 200),
    })),
    labels,
    components,
  };

  const stats: EnrichedTicketInputStats = {
    totalCommentsConsidered: commentClassification.totalConsidered,
    commentsIncluded: commentClassification.ordered.filter((c) => c.included)
      .length,
    commentsDroppedByBotFilter: commentClassification.droppedByBotFilter,
    commentsDroppedByBudget: commentClassification.droppedByBudget,
    commentBytesIncluded: commentClassification.bytesIncluded,
  };

  return { ticketText, sections, stats };
}

function resolveBudgetFromEnv(): number | null {
  const raw = process.env.ONESHOT_REPO_ROUTER_COMMENT_BUDGET_CHARS;
  if (raw === undefined || raw === null) return null;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Recursively flatten Atlassian Document Format (ADF) into plain text. Mirrors
 * the pattern used by VERITASJiraService.extractTextFromAdf but lives here so
 * this module has no cross-directory dependency.
 */
export function adfToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => adfToText(v)).join("");
  }
  if (typeof value !== "object") return "";

  const node = value as Record<string, unknown>;
  if (node.type === "text" && typeof node.text === "string") {
    return node.text;
  }
  if (node.type === "inlineCard" || node.type === "blockCard") {
    return extractSmartLinkText(node);
  }

  const parts: string[] = [];
  if (Array.isArray(node.content)) {
    for (const child of node.content) parts.push(adfToText(child));
  }

  const inner = parts.join("");
  if (node.type === "paragraph" || node.type === "heading") {
    return inner + "\n";
  }
  if (node.type === "listItem") {
    return "- " + inner + "\n";
  }
  if (node.type === "codeBlock") {
    return "```\n" + inner + "\n```\n";
  }
  return inner;
}

function extractSmartLinkText(node: Record<string, unknown>): string {
  const attrs = node.attrs;
  if (!attrs || typeof attrs !== "object") {
    return "";
  }

  const attrRecord = attrs as Record<string, unknown>;
  for (const candidate of [
    attrRecord.url,
    (attrRecord.data as Record<string, unknown> | undefined)?.url,
    (attrRecord.data as Record<string, unknown> | undefined)?.text,
    (attrRecord.data as Record<string, unknown> | undefined)?.title,
  ]) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }

    const jiraKey = candidate.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
    if (jiraKey) {
      return jiraKey;
    }

    return candidate.trim();
  }

  return "";
}

function flattenComponents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
      continue;
    }
    if (item && typeof item === "object") {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) {
        out.push(name.trim());
      }
    }
  }
  return dedupe(out);
}

function extractParentEpicTitle(parent: unknown): string | null {
  if (!parent || typeof parent !== "object") return null;
  const p = parent as Record<string, unknown>;
  const pf = (p.fields ?? {}) as Record<string, unknown>;
  const summary = pf.summary;
  if (typeof summary === "string" && summary.trim()) return summary.trim();
  return null;
}

function extractLinkedIssueTitles(issuelinks: unknown): string[] {
  if (!Array.isArray(issuelinks)) return [];
  const titles: string[] = [];
  for (const link of issuelinks) {
    if (!link || typeof link !== "object") continue;
    const l = link as Record<string, unknown>;
    for (const side of [l.inwardIssue, l.outwardIssue]) {
      if (!side || typeof side !== "object") continue;
      const s = side as Record<string, unknown>;
      const sf = (s.fields ?? {}) as Record<string, unknown>;
      const key = typeof s.key === "string" ? s.key : "";
      const summary = typeof sf.summary === "string" ? sf.summary.trim() : "";
      if (summary) {
        titles.push(key ? `${key}: ${summary}` : summary);
      }
    }
  }
  return dedupe(titles);
}

function extractAttachmentFilenames(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  const names: string[] = [];
  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;
    const a = att as Record<string, unknown>;
    if (typeof a.filename === "string" && a.filename.trim()) {
      names.push(a.filename.trim());
    }
  }
  return dedupe(names);
}

function extractAcceptanceCriteria(ticket: RouterTicketInput): string | null {
  const fields = ticket.fields ?? {};

  for (const [fieldId, name] of Object.entries(ticket.names ?? {})) {
    if (ACCEPTANCE_CRITERIA_NAME_PATTERN.test(name)) {
      const text = adfToText(fields[fieldId]).trim();
      if (text) return text;
    }
  }

  for (const fieldId of ACCEPTANCE_CRITERIA_FIELD_IDS) {
    if (fieldId in fields) {
      const text = adfToText(fields[fieldId]).trim();
      if (text) return text;
    }
  }

  return null;
}

interface ClassifiedComment {
  id: string;
  author: string;
  created: string;
  isPrismPlan: boolean;
  isBotFiltered: boolean;
  body: string;
  bodyLength: number;
  truncated: boolean;
  included: boolean;
  ordinal: number;
}

interface CommentClassification {
  ordered: ClassifiedComment[];
  totalConsidered: number;
  droppedByBotFilter: number;
  droppedByBudget: number;
  bytesIncluded: number;
}

/**
 * Classify each comment (PRISM-plan / bot-filtered) then select which ones to
 * include under the character budget:
 *
 *   1. PRISM Implementation Plan comments are ALWAYS retained (PRISM detection
 *      runs before bot filter). Each is individually truncated to
 *      `PRISM_PLAN_MAX_CHARS` as a safety valve.
 *   2. Bot-filtered non-PRISM comments are dropped.
 *   3. Remaining comments are sorted newest-first and included whole while
 *      they fit under the budget remaining after PRISM plans.
 *   4. A comment that doesn't fit is dropped whole (no mid-sentence cuts).
 */
function classifyAndSelectComments(
  commentField: unknown,
  budget: number,
): CommentClassification {
  const raw = extractCommentsArray(commentField);
  const totalConsidered = raw.length;

  // First pass: classify.
  const classified: ClassifiedComment[] = raw.map((c, idx) => {
    const body = adfToText(c.body).trim();
    const isPrismPlan = detectPrismPlan(body);
    const isBotFiltered =
      !isPrismPlan && (detectBotPrefix(body) || detectBotAuthor(c.author));
    return {
      id: c.id || `c${idx + 1}`,
      author: c.author || "Unknown",
      created: c.created || "",
      isPrismPlan,
      isBotFiltered,
      body,
      bodyLength: body.length,
      truncated: false,
      included: false,
      ordinal: 0,
    };
  });

  const droppedByBotFilter = classified.filter((c) => c.isBotFiltered).length;

  // PRISM plans: always retained, individually truncated to safety cap.
  const prismPlans = classified.filter((c) => c.isPrismPlan);
  let bytesUsed = 0;
  for (const plan of prismPlans) {
    if (plan.bodyLength > PRISM_PLAN_MAX_CHARS) {
      plan.body = plan.body.slice(0, PRISM_PLAN_MAX_CHARS);
      plan.truncated = true;
      plan.bodyLength = plan.body.length;
    }
    plan.included = true;
    bytesUsed += plan.bodyLength;
  }

  // Remaining candidates: non-PRISM, non-bot, not already included.
  const others = classified
    .filter((c) => !c.isPrismPlan && !c.isBotFiltered)
    .sort((a, b) => compareCreatedDesc(a.created, b.created));

  let droppedByBudget = 0;
  for (const c of others) {
    if (bytesUsed + c.bodyLength <= budget) {
      c.included = true;
      bytesUsed += c.bodyLength;
    } else {
      droppedByBudget += 1;
    }
  }

  // Preserve input order for the audit record so the ordinal is stable and
  // matches how the LLM will see the comments (oldest-first in the final text).
  const inInputOrder = [...classified].sort((a, b) =>
    compareCreatedAsc(a.created, b.created),
  );
  let ordinal = 0;
  for (const c of inInputOrder) {
    if (c.included) {
      ordinal += 1;
      c.ordinal = ordinal;
    }
  }

  return {
    ordered: inInputOrder,
    totalConsidered,
    droppedByBotFilter,
    droppedByBudget,
    bytesIncluded: bytesUsed,
  };
}

interface RawComment {
  id: string;
  author: string;
  created: string;
  body: unknown;
}

function extractCommentsArray(commentField: unknown): RawComment[] {
  if (!commentField || typeof commentField !== "object") return [];
  const cf = commentField as Record<string, unknown>;
  const arr = Array.isArray(cf.comments) ? cf.comments : null;
  if (!arr) return [];
  return arr
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => {
      const author =
        c.author && typeof c.author === "object"
          ? ((c.author as Record<string, unknown>).displayName as string) ||
            ((c.author as Record<string, unknown>).emailAddress as string) ||
            "Unknown"
          : "Unknown";
      return {
        id: typeof c.id === "string" ? c.id : "",
        author,
        created: typeof c.created === "string" ? c.created : "",
        body: c.body,
      };
    });
}

function detectPrismPlan(body: string): boolean {
  const head = body.slice(0, 200).trim();
  return (
    /^PRISM Implementation Plan Ticket:/i.test(head) ||
    /^PRISM Implementation Plan\b/i.test(head)
  );
}

function detectBotPrefix(body: string): boolean {
  const head = body.slice(0, 200).trim();
  return BOT_PREFIX_SIGNATURES.some((sig) =>
    head.toLowerCase().startsWith(sig.toLowerCase()),
  );
}

function detectBotAuthor(author: string): boolean {
  const trimmed = (author || "").trim();
  return BOT_AUTHOR_DISPLAY_NAMES.some(
    (name) => trimmed.toLowerCase() === name.toLowerCase(),
  );
}

function compareCreatedDesc(a: string, b: string): number {
  const ta = parseTimestamp(a);
  const tb = parseTimestamp(b);
  if (ta === tb) return 0;
  return tb - ta;
}

function compareCreatedAsc(a: string, b: string): number {
  return -compareCreatedDesc(a, b);
}

function parseTimestamp(value: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function dedupe<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
