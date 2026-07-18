import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from "react";
import {
  ONE_SHOT_NOTIFICATION_TYPES,
  ONE_SHOT_STATES,
} from "../../../src/oneshot/types.js";
import {
  aboutPanelHref,
  PROFILED_REPOS,
  type AboutPanel,
} from "./aboutData.js";
import { AGENT_STAGES, FONTS, STAGE_LABELS } from "./pipelineStyles.js";
import { glassPlaceStyle } from "./motion.js";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircuitBoard,
  Copy,
  FileText,
  GitBranch,
  Hash,
  ICON_SIZE,
  ICON_STROKE,
  Minus,
  Receipt,
  ShieldCheck,
  Sparkles,
  Tag,
  Telescope,
  type LucideIcon,
} from "./icons.js";

// ───────────────────────────────────────────────────────────────
// About — Guide panels:
//   • Features  — shared hero → capability grid → cinema stages
//   • How-to    — shared hero → operator workflow and templates
//   • Tech Spec — shared hero → sticky-TOC reference manual
//   • Changelog — shared hero → refined editorial timeline
// ───────────────────────────────────────────────────────────────

type Feature = {
  eyebrow: string;
  title: string;
  blurb: string;
  icon: LucideIcon;
};

export { aboutPanelHref, PROFILED_REPOS };
export type { AboutPanel };

type ProductNavItem = { label: string; panel: AboutPanel };

// Six leadership-facing capabilities. Real subsystems underneath, but the
// surface copy reads as benefits — not as variable names or infra terms.
const FEATURE_HIGHLIGHTS: ReadonlyArray<Feature> = [
  {
    eyebrow: "Qualifier",
    title: "Only ready tickets get through",
    blurb:
      "The Qualifier reads the ticket before build time starts. If scope is thin, it sends back the missing pieces instead of burning a workspace.",
    icon: ShieldCheck,
  },
  {
    eyebrow: "Isolation",
    title: "Each run gets its own room",
    blurb:
      "A ticket runs in a clean workspace with its own branch state. OneShot checks branch drift before it touches code.",
    icon: GitBranch,
  },
  {
    eyebrow: "Continuity",
    title: "Revision rounds remember the work",
    blurb:
      "When a draft comes back for changes, the next pass keeps the prior attempt, reviewer notes, and repo facts in view.",
    icon: CircuitBoard,
  },
  {
    eyebrow: "Safety",
    title: "Destructive commands are blocked",
    blurb:
      "Forced overwrites and destructive shell commands are blocked at the boundary. OneShot can build. It cannot erase the repo.",
    icon: ShieldCheck,
  },
  {
    eyebrow: "Reliability",
    title: "A failed stage tells you where to look",
    blurb:
      "Stage work is isolated, retried, and shown with the reason it stopped. A stuck ticket does not stall every other run.",
    icon: Receipt,
  },
  {
    eyebrow: "Visibility",
    title: "Spend is traceable",
    blurb:
      "Tokens, cost, model, and duration are recorded per run and per stage, so model spend is easy to explain later.",
    icon: Telescope,
  },
];

const STAGE_VISUAL_BASE = "/oneshot/stages";
type AgentStage = (typeof AGENT_STAGES)[number];

type StageVisual = {
  image: string;
  accent: string;
  glow: string;
  eyebrow: string;
  proof: string;
  body: string;
};

const STAGE_VISUALS: Record<AgentStage, StageVisual> = {
  qualification: {
    image: `${STAGE_VISUAL_BASE}/about-stage-qualify-openai.webp`,
    accent: "#6ddcff",
    glow: "rgba(109, 220, 255, 0.22)",
    eyebrow: "The ticket reaches the gate",
    proof: "Title, description, acceptance criteria, intake label",
    body: "OneShot checks whether the ticket is clear enough to automate before any code path opens.",
  },
  planning: {
    image: `${STAGE_VISUAL_BASE}/about-stage-plan-openai.webp`,
    accent: "#9d8cff",
    glow: "rgba(157, 140, 255, 0.22)",
    eyebrow: "Repo facts become a plan",
    proof: "Repo scan, target files, test commands, risk notes",
    body: "The Planner turns ticket intent into repo-specific work: files, tests, risks, and validation steps.",
  },
  review: {
    image: `${STAGE_VISUAL_BASE}/about-stage-validate-openai.webp`,
    accent: "#63e6d3",
    glow: "rgba(99, 230, 211, 0.2)",
    eyebrow: "The plan is challenged before build",
    proof: "Scope fit, missing context, acceptance criteria alignment",
    body: "The Reviewer tests the plan against the ticket before build time and budget are spent.",
  },
  implementation: {
    image: `${STAGE_VISUAL_BASE}/about-stage-build-openai.webp`,
    accent: "#87a7ff",
    glow: "rgba(135, 167, 255, 0.22)",
    eyebrow: "Work happens in isolation",
    proof: "Isolated workspace, changed files, draft summary",
    body: "The Implementer writes in its own workspace and records the diff, logs, and state changes for review.",
  },
  code_review: {
    image: `${STAGE_VISUAL_BASE}/about-stage-review-openai.webp`,
    accent: "#e78bd7",
    glow: "rgba(231, 139, 215, 0.18)",
    eyebrow: "The diff is inspected before delivery",
    proof: "Reviewer findings, revision rounds, attempt limits",
    body: "Code Reviewer looks for broken assumptions before the change moves toward delivery.",
  },
  testing: {
    image: `${STAGE_VISUAL_BASE}/about-stage-test-openai.webp`,
    accent: "var(--ok)",
    glow: "rgba(127, 227, 161, 0.22)",
    eyebrow: "The run ends with proof",
    proof: "Test result, readiness gates, draft or ready PR",
    body: "Tester checks commands and logs before OneShot opens or updates the pull request.",
  },
};

const PRODUCT_NAV: ReadonlyArray<ProductNavItem> = [
  { label: "Features", panel: "features" },
  { label: "How-to", panel: "how-to" },
  { label: "Tech Spec", panel: "tech-spec" },
  { label: "Changelog", panel: "changelog" },
];

const LAST_UPDATED_LABEL = "June 16, 2026";
const ONESHOT_DISPLAY_VERSION = __APP_VERSION__;

const techSpecSlug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const TECH_SPEC_GROUPS: ReadonlyArray<{
  title: string;
  caption: string;
  rows: ReadonlyArray<{ label: string; value: string }>;
}> = [
  {
    title: "Pipeline",
    caption: "Six queue-isolated stages move one run from ticket to PR.",
    rows: [
      {
        label: "Stages",
        value:
          "Qualifier, Planner, Reviewer, Implementer, Code Reviewer, Tester.",
      },
      {
        label: "Queues",
        value:
          "SQS FIFO queue per stage, each with a dedicated DLQ for failure isolation.",
      },
      {
        label: "Lifecycle",
        value:
          "18 run states cover queueing, active work, PR delivery, escalation, blocked paths, and failure.",
      },
      {
        label: "Recovery",
        value:
          "Stale active runs can be reconciled and republished. Terminal runs stay closed.",
      },
    ],
  },
  {
    title: "Qualification",
    caption: "A readiness gate decides whether pipeline should start.",
    rows: [
      {
        label: "Opt-in",
        value:
          "Manual OneShot tickets use PFOS. Scan EPICs use WIZ-SCAN-PENDING, SONAR-SCAN-PENDING, or WIZ-CODE-SCAN-PENDING and generate child tickets with the OneShot intake label.",
      },
      {
        label: "Verdict",
        value:
          "An LLM qualifier reads the ticket and returns a structured verdict: qualified or not, template match, blockers, warnings, and reasoning.",
      },
      {
        label: "Telemetry",
        value:
          "A six-part readiness scorer checks acceptance criteria, scope, repo hints, testing notes, and boundaries. It writes analytics to oneshot_ticket_readiness_scores but does not gate routing.",
      },
      {
        label: "Controls",
        value:
          "PFOS-FORCE-APPROVE bypasses rejection; PFOS-REPLAN discards the current plan and replans the same run from branch head.",
      },
    ],
  },
  {
    title: "Planning & Grounding",
    caption: "Plans start from real repos, files, and linked specs.",
    rows: [
      {
        label: "Repo routing",
        value:
          "Explicit repo fields, description directives, route cards, domain rules, retrofit cues, and router confirmations select the repo.",
      },
      {
        label: "Repo scan",
        value:
          "Planner receives stack, build tool, test framework, root files, entry points, and key dependencies.",
      },
      {
        label: "Plan artifact",
        value:
          "Structured objectives, acceptance criteria, target files, implementation notes, and validation steps.",
      },
      {
        label: "Evidence",
        value:
          "Planner grounding keeps references tied to files, repo metadata, or linked specs.",
      },
    ],
  },
  {
    title: "Implementation",
    caption: "Build work runs in an isolated workspace with guarded handoffs.",
    rows: [
      {
        label: "Workspace",
        value:
          "Shared repo cache plus per-run local worktree, guarded by database-backed leases so stages do not mutate the same workspace concurrently.",
      },
      {
        label: "Implementer",
        value:
          "Claude via Bedrock writes code with tool access, command guardrails, stage token budgets, and retry classification.",
      },
      {
        label: "Diff evidence",
        value:
          "Implementation captures commit SHA, changed files, git diff, logs, and session notes.",
      },
      {
        label: "Revision context",
        value:
          "Revision builds preserve approved spec IDs and can fork-resume the prior implementer session.",
      },
    ],
  },
  {
    title: "Review & Test",
    caption: "Plans and diffs get challenged before delivery.",
    rows: [
      {
        label: "Plan review",
        value:
          "Reviewer checks clarity, feasibility, completeness, blockers, and scope fit before implementation starts.",
      },
      {
        label: "Code review",
        value:
          "Code Reviewer evaluates the diff against the approved plan and prior review context.",
      },
      {
        label: "Providers",
        value:
          "OpenAI or Anthropic models handles Reviewer and Code Reviewer in the current specs.",
      },
      {
        label: "Tester",
        value:
          "Deterministic tester parses command output, exit codes, and build logs before draft or ready PR handoff.",
      },
    ],
  },
  {
    title: "Git, PR & Jira",
    caption: "Delivery stays tied to the ticket and branch state.",
    rows: [
      {
        label: "Branching",
        value:
          "Target branch resolution, branch drift detection, branch hygiene, implementation branch, and candidate SHA checks.",
      },
      {
        label: "Pull request",
        value:
          "OneShot creates or updates a draft or ready PR with structured title, body, artifacts, and readiness state.",
      },
      {
        label: "Jira",
        value:
          "Progress, escalation, drift, result, and delivery comments are rendered as Jira notifications.",
      },
      {
        label: "Escalation",
        value:
          "Review or verification budget exhaustion can open a WIP draft PR with the context needed for a human handoff.",
      },
    ],
  },
  {
    title: "Observability",
    caption: "Every meaningful action leaves telemetry and artifacts.",
    rows: [
      {
        label: "Events",
        value:
          "Run events record state transitions, claims, artifact storage, and stage lifecycle details.",
      },
      {
        label: "Artifacts",
        value:
          "Plan, review, implementation, code review, test result, and postmortem artifacts are versioned per stage.",
      },
      {
        label: "Cost",
        value:
          "Tokens, cost, duration, provider, model, input/output/cache token counts, and pricing aliases are tracked.",
      },
      {
        label: "Dashboard",
        value:
          "Overview, runs, agents, queue, throughput, costs, statistics, and a detail modal show the run record. A command palette launches new runs by Jira key.",
      },
    ],
  },
  {
    title: "Operations & Providers",
    caption: "Runtime controls keep production work inside clear limits.",
    rows: [
      {
        label: "Health",
        value:
          "Consumers expose health/readiness endpoints and tune SQS visibility while long-running stage work is active.",
      },
      {
        label: "Prompt source",
        value:
          "Prompts and guardrails can load from S3 or local source. Healthcare guardrails are validated at startup.",
      },
      {
        label: "Preview deploy",
        value:
          "Preview deployment records build/deploy state and can dispatch GitHub Actions into named slots.",
      },
      {
        label: "Provider split",
        value:
          "Bedrock Claude powers Qualifier, Planner, and Implementer paths; OpenAI reviewers provide adversarial checks.",
      },
    ],
  },
];

const REPO_BASE_URL =
  "https://github.com/mhk-repos/cp-autonomous-ai-agents-platform";
const CHANGELOG_URL = `${REPO_BASE_URL}/blob/main/CHANGELOG.md`;
const FEATURE_REFERENCE_URL = `${REPO_BASE_URL}/blob/main/docs/ONESHOT_FEATURES.md`;
const RUNBOOK_URL = `${REPO_BASE_URL}/blob/main/docs/ONESHOT_RUNBOOK.md`;
const ONESHOT_FORMATTER_ROVO_URL =
  "https://home.atlassian.com/o/68k14ka0-3db3-16c3-6d43-ad0a6b4cjc28/people/agent/035ce2a2-414d-4181-8671-45472ed477b7?cloudId=85b42bc3-1fd1-48e1-8f21-cf3c8d2eae05&rovoChatCloudId=85b42bc3-1fd1-48e1-8f21-cf3c8d2eae05";

// ───────────────────────────────────────────────────────────────
// SPEC SHEET DATA — JetBrains-style: rows are {capability, status, notes}.
// ───────────────────────────────────────────────────────────────

type SpecStatus = "yes" | "partial" | "no";
type SpecRow = {
  capability: string;
  status: SpecStatus;
  notes: string;
};
type SpecSection = {
  title: string;
  caption: string;
  anchor?: string;
  rows: ReadonlyArray<SpecRow>;
};

const SPEC_SECTIONS: ReadonlyArray<SpecSection> = [
  {
    title: "Work OneShot can handle",
    caption: "The Jira work OneShot can pick up with confidence.",
    anchor: "about-what-fits",
    rows: [
      {
        capability: "Feature work",
        status: "yes",
        notes:
          "New endpoints, service methods, fields, screens, validation, or feature toggles with clear acceptance criteria.",
      },
      {
        capability: "Defect work with research done",
        status: "yes",
        notes:
          "Bug fixes work when the root cause is named, the file or class is identified, and the expected behavior is documented.",
      },
      {
        capability: "Retrofit / backport work",
        status: "yes",
        notes:
          "Requires Retrofit, From, and Target fields together; carries retrofit context through the same six-stage pipeline.",
      },
      {
        capability: "Multi-repo feature work",
        status: "yes",
        notes:
          "When requirements map to independently buildable slices across profiled repos, the Qualifier auto-splits the ticket into a linked group of single-repo runs, one PR per repo in merge order. Repos that depend on each other's unmerged changes at compile time are not split.",
      },
      {
        capability: "Test additions",
        status: "yes",
        notes:
          "Supported when the behavior already exists and the work names the target test file, scenario, or expected assertion. OneShot can add or adjust tests, but it should not discover requirements from scratch.",
      },
      {
        capability: "Wiz scan batches",
        status: "yes",
        notes:
          "Supported from WIZ-SCAN-PENDING or WIZ-SCAN-APPROVED on a scan EPIC. TRIAGE groups findings and creates bounded PFOS remediation child stories.",
      },
      {
        capability: "SonarQube scan batches",
        status: "yes",
        notes:
          "Supported from SONAR-SCAN-PENDING or SONAR-SCAN-APPROVED on a scan EPIC. TRIAGE creates SONAR-AUTOFIX child stories for auto-fixable issues.",
      },
      {
        capability: "Wiz Code (SAST) scan batches",
        status: "yes",
        notes:
          "Supported from WIZ-CODE-SCAN-PENDING on a scan EPIC (auto-apply, no SCAN-APPROVED gate). TRIAGE routes all SAST findings to Team A, groups them into code-fix stories by repo, module, and CWE, and pushes them into OneShot via PFOS.",
      },
      {
        capability: "Documentation artifact tasks",
        status: "yes",
        notes:
          "Supported for documentation-only child tasks with DOCS-GENERATE plus one DOC-TYPE-* label. OneShot attaches the generated markdown, Jira summary, and JSON evidence artifact back to Jira.",
      },
      {
        capability: "Refactors with clear scope",
        status: "partial",
        notes:
          "Accepted when the target files and the refactor pattern are explicit; broad rewrites are not.",
      },
      {
        capability: "Defects requiring investigation",
        status: "no",
        notes:
          '"Something is broken, please investigate" asks. OneShot implements known fixes. It does not diagnose unknowns.',
      },
      {
        capability: "Net-new architecture / system design",
        status: "no",
        notes:
          "Cross-cutting design work with no named files belongs in a design doc, not OneShot.",
      },
      {
        capability: "Intermittent / flaky production failures",
        status: "no",
        notes:
          "Unknown root cause means the planner has nothing to ground a plan on.",
      },
    ],
  },
  {
    title: "Repo support and routing",
    caption: "How OneShot decides where work should run.",
    rows: [
      {
        capability: "Profiled repos with auto-routing",
        status: "yes",
        notes:
          "The profiled repo catalog below is the auto-routing set. No Repo: directive is required when the work clearly maps to one of those profiles.",
      },
      {
        capability: "Non-profiled repos with explicit Repo",
        status: "yes",
        notes:
          "Outside the profiled catalog, OneShot does not auto-detect the repository. Add `Repo: owner/repo-name` to the description; the owner must be allowed/configured.",
      },
      {
        capability: "Repos outside configured owner search",
        status: "partial",
        notes:
          "Bare Repo: values are searched only under configured GitHub owners such as mhk-repos. Explicit owner/repo or GitHub URLs can resolve if accessible; unresolved or ambiguous repos stop at Qualifier before a run starts.",
      },
    ],
  },
  {
    title: "When not to use OneShot",
    caption: "Work that is not compatible with OneShot.",
    rows: [
      {
        capability: "Diagnostic investigation of unknowns",
        status: "no",
        notes:
          "Run the investigation first; bring OneShot the named root cause and expected behavior.",
      },
      {
        capability: "Epics and requirement gathering",
        status: "no",
        notes:
          "Epics, discovery work, vague business asks, and requirement-gathering belong upstream. Break them into implementation-ready CPDEV work items with acceptance criteria before using OneShot.",
      },
      {
        capability: "Schema migrations without explicit acceptance criteria",
        status: "no",
        notes:
          "Migration steps, rollback plan, and verification must be in the ticket before OneShot will route.",
      },
      {
        capability: "Auto-merge / unattended delivery",
        status: "no",
        notes:
          "OneShot always opens a PR. It does the work; you decide whether to ship.",
      },
      {
        capability: "Long-running redesigns or research projects",
        status: "no",
        notes:
          "Stage budgets are tuned for ticket-scoped work, not multi-week initiatives.",
      },
    ],
  },
  {
    title: "Labels and retry controls",
    caption: "How an author opts in, retries, or asks for a replan.",
    rows: [
      {
        capability: "PFOS: opt-in trigger",
        status: "yes",
        notes:
          "Required. Without PFOS the orchestrator skips the ticket entirely.",
      },
      {
        capability: "PFOS-FORCE-APPROVE: bypass rejection",
        status: "yes",
        notes:
          "Re-trigger after escalation. Skips re-qualification and resumes the escalated run into implementation or testing.",
      },
      {
        capability: "PFOS-REPLAN: discard plan and same-run replan",
        status: "yes",
        notes:
          "Replans eligible pre-PR runs in place and consumes the label; failed or blocked runs do not create fresh duplicates.",
      },
    ],
  },
];

type FieldTone = "required" | "optional" | "recommended";

