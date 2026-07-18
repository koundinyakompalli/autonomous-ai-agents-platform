import { adfToText } from "./repo-router/ticket-input.js";

export type TicketIntentRepoHintKind = "repo" | "repository" | "github_repo";

export type TicketIntentBranchHintKind =
  | "retrofit_target"
  | "target"
  | "target_branch"
  | "base_branch"
  | "working_branch"
  | "branch"
  | "release"
  | "version";

export interface TicketIntentHint<TKind extends string = string> {
  kind: TKind;
  label: string;
  value: string;
  line: string;
  lineNumber: number;
}

export interface TicketIntentIgnoredHint
  extends TicketIntentHint<TicketIntentBranchHintKind> {
  negationPhrase: string;
}

export interface TicketIntentRetrofitContext {
  sourceJiraKey: string;
  sourceBranch: string;
  targetBranch: string;
  sourcePrUrl?: string;
}

export interface TicketIntentRetrofit {
  present: boolean;
  complete: boolean;
  context: TicketIntentRetrofitContext | null;
  targetBranches: string[];
  skippedTargetBranches: string[];
  missingFields: Array<"retrofit" | "from" | "target">;
  hints: {
    retrofit?: TicketIntentHint<"retrofit">;
    from?: TicketIntentHint<"from">;
    target?: TicketIntentHint<"target">;
  };
}

export interface TicketIntentBranchConflict {
  reason: "target_conflict";
  values: string[];
  hints: Array<TicketIntentHint<TicketIntentBranchHintKind>>;
}

export interface ParsedTicketIntent {
  repoHint: TicketIntentHint<TicketIntentRepoHintKind> | null;
  retrofit: TicketIntentRetrofit;
  positiveBranchHints: Array<TicketIntentHint<TicketIntentBranchHintKind>>;
  ignoredNegatedBranchHints: TicketIntentIgnoredHint[];
  branchConflicts: TicketIntentBranchConflict[];
}

const FIELD_LABEL_PATTERN =
  "github\\s+repo|repository|repo|target\\s+branch|base\\s+branch|working\\s+branch|branch|retrofit|from|target|release|version";
const FIELD_PATTERN = new RegExp(
  `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?\\s*(${FIELD_LABEL_PATTERN})\\s*(?:\\*\\*)?\\s*[:=-]\\s*(?:\\*\\*)?\\s*(.+?)\\s*$`,
  "i",
);
const EMPTY_FIELD_PATTERN = new RegExp(
  `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?\\s*(${FIELD_LABEL_PATTERN})\\s*(?:\\*\\*)?\\s*[:=-]\\s*(?:\\*\\*)?\\s*$`,
  "i",
);

const INLINE_BRANCH_PATTERNS: Array<{
  kind: TicketIntentBranchHintKind;
  label: string;
  rx: RegExp;
}> = [
  {
    kind: "target_branch",
    label: "target branch",
    rx: /\btarget\s+branch\s*[:=-]?\s*([A-Za-z0-9._/-]+)\b/i,
  },
  {
    kind: "base_branch",
    label: "base branch",
    rx: /\bbase\s+branch\s*[:=-]?\s*([A-Za-z0-9._/-]+)\b/i,
  },
  {
    kind: "working_branch",
    label: "working branch",
    rx: /\bworking\s+branch\s*[:=-]?\s*([A-Za-z0-9._/-]+)\b/i,
  },
  {
    kind: "branch",
    label: "branch",
    rx: /\bbranch\s*[:=-]?\s*([A-Za-z0-9._/-]+)\b/i,
  },
  {
    kind: "release",
    label: "release",
    rx: /\brelease\s*[:=-]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b/i,
  },
  {
    kind: "version",
    label: "version",
    rx: /\bversion\s*[:=-]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b/i,
  },
];

