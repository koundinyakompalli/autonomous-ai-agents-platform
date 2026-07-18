import type mysql from "mysql2/promise";
import { getPool } from "../db.js";

type ProductFactory =
  | "OneShot"
  | "Production Support"
  | "Spec Factory"
  | "Platform";

type ProductStatus =
  | "production_ready"
  | "needs_configuration"
  | "preview"
  | "upcoming";

type ProductDomain =
  | "Feature Delivery"
  | "Jira Automation"
  | "Deployment"
  | "Repository Intelligence"
  | "Dashboard"
  | "Support Operations";

type ProductShelfKey =
  | "top_picks"
  | "trending"
  | "recently_added"
  | "production_ready"
  | "needs_configuration"
  | "repository_catalog"
  | "oneshot_tickets"
  | "oneshot_epics"
  | "oneshot"
  | "production_support"
  | "platform"
  | "spec_factory"
  | `repo:${string}`;

type ProductContentType = "feature" | "fix" | "integration" | "epic";

type ProductDeploymentActionKind = "jenkins" | "github" | "preview";

interface ProductEvidenceLink {
  label: string;
  href: string;
  kind: "doc" | "jira" | "github" | "runbook" | "dashboard";
}

interface ProductDeploymentAction {
  label: string;
  href: string;
  kind: ProductDeploymentActionKind;
}

interface ProductCatalogTicket {
  key: string;
  source: "oneshot" | "router" | "task";
  state?: string;
  branch?: string;
  prUrl?: string | null;
  updatedAt?: string | null;
}

interface ProductCatalogItem {
  id: string;
  name: string;
  tagline: string;
  description: string;
  factory: ProductFactory;
  status: ProductStatus;
  domains: ProductDomain[];
  shelves: ProductShelfKey[];
  supportedVersions: string[];
  configuration: string[];
  deploymentSteps: string[];
  deploymentActions?: ProductDeploymentAction[];
  dependencies: string[];
  evidenceLinks: ProductEvidenceLink[];
  knownLimitations: string[];
  storyDescription?: string;
  supportInsight?: {
    defectDescription?: string;
    rootCause?: string;
  };
  lastUpdated: string;
  repository?: {
    id: number;
    name: string;
    url: string;
    defaultBranch: string;
  };
  metrics?: {
    oneshotRuns?: number;
    recentOneshotRuns?: number;
    linkedTicketCount?: number;
    candidateVersions?: number;
    routerDecisions?: number;
    recentRouterDecisions?: number;
    taskCount?: number;
    customerBranchCount?: number;
  };
  recentTickets?: ProductCatalogTicket[];
  contentType?: ProductContentType;
  contentGroup?: {
    id: string;
    label: string;
    ticketCount: number;
  };
  accent: {
    primary: string;
    secondary: string;
    image: string;
  };
  featured?: boolean;
}

export interface RepositoryActivityRow {
  id: number;
  repoName: string;
  repoUrl: string;
  description: string | null;
  defaultBranch: string;
  createdAt: Date | string | null;
  oneshotRuns: number | string;
  recentOneshotRuns: number | string;
  latestRunUpdatedAt: Date | string | null;
  candidateVersions: number | string;
  latestCandidateAt: Date | string | null;
  routerDecisions: number | string;
  recentRouterDecisions: number | string;
}

export interface RecentRunRow {
  id: number;
  runGroupId: number | string | null;
  repoId: number;
  jiraKey: string;
  state: string;
  branchName: string | null;
  implementationBranch: string | null;
  prUrl: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  repoName?: string | null;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  customerName?: string | null;
  planVersion?: number | string | null;
  implementationVersion?: number | string | null;
  codeReviewVersion?: number | string | null;
  testVersion?: number | string | null;
  taskDescription?: string | null;
  indexedText?: string | null;
}

