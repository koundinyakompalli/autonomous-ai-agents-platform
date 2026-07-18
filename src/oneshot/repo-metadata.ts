import type { CodeRepository } from "../orchestrator/database.js";

export type OneShotRepoFamily = "cp" | "ai" | "document" | "mp";

export interface OneShotRepoMetadata {
  repoName: string;
  githubSlug: string;
  aliases: string[];
  productFamily: OneShotRepoFamily;
  domains: string[];
  oneshotEnabled: boolean;
}

export interface GitHubInventoryRepository {
  name: string;
  fullName?: string;
  htmlUrl?: string;
  cloneUrl?: string;
  description?: string | null;
  defaultBranch?: string | null;
}

export interface DraftOneShotRepoCard extends OneShotRepoMetadata {
  inventoryName: string;
  inventoryFullName?: string;
  htmlUrl?: string;
  cloneUrl?: string;
  description?: string | null;
  defaultBranch?: string | null;
  reviewStatus: "enabled" | "draft" | "disabled";
  reviewNotes: string[];
}

export const ONE_SHOT_REPO_METADATA: OneShotRepoMetadata[] = [
  {
    repoName: "core-app",
    githubSlug: "cp-medhok-monorepo",
    aliases: [
      "core-app",
      "core app",
      "cp-medhok-monorepo",
      "medhok monorepo",
      "core web services",
      "mhk core api",
      "medhok web services",
      "medhok-web-services",
      "ws-doc-api",
      "authrestservices",
      "rxparestservices",
    ],
    productFamily: "cp",
    domains: [
      "primary-ui",
      "api",
      "business-logic",
      "web-services",
      "core-web-services",
      "rest-api-contracts",
      "swagger-openapi",
      "authorization-services",
      "member-services",
      "rxpa-services",
    ],
    oneshotEnabled: true,
  },
  {
    repoName: "client-services",
    githubSlug: "cp-client-services-monorepo",
    aliases: [
      "client-services",
      "client services",
      "cp-client-services-monorepo",
    ],
    productFamily: "cp",
    domains: ["customer-services", "client-integrations"],
    oneshotEnabled: true,
  },
  {
    repoName: "batch-jobs",
    githubSlug: "cp-batch-monorepo",
    aliases: ["batch-jobs", "batch jobs", "cp-batch-monorepo"],
    productFamily: "cp",
    domains: ["batch", "workflow", "correspondence", "assessments"],
    oneshotEnabled: true,
  },
  {
    repoName: "provider-portal",
    githubSlug: "cp-provider-portal",
    aliases: ["provider-portal", "provider portal", "cp-provider-portal"],
    productFamily: "cp",
    domains: ["provider-ui", "provider-api"],
    oneshotEnabled: true,
  },
  {
    repoName: "React-based-new-ui",
    githubSlug: "cp-mhk-smart-prominence",
    aliases: [
      "React-based-new-ui",
      "react based new ui",
      "cp-mhk-smart-prominence",
      "smart prominence",
    ],
    productFamily: "cp",
    domains: ["react-ui", "ocr-ui", "md-review"],
    oneshotEnabled: true,
  },
  {
    repoName: "interop",
    githubSlug: "cp-interoperability-monorepo",
    aliases: [
      "interop",
      "interoperability",
      "cp-interoperability-monorepo",
      "crd",
      "dtr",
      "pas",
      "da vinci",
      "davinci",
      "medpharm",
      "interqual",
      "mcg",
    ],
    productFamily: "cp",
    domains: [
      "interop",
      "fhir",
      "cds-hooks",
      "da-vinci-crd",
      "da-vinci-dtr",
      "da-vinci-pas",
      "external-integrations",
      "clinical-engine-integrations",
    ],
    oneshotEnabled: true,
  },
  {
    repoName: "data-visor",
    githubSlug: "cp-datalake-pipeline",
    aliases: [
      "data-visor",
      "data visor",
      "datavisor",
      "dv",
      "data-lake",
      "data lake",
      "data-lake-pipeline",
      "cp-datalake-pipeline",
    ],
    productFamily: "cp",
    domains: [
      "data-lake",
      "data-visor",
      "reporting",
      "reference-data-validation",
    ],
    oneshotEnabled: true,
  },
  {
    repoName: "cp-medhok-bi-datamart-monorepo",
    githubSlug: "cp-medhok-bi-datamart-monorepo",
    aliases: [
      "cp-medhok-bi-datamart-monorepo",
      "bi-datamart",
      "bi datamart",
      "medhok-bi-datamart",
      "datamart",
      "data mart",
      "member data mart",
      "bi data mart",
    ],
    productFamily: "cp",
    domains: [
      "bi-datamart",
      "member-data-mart",
      "reporting",
      "digital-communication-reporting",
    ],
    oneshotEnabled: true,
  },
  {
    repoName: "Document-ai",
    githubSlug: "document-ai",
    aliases: ["Document-ai", "document-ai", "document ai"],
    productFamily: "document",
    domains: ["ocr", "document-understanding", "intake"],
    oneshotEnabled: true,
  },
  {
    repoName: "Ai-agents",
    githubSlug: "enterprise-ai-agent-platform",
    aliases: [
      "Ai-agents",
      "ai agents",
      "enterprise-ai-agent-platform",
      "enterprise ai agent platform",
      "ai agent platform",
      "controller agents",
      "processing agents",
      "agent hosting",
    ],
    productFamily: "ai",
    domains: [
      "agents",
      "mcp",
      "automation-platform",
      "controller-agent-architecture",
      "healthcare-ai-saas",
      "aws-hosted-agents",
      "terraform-managed-agents",
    ],
    oneshotEnabled: true,
  },
  {
    repoName: "cp-autonomous-ai-agents-platform",
    githubSlug: "cp-autonomous-ai-agents-platform",
    aliases: [
      "cp-autonomous-ai-agents-platform",
      "autonomous ai agents platform",
      "Specter",
      "specter",
      "OneShot",
      "oneshot",
      "one shot",
      "oneshot platform",
      "qualifier",
      "planner",
    ],
    productFamily: "ai",
    domains: ["agents", "mcp", "automation-platform", "oneshot"],
    oneshotEnabled: true,
  },
  {
    repoName: "mp-web",
    githubSlug: "mp-web",
    aliases: ["mp-web", "mp web"],
    productFamily: "mp",
    domains: ["mp-ui"],
    oneshotEnabled: false,
  },
  {
    repoName: "mp-product-client-configs",
    githubSlug: "mp-product-client-configs",
    aliases: [
      "mp-product-client-configs",
      "mp product client configs",
      "mp configs",
    ],
    productFamily: "mp",
    domains: ["mp-config"],
    oneshotEnabled: false,
  },
];