type TemplateBlock =
  | { kind: "h"; text: string; tone: FieldTone }
  | { kind: "note"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: ReadonlyArray<string> }
  | {
      kind: "kv";
      rows: ReadonlyArray<{ key: string; value: string; tone?: FieldTone }>;
    };

type TicketTemplate = {
  ticketKey: string;
  issueType: "Story / Task / Bug" | "Retrofit";
  labels: ReadonlyArray<{ text: string; tone: "required" | "neutral" }>;
  description: ReadonlyArray<TemplateBlock>;
};

const CPDEV_TEMPLATE: TicketTemplate = {
  ticketKey: "CPDEV-XXXXX",
  issueType: "Story / Task / Bug",
  labels: [{ text: "PFOS", tone: "required" }],
  description: [
    { kind: "h", text: "Summary", tone: "required" },
    {
      kind: "p",
      text: "Add / Fix / Update <specific behavior> in <specific area>",
    },

    { kind: "h", text: "Overview", tone: "optional" },
    {
      kind: "p",
      text: "<What is changing, why it matters, and the expected user / system behavior. 2 to 4 sentences.>",
    },

    { kind: "h", text: "Acceptance Criteria", tone: "required" },
    {
      kind: "note",
      text: "Three or more items. Bulleted or Given / When / Then.",
    },
    {
      kind: "ul",
      items: [
        "The system should <observable behavior>.",
        "When <trigger>, then <outcome>.",
        "All existing behavior for <adjacent area> remains unchanged.",
      ],
    },

    { kind: "h", text: "Technical Details", tone: "recommended" },
    {
      kind: "note",
      text: "Hints that anchor the planner to real files and services. Optional, but boosts the Scope Clarity score.",
    },
    {
      kind: "kv",
      rows: [
        { key: "Repo", value: "<repo-name>" },
        { key: "Branch", value: "<branch if not default>" },
      ],
    },
    {
      kind: "ul",
      items: ["<path/to/file>", "<ClassName / component / service>"],
    },

    { kind: "h", text: "Out of Scope", tone: "optional" },
    {
      kind: "ul",
      items: ["Do not change <…>", "Do not include <…>"],
    },

    { kind: "h", text: "Testing Notes", tone: "optional" },
    {
      kind: "ul",
      items: ["Verify <…>", "Run / check <…>"],
    },
  ],
};

const RETROFIT_TEMPLATE: TicketTemplate = {
  ticketKey: "CPDEV-XXXXX",
  issueType: "Retrofit",
  labels: [{ text: "PFOS", tone: "required" }],
  description: [
    {
      kind: "note",
      text: "All three fields below are required together. Without them OneShot will not treat this as a retrofit.",
    },
    {
      kind: "kv",
      rows: [
        {
          key: "Retrofit",
          value: "CPDEV-<source-key>",
          tone: "required",
        },
        {
          key: "From",
          value: "<source-branch>",
          tone: "required",
        },
        {
          key: "Target",
          value: "<target-branch>",
          tone: "required",
        },
      ],
    },
  ],
};

function toneTag(tone: FieldTone): string {
  return ` [${tone}]`;
}

function templateToPlainText(t: TicketTemplate): string {
  const lines: string[] = [];
  lines.push(`Ticket: ${t.ticketKey}   Type: ${t.issueType}`);
  lines.push(`Labels [required]: ${t.labels.map((l) => l.text).join(", ")}`);
  lines.push("");
  lines.push("Description:");
  lines.push("");
  for (const b of t.description) {
    if (b.kind === "h") {
      lines.push(`## ${b.text}${toneTag(b.tone)}`);
    } else if (b.kind === "note") {
      lines.push(`// ${b.text}`);
    } else if (b.kind === "p") {
      lines.push(b.text);
    } else if (b.kind === "ul") {
      for (const item of b.items) lines.push(`- ${item}`);
    } else if (b.kind === "kv") {
      for (const row of b.rows) {
        const tag = row.tone ? toneTag(row.tone) : "";
        lines.push(`${row.key}${tag}: ${row.value}`);
      }
    }
    lines.push("");
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof document !== "undefined") {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, text.length);

    try {
      if (document.execCommand("copy")) {
        return;
      }
    } finally {
      document.body.removeChild(textArea);
    }
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  throw new Error("Clipboard is unavailable");
}

const HOW_TO_JUMP_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Templates", href: "#about-templates" },
  { label: "Docs mode", href: "#about-docs-mode" },
  { label: "Wiz scans", href: "#about-wiz-scans" },
  { label: "SonarQube", href: "#about-sonarqube-scans" },
  { label: "Wiz Code (SAST)", href: "#about-wiz-code-scans" },
  { label: "Before you run", href: "#about-before-run" },
  { label: "What fits", href: "#about-what-fits" },
  { label: "If it stops", href: "#about-if-it-stops" },
  { label: "Reference", href: "#about-reference" },
];

const BEFORE_RUN_CHECKLIST: ReadonlyArray<{
  title: string;
  body: string;
}> = [
  {
    title: "Ticket is implementation-ready",
    body: "OneShot needs clear scope, acceptance criteria, and repo hints. It is not a discovery or requirements tool.",
  },
  {
    title: "The right intake label is present",
    body: "Manual tickets use PFOS. Scan EPICs use WIZ-SCAN-PENDING, SONAR-SCAN-PENDING, or WIZ-CODE-SCAN-PENDING; generated child tickets receive the OneShot intake label automatically.",
  },
  {
    title: "Acceptance criteria describe observable behavior",
    body: "Name the outcome a reviewer can see, test, or verify without guessing.",
  },
  {
    title: "Repo, file, or service hints are included when known",
    body: "Hints point the Planner at real code instead of a broad ask.",
  },
  {
    title: "Out-of-scope boundaries are named",
    body: "Tell OneShot what nearby behavior must stay unchanged.",
  },
  {
    title: "Testing notes say what should be verified",
    body: "Give the expected command, suite, scenario, or manual check when you know it.",
  },
];

const STOP_GUIDANCE: ReadonlyArray<{ title: string; action: string }> = [
  {
    title: "Unclear ticket",
    action: "Add missing acceptance criteria or scope, then rerun.",
  },
  {
    title: "Repo ambiguity",
    action: "Confirm the target repo before work enters planning.",
  },
  {
    title: "Plan blocked",
    action: "Add repo evidence or use PFOS-REPLAN after correcting the ticket.",
  },
  {
    title: "Escalated after review",
    action: "Inspect artifacts before force-approving another attempt.",
  },
];

type DocumentationLabelRow = {
  task: string;
  labels: readonly [string, string];
};

const DOCUMENTATION_LABEL_RULES: ReadonlyArray<string> = [
  "Use exactly two labels on each documentation child task.",
  "Add DOCS-GENERATE plus one canonical DOC-TYPE-* label.",
  "Do not add multiple doc-type labels.",
  "Avoid DOC-TYPE-SUPPORT-INTERNAL; use DOC-TYPE-SUPPORT-RUNBOOK.",
];

const DOCUMENTATION_LABEL_ROWS: ReadonlyArray<DocumentationLabelRow> = [
  {
    task: "Release Notes",
    labels: ["DOCS-GENERATE", "DOC-TYPE-RELEASE-NOTES"],
  },
  {
    task: "Client-facing knowledge base",
    labels: ["DOCS-GENERATE", "DOC-TYPE-FUNCTIONALITY"],
  },
  {
    task: "Internal documentation for Support Teams",
    labels: ["DOCS-GENERATE", "DOC-TYPE-SUPPORT-RUNBOOK"],
  },
  {
    task: "Integration requirements and steps",
    labels: ["DOCS-GENERATE", "DOC-TYPE-INTEGRATION"],
  },
  {
    task: "Config Instructions",
    labels: ["DOCS-GENERATE", "DOC-TYPE-CONFIG"],
  },
  {
    task: "API Documentation",
    labels: ["DOCS-GENERATE", "DOC-TYPE-API"],
  },
  {
    task: "Deployment and infrastructure changes",
    labels: ["DOCS-GENERATE", "DOC-TYPE-DEPLOYMENT-RUNBOOK"],
  },
  {
    task: "Terraform variables or environment wiring",
    labels: ["DOCS-GENERATE", "DOC-TYPE-TERRAFORM"],
  },
  {
    task: "Troubleshooting Guidance",
    labels: ["DOCS-GENERATE", "DOC-TYPE-TROUBLESHOOTING"],
  },
];

type ScanUsageSection = {
  anchor: string;
  eyebrow: string;
  title: string;
  body: string;
  icon: LucideIcon;
  jiraNeeds: ReadonlyArray<string>;
  oneShotFlow: ReadonlyArray<string>;
  notes: ReadonlyArray<string>;
};

const SCAN_USAGE_SECTIONS: ReadonlyArray<ScanUsageSection> = [
  {
    anchor: "about-wiz-scans",
    eyebrow: "Wiz scan intake",
    title: "Use an EPIC to turn a Wiz export into OneShot remediation stories.",
    body: "Use this path for vulnerability scan batches. TRIAGE reads the scan attachment from the EPIC, groups the findings, and creates bounded child stories only after approval.",
    icon: ShieldCheck,
    jiraNeeds: [
      "Create or choose a CPDEV EPIC for the scan batch.",
      "Attach the Wiz CSV or XLSX export to the EPIC.",
      "Add WIZ-SCAN-PENDING to request analysis only.",
      "Review the TRIAGE analysis comment, then add WIZ-SCAN-APPROVED when the grouped story set is approved.",
    ],
    oneShotFlow: [
      "TRIAGE creates child stories under the EPIC after approval.",
      "Team A Maven remediation stories receive PFOS and enter QUALIFIER automatically.",
      "OneShot plans, implements, reviews, tests, and opens a PR for each PFOS child story.",
      "PFOS scope guidance stays in place for Wiz remediation, and implementation now records out-of-scope edits as warnings instead of hard-blocking the run.",
    ],
    notes: [
      "Infrastructure, runtime, archive, and unsupported package manager findings are routed or held for human review instead of being forced into OneShot.",
      "The EPIC moves through WIZ-SCAN-IN-PROGRESS and finishes as WIZ-SCAN-COMPLETE or WIZ-SCAN-COMPLETE-WITH-EXCEPTIONS.",
    ],
  },
  {
    anchor: "about-sonarqube-scans",
    eyebrow: "SonarQube scan intake",
    title: "Use an EPIC to turn SonarQube issues into scoped code-fix stories.",
    body: "Use this path for high-severity SonarQube batches. TRIAGE reads the Sonar CSV, groups auto-fixable issues by repo, module, and rule, then creates child stories after approval.",
    icon: CircuitBoard,
    jiraNeeds: [
      "Create or choose a CPDEV EPIC for the SonarQube scan batch.",
      "Attach the SonarQube CSV export to the EPIC; a sonarqube_ filename is recommended.",
      "Add SONAR-SCAN-PENDING to request analysis only.",
      "Review the TRIAGE analysis comment, then add SONAR-SCAN-APPROVED when the grouped story set is approved.",
    ],
    oneShotFlow: [
      "TRIAGE creates child stories under the EPIC after approval.",
      "Auto-fix child stories receive SONAR and SONAR-AUTOFIX, which QUALIFIER watches like PFOS.",
      "OneShot plans, implements, reviews, tests, and opens a PR for each SONAR-AUTOFIX child story.",
      "The PFOS dependency scope guard is not applied; Sonar fixes are constrained by listed issue keys, rules, files, and line numbers.",
    ],
    notes: [
      "Auto-fix currently includes vulnerabilities, blocker or critical bugs, and allowlisted blocker code smells.",
      "High-volume style or judgment-heavy findings are held as review-needed candidates instead of being pushed directly into OneShot.",
      "The EPIC moves through SONAR-SCAN-IN-PROGRESS and finishes as SONAR-SCAN-COMPLETE or SONAR-SCAN-COMPLETE-WITH-EXCEPTIONS.",
    ],
  },
  {
    anchor: "about-wiz-code-scans",
    eyebrow: "Wiz Code (SAST) scan intake",
    title:
      "Use an EPIC to turn Wiz Code findings into scoped code-fix stories.",
    body: "Use this path for Wiz Code Analysis (SAST) batches: code-logic weaknesses such as SQL injection (CWE-89) and XXE (CWE-611), one row per file and line. This is distinct from the Wiz dependency-CVE export and uses its own WIZ-CODE-SCAN label namespace.",
    icon: CircuitBoard,
    jiraNeeds: [
      "Create or choose a CPDEV EPIC for the Wiz Code scan batch.",
      "Attach the Wiz Code CSV export to the EPIC. TRIAGE auto-detects it from the weaknesses, filePath, and resource.name headers, so any filename works.",
      "Add WIZ-CODE-SCAN-PENDING. Unlike the Wiz-CVE and Sonar paths, this runs end to end automatically, with no SCAN-APPROVED gate.",
      "No manual approval step: TRIAGE creates the stories and queues them into OneShot directly.",
    ],
    oneShotFlow: [
      "TRIAGE applies the PENDING epic directly (no approval gate) and creates child stories under it.",
      "Every SAST finding is a code issue, so all findings route to Team A and are grouped into stories by repo, module, and CWE.",
      "Stories carry WIZ-CODE / SAST / PFOS labels; PFOS creates the task_management row so QUALIFIER picks them up and OneShot plans, implements, reviews, tests, and opens a PR for each.",
      "Each story lists the exact weakness, files, and line numbers to fix, and is scoped to those code-logic changes.",
    ],
    notes: [
      "Wiz Code (SAST) findings ride WIZ-CODE-SCAN labels so the Wiz dependency-CVE poller (WIZ-SCAN) never picks them up.",
      "The EPIC moves WIZ-CODE-SCAN-PENDING → IN-PROGRESS → COMPLETE (or COMPLETE-WITH-EXCEPTIONS); the SCAN-APPROVED / REVIEW-READY states are skipped for this auto-apply source.",
    ],
  },
];