export interface RunGroupRow {
  id: number;
  jiraKey: string;
  status: string;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

export interface CandidateVersionRow {
  repoId: number;
  oneshotRunId: number;
  jiraKey: string;
  candidateVersion: number | string;
  status: string;
  candidateSha: string;
  createdAt: Date | string | null;
}

export interface RouterTicketRow {
  repoId: number;
  ticketId: string;
  outcome: string;
  decidedAt: Date | string | null;
}

export interface CustomerBranchRow {
  customer: string | null;
  branch: string | null;
  isDefault: boolean | number | null;
}

export interface TaskCountRow {
  taskType: string;
  status: string;
  count: number | string;
  latestUpdate: Date | string | null;
}

export interface RecentTaskRow {
  id: number;
  jiraNumber: string;
  status: string;
  taskType: string | null;
  source: string;
  agentName: string | null;
  customer: string | null;
  updatedAt: Date | string | null;
  jiraPostedAt: Date | string | null;
  taskDescription?: string | null;
}

export interface ProductCatalogBuildInput {
  generatedAt: Date;
  repositories: RepositoryActivityRow[];
  runGroups: RunGroupRow[];
  recentRuns: RecentRunRow[];
  candidateVersions: CandidateVersionRow[];
  routerTickets: RouterTicketRow[];
  customerBranches: CustomerBranchRow[];
  taskCounts: TaskCountRow[];
  recentTasks: RecentTaskRow[];
}

export interface ProductCatalogResponse {
  generatedAt: string;
  summary: {
    repositoryCount: number;
    customerBranchCount: number;
    recentTicketCount: number;
    oneshotRunCount: number;
    successfulOutcomeCount: number;
    ticketOutcomeCount: number;
    epicOutcomeCount: number;
    taskCount: number;
  };
  products: ProductCatalogItem[];
}

const ACCENTS = [
  ["#e50914", "#450a0a", "linear-gradient(135deg, #120507 0%, #7f1d1d 48%, #050505 100%)"],
  ["#f97316", "#431407", "linear-gradient(135deg, #170a04 0%, #9a3412 48%, #050505 100%)"],
  ["#14b8a6", "#042f2e", "linear-gradient(135deg, #031b1a 0%, #0f766e 48%, #050505 100%)"],
  ["#38bdf8", "#082f49", "linear-gradient(135deg, #020617 0%, #075985 52%, #050505 100%)"],
  ["#a3e635", "#1a2e05", "linear-gradient(135deg, #0a1403 0%, #365314 48%, #050505 100%)"],
  ["#facc15", "#422006", "linear-gradient(135deg, #171204 0%, #854d0e 48%, #050505 100%)"],
] as const;

const JENKINS_BUILD_DEPLOY_URL =
  "https://dev.medhokapps.com/hudson/job/git-master-core-build/";
const CORE_PREVIEW_URL =
  "https://devaccountqa.mhkdevsandbox.com/cas/login?service=https%3A%2F%2Fclient-a-cp-dev-mhk-core.mhkdevsandbox.com%2Fmedhok%2F";

function toCount(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateOnly(value: Date | string | null | undefined): string {
  return toIsoString(value)?.slice(0, 10) ?? new Date(0).toISOString().slice(0, 10);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function accentFor(seed: number): ProductCatalogItem["accent"] {
  const [primary, secondary, image] = ACCENTS[Math.abs(seed) % ACCENTS.length];
  return { primary, secondary, image };
}

function groupByRepo<T extends { repoId: number }>(rows: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    grouped.set(row.repoId, [...(grouped.get(row.repoId) ?? []), row]);
  }
  return grouped;
}

function uniqueStrings(values: Array<string | null | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function recentTicketKey(ticket: ProductCatalogTicket): string {
  return `${ticket.source}:${ticket.key}`;
}

function mergeTickets(tickets: ProductCatalogTicket[], limit: number): ProductCatalogTicket[] {
  const seen = new Set<string>();
  const result: ProductCatalogTicket[] = [];
  for (const ticket of tickets) {
    const key = recentTicketKey(ticket);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ticket);
    if (result.length >= limit) break;
  }
  return result;
}

function runGroupKey(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSuccessfulOneShotRun(run: RecentRunRow): boolean {
  return run.state !== "failed" && Boolean(run.prUrl?.trim());
}

function runUpdatedTime(run: RecentRunRow): number {
  const updatedAt = toIsoString(run.updatedAt);
  if (updatedAt) return Date.parse(updatedAt);
  const createdAt = toIsoString(run.createdAt);
  return createdAt ? Date.parse(createdAt) : 0;
}

function versionLabel(label: string, value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return `${label} v${value}`;
}

function repositoryMetaForRun(
  run: RecentRunRow,
  repositoriesById: Map<number, RepositoryActivityRow>,
) {
  const repo = repositoriesById.get(run.repoId);
  const name = run.repoName ?? repo?.repoName ?? `Repository #${run.repoId}`;
  const url = run.repoUrl ?? repo?.repoUrl ?? "";
  const defaultBranch = run.defaultBranch ?? repo?.defaultBranch ?? run.branchName ?? "";
  return {
    id: run.repoId,
    name,
    url,
    defaultBranch,
    slug: slugify(name) || `repo-${run.repoId}`,
  };
}

function runTicket(run: RecentRunRow): ProductCatalogTicket {
  return {
    key: run.jiraKey,
    source: "oneshot",
    state: run.state,
    branch: run.branchName ?? undefined,
    prUrl: run.prUrl,
    updatedAt: toIsoString(run.updatedAt),
  };
}

function runSupportedVersions(run: RecentRunRow): string[] {
  return uniqueStrings(
    [
      run.branchName ? `Target branch: ${run.branchName}` : null,
      run.implementationBranch
        ? `Implementation branch: ${run.implementationBranch}`
        : null,
      versionLabel("Plan", run.planVersion),
      versionLabel("Implementation", run.implementationVersion),
      versionLabel("Code review", run.codeReviewVersion),
      versionLabel("Test", run.testVersion),
    ],
    8,
  );
}

const STORY_SECTION_HEADINGS = [
  "executive summary",
  "summary",
  "overview",
  "description",
  "problem statement",
];

function normalizedHeading(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();
}

function findStorySection(text: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const startIndex = lines.findIndex((line) =>
    STORY_SECTION_HEADINGS.includes(normalizedHeading(line)),
  );
  if (startIndex === -1) return null;

  const collected: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    const heading = normalizedHeading(line);
    if (heading && line.trim().match(/^#{1,6}\s+/)) break;
    if (heading && STORY_SECTION_HEADINGS.includes(heading)) break;
    collected.push(line);
  }

  return collected.join("\n");
}

function cleanStoryText(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .split(/\n+/)
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s*/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .replace(/^>\s*/, "")
        .replace(/\*\*/g, "")
        .replace(/\*/g, ""),
    )
    .filter((line) => line && !/^-{3,}$/.test(line))
    .join(" ")
    .replace(/^(?:executive summary|summary|overview|description|problem statement)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateStory(text: string, maxLength = 720): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength + 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, lastSpace > 480 ? lastSpace : maxLength).trim()}...`;
}

function extractStoryDescription(run: RecentRunRow): string | undefined {
  const source = run.taskDescription?.trim() || run.indexedText?.trim();
  if (!source) return undefined;

  const section = findStorySection(source) ?? source;
  const cleaned = cleanStoryText(section);
  return cleaned ? truncateStory(cleaned) : undefined;
}

function hasAnySignal(signal: string, terms: string[]): boolean {
  return terms.some((term) => signal.includes(term));
}

function ticketContentTypeLabel(contentType: ProductContentType): string {
  if (contentType === "integration") return "Integration";
  if (contentType === "fix") return "Fix";
  if (contentType === "epic") return "Epic";
  return "Feature";
}

function inferTicketContentType(
  run: RecentRunRow,
  repo: ReturnType<typeof repositoryMetaForRun>,
): ProductContentType {
  const signal = [
    run.jiraKey,
    run.branchName,
    run.implementationBranch,
    repo.name,
    repo.defaultBranch,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  if (hasAnySignal(signal, ["hotfix", "bugfix", "defect", "bug", "patch", "fix"])) {
    return "fix";
  }
  if (
    hasAnySignal(signal, [
      "integration",
      "interop",
      "interface",
      "connector",
      "hl7",
      "edi",
      "sftp",
    ])
  ) {
    return "integration";
  }
  return "feature";
}

function buildOutcomeDeploymentActions(
  prUrl: string | null | undefined,
  githubLabel: string,
): ProductDeploymentAction[] {
  return [
    {
      label: "Build and deploy",
      href: JENKINS_BUILD_DEPLOY_URL,
      kind: "jenkins",
    },
    ...(prUrl
      ? [
          {
            label: githubLabel,
            href: prUrl,
            kind: "github" as const,
          },
        ]
      : []),
    {
      label: "Preview",
      href: CORE_PREVIEW_URL,
      kind: "preview",
    },
  ];
}

function activityScore(repo: RepositoryActivityRow): number {
  return (
    toCount(repo.recentOneshotRuns) * 1000 +
    toCount(repo.recentRouterDecisions) * 25 +
    toCount(repo.oneshotRuns) * 10 +
    toCount(repo.candidateVersions)
  );
}

function isRecentlyTouched(repo: RepositoryActivityRow): boolean {
  return Boolean(repo.latestRunUpdatedAt || repo.latestCandidateAt);
}

function buildRepositoryProduct(
  repo: RepositoryActivityRow,
  topRepoIds: Set<number>,
  recentRuns: RecentRunRow[],
  candidates: CandidateVersionRow[],
  routerTickets: RouterTicketRow[],
): ProductCatalogItem {
  const repoSlug = slugify(repo.repoName);
  const recentRunTickets = recentRuns.map((run) => ({
    key: run.jiraKey,
    source: "oneshot" as const,
    state: run.state,
    branch: run.branchName ?? undefined,
    prUrl: run.prUrl,
    updatedAt: toIsoString(run.updatedAt),
  }));
  const recentRouterTickets = routerTickets.map((ticket) => ({
    key: ticket.ticketId,
    source: "router" as const,
    state: ticket.outcome,
    updatedAt: toIsoString(ticket.decidedAt),
  }));
  const tickets = mergeTickets([...recentRunTickets, ...recentRouterTickets], 8);
  const runBranches = uniqueStrings(recentRuns.map((run) => run.branchName), 5);
  const implementationBranches = uniqueStrings(
    recentRuns.map((run) => run.implementationBranch),
    3,
  );
  const candidateLabels = candidates.slice(0, 3).map((candidate) => {
    const version = toCount(candidate.candidateVersion);
    return `Candidate v${version}: ${candidate.status} ${candidate.candidateSha}`;
  });
  const supportedVersions = uniqueStrings(
    [
      `Default branch: ${repo.defaultBranch}`,
      ...runBranches.map((branch) => `Run branch: ${branch}`),
      ...candidateLabels,
    ],
    8,
  );
  const hasOneShotActivity = toCount(repo.oneshotRuns) > 0;
  const hasRouterActivity = toCount(repo.routerDecisions) > 0;
  const status: ProductStatus = hasOneShotActivity
    ? "production_ready"
    : hasRouterActivity
      ? "needs_configuration"
      : "preview";
  const shelves: ProductShelfKey[] = [
    "repository_catalog",
    `repo:${repoSlug}`,
    "oneshot",
  ];
  if (status === "production_ready" || status === "needs_configuration") {
    shelves.push(status);
  }
  if (topRepoIds.has(repo.id)) shelves.push("top_picks");
  if (toCount(repo.recentOneshotRuns) > 0 || toCount(repo.recentRouterDecisions) > 0) {
    shelves.push("trending");
  }
  if (isRecentlyTouched(repo)) shelves.push("recently_added");

  const recentRunCount = toCount(repo.recentOneshotRuns);
  const tagline = recentRunCount > 0
    ? `${recentRunCount} recent OneShot runs on ${repo.defaultBranch} and customer branches.`
    : hasRouterActivity
      ? `${toCount(repo.recentRouterDecisions)} recent router decisions; ready for qualification.`
      : `Registered repository profile on ${repo.defaultBranch}.`;

  return {
    id: `repo-${repo.id}-${repoSlug}`,
    name: repo.repoName,
    tagline,
    description:
      repo.description ??
      `Repository profile for ${repo.repoName}, defaulting to ${repo.defaultBranch}.`,
    factory: "OneShot",
    status,
    domains: ["Repository Intelligence", "Feature Delivery"],
    shelves,
    supportedVersions,
    configuration: [
      `Repository profile #${repo.id}`,
      `Default branch: ${repo.defaultBranch}`,
      `${toCount(repo.routerDecisions)} router decisions`,
      `${toCount(repo.oneshotRuns)} OneShot runs`,
      ...implementationBranches.map((branch) => `Implementation branch: ${branch}`),
    ],
    deploymentSteps: [
      "Route ticket to repository",
      "Create or qualify OneShot run",
      "Build implementation branch",
      "Publish PR and Jira evidence",
    ],
    dependencies: ["code_repositories", "router_decisions", "oneshot_runs"],
    evidenceLinks: [
      { label: "GitHub repository", href: repo.repoUrl, kind: "github" },
      ...tickets
        .filter((ticket) => ticket.prUrl)
        .slice(0, 2)
        .map((ticket) => ({
          label: `${ticket.key} PR`,
          href: ticket.prUrl!,
          kind: "github" as const,
        })),
    ],
    knownLimitations: hasOneShotActivity
      ? ["Build and test coverage remains repository-profile specific."]
      : ["No completed OneShot run is recorded for this repository yet."],
    lastUpdated: dateOnly(repo.latestRunUpdatedAt ?? repo.latestCandidateAt ?? repo.createdAt),
    repository: {
      id: repo.id,
      name: repo.repoName,
      url: repo.repoUrl,
      defaultBranch: repo.defaultBranch,
    },
    metrics: {
      oneshotRuns: toCount(repo.oneshotRuns),
      recentOneshotRuns: toCount(repo.recentOneshotRuns),
      candidateVersions: toCount(repo.candidateVersions),
      routerDecisions: toCount(repo.routerDecisions),
      recentRouterDecisions: toCount(repo.recentRouterDecisions),
    },
    recentTickets: tickets,
    accent: accentFor(repo.id),
  };
}