const RAW_NEGATION_PHRASES = [
  "do not cherry-pick from",
  "don't cherry-pick from",
  "do not base work on",
  "don't base work on",
  "must not follow",
  "do not follow",
  "do not use",
  "don't use",
  "must not use",
  "deprecated",
  "avoid",
];
const NEGATION_PHRASES = [...RAW_NEGATION_PHRASES].sort(
  (a, b) => b.length - a.length,
);

export const MAX_MULTI_BRANCH_RETROFIT_TARGETS = 7;

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function kindForLabel(label: string):
  | TicketIntentRepoHintKind
  | TicketIntentBranchHintKind
  | "retrofit"
  | "from" {
  const normalized = normalizeLabel(label);
  switch (normalized) {
    case "github repo":
      return "github_repo";
    case "repository":
      return "repository";
    case "repo":
      return "repo";
    case "target branch":
      return "target_branch";
    case "base branch":
      return "base_branch";
    case "working branch":
      return "working_branch";
    case "branch":
      return "branch";
    case "retrofit":
      return "retrofit";
    case "from":
      return "from";
    case "target":
      return "target";
    case "release":
      return "release";
    case "version":
      return "version";
    default:
      return "branch";
  }
}

function stripMarkdownValue(value: string): string {
  return value
    .trim()
    .replace(/[.,;]+$/g, "")
    .replace(/^`+|`+$/g, "")
    .replace(/^<(.+)>$/g, "$1")
    .replace(/^\*\*(.+)\*\*$/g, "$1")
    .replace(/^[*_]+|[*_]+$/g, "")
    .replace(/[.,;]+$/g, "")
    .trim();
}

function cleanValue(value: string): string {
  const withoutComment = value.split(/\s+#/)[0] ?? value;
  return stripMarkdownValue(withoutComment);
}

function branchKey(value: string): string {
  return value.trim().toLowerCase();
}

function splitTargetBranchValues(value: string): string[] {
  return value
    .split(",")
    .map((part) => stripMarkdownValue(part))
    .filter((part) => part.length > 0);
}

function appendUniqueBranch(values: string[], value: string): void {
  if (!values.some((candidate) => branchKey(candidate) === branchKey(value))) {
    values.push(value);
  }
}

function isRepoKind(kind: string): kind is TicketIntentRepoHintKind {
  return kind === "repo" || kind === "repository" || kind === "github_repo";
}

function isBranchKind(kind: string): kind is TicketIntentBranchHintKind {
  return (
    kind === "target" ||
    kind === "target_branch" ||
    kind === "base_branch" ||
    kind === "working_branch" ||
    kind === "branch" ||
    kind === "release" ||
    kind === "version"
  );
}

export function looksLikeBranchName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "main" || normalized === "master") {
    return true;
  }

  return /[0-9/_\-.]/.test(value);
}

function looksLikeNegatedBranchToken(value: string): boolean {
  const normalized = cleanValue(value).toLowerCase();
  if (normalized === "main" || normalized === "master") {
    return true;
  }
  if (normalized.includes("/")) {
    return true;
  }
  if (/^(fix|hotfix|feature|bugfix|release|support|develop|dev)[._-]/i.test(normalized)) {
    return true;
  }
  if (normalized.includes("monorepo")) {
    return true;
  }
  return /^v?\d+\.\d+(?:\.\d+)?$/.test(normalized);
}

function findNegationPhrase(line: string, value: string): string | null {
  const lowerLine = line.toLowerCase();
  const lowerValue = value.toLowerCase();
  const valueIndex = lowerLine.indexOf(lowerValue);
  const searchEnd = valueIndex >= 0 ? valueIndex : lowerLine.length;
  const windowStart = Math.max(0, searchEnd - 100);
  const localPrefix = lowerLine.slice(windowStart, searchEnd);

  for (const phrase of NEGATION_PHRASES) {
    if (localPrefix.includes(phrase)) {
      return phrase;
    }
  }

  return null;
}

function makeHint<TKind extends string>(
  kind: TKind,
  label: string,
  value: string,
  line: string,
  lineNumber: number,
): TicketIntentHint<TKind> {
  return {
    kind,
    label: label.trim(),
    value: cleanValue(value),
    line: line.trim(),
    lineNumber,
  };
}