// ── Motion ─────────────────────────────────────────────────────
const KEYFRAMES = `
@keyframes about-rise {
  from { opacity: 0; transform: translate3d(0, 14px, 0); filter: blur(6px); }
  to   { opacity: 1; transform: none;                     filter: blur(0);   }
}
@keyframes about-glass-materialize {
  0% {
    opacity: 0;
    transform: translate3d(0, 18px, 0) scale(0.985);
    filter: blur(14px) saturate(0.82);
  }
  72% {
    opacity: 1;
    transform: translate3d(0, -2px, 0) scale(1.006);
    filter: blur(0) saturate(1.08);
  }
  100% {
    opacity: 1;
    transform: none;
    filter: blur(0) saturate(1);
  }
}
@keyframes about-aurora-drift {
  0%   { transform: translate3d(-4%, -2%, 0) scale(1);   }
  50%  { transform: translate3d( 3%,  2%, 0) scale(1.06); }
  100% { transform: translate3d(-4%, -2%, 0) scale(1);   }
}
@keyframes about-image-breathe {
  0%, 100% { transform: scale(1); filter: saturate(0.98) contrast(0.98) brightness(1); }
  50% { transform: scale(1.028); filter: saturate(1.06) contrast(1.02) brightness(1.02); }
}
@keyframes about-color-orbit {
  0%   { transform: translate3d(-8%, -3%, 0) rotate(0deg) scale(1); opacity: 0.62; }
  45%  { transform: translate3d(5%, 4%, 0) rotate(8deg) scale(1.08); opacity: 0.9; }
  100% { transform: translate3d(-8%, -3%, 0) rotate(0deg) scale(1); opacity: 0.62; }
}
@keyframes about-stage-handoff {
  0%   { transform: translateX(-35%); opacity: 0; }
  14%, 78% { opacity: 1; }
  100% { transform: translateX(135%); opacity: 0; }
}
@keyframes about-stage-swap {
  from { opacity: 0.92; transform: translate3d(0, 10px, 0) scale(0.992); }
  to { opacity: 1; transform: none; }
}
.about-view {
  --about-frame-pad: clamp(20px, 2.4vw, 34px);
  --about-header-gap: clamp(18px, 1.8vw, 24px);
  overflow-x: clip;
  scroll-behavior: smooth;
  min-height: 100vh;
  padding: var(--about-frame-pad) var(--about-frame-pad) clamp(36px, 5vw, 64px);
  border-radius: 0;
  background: #000;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045);
}
.about-stack {
  display: flex;
  flex-direction: column;
  gap: var(--about-header-gap);
  max-width: 1220px;
  width: 100%;
  margin: 0 auto;
  padding-bottom: 32px;
}
.about-stack.is-specs { max-width: 1320px; }
.about-stack.is-specs .about-guide-hero {
  width: min(100%, 1220px);
  align-self: center;
}

/* ── Sticky tab bar ───────────────────────────────────────── */
.about-product-nav {
  position: sticky;
  top: 0;
  z-index: 20;
  width: calc(100% + (var(--about-frame-pad) * 2));
  margin: calc(var(--about-frame-pad) * -1) calc(var(--about-frame-pad) * -1) clamp(16px, 2.1vw, 28px);
  padding: 0 var(--about-frame-pad);
  overflow: hidden;
  isolation: isolate;
  border: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 0;
  background:
    linear-gradient(90deg, rgba(255,184,112,0.055), rgba(56,125,255,0.05) 52%, rgba(67,214,156,0.04)),
    rgba(10, 10, 11, 0.86);
  box-shadow:
    inset 0 -1px 0 rgba(255,255,255,0.045),
    0 16px 42px -34px rgba(0,0,0,0.95);
  backdrop-filter: blur(22px) saturate(1.35);
  -webkit-backdrop-filter: blur(22px) saturate(1.35);
}
.about-product-nav::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background:
    radial-gradient(circle at 38% 0%, rgba(64,118,255,0.16), transparent 34%),
    radial-gradient(circle at 72% 0%, rgba(255,184,112,0.16), transparent 30%);
  opacity: 0.55;
  pointer-events: none;
}
.about-product-nav-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: clamp(12px, 2vw, 28px);
  min-height: 58px;
  max-width: 1320px;
  width: 100%;
  margin: 0 auto;
}
.about-product-back {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--text);
  font-family: ${FONTS.body};
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.18s ease;
  white-space: nowrap;
}
.about-product-back:hover { color: #fff; }
.about-product-back:focus-visible {
  outline: 1px solid rgba(255, 184, 112, 0.48);
  outline-offset: 4px;
}
.about-product-nav-links {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: clamp(6px, 1vw, 16px);
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.about-product-nav-links::-webkit-scrollbar { display: none; }
.about-product-nav a {
  flex: 0 0 auto;
  padding: 7px 11px;
  border-radius: 999px;
  color: var(--text-2);
  font-family: ${FONTS.body};
  font-size: 12.5px;
  text-decoration: none;
  transition: color 0.18s ease, background 0.18s ease;
}
.about-product-nav a:hover,
.about-product-nav a:focus-visible {
  color: var(--text);
  background: rgba(255,255,255,0.08);
  outline: none;
}
.about-product-nav a.is-active {
  color: var(--text);
  background: rgba(255,255,255,0.1);
}

.about-scroll-reveal {
  opacity: 0;
  transform: translate3d(0, 24px, 0) scale(0.99);
  filter: blur(12px);
  transition:
    opacity 0.82s cubic-bezier(0.16, 1, 0.3, 1) var(--about-reveal-delay, 0ms),
    transform 0.82s cubic-bezier(0.16, 1, 0.3, 1) var(--about-reveal-delay, 0ms),
    filter 0.82s cubic-bezier(0.16, 1, 0.3, 1) var(--about-reveal-delay, 0ms);
}
.about-scroll-reveal[data-revealed="true"] {
  opacity: 1;
  transform: none;
  filter: none;
  animation: about-glass-materialize 0.86s cubic-bezier(0.16, 1, 0.3, 1) var(--about-reveal-delay, 0ms) both;
}
.about-section-stack {
  display: flex;
  flex-direction: column;
  gap: 28px;
  min-width: 0;
  scroll-margin-top: 96px;
}
.about-section-stack > * { min-width: 0; }

.about-link-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.055);
  color: var(--text-2);
  text-decoration: none;
  font-family: ${FONTS.body};
  font-size: 12.5px;
  transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}
.about-link-pill:hover,
.about-link-pill:focus-visible {
  transform: translateY(-1px);
  background: rgba(255,255,255,0.09);
  border-color: rgba(255,255,255,0.18);
  color: var(--text);
  outline: none;
}
.about-link-pill.is-primary {
  background: linear-gradient(135deg, rgba(255,184,112,0.22), rgba(255,184,112,0.08));
  border-color: rgba(255,184,112,0.42);
  color: var(--text);
}
.about-link-pill.is-primary:hover,
.about-link-pill.is-primary:focus-visible {
  background: linear-gradient(135deg, rgba(255,184,112,0.32), rgba(255,184,112,0.14));
  border-color: rgba(255,184,112,0.62);
}

/* ── Shared Guide hero ───────────────────────────────────────── */
.about-guide-hero {
  --hero-pad-y: clamp(72px, 12vw, 144px);
  --hero-pad-x: clamp(28px, 5vw, 80px);
  --hero-wordmark-size: clamp(58px, 6.5vw, 104px);
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border-radius: var(--r-lg);
  border: 1px solid rgba(255,255,255,0.08);
  padding: var(--hero-pad-y) var(--hero-pad-x);
  min-height: clamp(640px, 88vh, 880px);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: clamp(40px, 6vw, 96px);
  background: linear-gradient(180deg, rgba(13,15,19,0.96) 0%, rgba(2,3,5,0.98) 100%);
  scroll-margin-top: calc(140px + var(--about-header-gap));
}
.about-guide-hero .about-hero-aurora,
.about-guide-hero .about-hero-grain {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}
.about-hero-aurora {
  inset: -20%;
  background:
    radial-gradient(60% 50% at 86% 12%, rgba(72, 126, 255, 0.18) 0%, transparent 62%),
    radial-gradient(46% 44% at 22% 78%, rgba(255, 184, 112, 0.10) 0%, transparent 64%),
    radial-gradient(48% 42% at 78% 90%, rgba(67, 214, 156, 0.08) 0%, transparent 68%);
  filter: blur(40px);
  animation: about-aurora-drift 30s ease-in-out infinite;
}
.about-hero-grain {
  opacity: 0.06;
  mix-blend-mode: overlay;
  background-image:
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.9'/></svg>");
}
.about-guide-masthead {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}
.about-guide-masthead::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  width: clamp(280px, 22vw, 420px);
  height: clamp(280px, 22vw, 420px);
  transform: translate(-12%, -50%);
  background: radial-gradient(
    closest-side,
    rgba(255, 184, 112, 0.22),
    rgba(255, 184, 112, 0.08) 38%,
    transparent 70%
  );
  filter: blur(28px);
  pointer-events: none;
  z-index: 0;
}
.about-guide-masthead .oneshot-wordmark {
  position: relative;
  z-index: 2;
}
.about-guide-eyebrow {
  font-family: ${FONTS.mono};
  font-size: 11px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--dim);
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}
.about-guide-eyebrow::before {
  content: "";
  display: inline-block;
  width: 38px;
  height: 1px;
  background: currentColor;
  opacity: 0.55;
}
.about-guide-body {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: clamp(22px, 2.4vw, 32px);
  max-width: 880px;
}
.about-guide-title {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(48px, 7.4vw, 116px);
  line-height: 0.94;
  letter-spacing: 0;
  color: var(--text);
  font-variation-settings: '"opsz" 144, "wght" 360, "SOFT" 30';
  cursor: text;
}
.about-guide-title em {
  font-style: italic;
  color: var(--accent);
  font-variation-settings: '"opsz" 144, "wght" 340, "SOFT" 60';
  text-shadow: 0 0 32px rgba(255, 184, 112, 0.18);
}
.about-guide-subhead {
  margin: 0;
  max-width: 640px;
  font-family: ${FONTS.body};
  font-size: clamp(15px, 1.2vw, 18px);
  line-height: 1.62;
  color: var(--text-2);
}
.about-guide-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}
.about-guide-actions .about-howto-jump-row {
  padding-top: 0;
}
@media (max-width: 720px) {
  .about-guide-hero {
    min-height: 0;
    padding: 64px 22px 56px;
    gap: 32px;
  }
  .about-guide-masthead {
    flex-direction: column;
    gap: 18px;
  }
  .about-guide-eyebrow {
    align-self: flex-start;
    max-width: 100%;
    margin-top: 0;
    letter-spacing: 0.24em;
  }
}

/* ── Feature highlights (6-card grid) ─────────────────── */
.about-features-intro {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 64ch;
  margin-bottom: clamp(28px, 3.6vw, 48px);
}
.about-features-eyebrow {
  font-family: ${FONTS.mono};
  font-size: 11px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--accent-2);
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.about-features-eyebrow::before {
  content: "";
  display: inline-block;
  width: 28px;
  height: 1px;
  background: currentColor;
  opacity: 0.55;
}
.about-features-headline {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(28px, 3.4vw, 44px);
  line-height: 1.04;
  letter-spacing: -0.024em;
  color: var(--text);
  font-variation-settings: '"opsz" 144, "wght" 380, "SOFT" 30';
  max-width: 26ch;
}
.about-features-lede {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 15px;
  line-height: 1.62;
  color: var(--text-2);
  max-width: 60ch;
}
.about-features-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 22px;
  overflow: hidden;
}
.about-feature-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: clamp(24px, 2.6vw, 36px);
  min-width: 0;
  background: rgba(11, 12, 16, 0.94);
  transition: background 0.18s ease;
}
.about-feature-card:hover { background: rgba(15, 16, 22, 0.94); }
.about-feature-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 1px solid rgba(255, 184, 112, 0.32);
  background: rgba(255, 184, 112, 0.08);
  color: var(--accent);
  margin-bottom: 4px;
}
.about-feature-eyebrow {
  font-family: ${FONTS.mono};
  font-size: 10px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--dim);
}
.about-feature-title {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(18px, 1.7vw, 22px);
  line-height: 1.16;
  letter-spacing: -0.012em;
  color: var(--text);
  font-variation-settings: '"opsz" 32, "wght" 420, "SOFT" 30';
  max-width: 22ch;
}
.about-feature-blurb {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 13.75px;
  line-height: 1.62;
  color: var(--text-2);
  max-width: 38ch;
}
@media (max-width: 980px) {
  .about-features-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .about-features-grid { grid-template-columns: 1fr; }
}

/* ── Dashboard showcase ───────────────────────────────── */
.about-dashboard-intro {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 64ch;
  margin-bottom: clamp(24px, 3vw, 40px);
}
.about-dashboard-groups {
  display: flex;
  flex-direction: column;
  gap: clamp(22px, 3vw, 34px);
}
.about-dashboard-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.about-dashboard-group-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.about-dashboard-group-head h3 {
  margin: 0;
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--accent-2);
}
.about-dashboard-group-head p {
  margin: 0;
  max-width: 58ch;
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.55;
  text-align: right;
  color: var(--text-2);
}
.about-dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}
.about-dashboard-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: clamp(22px, 2.4vw, 30px);
  min-width: 0;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.012)),
    rgba(11, 12, 16, 0.78);
  transition: border-color 0.18s ease, transform 0.18s ease;
}
.about-dashboard-card:hover {
  border-color: rgba(255, 184, 112, 0.32);
  transform: translateY(-1px);
}
.about-dashboard-tab {
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--accent-2);
  padding: 4px 10px;
  align-self: flex-start;
  border-radius: 999px;
  border: 1px solid rgba(255, 184, 112, 0.28);
  background: rgba(255, 184, 112, 0.08);
}
.about-dashboard-title {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(17px, 1.55vw, 20px);
  line-height: 1.22;
  letter-spacing: -0.012em;
  color: var(--text);
  font-variation-settings: '"opsz" 32, "wght" 420, "SOFT" 30';
  max-width: 22ch;
}
.about-dashboard-blurb {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-2);
  flex: 1 1 auto;
}
.about-dashboard-signals {
  list-style: none;
  margin: 0;
  padding: 12px 0 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.1);
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--dim);
}
.about-dashboard-signals li {
  display: inline-flex;
  align-items: center;
}
.about-dashboard-signals li + li::before {
  content: "·";
  margin-right: 14px;
  opacity: 0.5;
}
.about-dashboard-footnote {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: clamp(20px, 2.4vw, 32px);
  padding: 18px 22px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(11, 12, 16, 0.5);
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-2);
}
@media (max-width: 980px) {
  .about-dashboard-group-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .about-dashboard-group-head p {
    text-align: left;
  }
}
@media (max-width: 640px) {
  .about-dashboard-grid { grid-template-columns: minmax(0, 1fr); }
}

/* ── OneShot in numbers ───────────────────────────────── */
.about-numbers-intro {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 64ch;
  margin-bottom: clamp(24px, 3vw, 40px);
}
.about-numbers-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 22px;
  overflow: hidden;
}
.about-numbers-cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: clamp(20px, 2.4vw, 30px) clamp(20px, 2vw, 28px);
  min-width: 0;
  background: rgba(11, 12, 16, 0.94);
}
.about-numbers-value {
  font-family: ${FONTS.display};
  font-size: clamp(36px, 4vw, 56px);
  line-height: 1;
  letter-spacing: -0.03em;
  color: var(--text);
  font-variation-settings: '"opsz" 144, "wght" 360, "SOFT" 30';
}
.about-numbers-label {
  font-family: ${FONTS.body};
  font-size: 13.25px;
  line-height: 1.4;
  color: var(--text);
  max-width: 24ch;
}
.about-numbers-meaning {
  font-family: ${FONTS.body};
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
  margin-top: auto;
}
@media (max-width: 980px) {
  .about-numbers-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 540px) {
  .about-numbers-grid { grid-template-columns: 1fr; }
}

/* ── Multi-repo flow (one ticket, many repos) ─────────── */
.about-multirepo-intro {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 64ch;
  margin-bottom: clamp(24px, 3vw, 40px);
}
.about-multirepo-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 22px;
  overflow: hidden;
}
.about-multirepo-step {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: clamp(22px, 2.4vw, 32px);
  min-width: 0;
  background: rgba(11, 12, 16, 0.94);
  transition: background 0.18s ease;
}
.about-multirepo-step:hover { background: rgba(15, 16, 22, 0.94); }
.about-multirepo-step-num {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--dim);
}
.about-multirepo-step-num::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 14px rgba(255, 184, 112, 0.6);
}
.about-multirepo-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 1px solid rgba(255, 184, 112, 0.32);
  background: rgba(255, 184, 112, 0.08);
  color: var(--accent);
}
.about-multirepo-title {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(17px, 1.6vw, 21px);
  line-height: 1.16;
  letter-spacing: -0.012em;
  color: var(--text);
  font-variation-settings: '"opsz" 32, "wght" 420, "SOFT" 30';
  max-width: 20ch;
}
.about-multirepo-body {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 13.75px;
  line-height: 1.62;
  color: var(--text-2);
}
.about-multirepo-note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: clamp(18px, 2.2vw, 28px);
  padding: 16px 18px;
  border-radius: 14px;
  border: 1px solid rgba(255, 184, 112, 0.22);
  background: rgba(255, 184, 112, 0.06);
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-2);
}
.about-multirepo-note svg {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--accent-2);
}
@media (max-width: 980px) {
  .about-multirepo-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 540px) {
  .about-multirepo-grid { grid-template-columns: 1fr; }
}

/* ── Section primitives (intro layout, eyebrow, side copy) ── */
.about-section-grid {
  display: grid;
  grid-template-columns: minmax(160px, 200px) minmax(0, 1fr);
  gap: 48px;
  min-width: 0;
  scroll-margin-top: 96px;
}
.about-section-grid > * { min-width: 0; }
.about-side-copy {
  margin-top: 16px;
  font-family: ${FONTS.body};
  font-size: 13px;
  line-height: 1.6;
  color: var(--dim);
  max-width: 190px;
}
.about-section-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent-2);
}
.about-section-eyebrow::before {
  content: "";
  width: 22px;
  height: 1px;
  background: currentColor;
  opacity: 0.5;
}

/* ── Pipeline (sticky-scroll, one stage at a time) ── */
.about-pipeline-scroll-section {
  --pipeline-sticky-top: clamp(82px, 11vh, 116px);
  align-items: start;
  min-height: 520vh;
  padding: 88px 0 4px;
}
.about-pipeline-scroll-intro {
  position: sticky;
  top: var(--pipeline-sticky-top);
  align-self: start;
}
.about-pipeline-scroll-track {
  position: relative;
  min-height: 500vh;
}
.about-pipeline-sticky {
  position: sticky;
  top: var(--pipeline-sticky-top);
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: min(720px, calc(100vh - var(--pipeline-sticky-top) - 34px));
}
.about-stage-stack {
  position: relative;
  flex: 1 1 auto;
  min-height: 560px;
}
.about-pipeline-progress {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  padding: 10px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.045);
  backdrop-filter: blur(16px) saturate(1.2);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
}
.about-pipeline-progress-step {
  appearance: none;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  height: 32px;
  border: 0;
  border-radius: 999px;
  background: rgba(255,255,255,0.035);
  color: var(--dim);
  cursor: pointer;
  font-family: ${FONTS.mono};
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  overflow: hidden;
  transition:
    background 0.18s ease,
    color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease;
}
.about-pipeline-progress-step::before {
  content: "";
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--stage-accent, #6ddcff) 58%, white);
  opacity: 0.45;
  box-shadow: 0 0 14px var(--stage-accent, #6ddcff);
}
.about-pipeline-progress-step:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--stage-accent, #6ddcff) 12%, rgba(255,255,255,0.035));
  transform: translateY(-1px);
}
.about-pipeline-progress-step:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--stage-accent, #6ddcff) 80%, white);
  outline-offset: 3px;
}
.about-pipeline-progress-step.is-active {
  color: var(--text);
  background: color-mix(in srgb, var(--stage-accent, #6ddcff) 18%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
}
.about-pipeline-progress-step.is-active::before { opacity: 1; }
.about-stage-panel {
  --stage-accent: #6ddcff;
  --stage-glow: rgba(109, 220, 255, 0.18);
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1fr);
  gap: 28px;
  align-items: center;
  min-height: 430px;
  padding: 28px;
  border-radius: 28px;
  border: 1px solid rgba(255,255,255,0.12);
  background:
    linear-gradient(135deg, rgba(255,255,255,0.075), rgba(255,255,255,0.02)),
    rgba(11, 14, 20, 0.7);
  overflow: hidden;
  isolation: isolate;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.1),
    0 34px 88px -58px rgba(0,0,0,0.88);
}
.about-stage-panel.is-stacked {
  position: relative;
  grid-template-columns: minmax(0, 1.02fr) minmax(0, 0.88fr);
  height: 100%;
  min-height: 0;
  transform-origin: 50% 58%;
  animation: about-stage-swap 0.34s cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: opacity, transform;
}
.about-stage-panel::before {
  content: "";
  position: absolute;
  inset: -28%;
  z-index: -1;
  background:
    radial-gradient(circle at 20% 20%, var(--stage-glow), transparent 28%),
    radial-gradient(circle at 78% 70%, rgba(157, 140, 255, 0.12), transparent 32%);
  filter: blur(26px);
  animation: about-color-orbit 26s ease-in-out infinite;
}
.about-stage-panel.is-stacked::before {
  filter: blur(16px);
  animation: none;
}
.about-stage-panel.is-reversed {
  grid-template-columns: minmax(0, 1fr) minmax(0, 0.95fr);
}
.about-stage-panel.is-reversed .about-stage-visual { order: 2; }
.about-stage-panel.is-stacked.is-reversed {
  grid-template-columns: minmax(0, 1.02fr) minmax(0, 0.88fr);
}
.about-stage-panel.is-stacked.is-reversed .about-stage-visual { order: initial; }
.about-stage-copy {
  position: relative;
  z-index: 1;
  max-width: 480px;
}
.about-stage-panel.is-stacked .about-stage-copy { max-width: 520px; }
.about-stage-copy h3 {
  margin: 10px 0 0;
  font-family: ${FONTS.display};
  font-size: clamp(38px, 5.5vw, 74px);
  line-height: 0.94;
  letter-spacing: -0.035em;
  color: var(--text);
  font-variation-settings: "opsz" 144, "wght" 420, "SOFT" 34;
}
.about-stage-stagenum {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 10px;
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--dim);
}
.about-stage-stagenum-eyebrow {
  color: color-mix(in srgb, var(--stage-accent) 80%, var(--text-2));
}
.about-stage-copy p {
  margin: 6px 0 0;
  font-family: ${FONTS.body};
  font-size: 15px;
  line-height: 1.66;
  color: var(--text-2);
}
.about-stage-proof {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-family: ${FONTS.body};
  font-size: 13.25px;
  line-height: 1.5;
  letter-spacing: 0.02em;
  text-transform: none;
}
.about-stage-proof::before {
  content: "";
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--stage-accent);
  box-shadow: 0 0 18px var(--stage-accent);
}
.about-stage-visual {
  position: relative;
  min-height: 350px;
  border-radius: 24px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.16);
  background:
    linear-gradient(135deg, rgba(255,255,255,0.12), rgba(255,255,255,0.035)),
    rgba(13, 16, 22, 0.36);
}
.about-stage-panel.is-stacked .about-stage-visual {
  height: 100%;
  min-height: 0;
}
.about-stage-visual img {
  width: 100%;
  height: 100%;
  min-height: 350px;
  object-fit: cover;
  display: block;
  animation: about-image-breathe 20s ease-in-out infinite;
}
.about-stage-panel.is-stacked .about-stage-visual img {
  min-height: 0;
  animation: none;
  filter: saturate(1.06) contrast(1.02) brightness(1.08);
}
.about-stage-visual::after {
  content: "";
  position: absolute;
  inset: auto 0 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--stage-accent), transparent);
  animation: about-stage-handoff 5.8s cubic-bezier(0.45, 0, 0.35, 1) infinite;
  filter: blur(0.2px);
}
@media (max-width: 980px) {
  .about-section-grid {
    grid-template-columns: 1fr;
    gap: 24px;
  }
  .about-side-copy { max-width: 560px; }
  .about-pipeline-scroll-section {
    min-height: 0;
    padding: 70px 0 12px;
  }
  .about-pipeline-scroll-intro,
  .about-pipeline-sticky {
    position: relative;
    top: auto;
  }
  .about-pipeline-scroll-track { min-height: 0; }
  .about-pipeline-sticky { min-height: 0; }
  .about-pipeline-progress { display: none; }
  .about-stage-stack {
    display: flex;
    flex-direction: column;
    gap: 22px;
    min-height: 0;
  }
  .about-stage-panel.is-stacked {
    position: relative;
    inset: auto;
    height: auto;
    min-height: 0;
    opacity: 1 !important;
    transform: none !important;
    filter: none !important;
  }
  .about-stage-panel.is-stacked,
  .about-stage-panel.is-stacked.is-reversed {
    grid-template-columns: 1fr;
  }
  .about-stage-panel.is-stacked.is-reversed .about-stage-visual { order: 2; }
  .about-stage-panel,
  .about-stage-panel.is-reversed {
    grid-template-columns: 1fr;
    min-height: 0;
  }
  .about-stage-panel.is-reversed .about-stage-visual { order: initial; }
  .about-stage-copy { order: 1; }
  .about-stage-visual,
  .about-stage-panel.is-reversed .about-stage-visual { order: 2; }
}

/* ── How-to ticket templates ─────────────────────────── */
.about-template-intro {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 68ch;
}
.about-howto-jump-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 14px 0 0;
}
.about-howto-jump-label {
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--dim);
  margin-right: 2px;
}
.about-howto-jump-link {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.045);
  color: var(--text-2);
  text-decoration: none;
  font-family: ${FONTS.body};
  font-size: 12.5px;
  transition: color 0.18s ease, background 0.18s ease, border-color 0.18s ease;
}
.about-howto-jump-link:hover,
.about-howto-jump-link:focus-visible {
  color: var(--text);
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.18);
  outline: none;
}
.about-template-list {
  display: flex;
  flex-direction: column;
  gap: clamp(32px, 4vw, 48px);
}
.about-rovo-helper {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 20px;
  align-items: center;
  padding: clamp(18px, 2.2vw, 24px);
  border-radius: 20px;
  border: 1px solid rgba(255,255,255,0.11);
  background:
    linear-gradient(135deg, rgba(109, 220, 255, 0.07), rgba(255,184,112,0.055)),
    rgba(12, 14, 17, 0.76);
  box-shadow: 0 20px 50px -38px rgba(0,0,0,0.82);
}
.about-rovo-helper-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.about-rovo-helper-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent-2);
}
.about-rovo-helper-title {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(19px, 2vw, 25px);
  line-height: 1.12;
  letter-spacing: -0.018em;
  color: var(--text);
  font-variation-settings: '"opsz" 80, "wght" 420, "SOFT" 30';
}
.about-rovo-helper-body {
  margin: 0;
  max-width: 68ch;
  font-family: ${FONTS.body};
  font-size: 13.75px;
  line-height: 1.58;
  color: var(--text-2);
}
.about-rovo-helper-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 2px;
}
.about-rovo-helper-chip {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.045);
  color: var(--text-2);
  font-family: ${FONTS.body};
  font-size: 12px;
}
.about-rovo-helper-action {
  justify-self: end;
  white-space: nowrap;
}
.about-template-group {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.about-template-group-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.about-template-group-eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--dim);
}
.about-template-group-caption {
  max-width: 560px;
  text-align: right;
  font-family: ${FONTS.body};
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-2);
}
.about-template-group-title {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(22px, 2.2vw, 30px);
  line-height: 1.08;
  letter-spacing: -0.02em;
  color: var(--text);
  font-variation-settings: '"opsz" 144, "wght" 420, "SOFT" 30';
}
.about-template-reveal {
  opacity: 0;
  transform: translate3d(0, 12px, 0);
  transition:
    opacity 0.55s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.55s cubic-bezier(0.22, 1, 0.36, 1);
}
.about-template-reveal[data-revealed="true"] {
  opacity: 1;
  transform: none;
}
.about-ticket-card {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.12);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.025)),
    rgba(14, 16, 18, 0.88);
  box-shadow: 0 22px 54px -32px rgba(0, 0, 0, 0.75);
  transition:
    background 0.3s ease,
    border-color 0.3s ease,
    transform 0.3s ease;
}
.about-ticket-card::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(115deg, transparent 0%, rgba(255, 255, 255, 0.09) 42%, transparent 66%);
  transform: translateX(-125%);
  transition: transform 0.72s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
}
.about-ticket-card:hover,
.about-ticket-card:focus-within {
  background:
    linear-gradient(180deg, rgba(109, 220, 255, 0.055), rgba(255,255,255,0.018) 70%),
    rgba(14, 16, 18, 0.9);
  border-color: rgba(109, 220, 255, 0.2);
  transform: translateY(-2px);
}
.about-ticket-card:hover::after,
.about-ticket-card:focus-within::after {
  transform: translateX(125%);
}
.about-ticket-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 10px 14px 10px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
  background: rgba(0, 0, 0, 0.24);
}
.about-ticket-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.about-ticket-key,
.about-ticket-type {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.about-template-copy {
  flex: 0 0 auto;
}
.about-template-kv {
  min-width: 0;
}
.about-placeholder {
  color: var(--accent-2);
  border-bottom: 1px dotted var(--accent-2);
  padding-bottom: 1px;
}
.about-docs-label-section {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  scroll-margin-top: 110px;
}
.about-docs-label-rules {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.about-docs-label-rule {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.045);
  color: var(--text-2);
  font-family: ${FONTS.body};
  font-size: 13px;
  line-height: 1.55;
}
.about-docs-label-rule svg {
  flex: 0 0 auto;
  margin-top: 3px;
  color: var(--accent-2);
}
.about-docs-label-table {
  --docs-table-text: #fff7ed;
  --docs-table-body: rgba(255, 247, 237, 0.84);
  --docs-table-muted: rgba(255, 247, 237, 0.68);
  display: grid;
  grid-template-columns: 1fr;
  min-width: 0;
  overflow: hidden;
  border-radius: 20px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.08);
}
.about-docs-label-row {
  display: grid;
  grid-template-columns: minmax(220px, 0.7fr) minmax(0, 1.3fr);
  gap: 1px;
  min-width: 0;
  border-top: 1px solid rgba(255,255,255,0.08);
}
.about-docs-label-row:first-child {
  border-top: 0;
}
.about-docs-label-row > div {
  min-width: 0;
  padding: 13px 16px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.02)),
    rgba(11, 12, 16, 0.78);
  color: var(--docs-table-body);
}
.about-docs-label-row.is-header > div {
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--docs-table-muted);
  background: rgba(11, 12, 16, 0.66);
}
.about-docs-label-task {
  font-family: ${FONTS.body};
  font-size: 13.75px;
  line-height: 1.45;
  color: var(--docs-table-text);
  font-weight: 600;
}
.about-docs-labels {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.about-docs-label-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 28px;
  padding: 4px 10px 4px 8px;
  border-radius: 3px;
  border: 1px solid rgba(255, 184, 112, 0.32);
  background: rgba(255, 184, 112, 0.12);
  color: var(--accent-2);
  font-family: ${FONTS.mono};
  font-size: 11px;
  letter-spacing: 0.04em;
  overflow-wrap: anywhere;
}
.about-docs-label-chip svg {
  flex: 0 0 auto;
}
.about-docs-dry-run {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
  padding: 13px 14px;
  border-radius: 14px;
  border: 1px solid rgba(255,184,112,0.22);
  background: rgba(255,184,112,0.07);
}
.about-docs-dry-run-label {
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent-2);
}
.about-docs-dry-run code {
  color: var(--text);
  font-family: ${FONTS.mono};
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.about-scan-section {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  scroll-margin-top: 110px;
}
.about-scan-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  max-width: 940px;
}
.about-scan-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  border: 1px solid rgba(109, 220, 255, 0.24);
  color: var(--accent);
  background:
    linear-gradient(135deg, rgba(109, 220, 255, 0.1), rgba(255,184,112,0.055)),
    rgba(255,255,255,0.035);
  box-shadow: 0 18px 40px -30px rgba(109, 220, 255, 0.72);
}
.about-scan-head-copy {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.about-scan-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border-radius: 20px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.08);
}
.about-scan-card {
  --scan-card-text: #fff7ed;
  --scan-card-body: rgba(255, 247, 237, 0.82);
  --scan-card-muted: rgba(255, 247, 237, 0.72);
  --scan-card-accent: #ffb870;
  min-width: 0;
  padding: clamp(20px, 2.4vw, 28px);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.022)),
    rgba(11, 12, 16, 0.78);
}
.about-scan-card-eyebrow {
  display: block;
  margin-bottom: 9px;
  font-family: ${FONTS.mono};
  font-size: 10px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--scan-card-muted);
}
.about-scan-card-title {
  margin: 0 0 14px;
  font-family: ${FONTS.body};
  font-size: 15.5px;
  line-height: 1.35;
  color: var(--scan-card-text);
  font-weight: 650;
}
.about-scan-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding-left: 18px;
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.58;
  color: var(--scan-card-body);
  overflow-wrap: anywhere;
}
.about-scan-list li::marker {
  color: var(--scan-card-accent);
  font-family: ${FONTS.mono};
}
.about-scan-notes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.about-scan-note {
  min-width: 0;
  padding: 13px 14px;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.045);
  font-family: ${FONTS.body};
  font-size: 12.75px;
  line-height: 1.55;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
.about-guide-card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  border-radius: 20px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.08);
}
.about-guide-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: clamp(20px, 2.4vw, 28px);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.022)),
    rgba(11, 12, 16, 0.78);
}
.about-guide-card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid rgba(255,184,112,0.28);
  color: var(--accent-2);
  background: rgba(255,184,112,0.08);
}
.about-guide-card-title {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 14.5px;
  line-height: 1.35;
  color: var(--text);
  font-weight: 600;
}
.about-guide-card-body {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.58;
  color: var(--text-2);
}
.about-stop-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  border-radius: 20px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.08);
}
@media (max-width: 720px) {
  .about-rovo-helper {
    grid-template-columns: 1fr;
  }
  .about-rovo-helper-action {
    justify-self: start;
  }
  .about-template-group-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .about-template-group-caption {
    text-align: left;
  }
  .about-ticket-toolbar {
    flex-direction: column;
    align-items: flex-start;
  }
  .about-template-copy {
    align-self: flex-start;
  }
  .about-template-kv {
    display: block !important;
  }
  .about-template-kv-row {
    display: grid !important;
    grid-template-columns: 1fr;
    gap: 6px;
    margin-bottom: 10px;
  }
  .about-stop-grid {
    grid-template-columns: 1fr;
  }
  .about-docs-label-rules {
    grid-template-columns: 1fr;
  }
  .about-docs-label-row,
  .about-docs-label-row.is-header {
    grid-template-columns: 1fr;
  }
  .about-docs-label-row.is-header {
    display: none;
  }
  .about-scan-head {
    grid-template-columns: 1fr;
  }
  .about-scan-grid,
  .about-scan-notes {
    grid-template-columns: 1fr;
  }
  .about-guide-card-grid {
    grid-template-columns: 1fr;
  }
}
@media (min-width: 721px) and (max-width: 1040px) {
  .about-guide-card-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* ── Spec sheet (dark operator reference) ─────────── */
.spec-sheet {
  display: flex;
  flex-direction: column;
  gap: clamp(20px, 2.4vw, 32px);
}
.spec-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 0;
  font-family: ${FONTS.body};
  font-size: 13px;
  color: var(--text-2);
}
.spec-legend-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.09);
  background: rgba(255,255,255,0.04);
  white-space: nowrap;
}
.spec-legend-pill strong {
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1;
  color: var(--text);
  font-weight: 650;
}
.spec-legend-pill.is-total {
  color: var(--text);
  background: rgba(255,255,255,0.065);
}
.spec-legend-pill .spec-row-status-label {
  display: none;
}
.spec-legend-pill .spec-row-status .spec-icon {
  width: 18px;
  height: 18px;
  border-width: 1.3px;
}
.spec-legend-pill .spec-row-status svg {
  width: 11px;
  height: 11px;
}
.spec-legend-pill .spec-row-status[data-status="partial"] .spec-icon::after {
  width: 7px;
  height: 7px;
}
.spec-card {
  --spec-bg: rgba(14, 16, 18, 0.9);
  --spec-text: var(--text);
  --spec-text-2: var(--text-2);
  --spec-text-3: var(--dim);
  --spec-stroke: rgba(255,255,255,0.12);
  --spec-stroke-soft: rgba(255,255,255,0.075);
  --spec-row-hover: rgba(109, 220, 255, 0.065);
  --spec-yes: #81d892;
  --spec-no: #ff8d7f;
  --spec-partial: #ffbd72;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.018) 70%),
    var(--spec-bg);
  color: var(--spec-text);
  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.12);
  box-shadow:
    0 22px 54px -32px rgba(0, 0, 0, 0.75),
    0 0 0 1px rgba(255,255,255,0.035) inset;
  overflow: hidden;
}
.spec-section + .spec-section {
  border-top: 1px solid var(--spec-stroke);
}
.spec-section {
  scroll-margin-top: 96px;
}
.spec-section-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: end;
  padding: clamp(22px, 2.4vw, 30px) clamp(22px, 2.6vw, 36px) clamp(12px, 1.4vw, 18px);
  background: linear-gradient(180deg, rgba(255,255,255,0.035), transparent 62%);
}
.spec-section-title {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(22px, 2.4vw, 30px);
  line-height: 1.06;
  letter-spacing: -0.022em;
  color: var(--spec-text);
  font-variation-settings: '"opsz" 144, "wght" 420, "SOFT" 30';
}
.spec-section-caption {
  margin: 6px 0 0;
  font-family: ${FONTS.body};
  font-size: 14px;
  line-height: 1.55;
  color: var(--spec-text-2);
  max-width: 64ch;
}
.spec-section-count {
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--spec-text-3);
  white-space: nowrap;
  align-self: end;
}
.spec-table {
  display: grid;
  grid-template-columns: minmax(280px, 0.42fr) 100px minmax(0, 1fr);
  align-items: stretch;
}
.spec-table-head { display: contents; }
.spec-table-head > div {
  padding: 10px clamp(16px, 2vw, 24px);
  background: linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.018));
  border-top: 1px solid var(--spec-stroke);
  border-bottom: 1px solid var(--spec-stroke);
  font-family: ${FONTS.mono};
  font-size: 10px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--spec-text-3);
}
.spec-row { display: contents; }
.spec-row > div {
  padding: 14px clamp(16px, 2vw, 24px);
  border-bottom: 1px solid var(--spec-stroke-soft);
  font-family: ${FONTS.body};
  font-size: 14px;
  line-height: 1.55;
  background: transparent;
  transition: background 0.12s ease;
}
.spec-row:hover > div { background: var(--spec-row-hover); }
.spec-row:last-child > div { border-bottom: none; }
.spec-row > div:first-child {
  font-family: ${FONTS.body};
  font-size: 14.25px;
  font-weight: 500;
  color: var(--spec-text);
}
.spec-row-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.spec-row-status .spec-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 999px;
  border: 1.5px solid currentColor;
}
.spec-row-status[data-status="yes"] { color: var(--spec-yes); }
.spec-row-status[data-status="no"] { color: var(--spec-no); }
.spec-row-status[data-status="partial"] { color: var(--spec-partial); }
.spec-row-status[data-status="partial"] .spec-icon::after {
  content: "";
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: currentColor;
}
.spec-row-status[data-status="partial"] .spec-icon { background: transparent; }
.spec-row-status[data-status="partial"] svg { display: none; }
.spec-row-status-label {
  font-family: ${FONTS.mono};
  font-size: 9.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.spec-row > div:last-child { color: var(--spec-text-2); }
.spec-row .spec-row-cap { display: flex; flex-direction: column; gap: 4px; }
.spec-profiled-repos {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: clamp(20px, 2.5vw, 30px) clamp(20px, 2.8vw, 36px) clamp(24px, 3vw, 36px);
  border-top: 1px solid var(--spec-stroke);
  background:
    linear-gradient(180deg, rgba(109, 220, 255, 0.045), rgba(255,255,255,0.012)),
    rgba(0, 0, 0, 0.12);
}
.spec-profiled-repos-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 20px;
  align-items: end;
}
.spec-profiled-repos-title {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 15px;
  line-height: 1.35;
  color: var(--spec-text);
  font-weight: 600;
}
.spec-profiled-repos-copy {
  margin: 6px 0 0;
  max-width: 78ch;
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.58;
  color: var(--spec-text-2);
}
.spec-profiled-repos-copy code {
  font-family: ${FONTS.mono};
  font-size: 0.92em;
  color: var(--accent-2);
}
.spec-profiled-repos-count {
  font-family: ${FONTS.mono};
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--spec-text-3);
  white-space: nowrap;
}
.spec-profiled-repos-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1px;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.09);
  background: rgba(255,255,255,0.08);
}
.spec-profiled-repo {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 14px 16px;
  background: rgba(11, 12, 16, 0.72);
}
.spec-profiled-repo-name,
.spec-profiled-repo-slug {
  min-width: 0;
  overflow-wrap: anywhere;
}
.spec-profiled-repo-name {
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.35;
  color: var(--spec-text);
  font-weight: 600;
}
.spec-profiled-repo-slug {
  font-family: ${FONTS.mono};
  font-size: 11px;
  line-height: 1.5;
  letter-spacing: 0.02em;
  color: var(--spec-text-3);
}

@media (max-width: 720px) {
  .spec-legend {
    align-items: stretch;
  }
  .spec-legend-pill {
    flex: 1 1 auto;
    justify-content: center;
  }
  .spec-table { grid-template-columns: 1fr; }
  .spec-table-head { display: none; }
  .spec-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 16px;
    padding: 14px clamp(16px, 2vw, 24px);
    border-bottom: 1px solid var(--spec-stroke-soft);
  }
  .spec-row:hover { background: var(--spec-row-hover); }
  .spec-row:hover > div { background: transparent; }
  .spec-row > div { padding: 0; border-bottom: none; }
  .spec-row > div:first-child { grid-column: 1 / 2; }
  .spec-row > div:nth-child(2) { grid-column: 2 / 3; grid-row: 1 / 2; justify-self: end; }
  .spec-row > div:last-child { grid-column: 1 / -1; }
  .spec-profiled-repos-head {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .spec-profiled-repos-count { white-space: normal; }
  .spec-profiled-repos-grid { grid-template-columns: 1fr; }
}

/* ── Guide closer card ─────────────────────────────── */
.about-closer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: clamp(28px, 4vw, 64px);
  padding: clamp(48px, 6vw, 88px) clamp(28px, 4vw, 56px);
  margin-top: clamp(40px, 6vw, 80px);
  border-radius: 28px;
  border: 1px solid rgba(255,255,255,0.1);
  background:
    radial-gradient(120% 120% at 0% 0%, rgba(255,184,112,0.07), transparent 50%),
    radial-gradient(120% 120% at 100% 100%, rgba(72,126,255,0.08), transparent 52%),
    rgba(11, 12, 16, 0.74);
  position: relative;
  overflow: hidden;
}
.about-closer h3 {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(28px, 3.4vw, 44px);
  line-height: 1.06;
  letter-spacing: -0.022em;
  color: var(--text);
  font-variation-settings: '"opsz" 144, "wght" 380, "SOFT" 40';
  max-width: 22ch;
}
.about-closer p {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--text-2);
  max-width: 44ch;
}
.about-closer-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
@media (max-width: 880px) { .about-closer { grid-template-columns: 1fr; } }

/* ── Next-steps trio (Features closer) ─────────────────── */
.about-trio {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: clamp(40px, 6vw, 80px);
  border-radius: 28px;
  border: 1px solid rgba(255,255,255,0.1);
  background:
    radial-gradient(120% 120% at 0% 0%, rgba(255,184,112,0.07), transparent 50%),
    radial-gradient(120% 120% at 100% 100%, rgba(72,126,255,0.08), transparent 52%),
    rgba(11, 12, 16, 0.74);
  overflow: hidden;
}
.about-trio-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: clamp(28px, 3vw, 40px) clamp(24px, 2.6vw, 36px);
  min-width: 0;
}
.about-trio-card + .about-trio-card {
  border-left: 1px solid rgba(255,255,255,0.08);
}
.about-trio-eyebrow {
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--accent-2);
}
.about-trio-title {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(22px, 2.1vw, 28px);
  line-height: 1.12;
  letter-spacing: -0.014em;
  color: var(--text);
  font-variation-settings: '"opsz" 144, "wght" 400, "SOFT" 30';
  max-width: 18ch;
}
.about-trio-body {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-2);
  flex: 1 1 auto;
}
.about-trio-card .about-link-pill {
  align-self: flex-start;
  margin-top: 6px;
}
@media (max-width: 880px) {
  .about-trio { grid-template-columns: 1fr; }
  .about-trio-card + .about-trio-card {
    border-left: 0;
    border-top: 1px solid rgba(255,255,255,0.08);
  }
}

/* ── Tech Spec — sticky TOC + spec rows ──────────────── */
.about-techspec-page { display: flex; flex-direction: column; gap: clamp(36px, 5vw, 72px); }
.about-techspec-body {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: clamp(28px, 4vw, 64px);
  align-items: start;
}
.about-techspec-toc {
  position: sticky;
  top: 96px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-left: 1px solid rgba(255,255,255,0.08);
  padding-left: 18px;
}
.about-techspec-toc-eyebrow {
  font-family: ${FONTS.mono};
  font-size: 10px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--dim);
  margin-bottom: 6px;
}
.about-techspec-toc a {
  display: block;
  padding: 8px 4px;
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.4;
  color: var(--text-2);
  text-decoration: none;
  border-left: 2px solid transparent;
  margin-left: -20px;
  padding-left: 18px;
  transition: color 0.18s ease, border-color 0.18s ease, background 0.18s ease;
}
.about-techspec-toc a:hover { color: var(--text); }
.about-techspec-toc a.is-active {
  color: var(--text);
  border-left-color: var(--accent, #ffb870);
}
.about-techspec-toc-mobile { display: none; }
@media (max-width: 880px) {
  .about-techspec-body { grid-template-columns: 1fr; gap: 24px; }
  .about-techspec-toc { display: none; }
  .about-techspec-toc-mobile {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 10px 0;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .about-techspec-toc-mobile select {
    flex: 1 1 auto;
    background: rgba(11, 12, 16, 0.72);
    border: 1px solid rgba(255,255,255,0.12);
    color: var(--text);
    font-family: ${FONTS.body};
    font-size: 14px;
    padding: 8px 12px;
    border-radius: 10px;
  }
}
.about-techspec-groups { display: flex; flex-direction: column; gap: clamp(36px, 5vw, 64px); }
.about-techspec-group {
  display: flex;
  flex-direction: column;
  gap: 18px;
  scroll-margin-top: 110px;
}
.about-techspec-group-head {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.about-techspec-group-eyebrow {
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--dim);
}
.about-techspec-group-title {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: clamp(28px, 3.2vw, 42px);
  line-height: 1.04;
  letter-spacing: -0.026em;
  color: var(--text);
  font-variation-settings: '"opsz" 144, "wght" 380, "SOFT" 30';
}
.about-techspec-group-caption {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--text-2);
  max-width: 70ch;
}
.about-techspec-rows { display: flex; flex-direction: column; }
.about-techspec-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(160px, 0.28fr) minmax(0, 1fr);
  gap: clamp(16px, 2vw, 32px);
  padding: 16px 0;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.about-techspec-row:last-child { border-bottom: none; }
.about-techspec-row-label {
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--dim);
  padding-top: 3px;
}
.about-techspec-row-value {
  font-family: ${FONTS.body};
  font-size: 14.75px;
  line-height: 1.62;
  color: var(--text);
}
.about-techspec-row-anchor {
  position: absolute;
  right: 0;
  top: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(11,12,16,0.62);
  border-radius: 999px;
  color: var(--dim);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}
.about-techspec-row:hover .about-techspec-row-anchor,
.about-techspec-row:focus-within .about-techspec-row-anchor { opacity: 1; }
.about-techspec-row-anchor:hover {
  color: var(--text);
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.22);
}
.about-techspec-row-anchor.is-copied {
  opacity: 1;
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 38%, transparent);
}
.about-techspec-end {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 20px;
  padding: 24px;
  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(11, 12, 16, 0.62);
}
.about-techspec-end h4 {
  margin: 0;
  font-family: ${FONTS.display};
  font-size: 18px;
  letter-spacing: -0.012em;
  color: var(--text);
  font-variation-settings: '"opsz" 32, "wght" 380';
}
.about-techspec-end p {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-2);
  max-width: 60ch;
}
.about-techspec-end-actions { display: flex; flex-wrap: wrap; gap: 8px; }

/* ── Changelog timeline ───────────────────────────────── */
.about-changelog-page { display: flex; flex-direction: column; gap: clamp(28px, 4vw, 56px); }
.about-timeline {
  --timeline-date-col: clamp(86px, 12vw, 132px);
  --timeline-gutter: clamp(22px, 3vw, 34px);
  --timeline-rail-x: calc(var(--timeline-date-col) + (var(--timeline-gutter) / 2));
  display: flex;
  flex-direction: column;
  gap: clamp(30px, 4vw, 46px);
  max-width: 940px;
}
.about-timeline-group {
  position: relative;
  display: grid;
  grid-template-columns: var(--timeline-date-col) minmax(0, 1fr);
  column-gap: var(--timeline-gutter);
}
.about-timeline-month {
  position: relative;
  grid-column: 2;
  margin: 0 0 16px;
  display: flex;
  align-items: center;
  min-height: 28px;
}
.about-timeline-month::before {
  content: "";
  position: absolute;
  left: calc(var(--timeline-gutter) / -2);
  width: calc((var(--timeline-gutter) / 2) - 7px);
  height: 1px;
  background: rgba(255,184,112,0.75);
  top: 50%;
}
.about-timeline-month strong {
  font-family: ${FONTS.display};
  font-size: clamp(20px, 2vw, 26px);
  letter-spacing: -0.012em;
  color: var(--text);
  font-variation-settings: '"opsz" 32, "wght" 380';
}
.about-timeline-entries {
  position: relative;
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.about-timeline-entries::before {
  content: "";
  position: absolute;
  top: -16px;
  bottom: 12px;
  left: var(--timeline-rail-x);
  width: 1px;
  background: linear-gradient(180deg, rgba(255,184,112,0.58), rgba(255,184,112,0.08) 78%);
}
.about-timeline-entry {
  position: relative;
  display: grid;
  grid-template-columns: var(--timeline-date-col) minmax(0, 1fr);
  column-gap: var(--timeline-gutter);
  align-items: start;
}
.about-timeline-entry::before {
  content: "";
  position: absolute;
  left: calc(var(--timeline-rail-x) - 5px);
  top: 24px;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: rgba(11,12,16,1);
  border: 2px solid var(--accent, #ffb870);
  box-shadow: 0 0 14px rgba(255,184,112,0.55);
  z-index: 1;
}
.about-timeline-date {
  padding-top: 18px;
  text-align: right;
  font-family: ${FONTS.mono};
  font-size: 10.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--dim);
}
.about-timeline-entry-body {
  min-width: 0;
  padding: 16px 18px 18px;
  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.09);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.022)),
    rgba(13, 15, 18, 0.78);
  box-shadow: 0 20px 46px -34px rgba(0, 0, 0, 0.86);
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    transform 0.18s ease;
}
.about-timeline-entry:hover .about-timeline-entry-body {
  border-color: rgba(255,184,112,0.2);
  background:
    linear-gradient(180deg, rgba(255,184,112,0.07), rgba(255,255,255,0.025)),
    rgba(13, 15, 18, 0.86);
  transform: translateY(-1px);
}
.about-timeline-title {
  margin: 0 0 8px;
  font-family: ${FONTS.display};
  font-size: clamp(19px, 1.8vw, 24px);
  line-height: 1.16;
  letter-spacing: -0.012em;
  color: var(--text);
  font-variation-settings: '"opsz" 32, "wght" 420, "SOFT" 30';
  max-width: 40ch;
}
.about-timeline-summary {
  margin: 0;
  font-family: ${FONTS.body};
  font-size: 14.25px;
  line-height: 1.62;
  color: var(--text-2);
  max-width: 64ch;
}

@media (max-width: 720px) {
  .about-view {
    --about-frame-pad: 14px;
    --about-header-gap: 14px;
    border-radius: 0;
  }
  .about-stack { padding-bottom: 20px; }
  .about-product-nav-links { flex-wrap: nowrap; -webkit-overflow-scrolling: touch; scroll-snap-type: x proximity; }
  .about-product-nav-links a { scroll-snap-align: start; white-space: nowrap; }
  .about-cinema-stage { min-height: 0; }
  .about-cinema-stage-visual { min-height: 240px; }
  .about-techspec-rows { gap: 6px; }
  .about-techspec-row { grid-template-columns: 1fr; gap: 4px; padding: 14px 0; }
  .about-techspec-row-anchor { display: none; }
  .about-timeline {
    --timeline-date-col: 0px;
    --timeline-gutter: 28px;
    --timeline-rail-x: 8px;
    gap: 28px;
  }
  .about-timeline-group {
    display: block;
    padding-left: 28px;
  }
  .about-timeline-month {
    margin-bottom: 14px;
  }
  .about-timeline-month::before {
    left: -28px;
    width: 18px;
  }
  .about-timeline-entries { gap: 12px; }
  .about-timeline-entries::before {
    left: -20px;
    top: -14px;
    bottom: 12px;
  }
  .about-timeline-entry {
    display: block;
  }
  .about-timeline-entry::before {
    left: -25px;
    top: 22px;
  }
  .about-timeline-date {
    display: block;
    padding: 0 0 8px;
    text-align: left;
  }
  .about-timeline-entry-body {
    padding: 14px 15px 16px;
    border-radius: 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .about-view *,
  .about-view *::before,
  .about-view *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
  .about-scroll-reveal {
    opacity: 1 !important;
    transform: none !important;
    filter: none !important;
  }
  .about-template-reveal {
    opacity: 1 !important;
    transform: none !important;
  }
  .about-pipeline-scroll-section { min-height: 0 !important; }
  .about-pipeline-scroll-intro,
  .about-pipeline-sticky {
    position: relative !important;
    top: auto !important;
  }
  .about-pipeline-scroll-track,
  .about-pipeline-sticky,
  .about-stage-stack { min-height: 0 !important; }
  .about-pipeline-progress { display: none !important; }
  .about-stage-stack {
    display: flex !important;
    flex-direction: column !important;
    gap: 22px !important;
  }
  .about-stage-panel.is-stacked {
    position: relative !important;
    inset: auto !important;
    height: auto !important;
    opacity: 1 !important;
    transform: none !important;
    filter: none !important;
  }
}
`;