function buildOneShotTicketProduct(
  run: RecentRunRow,
  repositoriesById: Map<number, RepositoryActivityRow>,
): ProductCatalogItem {
  const repo = repositoryMetaForRun(run, repositoriesById);
  const ticket = runTicket(run);
  const contentType = inferTicketContentType(run, repo);
  const contentTypeName = ticketContentTypeLabel(contentType);
  const storyDescription = extractStoryDescription(run);
  const fallbackDescription =
    `Successful OneShot ticket outcome for ${run.jiraKey}. This tile represents the generated PR and the configuration needed to reproduce or deploy the work.`;
  return {
    id: `oneshot-ticket-${run.id}-${slugify(run.jiraKey)}`,
    name: run.jiraKey,
    tagline: `${contentTypeName} - ${repo.name} on ${run.branchName ?? repo.defaultBranch}.`,
    description: storyDescription ?? fallbackDescription,
    factory: "OneShot",
    status: "production_ready",
    domains: ["Feature Delivery", "Repository Intelligence"],
    shelves: [
      "oneshot_tickets",
      "oneshot",
      "production_ready",
      "trending",
      "recently_added",
      `repo:${repo.slug}`,
    ],
    supportedVersions: runSupportedVersions(run),
    configuration: uniqueStrings(
      [
        `OneShot run #${run.id}`,
        `Repository profile #${run.repoId}`,
        run.customerName ? `Customer: ${run.customerName}` : null,
        run.prUrl ? "PR opened successfully" : null,
      ],
      8,
    ),
    deploymentSteps: [
      "Open the generated PR",
      "Review implementation branch and CI evidence",
      "Merge through the repository workflow",
      "Deploy using the target repository release path",
    ],
    deploymentActions: buildOutcomeDeploymentActions(run.prUrl, "View PR"),
    dependencies: ["oneshot_runs", "code_repositories", "GitHub PR"],
    evidenceLinks: [
      { label: "OneShot run", href: `/oneshot?view=runs&run=run-${run.id}`, kind: "dashboard" },
      ...(run.prUrl
        ? [{ label: `${run.jiraKey} PR`, href: run.prUrl, kind: "github" as const }]
        : []),
    ],
    knownLimitations: [
      "The tile tracks the PR-producing OneShot outcome; merge and deployment status remain in GitHub and downstream release systems.",
    ],
    storyDescription,
    lastUpdated: dateOnly(run.updatedAt ?? run.createdAt),
    repository: {
      id: repo.id,
      name: repo.name,
      url: repo.url,
      defaultBranch: repo.defaultBranch,
    },
    metrics: {
      oneshotRuns: 1,
      recentOneshotRuns: 1,
    },
    recentTickets: [ticket],
    contentType,
    accent: accentFor(run.id + 17),
  };
}