function addIgnoredNegatedBranchHint(
  ignoredHints: TicketIntentIgnoredHint[],
  hint: TicketIntentHint<TicketIntentBranchHintKind>,
  negationPhrase: string,
): void {
  const valueKey = branchKey(hint.value);
  const alreadyRecorded = ignoredHints.some(
    (existing) =>
      existing.lineNumber === hint.lineNumber &&
      branchKey(existing.value) === valueKey,
  );
  if (alreadyRecorded) {
    return;
  }

  ignoredHints.push({
    ...hint,
    negationPhrase,
  });
}

export function normalizeTicketIntentDescription(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  return adfToText(value).trim();
}

function mergeSplitFieldValueLines(ticketText: string): string[] {
  const lines = ticketText.replace(/\r\n/g, "\n").split("\n");
  const merged: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!EMPTY_FIELD_PATTERN.test(line)) {
      merged.push(line);
      continue;
    }

    let valueIndex = index + 1;
    while (valueIndex < lines.length && !lines[valueIndex].trim()) {
      valueIndex += 1;
    }

    const valueLine = lines[valueIndex];
    if (
      valueLine === undefined ||
      FIELD_PATTERN.test(valueLine) ||
      EMPTY_FIELD_PATTERN.test(valueLine)
    ) {
      merged.push(line);
      continue;
    }

    merged.push(`${line.trim()} ${valueLine.trim()}`);
    index = valueIndex;
  }

  return merged;
}

function firstDistinctConflict(
  retrofitTarget: TicketIntentHint<"target"> | undefined,
  branchHints: Array<TicketIntentHint<TicketIntentBranchHintKind>>,
): TicketIntentBranchConflict[] {
  if (!retrofitTarget) {
    return [];
  }

  const conflictingHints = branchHints.filter(
    (hint) =>
      hint.kind !== "retrofit_target" &&
      (hint.kind === "target_branch" ||
        hint.kind === "base_branch" ||
        hint.kind === "working_branch" ||
        hint.kind === "branch") &&
      branchKey(hint.value) !== branchKey(retrofitTarget.value),
  );

  if (conflictingHints.length === 0) {
    return [];
  }

  return [
    {
      reason: "target_conflict",
      values: Array.from(
        new Set([retrofitTarget.value, ...conflictingHints.map((h) => h.value)]),
      ),
      hints: [
        {
          ...retrofitTarget,
          kind: "retrofit_target" as const,
        },
        ...conflictingHints,
      ],
    },
  ];
}