export const AI_AGENTS_REPO_SLUG = "enterprise-ai-agent-platform";

const METADATA_BY_REPO_NAME = new Map(
  ONE_SHOT_REPO_METADATA.map((metadata) => [
    metadata.repoName.toLowerCase(),
    metadata,
  ]),
);
const METADATA_BY_SLUG = new Map(
  ONE_SHOT_REPO_METADATA.map((metadata) => [
    metadata.githubSlug.toLowerCase(),
    metadata,
  ]),
);

export function getRepositorySlug(repoUrl: string): string | null {
  const normalized = repoUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const slug = normalized.split("/").pop();
  return slug ? slug.trim() : null;
}

export function getOneShotRepoMetadata(
  repo: Pick<CodeRepository, "repo_name" | "repo_url">,
): OneShotRepoMetadata | null {
  const slug = getRepositorySlug(repo.repo_url);
  const bySlug = slug ? METADATA_BY_SLUG.get(slug.toLowerCase()) : null;
  if (bySlug) {
    return bySlug;
  }

  return METADATA_BY_REPO_NAME.get(repo.repo_name.toLowerCase()) ?? null;
}

export function isMpRepository(
  repo: Pick<CodeRepository, "repo_name" | "repo_url">,
): boolean {
  const metadata = getOneShotRepoMetadata(repo);
  if (metadata?.productFamily === "mp") {
    return true;
  }

  const slug = getRepositorySlug(repo.repo_url)?.toLowerCase() ?? "";
  return (
    repo.repo_name.toLowerCase().startsWith("mp-") || slug.startsWith("mp-")
  );
}

export function isOneShotRepoEnabled(
  repo: Pick<CodeRepository, "repo_name" | "repo_url">,
): boolean {
  const metadata = getOneShotRepoMetadata(repo);
  return metadata?.oneshotEnabled === true;
}