function buildOneShotEpicProduct(
  runGroupId: number,
  runs: RecentRunRow[],
  runGroup: RunGroupRow | undefined,
  repositoriesById: Map<number, RepositoryActivityRow>,
): ProductCatalogItem {
  const sortedRuns = [...runs].sort((left, right) => runUpdatedTime(right) - runUpdatedTime(left));
  const repoMetas = sortedRuns.map((run) => repositoryMetaForRun(run, repositoriesById));
  const reposById = new Map(repoMetas.map((repo) => [repo.id, repo]));
  const repoList = [...reposById.values()];
  const groupLabel = runGroup?.jiraKey ?? `OneShot Epic #${runGroupId}`;
  const firstRun = sortedRuns[0];
  const repoShelves = repoList.map((repo) => `repo:${repo.slug}` as ProductShelfKey);
  const supportedVersions = uniqueStrings(
    [
      ...sortedRuns.map((run) => (run.branchName ? `Target branch: ${run.branchName}` : null)),
      ...sortedRuns.map((run) =>
        run.implementationBranch ? `Implementation branch: ${run.implementationBranch}` : null,
      ),
      ...sortedRuns.flatMap((run) => [
        versionLabel("Plan", run.planVersion),
        versionLabel("Implementation", run.implementationVersion),
        versionLabel("Code review", run.codeReviewVersion),
        versionLabel("Test", run.testVersion),
      ]),
    ],
    10,
  );
  const repository = repoList.length === 1 ? repoList[0] : null;
  const repoNames = repoList.map((repo) => repo.name).join(", ");
  const latestPrUrl = sortedRuns.find((run) => run.prUrl)?.prUrl;

  return {
    id: `oneshot-epic-${runGroupId}-${slugify(groupLabel)}`,
    name: groupLabel,
    tagline: `${sortedRuns.length} successful tickets across ${repoList.length} ${repoList.length === 1 ? "repository" : "repositories"}.`,
    description:
      `Epic-level OneShot outcome for ${groupLabel}. Each linked ticket is a successful PR-producing delivery generated by OneShot.`,
    factory: "OneShot",
    status: "production_ready",
    domains: ["Feature Delivery", "Repository Intelligence"],
    shelves: [
      "oneshot_epics",
      "oneshot",
      "production_ready",
      "top_picks",
      "trending",
      "recently_added",
      ...repoShelves,
    ],
    supportedVersions,
    configuration: uniqueStrings(
      [
        `OneShot run group #${runGroupId}`,
        `Epic: ${groupLabel}`,
        `${sortedRuns.length} successful tickets`,
        repoNames ? `Repositories: ${repoNames}` : null,
        runGroup?.status ? `Group status: ${runGroup.status}` : null,
      ],
      8,
    ),
    deploymentSteps: [
      "Open each generated ticket PR",
      "Review sequencing and cross-ticket dependencies",
      "Merge ticket PRs through the repository workflows",
      "Deploy the epic as a coordinated release when all required tickets are merged",
    ],
    deploymentActions: buildOutcomeDeploymentActions(latestPrUrl, "View latest PR"),
    dependencies: ["oneshot_run_groups", "oneshot_runs", "code_repositories", "GitHub PR"],
    evidenceLinks: [
      { label: "OneShot dashboard", href: "/oneshot?view=runs", kind: "dashboard" },
      ...sortedRuns
        .filter((run) => run.prUrl)
        .slice(0, 4)
        .map((run) => ({
          label: `${run.jiraKey} PR`,
          href: run.prUrl!,
          kind: "github" as const,
        })),
    ],
    knownLimitations: [
      "Epic tiles are based on successful ticket PRs in the sampled OneShot run data; downstream merge and release state remain repository-owned.",
    ],
    lastUpdated: dateOnly(firstRun?.updatedAt ?? runGroup?.updatedAt ?? runGroup?.createdAt),
    repository: repository
      ? {
          id: repository.id,
          name: repository.name,
          url: repository.url,
          defaultBranch: repository.defaultBranch,
        }
      : undefined,
    metrics: {
      oneshotRuns: sortedRuns.length,
      recentOneshotRuns: sortedRuns.length,
      linkedTicketCount: sortedRuns.length,
    },
    recentTickets: sortedRuns.map(runTicket),
    contentType: "epic",
    contentGroup: {
      id: String(runGroupId),
      label: groupLabel,
      ticketCount: sortedRuns.length,
    },
    accent: accentFor(runGroupId + 29),
    featured: sortedRuns.length > 1,
  };
}