export function parseTicketIntent(ticketText: string): ParsedTicketIntent {
  const lines = mergeSplitFieldValueLines(ticketText);
  let repoHint: TicketIntentHint<TicketIntentRepoHintKind> | null = null;
  const positiveBranchHints: Array<
    TicketIntentHint<TicketIntentBranchHintKind>
  > = [];
  const ignoredNegatedBranchHints: TicketIntentIgnoredHint[] = [];
  const retrofitHints: TicketIntentRetrofit["hints"] = {};
  const retrofitTargetBranches: string[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const fieldMatch = line.match(FIELD_PATTERN);
    if (fieldMatch?.[1] && fieldMatch[2]) {
      const label = fieldMatch[1];
      const kind = kindForLabel(label);
      const value = cleanValue(fieldMatch[2]);
      if (!value) {
        return;
      }

      if (isRepoKind(kind)) {
        repoHint = repoHint ?? makeHint(kind, label, value, line, lineNumber);
        return;
      }

      if (kind === "retrofit") {
        retrofitHints.retrofit = makeHint(
          "retrofit",
          label,
          value,
          line,
          lineNumber,
        );
        return;
      }

      if (kind === "from") {
        retrofitHints.from = makeHint("from", label, value, line, lineNumber);
        return;
      }

      if (kind === "target") {
        for (const targetValue of splitTargetBranchValues(value)) {
          appendUniqueBranch(retrofitTargetBranches, targetValue);
        }
        retrofitHints.target =
          retrofitHints.target ?? makeHint("target", label, value, line, lineNumber);
      }

      if (isBranchKind(kind) && looksLikeBranchName(value)) {
        // Intentional fallthrough: `Target:` is both the retrofit target field
        // and the highest-precedence branch hint for the run branch.
        const branchKind =
          kind === "target" ? ("retrofit_target" as const) : kind;
        const branchValues =
          kind === "target" ? splitTargetBranchValues(value) : [value];
        for (const branchValue of branchValues) {
          if (!looksLikeBranchName(branchValue)) {
            continue;
          }
          const hint = makeHint(branchKind, label, branchValue, line, lineNumber);
          const negationPhrase = findNegationPhrase(line, branchValue);
          if (negationPhrase) {
            addIgnoredNegatedBranchHint(
              ignoredNegatedBranchHints,
              hint,
              negationPhrase,
            );
          } else {
            positiveBranchHints.push(hint);
          }
        }
        return;
      }
    }

    for (const pattern of INLINE_BRANCH_PATTERNS) {
      const match = line.match(pattern.rx);
      if (!match?.[1]) {
        continue;
      }
      const value = cleanValue(match[1]);
      if (!looksLikeBranchName(value)) {
        continue;
      }
      const hint = makeHint(pattern.kind, pattern.label, value, line, lineNumber);
      const negationPhrase = findNegationPhrase(line, value);
      if (negationPhrase) {
        addIgnoredNegatedBranchHint(
          ignoredNegatedBranchHints,
          hint,
          negationPhrase,
        );
      } else {
        positiveBranchHints.push(hint);
      }
      break;
    }

    const lowerLine = line.toLowerCase();
    const negationPhrase = NEGATION_PHRASES.find((phrase) =>
      lowerLine.includes(phrase),
    );
    if (negationPhrase) {
      const tokens = line.match(/\b[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]\b/g) ?? [];
      for (const branchToken of tokens.filter(looksLikeNegatedBranchToken)) {
        addIgnoredNegatedBranchHint(
          ignoredNegatedBranchHints,
          makeHint("branch", "branch", branchToken, line, lineNumber),
          negationPhrase,
        );
      }
    }
  });

  const retrofitPresent = Boolean(
    retrofitHints.retrofit ||
      (retrofitHints.from && retrofitTargetBranches.length > 0),
  );
  const missingFields: TicketIntentRetrofit["missingFields"] = [];
  if (retrofitPresent) {
    if (!retrofitHints.retrofit) missingFields.push("retrofit");
    if (!retrofitHints.from) missingFields.push("from");
    if (retrofitTargetBranches.length === 0) missingFields.push("target");
  }
  const targetBranches = retrofitTargetBranches.slice(
    0,
    MAX_MULTI_BRANCH_RETROFIT_TARGETS,
  );
  const skippedTargetBranches = retrofitTargetBranches.slice(
    MAX_MULTI_BRANCH_RETROFIT_TARGETS,
  );
  const retrofitComplete =
    retrofitPresent &&
    Boolean(
      retrofitHints.retrofit?.value &&
        retrofitHints.from?.value &&
        targetBranches.length > 0,
    );
  const context = retrofitComplete
    ? {
        sourceJiraKey: retrofitHints.retrofit!.value,
        sourceBranch: retrofitHints.from!.value,
        targetBranch: targetBranches[0],
      }
    : null;

  return {
    repoHint,
    retrofit: {
      present: retrofitPresent,
      complete: retrofitComplete,
      context,
      targetBranches,
      skippedTargetBranches,
      missingFields,
      hints: retrofitHints,
    },
    positiveBranchHints,
    ignoredNegatedBranchHints,
    branchConflicts: firstDistinctConflict(
      retrofitHints.target,
      positiveBranchHints,
    ),
  };
}