function preferCanonicalRepo<
  T extends Pick<CodeRepository, "id" | "repo_name" | "repo_url">,
>(current: T, candidate: T, canonicalRepoName: string): T {
  const normalizedCanonicalName = canonicalRepoName.toLowerCase();
  const currentIsCanonical =
    current.repo_name.toLowerCase() === normalizedCanonicalName;
  const candidateIsCanonical =
    candidate.repo_name.toLowerCase() === normalizedCanonicalName;

  if (candidateIsCanonical && !currentIsCanonical) {
    return candidate;
  }
  if (currentIsCanonical && !candidateIsCanonical) {
    return current;
  }
  return candidate.id < current.id ? candidate : current;
}

export function dedupeOneShotEnabledRepos<
  T extends Pick<CodeRepository, "id" | "repo_name" | "repo_url">,
>(repos: T[]): T[] {
  const deduped = new Map<string, T>();

  for (const repo of repos) {
    const metadata = getOneShotRepoMetadata(repo);
    if (metadata?.oneshotEnabled !== true) {
      continue;
    }

    const canonicalKey = metadata.repoName.toLowerCase();
    const current = deduped.get(canonicalKey);
    deduped.set(
      canonicalKey,
      current ? preferCanonicalRepo(current, repo, metadata.repoName) : repo,
    );
  }

  return Array.from(deduped.values());
}

export function getRepoMentionTokens(
  repo: Pick<CodeRepository, "repo_name" | "repo_url">,
): string[] {
  const metadata = getOneShotRepoMetadata(repo);
  const slug = getRepositorySlug(repo.repo_url);
  return Array.from(
    new Set(
      [repo.repo_name, slug, ...(metadata?.aliases ?? [])].filter(
        (value): value is string => Boolean(value?.trim()),
      ),
    ),
  );
}

function normalizeInventoryName(repo: GitHubInventoryRepository): string {
  return repo.name.trim();
}

function inferMetadataForInventoryRepo(
  repo: GitHubInventoryRepository,
): OneShotRepoMetadata | null {
  const name = normalizeInventoryName(repo).toLowerCase();
  return METADATA_BY_SLUG.get(name) ?? METADATA_BY_REPO_NAME.get(name) ?? null;
}

function isDocumentOrAiCandidate(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "document-ai" ||
    normalized === "cp-autonomous-ai-agents-platform" ||
    normalized === "enterprise-ai-agent-platform"
  );
}

function isCpCandidate(name: string): boolean {
  return name.toLowerCase().startsWith("cp-");
}

export function isOneShotMetadataPrepCandidate(
  repo: GitHubInventoryRepository,
): boolean {
  const name = normalizeInventoryName(repo);
  if (name.toLowerCase().startsWith("mp-")) {
    return false;
  }

  return isCpCandidate(name) || isDocumentOrAiCandidate(name);
}

export function buildDraftRepoCardsFromInventory(
  inventory: GitHubInventoryRepository[],
): DraftOneShotRepoCard[] {
  return inventory.filter(isOneShotMetadataPrepCandidate).map((repo) => {
    const name = normalizeInventoryName(repo);
    const knownMetadata = inferMetadataForInventoryRepo(repo);
    const draftMetadata: OneShotRepoMetadata = knownMetadata ?? {
      repoName: name,
      githubSlug: name,
      aliases: [name],
      productFamily: isDocumentOrAiCandidate(name)
        ? name.toLowerCase() === "document-ai"
          ? "document"
          : "ai"
        : "cp",
      domains: [],
      oneshotEnabled: false,
    };

    return {
      ...draftMetadata,
      inventoryName: name,
      inventoryFullName: repo.fullName,
      htmlUrl: repo.htmlUrl,
      cloneUrl: repo.cloneUrl,
      description: repo.description,
      defaultBranch: repo.defaultBranch,
      reviewStatus: draftMetadata.oneshotEnabled ? "enabled" : "draft",
      reviewNotes: draftMetadata.oneshotEnabled
        ? ["Known OneShot-enabled repository metadata."]
        : [
            "Draft CP/application candidate. Human review required before enabling OneShot.",
          ],
    };
  });
}