function buildOneShotOutcomeProducts(input: ProductCatalogBuildInput): ProductCatalogItem[] {
  const repositoriesById = new Map(input.repositories.map((repo) => [repo.id, repo]));
  return input.recentRuns
    .filter(isSuccessfulOneShotRun)
    .sort((left, right) => runUpdatedTime(right) - runUpdatedTime(left))
    .map((run, index) => {
      const product = buildOneShotTicketProduct(run, repositoriesById);
      const topPickShelves =
        index < 10 && !product.shelves.includes("top_picks")
          ? (["top_picks", ...product.shelves] as ProductShelfKey[])
          : product.shelves;
      return {
        ...product,
        shelves: topPickShelves,
        featured: index === 0,
      };
    });
}

function supportTaskStatus(status: string): ProductStatus {
  const normalized = status.trim().toLowerCase();
  if (normalized === "posted_to_jira" || normalized === "completed") {
    return "production_ready";
  }
  if (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("cancel")
  ) {
    return "needs_configuration";
  }
  return "preview";
}

function isCompletedSupportTask(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "posted_to_jira" || normalized === "completed";
}

function supportStatusLabel(status: string): string {
  return status
    .trim()
    .replace(/_/g, " ")
    .replace(/\bjira\b/i, "Jira");
}

function cleanMarkdownSummary(text: string, maxLength = 700): string | null {
  const cleaned = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter((line) => line && line !== "---")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}...`;
}

function extractMarkdownSection(markdown: string, headings: RegExp[]): string | null {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]?.match(/^#{2,6}\s+(.+?)\s*$/);
    if (heading && headings.some((pattern) => pattern.test(heading[1]))) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) return null;

  const sectionLines: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    if (/^#{2,6}\s+/.test(lines[index] ?? "")) break;
    sectionLines.push(lines[index] ?? "");
  }
  return cleanMarkdownSummary(sectionLines.join("\n"));
}

function extractRootCauseSentence(markdown: string): string | null {
  const executiveSummary =
    extractMarkdownSection(markdown, [/executive summary/i]) ?? markdown;
  const cleaned = cleanMarkdownSummary(executiveSummary, 1200);
  return findRootCauseSentence(cleaned);
}

function findRootCauseSentence(text: string | null): string | null {
  const cleaned = text?.trim();
  if (!cleaned) return null;

  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) ?? [cleaned];
  const rootCauseSentenceIndex = sentences.findIndex((sentence) =>
    /\b(root cause|caused by|due to|because|identified(?:\s+\w+){0,3}\s+as|tied to|stemming from)\b/i.test(sentence),
  );
  if (rootCauseSentenceIndex === -1) return null;

  const rootCauseSentence = sentences[rootCauseSentenceIndex]?.trim();
  if (rootCauseSentence && /\b\d+\.$/.test(rootCauseSentence)) {
    return `${rootCauseSentence}${sentences[rootCauseSentenceIndex + 1] ?? ""}`.trim();
  }
  return rootCauseSentence ?? null;
}

function buildSupportInsight(
  taskDescription: string | null | undefined,
): ProductCatalogItem["supportInsight"] | undefined {
  if (!taskDescription?.trim()) return undefined;

  const defectDescription =
    extractMarkdownSection(taskDescription, [
      /problem statement/i,
      /issue description/i,
      /original report/i,
    ]) ??
    extractMarkdownSection(taskDescription, [/executive summary/i]) ??
    cleanMarkdownSummary(taskDescription);
  const rootCauseSection = extractMarkdownSection(taskDescription, [
    /root cause/i,
    /technical analysis/i,
    /analysis summary/i,
  ]);
  const rootCause =
    extractRootCauseSentence(taskDescription) ??
    findRootCauseSentence(rootCauseSection) ??
    rootCauseSection;

  if (!defectDescription && !rootCause) return undefined;
  return {
    ...(defectDescription ? { defectDescription } : {}),
    ...(rootCause ? { rootCause } : {}),
  };
}

function buildProductionSupportStoryProduct(task: RecentTaskRow): ProductCatalogItem {
  const agentName = task.agentName?.trim() || "Production Support";
  const taskType = task.taskType?.trim() || "Support task";
  const statusLabel = supportStatusLabel(task.status);
  const status = supportTaskStatus(task.status);
  const supportInsight = buildSupportInsight(task.taskDescription);
  const statusShelf: ProductShelfKey | null =
    status === "production_ready" || status === "needs_configuration"
      ? status
      : null;
  const shelves: ProductShelfKey[] = statusShelf
    ? ["production_support", "recently_added", statusShelf]
    : ["production_support", "recently_added"];
  const customer = task.customer?.trim();
  return {
    id: `production-support-task-${task.id}-${slugify(task.jiraNumber)}`,
    name: task.jiraNumber,
    tagline: `${agentName} - ${statusLabel}`,
    description:
      `${task.jiraNumber} is a Production Support task handled by ${agentName}. Current status is ${statusLabel}.`,
    factory: "Production Support",
    status,
    domains: ["Support Operations", "Jira Automation"],
    shelves,
    supportedVersions: uniqueStrings(
      [
        `Agent: ${agentName}`,
        `Task type: ${taskType}`,
        customer ? `Customer: ${customer}` : null,
        `Status: ${statusLabel}`,
      ],
      6,
    ),
    configuration: uniqueStrings(
      [
        `Task management row #${task.id}`,
        `Source: ${task.source}`,
        `Jira ticket: ${task.jiraNumber}`,
        task.jiraPostedAt ? `Posted to Jira: ${dateOnly(task.jiraPostedAt)}` : null,
      ],
      6,
    ),
    deploymentSteps: [
      "Open the Jira ticket",
      "Review the Production Support output",
      "Confirm the posted Jira note or pending handoff",
    ],
    dependencies: ["agents", "task_management", "tasks", "Jira API"],
    evidenceLinks: [
      {
        label: task.jiraNumber,
        href: `https://mhkjira.atlassian.net/browse/${task.jiraNumber}`,
        kind: "jira",
      },
      {
        label: "Production Support dashboard",
        href: "/production-support",
        kind: "dashboard",
      },
    ],
    knownLimitations: [
      "Production Support stories reflect the latest completed task_management activity.",
    ],
    ...(supportInsight ? { supportInsight } : {}),
    lastUpdated: dateOnly(task.updatedAt ?? task.jiraPostedAt),
    metrics: { taskCount: 1 },
    recentTickets: [
      {
        key: task.jiraNumber,
        source: "task",
        state: task.status,
        branch: customer ?? undefined,
        updatedAt: toIsoString(task.updatedAt),
      },
    ],
    accent: accentFor(task.id + 41),
  };
}

