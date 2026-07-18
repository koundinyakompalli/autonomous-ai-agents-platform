export type ProductFactory =
  | "OneShot"
  | "Production Support"
  | "Spec Factory"
  | "Platform";

export type ProductStatus =
  | "production_ready"
  | "needs_configuration"
  | "preview"
  | "upcoming";

export type ProductDomain =
  | "Feature Delivery"
  | "Jira Automation"
  | "Deployment"
  | "Repository Intelligence"
  | "Dashboard"
  | "Support Operations";

export type ProductShelfKey =
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

export type ProductContentType = "feature" | "fix" | "integration" | "epic";

export type ProductDeploymentActionKind = "jenkins" | "github" | "preview";

export interface ProductEvidenceLink {
  label: string;
  href: string;
  kind: "doc" | "jira" | "github" | "runbook" | "dashboard";
}

export interface ProductDeploymentAction {
  label: string;
  href: string;
  kind: ProductDeploymentActionKind;
}

export interface ProductCatalogItem {
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
  recentTickets?: Array<{
    key: string;
    source: "oneshot" | "router" | "task";
    state?: string;
    branch?: string;
    prUrl?: string | null;
    updatedAt?: string | null;
  }>;
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

export interface ProductCatalogResponse {
  generatedAt: string;
  summary: {
    repositoryCount: number;
    customerBranchCount: number;
    recentTicketCount: number;
    oneshotRunCount: number;
    successfulOutcomeCount?: number;
    ticketOutcomeCount?: number;
    epicOutcomeCount?: number;
    taskCount: number;
  };
  products: ProductCatalogItem[];
}

export interface ProductCatalogFilters {
  factory: ProductFactory | "all";
  status: ProductStatus | "all";
  query: string;
}

export interface ProductShelf {
  key: ProductShelfKey;
  title: string;
  subtitle: string;
  products: ProductCatalogItem[];
}