function rise(delayMs: number): CSSProperties {
  return {
    animation: `about-rise 0.7s cubic-bezier(0.22, 1, 0.36, 1) both`,
    animationDelay: `${delayMs}ms`,
  };
}

function revealDelay(delayMs: number): CSSProperties {
  return { "--about-reveal-delay": `${delayMs}ms` } as CSSProperties;
}

function useReveal<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  revealed: boolean;
} {
  const ref = useRef<T>(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || revealed) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRevealed(true);
            obs.disconnect();
            break;
          }
        }
      },
      { threshold: 0.04, rootMargin: "0px 0px -20px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [revealed]);
  return { ref, revealed };
}

function RevealSection({
  children,
  className = "",
  delay = 0,
  id,
  style,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  id?: string;
  style?: CSSProperties;
}) {
  const { ref, revealed } = useReveal<HTMLElement>();
  return (
    <section
      id={id}
      ref={ref}
      className={`about-section-stack about-scroll-reveal${className ? ` ${className}` : ""}`}
      data-revealed={revealed ? "true" : undefined}
      style={{ ...revealDelay(delay), ...style }}
    >
      {children}
    </section>
  );
}

function ProductLocalNav({
  onExit,
  onPanelChange,
  panel,
}: {
  onExit?: () => void;
  onPanelChange?: (panel: AboutPanel) => void;
  panel: AboutPanel;
}) {
  const handleBack = useCallback(() => {
    if (onExit) {
      onExit();
      return;
    }
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
    }
  }, [onExit]);

  const handlePanelClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, nextPanel: AboutPanel) => {
      event.preventDefault();
      onPanelChange?.(nextPanel);
    },
    [onPanelChange],
  );

  return (
    <nav className="about-product-nav" aria-label="OneShot About sections">
      <div className="about-product-nav-inner">
        <button
          type="button"
          className="about-product-back"
          onClick={handleBack}
          aria-label="Back to dashboard"
        >
          <ArrowLeft
            size={ICON_SIZE.xs}
            strokeWidth={ICON_STROKE}
            aria-hidden="true"
          />
          Back
        </button>
        <div className="about-product-nav-links">
          {PRODUCT_NAV.map((item) => (
            <a
              key={item.panel}
              href={aboutPanelHref(item.panel)}
              className={panel === item.panel ? "is-active" : undefined}
              aria-current={panel === item.panel ? "page" : undefined}
              onClick={(event) => handlePanelClick(event, item.panel)}
            >
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}

// ───────────────────────────────────────────────────────────────
// GUIDE TAB — shared hero → triptych → cinema stages → spec sheet
// ───────────────────────────────────────────────────────────────

function GuidePanelHero({
  actions,
  copy,
  eyebrow,
  title,
  titleId,
  wordmarkRef,
}: {
  actions?: ReactNode;
  copy: ReactNode;
  eyebrow: string;
  title: ReactNode;
  titleId: string;
  wordmarkRef?: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section className="about-guide-hero" aria-labelledby={titleId}>
      <div aria-hidden="true" className="about-hero-aurora" />
      <div aria-hidden="true" className="about-hero-grain" />

      <div className="about-guide-masthead">
        <h1
          ref={wordmarkRef}
          className="oneshot-wordmark about-wordmark-slot"
          aria-label="OneShot"
          style={{ fontSize: "var(--hero-wordmark-size)" }}
        >
          <span className="wm-one">One</span>
          <span className="wm-shot">Shot</span>
          <span className="wm-period" aria-hidden="true">
            .
          </span>
        </h1>
        <span className="about-guide-eyebrow">{eyebrow}</span>
      </div>

      <div className="about-guide-body">
        <h2 id={titleId} className="about-guide-title" style={rise(80)}>
          {title}
        </h2>
        <p className="about-guide-subhead" style={rise(180)}>
          {copy}
        </p>
        {actions ? (
          <div className="about-guide-actions" style={rise(260)}>
            {actions}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function FeaturesHero({
  wordmarkRef,
  onOpenHowTo,
  onOpenTechSpec,
}: {
  wordmarkRef?: RefObject<HTMLHeadingElement | null>;
  onOpenHowTo?: () => void;
  onOpenTechSpec?: () => void;
}) {
  const handleHowTo = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!onOpenHowTo) return;
      event.preventDefault();
      onOpenHowTo();
    },
    [onOpenHowTo],
  );

  const handleTechSpec = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!onOpenTechSpec) return;
      event.preventDefault();
      onOpenTechSpec();
    },
    [onOpenTechSpec],
  );

  return (
    <GuidePanelHero
      wordmarkRef={wordmarkRef}
      eyebrow="OneShot · Autonomous feature delivery"
      title={<>Ship the work your ticket already defines.</>}
      titleId="about-features-title"
      copy={
        <>
          OneShot turns a ready Jira ticket into a reviewed pull request, with
          qualification, planning, build, review, and test work split into clear
          stages.
        </>
      }
      actions={
        <>
          <a
            className="about-link-pill is-primary"
            href={aboutPanelHref("how-to")}
            onClick={handleHowTo}
          >
            See the How-to
            <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
          </a>
          <a
            className="about-link-pill"
            href={aboutPanelHref("tech-spec")}
            onClick={handleTechSpec}
          >
            Read the Tech Spec
            <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
          </a>
        </>
      }
    />
  );
}

function FeatureHighlights() {
  return (
    <RevealSection
      id="about-features-grid"
      delay={80}
      style={{ padding: "clamp(40px, 6vw, 80px) 0 0" }}
    >
      <div className="about-features-intro">
        <span className="about-features-eyebrow">
          What ships in the box · OneShot {ONESHOT_DISPLAY_VERSION}
        </span>
        <h2 className="about-features-headline">
          Built for useful autonomy, not blind automation.
        </h2>
        <p className="about-features-lede">
          OneShot is opinionated about what gets in, where code is written, how
          review happens, and what operators can explain afterward.
        </p>
      </div>
      <div className="about-features-grid" role="list">
        {FEATURE_HIGHLIGHTS.map((feature, idx) => {
          const Icon = feature.icon;
          return (
            <article
              key={feature.title}
              role="listitem"
              className="about-feature-card glass-place-block"
              style={{ ...glassPlaceStyle(320 + idx * 90) }}
            >
              <div className="about-feature-icon" aria-hidden="true">
                <Icon size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
              </div>
              <span className="about-feature-eyebrow">{feature.eyebrow}</span>
              <h3 className="about-feature-title">{feature.title}</h3>
              <p className="about-feature-blurb">{feature.blurb}</p>
            </article>
          );
        })}
      </div>
    </RevealSection>
  );
}

// ── Dashboard showcase — the operator's surface ───────────────
type DashboardSurface = {
  tab: string;
  title: string;
  blurb: string;
  signals: ReadonlyArray<string>;
};

type DashboardSurfaceGroup = {
  label: string;
  description: string;
  surfaces: ReadonlyArray<DashboardSurface>;
};

const DASHBOARD_SURFACE_GROUPS: ReadonlyArray<DashboardSurfaceGroup> = [
  {
    label: "Workspace",
    description:
      "The daily operating view for watching runs move from ticket to PR.",
    surfaces: [
      {
        tab: "Overview",
        title: "Live health without the hunt",
        blurb:
          "Twenty-four-hour run count, pass rate, average and median time-to-PR, and throughput buckets load into a quick read.",
        signals: ["24h runs", "Pass rate", "Avg / median time-to-PR"],
      },
      {
        tab: "Runs",
        title: "Running · Queued · Waiting · History",
        blurb:
          "Tabbed run inventory with stage, branch, elapsed time, and estimated cost on every row. Open any run for the full detail modal.",
        signals: [
          "Per-state counters",
          "Cost on every row",
          "Click-through detail",
        ],
      },
      {
        tab: "Agents",
        title: "Per-agent health and recent runs",
        blurb:
          "Card grid for the Qualifier, Planner, Reviewer, Implementer, Code Reviewer, and Tester. Each card shows health, recent runs, and latency at a glance.",
        signals: ["6 stage agents", "Health badge", "Recent runs"],
      },
      {
        tab: "Queue",
        title: "Backlog depth and lane capacity",
        blurb:
          "One card per stage shows depth, in-flight work, and stuck items. Backed-up lanes stand out before they become a mystery.",
        signals: ["Live depth", "Stuck items", "Capacity"],
      },
    ],
  },
  {
    label: "Analytics",
    description:
      "Trend, spend, quality, and AI summary tabs for explaining what changed.",
    surfaces: [
      {
        tab: "Throughput",
        title: "Run velocity and stage bottlenecks",
        blurb:
          "Run trends, p50 / p90 time-to-PR, horizon buckets, and a stage-completion waterfall reveal where delivery is speeding up or slowing down.",
        signals: ["Run trend", "P50 / P90", "Stage waterfall"],
      },
      {
        tab: "Costs",
        title: "Spend, tokens, and model mix",
        blurb:
          "Total spend, token volume, pricing source, by-stage and by-model ladders, and top-cost run drilldowns make model usage auditable.",
        signals: ["USD + tokens", "Stage / model mix", "Top-cost runs"],
      },
      {
        tab: "Statistics",
        title: "AI summary with quality context",
        blurb:
          "A generated summary sits beside business metrics, ticket readiness, failure attribution, what is working, what needs attention, and recommended actions.",
        signals: ["AI summary", "Ticket readiness", "Actions"],
      },
    ],
  },
];

function DashboardShowcase({
  onOpenTechSpec,
}: {
  onOpenTechSpec?: () => void;
}) {
  const handleTechSpec = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!onOpenTechSpec) return;
      event.preventDefault();
      onOpenTechSpec();
    },
    [onOpenTechSpec],
  );
  return (
    <RevealSection
      id="about-dashboard"
      delay={120}
      style={{ padding: "clamp(60px, 8vw, 120px) 0 0" }}
    >
      <div className="about-dashboard-intro">
        <span className="about-features-eyebrow">Operator dashboard</span>
        <h2 className="about-features-headline">
          One place to watch the work and explain the result.
        </h2>
        <p className="about-features-lede">
          Runs, artifacts, cost, queues, agent health, and delivery outcomes sit
          together. Operators can move from a live run to the business answer
          without changing tools.
        </p>
      </div>
      <div className="about-dashboard-groups">
        {DASHBOARD_SURFACE_GROUPS.map((group) => (
          <section
            key={group.label}
            className="about-dashboard-group"
            aria-labelledby={`about-dashboard-${group.label.toLowerCase()}`}
          >
            <div className="about-dashboard-group-head">
              <h3 id={`about-dashboard-${group.label.toLowerCase()}`}>
                {group.label}
              </h3>
              <p>{group.description}</p>
            </div>
            <div className="about-dashboard-grid" role="list">
              {group.surfaces.map((surface) => (
                <article
                  key={surface.tab}
                  role="listitem"
                  className="about-dashboard-card"
                >
                  <span className="about-dashboard-tab">{surface.tab}</span>
                  <h4 className="about-dashboard-title">{surface.title}</h4>
                  <p className="about-dashboard-blurb">{surface.blurb}</p>
                  <ul className="about-dashboard-signals">
                    {surface.signals.map((signal) => (
                      <li key={signal}>{signal}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="about-dashboard-footnote">
        <span>
          The Detail Modal keeps plan, review, and test artifacts inline, and
          the command palette can start a new run from any Jira key.
        </span>
        <a
          className="about-link-pill"
          href={aboutPanelHref("tech-spec")}
          onClick={handleTechSpec}
        >
          Read the Tech Spec
          <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
        </a>
      </div>
    </RevealSection>
  );
}

// ── OneShot in numbers — real counts from source ──────────────
type StatFact = {
  value: string;
  label: string;
  meaning: string;
};

const ONESHOT_NUMBERS: ReadonlyArray<StatFact> = [
  {
    value: String(ONE_SHOT_STATES.length),
    label: "Lifecycle states",
    meaning: "Every transition is recorded from intake to pull request.",
  },
  {
    value: String(AGENT_STAGES.length),
    label: "Pipeline stages",
    meaning: "One agent per job, in order.",
  },
  {
    value: "5",
    label: "Queued handoffs",
    meaning: "After intake, queues keep downstream work separated.",
  },
  {
    value: "6",
    label: "Clarity inputs",
    meaning:
      "The Qualifier checks acceptance criteria, scope, testing notes, and boundaries.",
  },
  {
    value: "14",
    label: "Safety guards",
    meaning: "Destructive commands stop before they reach the repo.",
  },
  {
    value: "50 M",
    label: "Token ceiling",
    meaning: "Every run starts with a hard spend cap.",
  },
  {
    value: String(ONE_SHOT_NOTIFICATION_TYPES.length),
    label: "Status updates",
    meaning: "Authors get Jira updates at each milestone.",
  },
  {
    value: String(PROFILED_REPOS.length),
    label: "Repos onboarded",
    meaning: "These repos already have OneShot profiles.",
  },
];

function OneShotInNumbers() {
  return (
    <RevealSection
      id="about-numbers"
      delay={80}
      style={{ padding: "clamp(60px, 8vw, 120px) 0 0" }}
    >
      <div className="about-numbers-intro">
        <span className="about-features-eyebrow">By the numbers</span>
        <h2 className="about-features-headline">What is live today.</h2>
        <p className="about-features-lede">
          Every figure on this page comes straight from the running pipeline.
          The counts go up as the platform grows.
        </p>
      </div>
      <div className="about-numbers-grid" role="list">
        {ONESHOT_NUMBERS.map((stat) => (
          <article
            key={stat.label}
            role="listitem"
            className="about-numbers-cell"
          >
            <span className="about-numbers-value">{stat.value}</span>
            <span className="about-numbers-label">{stat.label}</span>
            <span className="about-numbers-meaning">{stat.meaning}</span>
          </article>
        ))}
      </div>
    </RevealSection>
  );
}

// ── Multi-repo flow — what happens when one ticket spans repos ──
type MultiRepoStep = {
  eyebrow: string;
  title: string;
  body: string;
  icon: LucideIcon;
};

const MULTI_REPO_FLOW: ReadonlyArray<MultiRepoStep> = [
  {
    eyebrow: "Step 01 · Detect",
    title: "The Qualifier splits the ticket",
    body: "When one ticket's requirements map to distinct, independently buildable slices across profiled repos, the Qualifier routes it as multi-repo and writes one objective and acceptance set per repo.",
    icon: Telescope,
  },
  {
    eyebrow: "Step 02 · Group",
    title: "One run group, one child run per repo",
    body: "OneShot opens a run group and a separate child run for each repo, each on its own branch and isolated workspace. The group keeps the slices linked under the same Jira key.",
    icon: GitBranch,
  },
  {
    eyebrow: "Step 03 · Build",
    title: "Each repo runs the full pipeline",
    body: "Every child is scoped to plan and build only its assigned repo, then moves through the same plan, review, build, code review, and test stages on its own.",
    icon: Sparkles,
  },
  {
    eyebrow: "Step 04 · Deliver",
    title: "A pull request per repo, in merge order",
    body: "Each repo gets its own PR. The body carries a multi-repo context block with its place in the merge order and the sibling repos, so you ship in the right sequence.",
    icon: FileText,
  },
];

function MultiRepoFlow() {
  return (
    <RevealSection
      id="about-multi-repo"
      delay={100}
      style={{ padding: "clamp(60px, 8vw, 120px) 0 0" }}
    >
      <div className="about-multirepo-intro">
        <span className="about-features-eyebrow">Multi-repo delivery</span>
        <h2 className="about-features-headline">
          When work spans repos, so does OneShot.
        </h2>
        <p className="about-features-lede">
          Some work lives in more than one repo. When the slices are
          independent, OneShot fans the ticket out into linked single-repo runs
          and delivers a pull request for each, no extra tickets required.
        </p>
      </div>
      <div className="about-multirepo-grid" role="list">
        {MULTI_REPO_FLOW.map((step) => {
          const Icon = step.icon;
          return (
            <article
              key={step.title}
              role="listitem"
              className="about-multirepo-step"
            >
              <div className="about-multirepo-icon" aria-hidden="true">
                <Icon size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
              </div>
              <span className="about-multirepo-step-num">{step.eyebrow}</span>
              <h3 className="about-multirepo-title">{step.title}</h3>
              <p className="about-multirepo-body">{step.body}</p>
            </article>
          );
        })}
      </div>
      <p className="about-multirepo-note">
        <ShieldCheck size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        <span>
          The split only happens when each repo can build on its own. If the
          repos depend on each other&apos;s unmerged changes at compile time,
          OneShot keeps the work as a single run so nothing ships half-wired.
        </span>
      </p>
    </RevealSection>
  );
}

function usePipelineScrollIndex(
  ref: RefObject<HTMLElement | null>,
  stageCount: number,
): {
  activeIndex: number;
  isInteractive: boolean;
  setActiveIndex: (index: number) => void;
} {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isInteractive, setIsInteractive] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const desktopQuery = window.matchMedia("(min-width: 981px)");
    let frame = 0;

    const update = () => {
      frame = 0;
      const interactive = desktopQuery.matches && !reducedMotionQuery.matches;
      setIsInteractive((current) =>
        current === interactive ? current : interactive,
      );

      const el = ref.current;
      if (!el || !interactive) {
        setActiveIndex(0);
        return;
      }

      const rect = el.getBoundingClientRect();
      const viewportHeight =
        window.innerHeight || document.documentElement.clientHeight || 1;
      const travelDistance = Math.max(rect.height - viewportHeight, 1);
      const progress = Math.max(0, Math.min(1, -rect.top / travelDistance));
      const nextIndex = Math.min(
        stageCount - 1,
        Math.max(0, Math.round(progress * (stageCount - 1))),
      );

      setActiveIndex((current) =>
        current === nextIndex ? current : nextIndex,
      );
    };

    const requestUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    requestUpdate();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    reducedMotionQuery.addEventListener("change", requestUpdate);
    desktopQuery.addEventListener("change", requestUpdate);

    return () => {
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
      reducedMotionQuery.removeEventListener("change", requestUpdate);
      desktopQuery.removeEventListener("change", requestUpdate);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ref, stageCount]);

  return { activeIndex, isInteractive, setActiveIndex };
}

const stagePanelId = (stage: AgentStage): string =>
  `about-stage-panel-${stage}`;

function PipelineStageCard({
  index,
  stage,
}: {
  index: number;
  stage: AgentStage;
}) {
  const visual = STAGE_VISUALS[stage];

  return (
    <article
      id={stagePanelId(stage)}
      role="listitem"
      aria-label={`Stage ${index + 1}: ${STAGE_LABELS[stage]}`}
      className={`about-stage-panel is-stacked${index % 2 === 1 ? " is-reversed" : ""}`}
      style={
        {
          "--stage-accent": visual.accent,
          "--stage-glow": visual.glow,
        } as CSSProperties
      }
    >
      <div className="about-stage-visual">
        <img
          src={visual.image}
          alt=""
          loading={index === 0 ? "eager" : "lazy"}
        />
      </div>
      <div className="about-stage-copy">
        <div className="about-stage-stagenum">
          Stage {String(index + 1).padStart(2, "0")} /{" "}
          {String(AGENT_STAGES.length).padStart(2, "0")}
          <span aria-hidden="true">·</span>
          <span className="about-stage-stagenum-eyebrow">{visual.eyebrow}</span>
        </div>
        <h3>{STAGE_LABELS[stage]}</h3>
        <span className="about-stage-proof">{visual.proof}</span>
        <p>{visual.body}</p>
      </div>
    </article>
  );
}

function PipelineStory() {
  const trackRef = useRef<HTMLDivElement>(null);
  const { activeIndex, isInteractive, setActiveIndex } = usePipelineScrollIndex(
    trackRef,
    AGENT_STAGES.length,
  );

  const activeStage = AGENT_STAGES[activeIndex] ?? AGENT_STAGES[0];
  const handleStageSelect = useCallback(
    (nextIndex: number) => {
      const nextStage = AGENT_STAGES[nextIndex];
      if (!nextStage) return;

      setActiveIndex(nextIndex);

      if (typeof window === "undefined") return;

      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";

      if (!isInteractive) {
        document.getElementById(stagePanelId(nextStage))?.scrollIntoView({
          block: "nearest",
          behavior,
        });
        return;
      }

      const el = trackRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const viewportHeight =
        window.innerHeight || document.documentElement.clientHeight || 1;
      const travelDistance = Math.max(rect.height - viewportHeight, 1);
      const progress =
        AGENT_STAGES.length <= 1
          ? 0
          : nextIndex / Math.max(AGENT_STAGES.length - 1, 1);
      const targetTop = window.scrollY + rect.top + travelDistance * progress;

      window.scrollTo({ top: targetTop, behavior });
    },
    [isInteractive, setActiveIndex],
  );

  return (
    <section
      id="about-pipeline"
      className="about-pipeline-scroll-section about-section-grid"
    >
      <div className="about-pipeline-scroll-intro">
        <div style={{ paddingTop: 4 }}>
          <div className="about-section-eyebrow">Pipeline</div>
          <h2
            style={{
              margin: "14px 0 0",
              fontFamily: FONTS.display,
              fontSize: "clamp(24px, 2.3vw, 34px)",
              lineHeight: 1.04,
              letterSpacing: "-0.025em",
              color: "var(--text)",
              fontVariationSettings: '"opsz" 144, "wght" 380, "SOFT" 30',
            }}
          >
            Six agents, one clear handoff at a time.
          </h2>
          <p className="about-side-copy">
            A run moves forward only after the previous stage leaves something
            concrete for the next one to use.
          </p>
        </div>
      </div>

      <div className="about-pipeline-scroll-track" ref={trackRef}>
        <div className="about-pipeline-sticky">
          <div
            className="about-pipeline-progress"
            aria-label="Pipeline stages"
            style={
              {
                "--stage-accent": STAGE_VISUALS[activeStage].accent,
              } as CSSProperties
            }
          >
            {AGENT_STAGES.map((stage, idx) => (
              <button
                key={stage}
                type="button"
                className={`about-pipeline-progress-step${activeIndex === idx ? " is-active" : ""}`}
                aria-current={activeIndex === idx ? "step" : undefined}
                aria-controls={
                  !isInteractive || activeIndex === idx
                    ? stagePanelId(stage)
                    : undefined
                }
                onClick={() => handleStageSelect(idx)}
                style={
                  {
                    "--stage-accent": STAGE_VISUALS[stage].accent,
                  } as CSSProperties
                }
              >
                {STAGE_LABELS[stage]}
              </button>
            ))}
          </div>
          <div className="about-stage-stack" role="list">
            {isInteractive ? (
              <PipelineStageCard
                key={activeStage}
                index={activeIndex}
                stage={activeStage}
              />
            ) : (
              AGENT_STAGES.map((stage, idx) => (
                <PipelineStageCard key={stage} index={idx} stage={stage} />
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function IssueTypeGlyph({ type }: { type: TicketTemplate["issueType"] }) {
  const isRetrofit = type === "Retrofit";
  return (
    <span
      aria-label={type}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
        borderRadius: 3,
        background: isRetrofit ? "var(--accent)" : "#68c77f",
        color: "#0b0c0e",
        fontFamily: FONTS.mono,
        fontSize: 10,
        fontWeight: 700,
      }}
    >
      {isRetrofit ? "↺" : "S"}
    </span>
  );
}

function RequiredBadge({ tone }: { tone: FieldTone }) {
  const isRequired = tone === "required";
  const isRecommended = tone === "recommended";
  const label = isRequired
    ? "required"
    : isRecommended
      ? "recommended"
      : "optional";
  return (
    <span
      style={{
        fontFamily: FONTS.mono,
        fontSize: 9,
        letterSpacing: "0.2em",
        textTransform: "uppercase",
        padding: "2px 7px",
        borderRadius: 999,
        color: isRequired
          ? "var(--accent-2)"
          : isRecommended
            ? "var(--text-2)"
            : "var(--dim)",
        background: isRequired
          ? "rgba(255, 184, 112, 0.12)"
          : isRecommended
            ? "rgba(255, 184, 112, 0.06)"
            : "transparent",
        border: isRequired
          ? "1px solid rgba(255, 184, 112, 0.32)"
          : isRecommended
            ? "1px solid rgba(255, 184, 112, 0.22)"
            : "1px solid rgba(255,255,255,0.12)",
      }}
    >
      {label}
    </span>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return <span className="about-placeholder">{children}</span>;
}

function HighlightedLine({ text }: { text: string }) {
  const parts = text.split(/(<[^>]+>)/g);
  return (
    <>
      {parts.map((part, i) => {
        const inner = /^<([^>]+)>$/.exec(part);
        return inner ? (
          <Placeholder key={i}>{inner[1]}</Placeholder>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

function TemplateBlockView({ block }: { block: TemplateBlock }) {
  if (block.kind === "h") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: "6px 0 2px",
        }}
      >
        <h4
          style={{
            margin: 0,
            fontFamily: FONTS.body,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text)",
          }}
        >
          {block.text}
        </h4>
        <RequiredBadge tone={block.tone} />
      </div>
    );
  }
  if (block.kind === "note") {
    return (
      <p
        style={{
          margin: 0,
          fontFamily: FONTS.body,
          fontSize: 12,
          lineHeight: 1.55,
          color: "var(--dim)",
        }}
      >
        // {block.text}
      </p>
    );
  }
  if (block.kind === "p") {
    return (
      <p
        style={{
          margin: 0,
          fontFamily: FONTS.body,
          fontSize: 13.5,
          lineHeight: 1.62,
          color: "var(--text-2)",
        }}
      >
        <HighlightedLine text={block.text} />
      </p>
    );
  }
  if (block.kind === "ul") {
    return (
      <ul
        style={{
          margin: 0,
          paddingLeft: 22,
          fontFamily: FONTS.body,
          fontSize: 13.5,
          lineHeight: 1.62,
          color: "var(--text-2)",
        }}
      >
        {block.items.map((item, i) => (
          <li key={i} style={{ margin: "2px 0" }}>
            <HighlightedLine text={item} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <dl
      className="about-template-kv"
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "minmax(86px, 140px) auto minmax(0, 1fr)",
        rowGap: 6,
        columnGap: 14,
        fontFamily: FONTS.body,
        fontSize: 13,
        alignItems: "center",
      }}
    >
      {block.rows.map((row, i) => (
        <div
          key={i}
          className="about-template-kv-row"
          style={{ display: "contents" }}
        >
          <dt
            style={{
              color: "var(--text)",
              fontSize: 12.5,
              fontWeight: 500,
            }}
          >
            {row.key}
          </dt>
          <dd style={{ margin: 0 }}>
            <RequiredBadge tone={row.tone ?? "optional"} />
          </dd>
          <dd
            style={{
              margin: 0,
              fontFamily: FONTS.mono,
              fontSize: 12.5,
            }}
          >
            <HighlightedLine text={row.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TemplateCopyButton({
  label,
  onCopy,
}: {
  label: string;
  onCopy: () => Promise<void>;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const handle = useCallback(async () => {
    try {
      await onCopy();
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }, [onCopy]);
  const copied = copyState === "copied";
  const failed = copyState === "failed";

  return (
    <button
      className="about-template-copy"
      type="button"
      onClick={handle}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 12px",
        borderRadius: 999,
        border: failed
          ? "1px solid rgba(255, 112, 112, 0.42)"
          : copied
            ? "1px solid rgba(255, 184, 112, 0.38)"
            : "1px solid rgba(255,255,255,0.12)",
        background: failed
          ? "rgba(255, 112, 112, 0.12)"
          : copied
            ? "rgba(255, 184, 112, 0.12)"
            : "rgba(255, 255, 255, 0.04)",
        color: failed
          ? "rgba(255, 190, 190, 0.95)"
          : copied
            ? "var(--accent-2)"
            : "var(--text-2)",
        fontFamily: FONTS.mono,
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
      }}
    >
      {copied ? (
        <Check size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
      ) : (
        <Copy size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
      )}
      {copied ? "Copied" : failed ? "Copy failed" : label}
    </button>
  );
}

function TicketTemplateCard({ template }: { template: TicketTemplate }) {
  const copyLabel =
    template.issueType === "Retrofit"
      ? "Copy Retrofit template"
      : "Copy CPDEV template";
  const handleCopy = useCallback(async () => {
    const text = templateToPlainText(template);
    await copyTextToClipboard(text);
  }, [template]);

  return (
    <article className="about-ticket-card">
      <div className="about-ticket-toolbar">
        <div className="about-ticket-title">
          <IssueTypeGlyph type={template.issueType} />
          <span
            className="about-ticket-key"
            style={{
              fontFamily: FONTS.mono,
              fontSize: 12,
              letterSpacing: "0.04em",
              color: "var(--text)",
            }}
          >
            {template.ticketKey}
          </span>
          <span
            className="about-ticket-type"
            style={{
              fontFamily: FONTS.body,
              fontSize: 12,
              color: "var(--dim)",
            }}
          >
            · {template.issueType}
          </span>
        </div>
        <TemplateCopyButton label={copyLabel} onCopy={handleCopy} />
      </div>

      <div
        style={{
          padding: "20px 22px 22px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: FONTS.mono,
              fontSize: 10.5,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "var(--dim)",
            }}
          >
            Labels
          </span>
          {template.labels.map((label) => (
            <span
              key={label.text}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontFamily: FONTS.mono,
                fontSize: 11,
                letterSpacing: "0.04em",
                padding: "4px 10px 4px 8px",
                borderRadius: 3,
                color: "var(--accent-2)",
                background: "rgba(255, 184, 112, 0.12)",
                border: "1px solid rgba(255, 184, 112, 0.32)",
              }}
            >
              <Tag size={11} strokeWidth={ICON_STROKE} />
              {label.text}
            </span>
          ))}
          <RequiredBadge tone="required" />
        </div>

        <div
          aria-hidden="true"
          style={{
            height: 1,
            background: "rgba(255,255,255,0.1)",
          }}
        />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <span
            style={{
              fontFamily: FONTS.mono,
              fontSize: 10.5,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "var(--dim)",
            }}
          >
            Description
          </span>
          {template.description.map((block, i) => (
            <TemplateBlockView key={i} block={block} />
          ))}
        </div>
      </div>
    </article>
  );
}

function TemplateGroup({
  eyebrow,
  heading,
  caption,
  icon: Icon,
  template,
  stagger = 0,
}: {
  eyebrow: string;
  heading: string;
  caption: string;
  icon: LucideIcon;
  template: TicketTemplate;
  stagger?: number;
}) {
  const { ref, revealed } = useReveal<HTMLDivElement>();
  return (
    <div className="about-template-group">
      <div className="about-template-group-head">
        <div className="about-template-group-eyebrow">
          <Icon size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
          <span>{eyebrow}</span>
        </div>
        <div className="about-template-group-caption">{caption}</div>
      </div>
      <h3 className="about-template-group-title">{heading}</h3>
      <div
        ref={ref}
        className="about-template-reveal"
        data-revealed={revealed ? "true" : undefined}
        style={{ transitionDelay: stagger ? `${stagger}ms` : undefined }}
      >
        <TicketTemplateCard template={template} />
      </div>
    </div>
  );
}

function TicketFormatContent() {
  const rovoPromptChips = [
    "Reformat rough Jira notes",
    "Update a Jira description",
    "Convert CPDEV work into Markdown",
  ];
  return (
    <RevealSection
      id="about-templates"
      delay={40}
      style={{ padding: "clamp(18px, 3vw, 34px) 0 0" }}
    >
      <div className="about-template-intro">
        <span className="about-features-eyebrow">Templates</span>
        <h2 className="about-features-headline">
          Give OneShot a ticket it can act on.
        </h2>
        <p className="about-features-lede">
          Required fields are tagged inline. Copy into Jira or hand to an LLM to
          fill in. Placeholders in angle brackets.
        </p>
      </div>
      <aside
        className="about-rovo-helper"
        aria-label="OneShot Formatter Rovo Agent"
      >
        <div className="about-rovo-helper-main">
          <span className="about-rovo-helper-eyebrow">
            <Sparkles size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
            Rovo Agent
          </span>
          <h3 className="about-rovo-helper-title">
            Format rough Jira work for OneShot
          </h3>
          <p className="about-rovo-helper-body">
            Open the OneShot Formatter agent, share a CPDEV key or rough Jira
            notes, and ask it to rewrite the work in the OneShot template.
          </p>
          <div className="about-rovo-helper-chips" aria-label="Example prompts">
            {rovoPromptChips.map((chip) => (
              <span key={chip} className="about-rovo-helper-chip">
                {chip}
              </span>
            ))}
          </div>
        </div>
        <a
          className="about-link-pill is-primary about-rovo-helper-action"
          href={ONESHOT_FORMATTER_ROVO_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open OneShot Formatter
          <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
        </a>
      </aside>
      <div className="about-template-list">
        <TemplateGroup
          eyebrow="CPDEV ticket"
          heading="A feature, fix, or tight refactor."
          caption="Use this for normal feature, fix, or focused refactor work. Acceptance Criteria carries the most readiness weight."
          icon={FileText}
          template={CPDEV_TEMPLATE}
        />
        <TemplateGroup
          eyebrow="Retrofit ticket"
          heading="A backport or forward-port."
          caption="Use this only when porting an existing fix. Retrofit, From, and Target must appear together."
          icon={GitBranch}
          template={RETROFIT_TEMPLATE}
          stagger={120}
        />
      </div>
    </RevealSection>
  );
}

function DocumentationLabelChip({ label }: { label: string }) {
  return (
    <span className="about-docs-label-chip">
      <Tag size={11} strokeWidth={ICON_STROKE} />
      {label}
    </span>
  );
}

function DocumentationModeSection() {
  return (
    <RevealSection
      id="about-docs-mode"
      delay={50}
      style={{ padding: "clamp(28px, 4vw, 48px) 0 0" }}
    >
      <section
        className="about-docs-label-section"
        aria-labelledby="about-docs-mode-title"
      >
        <header className="about-scan-head">
          <span className="about-scan-icon" aria-hidden="true">
            <FileText size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          </span>
          <div className="about-scan-head-copy">
            <span className="about-features-eyebrow">Documentation mode</span>
            <h2 id="about-docs-mode-title" className="about-features-headline">
              Label each documentation child task with one document type.
            </h2>
            <p className="about-features-lede">
              Use this for documentation-only child tasks under a documentation
              story. OneShot reads the selected template, reviews Jira evidence,
              and produces a dry-run artifact before any publish path is used.
            </p>
          </div>
        </header>

        <div className="about-docs-label-rules" role="list">
          {DOCUMENTATION_LABEL_RULES.map((rule) => (
            <div key={rule} className="about-docs-label-rule" role="listitem">
              <Check size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
              <span>{rule}</span>
            </div>
          ))}
        </div>

        <div
          className="about-docs-label-table"
          role="table"
          aria-label="Documentation mode labels"
        >
          <div className="about-docs-label-row is-header" role="row">
            <div role="columnheader">Document task</div>
            <div role="columnheader">Required labels</div>
          </div>
          {DOCUMENTATION_LABEL_ROWS.map((row) => (
            <div key={row.task} className="about-docs-label-row" role="row">
              <div className="about-docs-label-task" role="cell">
                {row.task}
              </div>
              <div className="about-docs-labels" role="cell">
                {row.labels.map((label) => (
                  <DocumentationLabelChip key={label} label={label} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="about-docs-dry-run">
          <span className="about-docs-dry-run-label">Dry run</span>
          <code>npm run oneshot:docs:dry-run &lt;JIRA_KEY&gt;</code>
          <span className="about-docs-dry-run-label">Jira run</span>
          <code>npm run oneshot:docs:run -- &lt;JIRA_KEY&gt;</code>
          <span className="about-docs-dry-run-label">Batch</span>
          <code>npm run oneshot:docs:run-all -- --limit 25</code>
        </div>
      </section>
    </RevealSection>
  );
}

function ScanUsageSectionView({
  section,
  index,
}: {
  section: ScanUsageSection;
  index: number;
}) {
  const Icon = section.icon;
  const titleId = `${section.anchor}-title`;

  return (
    <RevealSection
      id={section.anchor}
      delay={55 + index * 10}
      style={{ padding: "clamp(28px, 4vw, 48px) 0 0" }}
    >
      <section className="about-scan-section" aria-labelledby={titleId}>
        <header className="about-scan-head">
          <span className="about-scan-icon" aria-hidden="true">
            <Icon size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          </span>
          <div className="about-scan-head-copy">
            <span className="about-features-eyebrow">{section.eyebrow}</span>
            <h2 id={titleId} className="about-features-headline">
              {section.title}
            </h2>
            <p className="about-features-lede">{section.body}</p>
          </div>
        </header>

        <div className="about-scan-grid">
          <article className="about-scan-card">
            <span className="about-scan-card-eyebrow">Jira setup</span>
            <h3 className="about-scan-card-title">What is needed in Jira</h3>
            <ol className="about-scan-list">
              {section.jiraNeeds.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </article>

          <article className="about-scan-card">
            <span className="about-scan-card-eyebrow">OneShot flow</span>
            <h3 className="about-scan-card-title">How it enters OneShot</h3>
            <ol className="about-scan-list">
              {section.oneShotFlow.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </article>
        </div>

        <div className="about-scan-notes" role="list">
          {section.notes.map((note) => (
            <div key={note} className="about-scan-note" role="listitem">
              {note}
            </div>
          ))}
        </div>
      </section>
    </RevealSection>
  );
}

function ScanUsageSections() {
  return (
    <>
      {SCAN_USAGE_SECTIONS.map((section, index) => (
        <ScanUsageSectionView
          key={section.anchor}
          section={section}
          index={index}
        />
      ))}
    </>
  );
}

function HowToJumpRow() {
  const handleJump = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, href: string) => {
      if (typeof window === "undefined") return;

      const targetId = href.replace(/^#/, "");
      const target = document.getElementById(targetId);
      if (!target) return;

      event.preventDefault();
      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      target.scrollIntoView({
        block: "start",
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });

      const url = new URL(window.location.href);
      url.hash = targetId;
      window.history.replaceState(null, "", url);
    },
    [],
  );

  return (
    <nav className="about-howto-jump-row" aria-label="How-to sections">
      <span className="about-howto-jump-label">On this page</span>
      {HOW_TO_JUMP_LINKS.map((link) => (
        <a
          key={link.href}
          className="about-howto-jump-link"
          href={link.href}
          onClick={(event) => handleJump(event, link.href)}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

function BeforeRunChecklist() {
  return (
    <RevealSection
      id="about-before-run"
      delay={60}
      style={{ padding: "clamp(28px, 4vw, 48px) 0 0" }}
    >
      <div className="about-template-intro">
        <span className="about-features-eyebrow">Before you run</span>
        <h2 className="about-features-headline">
          Give the gates enough to trust.
        </h2>
        <p className="about-features-lede">
          A clean ticket gives the Qualifier, Planner, and Reviewer the details
          they need before build work starts.
        </p>
      </div>
      <div className="about-guide-card-grid" role="list">
        {BEFORE_RUN_CHECKLIST.map((item) => (
          <article
            key={item.title}
            className="about-guide-card"
            role="listitem"
          >
            <span className="about-guide-card-icon" aria-hidden="true">
              <Check size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
            </span>
            <h3 className="about-guide-card-title">{item.title}</h3>
            <p className="about-guide-card-body">{item.body}</p>
          </article>
        ))}
      </div>
    </RevealSection>
  );
}

function StopGuidanceSection() {
  return (
    <RevealSection
      id="about-if-it-stops"
      delay={70}
      style={{ padding: "clamp(28px, 4vw, 48px) 0 0" }}
    >
      <div className="about-template-intro">
        <span className="about-features-eyebrow">If it stops</span>
        <h2 className="about-features-headline">
          Treat every stop as a useful answer.
        </h2>
        <p className="about-features-lede">
          OneShot is designed to stop at gates instead of guessing. Fix the
          missing detail, then rerun or replan with the right label.
        </p>
      </div>
      <div className="about-stop-grid" role="list">
        {STOP_GUIDANCE.map((item) => (
          <article
            key={item.title}
            className="about-guide-card"
            role="listitem"
          >
            <span className="about-guide-card-icon" aria-hidden="true">
              <Minus size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
            </span>
            <h3 className="about-guide-card-title">{item.title}</h3>
            <p className="about-guide-card-body">{item.action}</p>
          </article>
        ))}
      </div>
    </RevealSection>
  );
}

function StatusGlyph({ status }: { status: SpecStatus }) {
  const labelMap: Record<SpecStatus, string> = {
    yes: "Yes",
    partial: "Limited",
    no: "No",
  };
  return (
    <span className="spec-row-status" data-status={status}>
      <span className="spec-icon" aria-hidden="true">
        {status === "yes" ? (
          <Check size={14} strokeWidth={2.6} />
        ) : status === "no" ? (
          <Minus size={14} strokeWidth={2.6} />
        ) : null}
      </span>
      <span className="spec-row-status-label">{labelMap[status]}</span>
    </span>
  );
}

function ProfiledReposCatalog() {
  return (
    <div
      className="spec-profiled-repos"
      aria-label="Profiled repos that OneShot can auto-route"
    >
      <div className="spec-profiled-repos-head">
        <div>
          <h3 className="spec-profiled-repos-title">Profiled repos</h3>
          <p className="spec-profiled-repos-copy">
            These repos are profiled for OneShot auto-routing. For any repo
            outside this catalog, add <code>Repo: owner/repo-name</code> to the
            ticket; OneShot will not infer it automatically.
          </p>
        </div>
        <span className="spec-profiled-repos-count">
          {PROFILED_REPOS.length} repos
        </span>
      </div>
      <div className="spec-profiled-repos-grid" role="list">
        {PROFILED_REPOS.map((repo) => (
          <div
            key={`${repo.repoName}-${repo.githubSlug}`}
            className="spec-profiled-repo"
            role="listitem"
          >
            <span className="spec-profiled-repo-name">{repo.repoName}</span>
            <span className="spec-profiled-repo-slug">
              GitHub: {repo.githubSlug}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GuideSpecSheet() {
  const totals = useMemo(() => {
    let yes = 0;
    let partial = 0;
    let no = 0;
    for (const section of SPEC_SECTIONS) {
      for (const row of section.rows) {
        if (row.status === "yes") yes++;
        else if (row.status === "partial") partial++;
        else no++;
      }
    }
    return { yes, partial, no, total: yes + partial + no };
  }, []);

  return (
    <RevealSection
      id="about-reference"
      delay={80}
      style={{ padding: "clamp(28px, 4vw, 48px) 0 0" }}
    >
      <div className="spec-sheet">
        <div className="about-template-intro">
          <span className="about-features-eyebrow">Launch guide</span>
          <h2 className="about-features-headline">
            Decide if this work belongs in OneShot.
          </h2>
          <p className="about-features-lede">
            Use this before launch or after a stop to confirm scope, repo
            routing, labels, and retry path.
          </p>
        </div>
        <div
          className="spec-legend"
          role="note"
          aria-label="Launch check summary"
          style={{ marginTop: 4 }}
        >
          <span className="spec-legend-pill is-total">
            <strong>{totals.total}</strong>
            <span>launch checks</span>
          </span>
          <span className="spec-legend-pill">
            <StatusGlyph status="yes" />
            <span>{totals.yes} supported</span>
          </span>
          <span className="spec-legend-pill">
            <StatusGlyph status="partial" />
            <span>{totals.partial} limited</span>
          </span>
          <span className="spec-legend-pill">
            <StatusGlyph status="no" />
            <span>{totals.no} out of scope</span>
          </span>
        </div>

        <article className="spec-card">
          {SPEC_SECTIONS.map((section, idx) => (
            <section
              key={section.title}
              id={section.anchor}
              className="spec-section"
              aria-labelledby={`spec-section-${idx}`}
            >
              <header className="spec-section-head">
                <div>
                  <h2 id={`spec-section-${idx}`} className="spec-section-title">
                    {section.title}
                  </h2>
                  <p className="spec-section-caption">{section.caption}</p>
                </div>
                <span className="spec-section-count">
                  {section.rows.length} checks
                </span>
              </header>
              <div className="spec-table" role="table">
                <div className="spec-table-head" role="rowgroup">
                  <div role="columnheader">Capability</div>
                  <div role="columnheader" style={{ textAlign: "center" }}>
                    Status
                  </div>
                  <div role="columnheader">Notes</div>
                </div>
                {section.rows.map((row, rowIdx) => (
                  <div
                    key={`${section.title}-${rowIdx}`}
                    className="spec-row"
                    role="row"
                  >
                    <div role="cell">
                      <div className="spec-row-cap">{row.capability}</div>
                    </div>
                    <div role="cell" style={{ textAlign: "center" }}>
                      <StatusGlyph status={row.status} />
                    </div>
                    <div role="cell">{row.notes}</div>
                  </div>
                ))}
              </div>
              {section.title === "Repo support and routing" ? (
                <ProfiledReposCatalog />
              ) : null}
            </section>
          ))}
        </article>
      </div>
    </RevealSection>
  );
}

function CtaCloser({
  title,
  body,
  primary,
  secondary,
}: {
  title: ReactNode;
  body: ReactNode;
  primary: {
    label: string;
    panel?: AboutPanel;
    href?: string;
    onClick?: () => void;
  };
  secondary?: {
    label: string;
    panel?: AboutPanel;
    href?: string;
    onClick?: () => void;
  };
}) {
  const buildHandler = (action: typeof primary) =>
    action.onClick
      ? (event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          action.onClick?.();
        }
      : undefined;

  const primaryHref = primary.panel
    ? aboutPanelHref(primary.panel)
    : (primary.href ?? "#");
  const secondaryHref = secondary
    ? secondary.panel
      ? aboutPanelHref(secondary.panel)
      : (secondary.href ?? "#")
    : undefined;

  return (
    <RevealSection delay={60} style={{ padding: 0 }}>
      <div className="about-closer">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <h3>{title}</h3>
          <p>{body}</p>
        </div>
        <div className="about-closer-actions">
          <a
            className="about-link-pill is-primary"
            href={primaryHref}
            onClick={buildHandler(primary)}
            target={primary.href && !primary.panel ? "_blank" : undefined}
            rel={
              primary.href && !primary.panel ? "noopener noreferrer" : undefined
            }
          >
            {primary.label}
            <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
          </a>
          {secondary && secondaryHref ? (
            <a
              className="about-link-pill"
              href={secondaryHref}
              onClick={buildHandler(secondary)}
              target={secondary.href && !secondary.panel ? "_blank" : undefined}
              rel={
                secondary.href && !secondary.panel
                  ? "noopener noreferrer"
                  : undefined
              }
            >
              {secondary.label}
              <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
            </a>
          ) : null}
        </div>
      </div>
    </RevealSection>
  );
}

type NextStep = {
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  panel: AboutPanel;
  onClick?: () => void;
};

function NextStepsTrio({ steps }: { steps: ReadonlyArray<NextStep> }) {
  const buildHandler = (step: NextStep) =>
    step.onClick
      ? (event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          step.onClick?.();
        }
      : undefined;

  return (
    <RevealSection delay={60} style={{ padding: 0 }}>
      <div className="about-trio">
        {steps.map((step, idx) => (
          <article key={step.panel} className="about-trio-card">
            <span className="about-trio-eyebrow">{step.eyebrow}</span>
            <h3 className="about-trio-title">{step.title}</h3>
            <p className="about-trio-body">{step.body}</p>
            <a
              className={`about-link-pill${idx === 0 ? " is-primary" : ""}`}
              href={aboutPanelHref(step.panel)}
              onClick={buildHandler(step)}
            >
              {step.cta}
              <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
            </a>
          </article>
        ))}
      </div>
    </RevealSection>
  );
}

function FeaturesPage({
  wordmarkRef,
  onPanelChange,
}: {
  wordmarkRef?: RefObject<HTMLHeadingElement | null>;
  onPanelChange?: (panel: AboutPanel) => void;
}) {
  const openHowTo = useCallback(() => {
    onPanelChange?.("how-to");
  }, [onPanelChange]);
  const openTechSpec = useCallback(() => {
    onPanelChange?.("tech-spec");
  }, [onPanelChange]);
  const openChangelog = useCallback(() => {
    onPanelChange?.("changelog");
  }, [onPanelChange]);

  const steps: ReadonlyArray<NextStep> = [
    {
      eyebrow: "Next · How-to",
      title: "Start with the right ticket.",
      body: "See which tickets OneShot accepts, which repos it can route, and which work should stay with a human first.",
      cta: "See the How-to",
      panel: "how-to",
      onClick: openHowTo,
    },
    {
      eyebrow: "Then · Tech Spec",
      title: "See how it’s built.",
      body: "Review the stages, providers, queues, artifacts, and delivery rules that keep a run controlled.",
      cta: "Read the Tech Spec",
      panel: "tech-spec",
      onClick: openTechSpec,
    },
    {
      eyebrow: "Live · Changelog",
      title: "Track the recent moves.",
      body: "Follow the latest changes to qualifier routing, statistics, repo directives, and operator guidance.",
      cta: "Recent shipping notes",
      panel: "changelog",
      onClick: openChangelog,
    },
  ];

  return (
    <>
      <FeaturesHero
        wordmarkRef={wordmarkRef}
        onOpenHowTo={onPanelChange ? openHowTo : undefined}
        onOpenTechSpec={onPanelChange ? openTechSpec : undefined}
      />
      <FeatureHighlights />
      <PipelineStory />
      <MultiRepoFlow />
      <DashboardShowcase
        onOpenTechSpec={onPanelChange ? openTechSpec : undefined}
      />
      <OneShotInNumbers />
      <NextStepsTrio steps={steps} />
    </>
  );
}

function HowToPage({
  onPanelChange,
  wordmarkRef,
}: {
  onPanelChange?: (panel: AboutPanel) => void;
  wordmarkRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const openTechSpec = useCallback(() => {
    onPanelChange?.("tech-spec");
  }, [onPanelChange]);
  const openChangelog = useCallback(() => {
    onPanelChange?.("changelog");
  }, [onPanelChange]);

  return (
    <>
      <GuidePanelHero
        wordmarkRef={wordmarkRef}
        eyebrow="How-to · operator guide"
        title={<>Start with a ticket OneShot can trust.</>}
        titleId="about-howto-title"
        copy="Use the templates, check the readiness details, launch with the right Jira labels, and know exactly what to fix when a gate stops the run."
        actions={<HowToJumpRow />}
      />
      <TicketFormatContent />
      <DocumentationModeSection />
      <ScanUsageSections />
      <BeforeRunChecklist />
      <StopGuidanceSection />
      <GuideSpecSheet />
      <CtaCloser
        title="Want the implementation map?"
        body={
          <>
            The Tech Spec explains how the run moves. The Changelog shows what
            changed recently. Both are written for the engineer who has to live
            with the result.
          </>
        }
        primary={{
          label: "Open Tech Spec",
          panel: "tech-spec",
          onClick: openTechSpec,
        }}
        secondary={{
          label: "Recent shipping notes",
          panel: "changelog",
          onClick: openChangelog,
        }}
      />
    </>
  );
}

// ───────────────────────────────────────────────────────────────
// TECH SPEC TAB — sticky TOC + deep links (unchanged)
// ───────────────────────────────────────────────────────────────

const TECH_SPEC_NAV = TECH_SPEC_GROUPS.map((g) => ({
  title: g.title,
  caption: g.caption,
  slug: techSpecSlug(g.title),
}));

function useActiveTechSpecSlug(): string {
  const [active, setActive] = useState<string>(TECH_SPEC_NAV[0]?.slug ?? "");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sections = TECH_SPEC_NAV.map(({ slug }) =>
      document.getElementById(slug),
    ).filter((el): el is HTMLElement => Boolean(el));
    if (sections.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActive(visible[0].target.id);
      },
      {
        rootMargin: "-20% 0px -55% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );
    for (const section of sections) obs.observe(section);
    return () => obs.disconnect();
  }, []);
  return active;
}

function TechSpecRowAnchor({ slug, label }: { slug: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handle = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const url = new URL(window.location.href);
      url.search = "?view=about&panel=tech-spec";
      url.hash = slug;
      try {
        await navigator.clipboard.writeText(url.toString());
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      } catch {
        setCopied(false);
      }
    },
    [slug],
  );
  return (
    <button
      type="button"
      onClick={handle}
      className={`about-techspec-row-anchor${copied ? " is-copied" : ""}`}
      aria-label={`Copy link to ${label}`}
      title={copied ? "Link copied" : "Copy link"}
    >
      {copied ? (
        <Check size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
      ) : (
        <Hash size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
      )}
    </button>
  );
}

function TechSpecPage({
  wordmarkRef,
}: {
  wordmarkRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const activeSlug = useActiveTechSpecSlug();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const el = document.getElementById(hash);
    if (!el) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    requestAnimationFrame(() => {
      el.scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "start",
      });
    });
  }, []);

  const handleTocClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, slug: string) => {
      event.preventDefault();
      const el = document.getElementById(slug);
      if (!el) return;
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      el.scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "start",
      });
      const url = new URL(window.location.href);
      url.hash = slug;
      window.history.replaceState({}, "", url.toString());
    },
    [],
  );

  const handleSelectChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const slug = event.target.value;
      const el = document.getElementById(slug);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [],
  );

  return (
    <div className="about-techspec-page">
      <GuidePanelHero
        wordmarkRef={wordmarkRef}
        eyebrow="Specification"
        title={
          <>
            The machinery behind <em>OneShot</em>.
          </>
        }
        titleId="about-techspec-title"
        copy="The stages, queues, providers, artifacts, delivery rules, and runtime controls behind a safe run. Each row has its own deep link."
        actions={
          <a
            className="about-link-pill"
            href={CHANGELOG_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Release notes
            <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
          </a>
        }
      />

      <div className="about-techspec-toc-mobile">
        <span
          style={{
            fontFamily: FONTS.mono,
            fontSize: 10,
            letterSpacing: "0.32em",
            textTransform: "uppercase",
            color: "var(--dim)",
          }}
        >
          Jump to
        </span>
        <select
          value={activeSlug}
          onChange={handleSelectChange}
          aria-label="Tech spec sections"
        >
          {TECH_SPEC_NAV.map((item) => (
            <option key={item.slug} value={item.slug}>
              {item.title}
            </option>
          ))}
        </select>
      </div>

      <div className="about-techspec-body">
        <nav
          className="about-techspec-toc"
          aria-label="Tech spec table of contents"
        >
          <span className="about-techspec-toc-eyebrow">Sections</span>
          {TECH_SPEC_NAV.map((item) => (
            <a
              key={item.slug}
              href={`#${item.slug}`}
              title={item.caption}
              className={item.slug === activeSlug ? "is-active" : undefined}
              aria-current={item.slug === activeSlug ? "true" : undefined}
              onClick={(event) => handleTocClick(event, item.slug)}
            >
              {item.title}
            </a>
          ))}
        </nav>

        <div className="about-techspec-groups">
          {TECH_SPEC_GROUPS.map((group, groupIdx) => {
            const slug = TECH_SPEC_NAV[groupIdx].slug;
            return (
              <section
                key={slug}
                id={slug}
                className="about-techspec-group"
                aria-labelledby={`${slug}-title`}
              >
                <header className="about-techspec-group-head">
                  <span className="about-techspec-group-eyebrow">
                    {String(groupIdx + 1).padStart(2, "0")} ·{" "}
                    {TECH_SPEC_GROUPS.length}
                  </span>
                  <h3
                    id={`${slug}-title`}
                    className="about-techspec-group-title"
                  >
                    {group.title}
                  </h3>
                  <p className="about-techspec-group-caption">
                    {group.caption}
                  </p>
                </header>
                <div className="about-techspec-rows">
                  {group.rows.map((row) => {
                    const rowSlug = `${slug}-${row.label
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/(^-|-$)/g, "")}`;
                    return (
                      <div
                        key={rowSlug}
                        id={rowSlug}
                        className="about-techspec-row"
                      >
                        <span className="about-techspec-row-label">
                          {row.label}
                        </span>
                        <span className="about-techspec-row-value">
                          {row.value}
                        </span>
                        <TechSpecRowAnchor slug={rowSlug} label={row.label} />
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <aside className="about-techspec-end" aria-label="Reference docs">
            <h4>Want the full record?</h4>
            <p>
              The runbook covers operating procedures and recovery. The feature
              reference lists the deeper implementation map with file paths.
            </p>
            <div className="about-techspec-end-actions">
              <a
                className="about-link-pill"
                href={CHANGELOG_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                CHANGELOG.md
                <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
              </a>
              <a
                className="about-link-pill"
                href={FEATURE_REFERENCE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Feature reference
                <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
              </a>
              <a
                className="about-link-pill"
                href={RUNBOOK_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Runbook
                <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
              </a>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// CHANGELOG TAB — refined timeline (unchanged)
// ───────────────────────────────────────────────────────────────

type ChangelogEntry = {
  date: string;
  title: string;
  summary: string;
};

const CHANGELOG_ENTRIES: ReadonlyArray<ChangelogEntry> = [
  {
    date: "2026-07-10",
    title: "Wiz Code (SAST) scan intake",
    summary:
      "TRIAGE now ingests Wiz Code Analysis (SAST) exports as a distinct source. Header auto-detection routes every finding to Team A, groups code-fix stories by repo, module, and CWE under WIZ-CODE-SCAN labels, and pushes them into OneShot via PFOS, kept separate from the Wiz dependency-CVE (WIZ-SCAN) path.",
  },
  {
    date: "2026-06-21",
    title: "Accurate retrofit source evidence",
    summary:
      "OneShot 1.21.37 anchors explicit retrofit planning to deterministic source PR/commit evidence, carries the original touched files into child runs, and blocks semantic no-op fallbacks without proof.",
  },
  {
    date: "2026-06-21",
    title: "Branch-scoped active run key",
    summary:
      "OneShot 1.21.36 fixes multi-branch retrofit run creation by making active duplicate-run detection branch-aware while preserving same-ticket same-branch protection.",
  },
  {
    date: "2026-06-19",
    title: "Multi-branch retrofit fan-out",
    summary:
      "OneShot 1.21.35 lets QUALIFIER split one-repo retrofit tickets across up to seven target branches, records skipped overflow targets, and shows grouped retrofit runs as target-branch lanes.",
  },
  {
    date: "2026-06-16",
    title: "Canonical Jira Client extraction",
    summary:
      "OneShot 1.21.12 uses the Jira Assets Client field for blocked-client eligibility before legacy Customer fields and requests the Client asset label during Jira lookup.",
  },
  {
    date: "2026-06-16",
    title: "Blocked-client eligibility enforcement",
    summary:
      "OneShot 1.21.11 adds DB-backed blocked-client eligibility checks, trusted-operator management APIs, audit events, and fail-open intake behavior when the policy store is unavailable.",
  },
  {
    date: "2026-06-12",
    title: "QUALIFIER multi-repo decision policy",
    summary:
      "OneShot 1.21.7 teaches QUALIFIER to emit multi_repo when ticket requirements map cleanly to independently plannable repo-owned slices, including the ePA ingestion plus UI search pattern.",
  },
  {
    date: "2026-06-11",
    title: "Multi-repo delivery defaulted on",
    summary:
      "OneShot 1.21.3 enables multi-repo delivery by default for local and qualifier ECS runtime, with readiness guards, Ai-agents repository metadata fixes, and transient qualifier retry handling.",
  },
  {
    date: "2026-06-11",
    title: "Default-branch-first resolution",
    summary:
      "OneShot 1.21.2 now prefers each repository default branch before falling back, carries Jira FixVersion values into branch resolution, and records fallback warnings in qualification metadata.",
  },
  {
    date: "2026-06-11",
    title: "Qualification handoff recovery",
    summary:
      "OneShot 1.21.1 retries GitHub workflow-impact timeout and repo-cache lease handoff failures before planning, adds CLI recovery, and records retry or exhaustion evidence on the qualification timeline.",
  },
  {
    date: "2026-06-10",
    title: "Planning handoff failure attribution",
    summary:
      "OneShot 1.21.0 adds bounded qualification-to-planning auto-retry, explicit workspace setup and planning publish terminal states, and clearer Jira comments when operator recovery is required.",
  },
  {
    date: "2026-05-29",
    title: "TRACE and VERIFY planning evidence",
    summary:
      "OneShot 1.20.0 expands planning into PLAN -> TRACE -> VERIFY -> Plan Review, generating canonical TRACE test-case artifacts, reviewing them with VERIFY guardrails, and carrying TRACE Section C unit-test specs into Build.",
  },
  {
    date: "2026-05-27",
    title: "Automatic documentation artifact polling",
    summary:
      "Documentation child tasks labeled DOCS-GENERATE and one DOC-TYPE-* label are now picked up by the orchestrator label poller, attached back to Jira, and marked with terminal DOCS-* status labels.",
  },
  {
    date: "2026-05-27",
    title: "Artifact Runs tracking",
    summary:
      "Runs now separates pipeline runs from artifact runs so Wiz scan batches, SonarQube scan batches, and documentation generation can show source tickets, generated children, human review items, evidence counts, and Jira summaries without pretending to be six-stage implementation runs.",
  },
  {
    date: "2026-05-27",
    title: "Documentation Mode templates",
    summary:
      "The Guide now documents the DOCS-GENERATE label flow, canonical DOC-TYPE-* labels, Confluence-derived templates, Jira attachment output, evidence review, and dry-run review path for documentation-only child tasks.",
  },
  {
    date: "2026-05-27",
    title: "Wiz and SonarQube intake guidance",
    summary:
      "How-to now includes dedicated Wiz scan and SonarQube scan sections covering EPIC setup, scan export labels, TRIAGE approval labels, child story generation, OneShot execution, and human-review routing.",
  },
  {
    date: "2026-05-18",
    title: "Implementation-ready ticket guidance",
    summary:
      "How-to now clarifies that OneShot can add tests for known behavior, while epics, discovery, and requirement gathering need to be broken into implementation-ready tickets first.",
  },
  {
    date: "2026-05-18",
    title: "Statistics operational bottlenecks",
    summary:
      "Statistics now surfaces repo-level status, unresolved routing groups, stage clusters, pass rates, example tickets, and wasted-spend signals.",
  },
  {
    date: "2026-05-18",
    title: "Guide refresh and compatibility reference",
    summary:
      "The Guide now includes Analytics detail, copyable CPDEV and Retrofit templates, readiness guidance, profiled repo support, fact-checked operator limits, and a cleaner aligned timeline.",
  },
  {
    date: "2026-05-13",
    title: "Qualifier LLM owns routing",
    summary:
      "The qualifier now adjudicates routing decisions directly, with profiled-repo summaries and explicit repo directives as inputs.",
  },
  {
    date: "2026-05-12",
    title: "AI Statistics tab",
    summary:
      "New analytics view for token, cost, and stage counters across runs, ranges, and repos.",
  },
  {
    date: "2026-05-11",
    title: "Recognized non-MP repo routing",
    summary:
      "OneShot now routes recognized non-MP repos automatically and preserves dashboard ALB workstation ingress on non-prod.",
  },
  {
    date: "2026-05-11",
    title: "Description repo directives",
    summary:
      "Authors can place an explicit Repo: <name> directive in the ticket description; the resolver honors it before description-signal inference.",
  },
  {
    date: "2026-05-11",
    title: "Triage CVE deduplication",
    summary:
      "TRIAGE security stories now deduplicate CVE IDs in the description so OneShot does not double-count remediation scope.",
  },
  {
    date: "2026-04-30",
    title: "Hardened qualifier routing and stage budgets",
    summary:
      "Stage budgets, queue boundaries, and qualifier routing tightened to keep runs from drifting past the configured limits.",
  },
];

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthBucketKey(date: string): string {
  return date.slice(0, 7);
}

function monthBucketTitle(key: string): string {
  const [year, monthStr] = key.split("-");
  const monthIdx = Number.parseInt(monthStr, 10) - 1;
  const monthName = MONTH_LABELS[monthIdx] ?? monthStr;
  return `${monthName} ${year}`;
}

function ChangelogPage({
  wordmarkRef,
}: {
  wordmarkRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const displayVersion = ONESHOT_DISPLAY_VERSION.trim();
  const showVersion = displayVersion !== "" && displayVersion !== "1.0.0";

  const grouped = useMemo(() => {
    const map = new Map<string, ChangelogEntry[]>();
    for (const entry of CHANGELOG_ENTRIES) {
      const key = monthBucketKey(entry.date);
      const list = map.get(key) ?? [];
      list.push(entry);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => (a < b ? 1 : -1));
  }, []);

  return (
    <div className="about-changelog-page">
      <GuidePanelHero
        wordmarkRef={wordmarkRef}
        eyebrow="Changelog"
        title={
          <>
            Recent <em>shipping notes</em>.
          </>
        }
        titleId="about-changelog-title"
        copy="A practical record of what changed for operators. For infra, refactors, and dependency work, use the source links."
        actions={
          <>
            <a
              className="about-link-pill is-primary"
              href={CHANGELOG_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              CHANGELOG.md
              <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
            </a>
            <a
              className="about-link-pill"
              href={FEATURE_REFERENCE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Feature reference
              <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
            </a>
            {showVersion && (
              <span
                className="about-link-pill"
                style={{ pointerEvents: "none", color: "var(--accent-2)" }}
              >
                Version {displayVersion}
              </span>
            )}
            <span className="about-link-pill" style={{ pointerEvents: "none" }}>
              Updated {LAST_UPDATED_LABEL}
            </span>
          </>
        }
      />

      <div className="about-timeline">
        {grouped.map(([key, entries]) => {
          const title = monthBucketTitle(key);
          return (
            <div key={key} className="about-timeline-group">
              <div className="about-timeline-month">
                <strong>{title}</strong>
              </div>
              <div className="about-timeline-entries">
                {entries.map((entry) => (
                  <article
                    key={`${entry.date}-${entry.title}`}
                    className="about-timeline-entry"
                  >
                    <span className="about-timeline-date">{entry.date}</span>
                    <div className="about-timeline-entry-body">
                      <h3 className="about-timeline-title">{entry.title}</h3>
                      <p className="about-timeline-summary">{entry.summary}</p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Entry component
// ───────────────────────────────────────────────────────────────

export function About({
  panel = "features",
  wordmarkDestRef,
  onPanelChange,
  onExit,
}: {
  panel?: AboutPanel;
  wordmarkDestRef?: RefObject<HTMLHeadingElement | null>;
  onPanelChange?: (panel: AboutPanel) => void;
  onExit?: () => void;
} = {}) {
  return (
    <div className="view about-view">
      <style>{KEYFRAMES}</style>
      <ProductLocalNav
        panel={panel}
        onPanelChange={onPanelChange}
        onExit={onExit}
      />
      <div className={`about-stack${panel === "tech-spec" ? " is-specs" : ""}`}>
        {panel === "tech-spec" ? (
          <TechSpecPage wordmarkRef={wordmarkDestRef} />
        ) : panel === "changelog" ? (
          <ChangelogPage wordmarkRef={wordmarkDestRef} />
        ) : panel === "how-to" ? (
          <HowToPage
            wordmarkRef={wordmarkDestRef}
            onPanelChange={onPanelChange}
          />
        ) : (
          <FeaturesPage
            wordmarkRef={wordmarkDestRef}
            onPanelChange={onPanelChange}
          />
        )}
      </div>
    </div>
  );
}