function buildProductionSupportStoryProducts(
  input: ProductCatalogBuildInput,
): ProductCatalogItem[] {
  return input.recentTasks
    .filter((task) => task.jiraNumber?.trim() && isCompletedSupportTask(task.status))
    .slice(0, 24)
    .map(buildProductionSupportStoryProduct);
}

function buildLiveOneShotProduct(input: ProductCatalogBuildInput): ProductCatalogItem {
  const totalRuns = input.repositories.reduce((sum, repo) => sum + toCount(repo.oneshotRuns), 0);
  const recentRuns = input.repositories.reduce(
    (sum, repo) => sum + toCount(repo.recentOneshotRuns),
    0,
  );
  const recentTickets = mergeTickets(
    input.recentRuns.map((run) => ({
      key: run.jiraKey,
      source: "oneshot" as const,
      state: run.state,
      branch: run.branchName ?? undefined,
      prUrl: run.prUrl,
      updatedAt: toIsoString(run.updatedAt),
    })),
    10,
  );
  const branches = uniqueStrings(input.recentRuns.map((run) => run.branchName), 8);
  const implementationBranches = uniqueStrings(
    input.recentRuns.map((run) => run.implementationBranch),
    4,
  );
  return {
    id: "live-oneshot-delivery",
    name: "Live OneShot Delivery",
    tagline: `${recentRuns} recent runs across ${input.repositories.length} repositories.`,
    description:
      "RDS-backed view of active OneShot delivery surfaces, implementation branches, candidate versions, and recent PR-producing tickets.",
    factory: "OneShot",
    status: totalRuns > 0 ? "production_ready" : "needs_configuration",
    domains: ["Feature Delivery", "Dashboard"],
    shelves: ["top_picks", "trending", "recently_added", "oneshot"],
    supportedVersions: branches.map((branch) => `Observed branch: ${branch}`),
    configuration: [
      `${input.repositories.length} repository profiles`,
      `${totalRuns} OneShot runs`,
      `${input.candidateVersions.length} candidate versions sampled`,
      ...implementationBranches.map((branch) => `Recent implementation branch: ${branch}`),
    ],
    deploymentSteps: [
      "Qualify ticket",
      "Select repository and branch",
      "Create candidate implementation",
      "Open PR and post Jira evidence",
    ],
    dependencies: ["oneshot_runs", "oneshot_candidate_versions", "oneshot_run_events"],
    evidenceLinks: [{ label: "OneShot dashboard", href: "/oneshot", kind: "dashboard" }],
    knownLimitations: ["Trend counts are derived from the latest bounded RDS sample."],
    lastUpdated: dateOnly(input.recentRuns[0]?.updatedAt ?? input.generatedAt),
    metrics: {
      oneshotRuns: totalRuns,
      recentOneshotRuns: recentRuns,
      candidateVersions: input.candidateVersions.length,
    },
    recentTickets,
    accent: {
      primary: "#e50914",
      secondary: "#450a0a",
      image: "linear-gradient(135deg, #090505 0%, #b91c1c 44%, #050505 100%)",
    },
    featured: true,
  };
}

function buildSupportProduct(input: ProductCatalogBuildInput): ProductCatalogItem {
  const totalTasks = input.taskCounts.reduce((sum, row) => sum + toCount(row.count), 0);
  const topTaskLines = input.taskCounts
    .slice(0, 8)
    .map((row) => `${row.taskType}: ${toCount(row.count)} ${row.status}`);
  const recentTickets = mergeTickets(
    input.recentTasks.map((task) => ({
      key: task.jiraNumber,
      source: "task" as const,
      state: task.status,
      branch: task.customer ?? undefined,
      updatedAt: toIsoString(task.updatedAt),
    })),
    10,
  );
  return {
    id: "support-agent-throughput",
    name: "Support Agent Throughput",
    tagline: `${totalTasks} task rows across DARCI, HERMES, RIFT, and support agents.`,
    description:
      "Live production-support catalog tile built from task_management and tasks, showing current Jira posting and agent throughput signals.",
    factory: "Production Support",
    status: "production_ready",
    domains: ["Support Operations", "Jira Automation"],
    shelves: ["top_picks", "trending", "recently_added", "production_support", "production_ready"],
    supportedVersions: topTaskLines,
    configuration: [
      "Agent registry rows",
      "Task management status",
      "Jira posting timestamp",
      "Result S3 pointers",
    ],
    deploymentSteps: [
      "Pick Jira ticket",
      "Create task row",
      "Run assigned agent",
      "Post result to Jira",
    ],
    dependencies: ["agents", "task_management", "tasks"],
    evidenceLinks: [
      { label: "Production Support dashboard", href: "/production-support", kind: "dashboard" },
    ],
    knownLimitations: ["Task counts include historical rows and should be read as operational signal."],
    lastUpdated: dateOnly(input.recentTasks[0]?.updatedAt ?? input.generatedAt),
    metrics: { taskCount: totalTasks },
    recentTickets,
    accent: {
      primary: "#f97316",
      secondary: "#431407",
      image: "linear-gradient(135deg, #120904 0%, #9a3412 52%, #050505 100%)",
    },
  };
}

function buildCustomerBranchProduct(input: ProductCatalogBuildInput): ProductCatalogItem {
  const branches = uniqueStrings(input.customerBranches.map((row) => row.branch), 10);
  const customers = uniqueStrings(input.customerBranches.map((row) => row.customer), 10);
  return {
    id: "customer-branch-matrix",
    name: "Customer Branch Matrix",
    tagline: `${input.customerBranches.length} customer branch mappings from RDS.`,
    description:
      "Shows the actual customer-to-version branch matrix used when factories need a target branch for support or implementation work.",
    factory: "Platform",
    status: "production_ready",
    domains: ["Repository Intelligence", "Support Operations"],
    shelves: ["recently_added", "platform", "repository_catalog", "production_ready"],
    supportedVersions: branches.map((branch) => `Configured branch: ${branch}`),
    configuration: customers.map((customer) => `Customer: ${customer}`),
    deploymentSteps: [
      "Resolve customer",
      "Read configured branch",
      "Select repository target",
      "Run factory workflow",
    ],
    dependencies: ["customer_branches", "code_repositories"],
    evidenceLinks: [],
    knownLimitations: ["Customer branch rows are global and not repository-specific in the current schema."],
    lastUpdated: dateOnly(input.generatedAt),
    metrics: { customerBranchCount: input.customerBranches.length },
    recentTickets: [],
    accent: {
      primary: "#14b8a6",
      secondary: "#042f2e",
      image: "linear-gradient(135deg, #031b1a 0%, #0f766e 48%, #050505 100%)",
    },
  };
}

function buildRouterProduct(input: ProductCatalogBuildInput): ProductCatalogItem {
  const totalRouterDecisions = input.repositories.reduce(
    (sum, repo) => sum + toCount(repo.routerDecisions),
    0,
  );
  const recentRouterDecisions = input.repositories.reduce(
    (sum, repo) => sum + toCount(repo.recentRouterDecisions),
    0,
  );
  return {
    id: "repo-router-live-routing",
    name: "Live Repository Router",
    tagline: `${recentRouterDecisions} recent routing decisions across registered repositories.`,
    description:
      "RDS-backed view of repository selection outcomes that determine which product repo a ticket should use before OneShot starts.",
    factory: "OneShot",
    status: totalRouterDecisions > 0 ? "production_ready" : "needs_configuration",
    domains: ["Repository Intelligence", "Feature Delivery"],
    shelves: ["top_picks", "trending", "oneshot", "repository_catalog"],
    supportedVersions: input.repositories
      .filter((repo) => toCount(repo.routerDecisions) > 0)
      .slice(0, 8)
      .map((repo) => `${repo.repoName}: ${toCount(repo.routerDecisions)} decisions`),
    configuration: ["Routing weights", "Repository profiles", "Ticket signals"],
    deploymentSteps: ["Extract ticket signals", "Rank repositories", "Confirm target repo"],
    dependencies: ["router_decisions", "code_repositories", "historical_ticket_index"],
    evidenceLinks: [{ label: "OneShot dashboard", href: "/oneshot", kind: "dashboard" }],
    knownLimitations: ["Ambiguous tickets still require manual repo confirmation."],
    lastUpdated: dateOnly(input.routerTickets[0]?.decidedAt ?? input.generatedAt),
    metrics: {
      routerDecisions: totalRouterDecisions,
      recentRouterDecisions,
    },
    recentTickets: mergeTickets(
      input.routerTickets.map((ticket) => ({
        key: ticket.ticketId,
        source: "router" as const,
        state: ticket.outcome,
        updatedAt: toIsoString(ticket.decidedAt),
      })),
      10,
    ),
    accent: {
      primary: "#38bdf8",
      secondary: "#082f49",
      image: "linear-gradient(135deg, #020617 0%, #075985 52%, #050505 100%)",
    },
  };
}

export function buildProductCatalogFromRows(
  input: ProductCatalogBuildInput,
): ProductCatalogResponse {
  const outcomeProducts = buildOneShotOutcomeProducts(input);
  const productionSupportStories = buildProductionSupportStoryProducts(input);
  const ticketOutcomeCount = outcomeProducts.filter(
    (product) => product.contentType !== "epic",
  ).length;
  const epicOutcomeCount = outcomeProducts.filter((product) => product.contentType === "epic")
    .length;

  return {
    generatedAt: input.generatedAt.toISOString(),
    summary: {
      repositoryCount: input.repositories.length,
      customerBranchCount: input.customerBranches.length,
      recentTicketCount: input.recentRuns.length + input.routerTickets.length + input.recentTasks.length,
      oneshotRunCount: input.repositories.reduce((sum, repo) => sum + toCount(repo.oneshotRuns), 0),
      successfulOutcomeCount: outcomeProducts.length,
      ticketOutcomeCount,
      epicOutcomeCount,
      taskCount: input.taskCounts.reduce((sum, row) => sum + toCount(row.count), 0),
    },
    products: [...outcomeProducts, ...productionSupportStories],
  };
}

export async function getProductCatalog(): Promise<ProductCatalogResponse> {
  const pool = getPool();
  const [
    [repositories],
    [runGroups],
    [recentRuns],
    [candidateVersions],
    [routerTickets],
    [customerBranches],
    [taskCounts],
    [recentTasks],
  ] = await Promise.all([
    pool.query<Array<RepositoryActivityRow & mysql.RowDataPacket>>(
      `SELECT cr.id,
              cr.repo_name AS repoName,
              cr.repo_url AS repoUrl,
              cr.description,
              cr.default_branch AS defaultBranch,
              cr.created_at AS createdAt,
              COUNT(DISTINCT r.id) AS oneshotRuns,
              COUNT(DISTINCT CASE WHEN r.created_at >= NOW() - INTERVAL 14 DAY THEN r.id END) AS recentOneshotRuns,
              MAX(r.updated_at) AS latestRunUpdatedAt,
              COUNT(DISTINCT cv.id) AS candidateVersions,
              MAX(cv.created_at) AS latestCandidateAt,
              COUNT(DISTINCT rd.id) AS routerDecisions,
              COUNT(DISTINCT CASE WHEN rd.ts >= NOW() - INTERVAL 14 DAY THEN rd.id END) AS recentRouterDecisions
       FROM code_repositories cr
       LEFT JOIN oneshot_runs r ON r.repo_id = cr.id
       LEFT JOIN oneshot_candidate_versions cv ON cv.oneshot_run_id = r.id
       LEFT JOIN router_decisions rd
         ON rd.chosen_repo_id = cr.id OR rd.top1_repo_id = cr.id OR rd.top2_repo_id = cr.id
       GROUP BY cr.id, cr.repo_name, cr.repo_url, cr.description, cr.default_branch, cr.created_at
       ORDER BY recentOneshotRuns DESC, recentRouterDecisions DESC, latestRunUpdatedAt DESC, cr.repo_name ASC`,
    ),
    pool.query<Array<RunGroupRow & mysql.RowDataPacket>>(
      `SELECT id,
              jira_key AS jiraKey,
              status,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM oneshot_run_groups
       ORDER BY updated_at DESC, id DESC
       LIMIT 100`,
    ),
    pool.query<Array<RecentRunRow & mysql.RowDataPacket>>(
      `SELECT r.id,
              r.run_group_id AS runGroupId,
              r.repo_id AS repoId,
              r.jira_key AS jiraKey,
              r.state,
              r.branch_name AS branchName,
              r.current_implementation_branch AS implementationBranch,
              r.current_pr_url AS prUrl,
              r.current_plan_version AS planVersion,
              r.current_implementation_version AS implementationVersion,
              r.current_code_review_version AS codeReviewVersion,
              r.current_test_version AS testVersion,
              t.task_description AS taskDescription,
              hti.text AS indexedText,
              r.created_at AS createdAt,
              r.updated_at AS updatedAt,
              cr.repo_name AS repoName,
              cr.repo_url AS repoUrl,
              cr.default_branch AS defaultBranch,
              cb.customer AS customerName
       FROM oneshot_runs r
       JOIN code_repositories cr ON cr.id = r.repo_id
       LEFT JOIN customer_branches cb ON cb.id = r.customer_id
       LEFT JOIN task_management tm ON tm.id = r.source_task_management_id
       LEFT JOIN tasks t ON t.id = tm.task_id
       LEFT JOIN (
         SELECT ticket_id, MAX(id) AS id
         FROM historical_ticket_index
         GROUP BY ticket_id
       ) latest_hti ON latest_hti.ticket_id = r.jira_key
       LEFT JOIN historical_ticket_index hti ON hti.id = latest_hti.id
       WHERE r.current_pr_url IS NOT NULL
         AND LENGTH(TRIM(r.current_pr_url)) > 0
         AND r.state <> 'failed'
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT 500`,
    ),
    pool.query<Array<CandidateVersionRow & mysql.RowDataPacket>>(
      `SELECT r.repo_id AS repoId,
              cv.oneshot_run_id AS oneshotRunId,
              r.jira_key AS jiraKey,
              cv.candidate_version AS candidateVersion,
              cv.status,
              LEFT(cv.candidate_commit_sha, 12) AS candidateSha,
              cv.created_at AS createdAt
       FROM oneshot_candidate_versions cv
       JOIN oneshot_runs r ON r.id = cv.oneshot_run_id
       ORDER BY cv.created_at DESC, cv.id DESC
       LIMIT 100`,
    ),
    pool.query<Array<RouterTicketRow & mysql.RowDataPacket>>(
      `SELECT COALESCE(rd.chosen_repo_id, rd.top1_repo_id, rd.top2_repo_id) AS repoId,
              rd.ticket_id AS ticketId,
              rd.outcome,
              rd.ts AS decidedAt
       FROM router_decisions rd
       WHERE COALESCE(rd.chosen_repo_id, rd.top1_repo_id, rd.top2_repo_id) IS NOT NULL
       ORDER BY rd.ts DESC, rd.id DESC
       LIMIT 150`,
    ),
    pool.query<Array<CustomerBranchRow & mysql.RowDataPacket>>(
      `SELECT customer, branch, \`default\` AS isDefault
       FROM customer_branches
       ORDER BY customer, \`default\` DESC, branch
       LIMIT 200`,
    ),
    pool.query<Array<TaskCountRow & mysql.RowDataPacket>>(
      `SELECT t.task_type AS taskType,
              t.status,
              COUNT(*) AS count,
              MAX(t.updated_at) AS latestUpdate
       FROM tasks t
       GROUP BY t.task_type, t.status
       ORDER BY latestUpdate DESC, t.task_type, t.status`,
    ),
    pool.query<Array<RecentTaskRow & mysql.RowDataPacket>>(
      `SELECT tm.id,
              tm.jira_number AS jiraNumber,
              tm.status,
              tm.task_type AS taskType,
              tm.source,
              a.name AS agentName,
              cb.customer,
              tm.updated_at AS updatedAt,
              tm.jira_posted_at AS jiraPostedAt,
              t.task_description AS taskDescription
       FROM task_management tm
       JOIN agents a ON a.id = tm.agent_id
       LEFT JOIN customer_branches cb ON cb.id = tm.customer_id
       LEFT JOIN tasks t ON t.id = tm.task_id
       ORDER BY tm.updated_at DESC, tm.id DESC
       LIMIT 100`,
    ),
  ]);

  return buildProductCatalogFromRows({
    generatedAt: new Date(),
    repositories,
    runGroups,
    recentRuns,
    candidateVersions,
    routerTickets,
    customerBranches,
    taskCounts,
    recentTasks,
  });
}
