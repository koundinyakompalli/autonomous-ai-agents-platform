import type {
  ProductCatalogFilters,
  ProductCatalogItem,
  ProductFactory,
  ProductShelf,
  ProductShelfKey,
  ProductStatus,
} from "./types.js";

export const FACTORY_FILTERS: ReadonlyArray<ProductFactory | "all"> = [
  "all",
  "OneShot",
  "Production Support",
  "Spec Factory",
  "Platform",
];

export const STATUS_FILTERS: ReadonlyArray<ProductStatus | "all"> = [
  "all",
  "production_ready",
  "needs_configuration",
  "preview",
  "upcoming",
];

export const PRODUCT_STATUS_LABEL: Record<ProductStatus | "all", string> = {
  all: "All statuses",
  production_ready: "Production ready",
  needs_configuration: "Needs configuration",
  preview: "Preview",
  upcoming: "Upcoming",
};

export type ProductVisualCategory =
  | "features"
  | "fixes"
  | "security"
  | "integration"
  | "performance"
  | "data";

const PRODUCT_ARTWORK_COUNTS: Record<ProductVisualCategory, number> = {
  features: 13,
  fixes: 10,
  security: 10,
  integration: 10,
  performance: 10,
  data: 10,
};

const PRODUCT_ARTWORK_SEQUENCE: string[] = (
  Object.entries(PRODUCT_ARTWORK_COUNTS) as Array<[ProductVisualCategory, number]>
).flatMap(([category, count]) =>
  Array.from(
    { length: count },
    (_, index) => `/product-catalog/tiles/${category}/${index + 1}.jpg`,
  ),
);

export const catalogProducts: ProductCatalogItem[] = [
  {
    id: "coreapp-preview-deployments",
    name: "CoreApp Preview Deployments",
    tagline: "Preview-before-merge environments for generated feature work.",
    description:
      "Deploys candidate implementation branches into an isolated preview path so reviewers can validate generated work before a production PR is merged.",
    factory: "OneShot",
    status: "production_ready",
    domains: ["Deployment", "Feature Delivery"],
    shelves: ["top_picks", "recently_added", "production_ready", "oneshot"],
    supportedVersions: ["CoreApp 2026.x", "Provider Portal 2026.x"],
    configuration: [
      "Repo profile",
      "Preview deploy mapping",
      "GitHub app access",
      "Deploy authorization",
    ],
    deploymentSteps: [
      "Create candidate branch",
      "Request preview deploy",
      "Validate preview URL",
      "Attach evidence",
      "Approve merge",
    ],
    dependencies: ["GitHub App", "ECS dashboard API", "Terraform preview target"],
    evidenceLinks: [
      {
        label: "OneShot preview runbook",
        href: "/docs/ONESHOT_PREVIEW_RUNBOOK.md",
        kind: "runbook",
      },
      {
        label: "CoreApp preview contract",
        href: "/docs/coreapp-preview-build-contract.md",
        kind: "doc",
      },
    ],
    knownLimitations: [
      "Requires configured preview target per supported repository.",
    ],
    lastUpdated: "2026-05-18",
    accent: {
      primary: "#e50914",
      secondary: "#451118",
      image: "linear-gradient(135deg, #1a1014 0%, #3b1118 48%, #111827 100%)",
    },
    featured: true,
  },
  {
    id: "jira-ai-result-posting",
    name: "Jira AI Result Posting",
    tagline: "Posts full AI findings back to Jira when analysis completes.",
    description:
      "Publishes generated task results as Jira comments and labels successfully delivered tickets for support visibility.",
    factory: "Production Support",
    status: "production_ready",
    domains: ["Jira Automation", "Support Operations"],
    shelves: ["trending", "recently_added", "production_ready", "production_support"],
    supportedVersions: ["Jira Cloud", "DARCI", "HERMES"],
    configuration: [
      "Jira credentials",
      "Agent labels",
      "Task management row",
      "Result S3 object",
    ],
    deploymentSteps: [
      "Complete AI task",
      "Load result markdown",
      "Post Jira comment",
      "Add done label",
      "Mark posted_to_jira",
    ],
    dependencies: ["Jira API", "S3 results bucket", "task_management table"],
    evidenceLinks: [
      {
        label: "DARCI debugging guide",
        href: "/docs/DARCI_DEBUGGING_GUIDE.md",
        kind: "doc",
      },
    ],
    knownLimitations: [
      "Comment posting depends on Jira API availability and issue permissions.",
    ],
    lastUpdated: "2026-05-18",
    accent: {
      primary: "#f97316",
      secondary: "#43210b",
      image: "linear-gradient(135deg, #1f1308 0%, #7c2d12 52%, #111827 100%)",
    },
  },
  {
    id: "repo-router-confirmation",
    name: "Repository Router Confirmation",
    tagline: "Confirms target repositories before OneShot starts work.",
    description:
      "Uses repository profiles and ticket context to route implementation work to the right codebase with a human-readable confirmation artifact.",
    factory: "OneShot",
    status: "needs_configuration",
    domains: ["Repository Intelligence", "Feature Delivery"],
    shelves: ["top_picks", "recently_added", "needs_configuration", "oneshot"],
    supportedVersions: ["Configured repo profiles", "GitHub repositories"],
    configuration: [
      "Repository profile YAML",
      "Routing weights",
      "Ticket context",
      "Default branch metadata",
    ],
    deploymentSteps: [
      "Generate repo profile",
      "Publish routing weights",
      "Run qualification",
      "Confirm selected repo",
    ],
    dependencies: ["config/repo-profiles", "repo router weights", "Jira ticket body"],
    evidenceLinks: [
      {
        label: "Repo router weights",
        href: "/config/repo-router/weights.yaml",
        kind: "doc",
      },
    ],
    knownLimitations: ["Ambiguous tickets still require manual confirmation."],
    lastUpdated: "2026-05-18",
    accent: {
      primary: "#06b6d4",
      secondary: "#0e3a46",
      image: "linear-gradient(135deg, #082f49 0%, #155e75 48%, #111827 100%)",
    },
  },
  {
    id: "oneshot-feature-delivery",
    name: "OneShot Feature Delivery",
    tagline: "Brownfield feature delivery through plan, build, review, and test stages.",
    description:
      "Coordinates planner, implementer, reviewer, code-review, and test stages to turn approved tickets into implementation PRs.",
    factory: "OneShot",
    status: "production_ready",
    domains: ["Feature Delivery", "Dashboard"],
    shelves: ["top_picks", "trending", "production_ready", "oneshot"],
    supportedVersions: ["GitHub repos", "Node and Java workers"],
    configuration: [
      "Prompt bundle",
      "Worker images",
      "Workspace leases",
      "GitHub credentials",
    ],
    deploymentSteps: [
      "Qualify ticket",
      "Plan work",
      "Build branch",
      "Review code",
      "Run tests",
      "Open PR",
    ],
    dependencies: ["SQS stage queues", "ECS workers", "GitHub App", "Workspace storage"],
    evidenceLinks: [
      {
        label: "OneShot runbook",
        href: "/docs/ONESHOT_RUNBOOK.md",
        kind: "runbook",
      },
    ],
    knownLimitations: ["Requires repository-specific build and test commands."],
    lastUpdated: "2026-05-18",
    accent: {
      primary: "#8b5cf6",
      secondary: "#2e1065",
      image: "linear-gradient(135deg, #1e1b4b 0%, #4c1d95 50%, #111827 100%)",
    },
  },
  {
    id: "production-support-task-console",
    name: "Production Support Task Console",
    tagline: "Operational view for DARCI, HERMES, and support task delivery.",
    description:
      "Shows support task status, active failures, posting progress, and support-agent throughput in a dedicated dashboard surface.",
    factory: "Production Support",
    status: "production_ready",
    domains: ["Support Operations", "Dashboard"],
    shelves: ["production_ready", "production_support"],
    supportedVersions: ["DARCI", "HERMES", "WATCHDOG", "SRLOG", "SCRIBE"],
    configuration: ["State API", "Agent registry", "Task management rows"],
    deploymentSteps: [
      "Deploy dashboard",
      "Expose /api/state",
      "Poll task state",
      "Review failures",
    ],
    dependencies: ["Dashboard server", "Orchestrator database", "Agent registry"],
    evidenceLinks: [
      {
        label: "Production Support dashboard",
        href: "/production-support",
        kind: "dashboard",
      },
    ],
    knownLimitations: ["Displays current state only; it does not edit support tasks."],
    lastUpdated: "2026-05-18",
    accent: {
      primary: "#22c55e",
      secondary: "#052e16",
      image: "linear-gradient(135deg, #052e16 0%, #14532d 48%, #111827 100%)",
    },
  },
  {
    id: "watchdog-investigation-workbench",
    name: "Watchdog Investigation Workbench",
    tagline: "Guided incident investigation with evidence, findings, and DARCI handoff.",
    description:
      "Turns bounded incident scopes into evidence-backed findings and hands validated investigation context to support agents.",
    factory: "Platform",
    status: "preview",
    domains: ["Support Operations", "Dashboard"],
    shelves: ["recently_added", "platform"],
    supportedVersions: ["Watchdog catalog", "CloudWatch log sources", "Jira handoff"],
    configuration: [
      "Client catalog",
      "Environment catalog",
      "UTC investigation window",
      "DARCI mapping",
    ],
    deploymentSteps: [
      "Define scope",
      "Collect log evidence",
      "Review findings",
      "Create DARCI handoff",
    ],
    dependencies: ["Watchdog MCP", "CloudWatch Logs", "Jira API"],
    evidenceLinks: [
      {
        label: "Watchdog runtime config",
        href: "/docs/WATCHDOG_RUNTIME_CONFIG.md",
        kind: "doc",
      },
      { label: "Watchdog dashboard", href: "/watchdog", kind: "dashboard" },
    ],
    knownLimitations: ["Deep log search still requires explicit client, environment, and UTC window."],
    lastUpdated: "2026-05-18",
    accent: {
      primary: "#38bdf8",
      secondary: "#0c4a6e",
      image: "linear-gradient(135deg, #0f172a 0%, #075985 50%, #020617 100%)",
    },
  },
  {
    id: "specter-office-floor",
    name: "Specter Office Floor",
    tagline: "Interactive command floor for navigating the agent platform.",
    description:
      "Provides an ambient office-style entry point for moving between the platform's major operational surfaces.",
    factory: "Platform",
    status: "production_ready",
    domains: ["Dashboard"],
    shelves: ["production_ready", "platform"],
    supportedVersions: ["Dashboard web app"],
    configuration: ["Default layout", "Asset catalog", "Navigation targets"],
    deploymentSteps: ["Deploy dashboard", "Load office assets", "Navigate to platform surfaces"],
    dependencies: ["Dashboard assets", "Vite bundle", "Office renderer"],
    evidenceLinks: [
      { label: "Floor dashboard", href: "/", kind: "dashboard" },
    ],
    knownLimitations: ["Navigation surface only; product details live in the catalog."],
    lastUpdated: "2026-05-18",
    accent: {
      primary: "#14b8a6",
      secondary: "#134e4a",
      image: "linear-gradient(135deg, #042f2e 0%, #0f766e 48%, #111827 100%)",
    },
  },
  {
    id: "spec-factory-backlog",
    name: "Spec Factory Backlog",
    tagline: "Upcoming product line for turning specs into governed implementation backlogs.",
    description:
      "Represents the next factory direction: converting structured specifications into actionable, reviewable delivery backlogs.",
    factory: "Spec Factory",
    status: "upcoming",
    domains: ["Feature Delivery", "Repository Intelligence"],
    shelves: ["spec_factory"],
    supportedVersions: ["Confluence specs", "Jira backlogs"],
    configuration: ["Spec source", "Backlog templates", "Jira project mapping"],
    deploymentSteps: [
      "Select spec",
      "Extract milestones",
      "Generate backlog",
      "Review scope",
      "Publish Jira issues",
    ],
    dependencies: ["Atlassian access", "Product templates", "Reviewer approval"],
    evidenceLinks: [],
    knownLimitations: [
      "Catalog entry documents intended capability before runtime automation is generally available.",
    ],
    lastUpdated: "2026-05-18",
    accent: {
      primary: "#facc15",
      secondary: "#422006",
      image: "linear-gradient(135deg, #1c1917 0%, #713f12 52%, #111827 100%)",
    },
  },
];

const SHELF_DEFINITIONS: ReadonlyArray<Omit<ProductShelf, "products">> = [
  {
    key: "top_picks",
    title: "Top Picks",
    subtitle: "High-signal capabilities and live repo surfaces",
  },
  {
    key: "trending",
    title: "Trending",
    subtitle: "Active products ranked by recent runs and routing signals",
  },
  {
    key: "recently_added",
    title: "Recently Added",
    subtitle: "Newly productized work and recent RDS activity",
  },
  {
    key: "repository_catalog",
    title: "Repository Catalog",
    subtitle: "RDS-backed repositories available to factory workflows",
  },
  {
    key: "oneshot_tickets",
    title: "OneShot Tickets",
    subtitle: "Successful ticket-level Feature, Fix, and Integration outcomes with generated PRs",
  },
  {
    key: "oneshot_epics",
    title: "OneShot Epics",
    subtitle: "Epic-level outcome groups with successful ticket PRs",
  },
  {
    key: "production_ready",
    title: "Production Ready",
    subtitle: "Ready to configure or use",
  },
  {
    key: "needs_configuration",
    title: "Needs Configuration",
    subtitle: "Available after environment setup",
  },
  {
    key: "oneshot",
    title: "Factory: OneShot",
    subtitle: "Brownfield feature delivery products",
  },
  {
    key: "production_support",
    title: "Factory: Production Support",
    subtitle: "Support automation and operational AI",
  },
  {
    key: "platform",
    title: "Platform Surfaces",
    subtitle: "Shared dashboard and investigation products",
  },
  {
    key: "spec_factory",
    title: "Upcoming / Spec Factory",
    subtitle: "Next factory capabilities",
  },
];

function searchableText(product: ProductCatalogItem): string {
  return [
    product.name,
    product.tagline,
    product.description,
    product.factory,
    product.status,
    ...product.domains,
    ...product.supportedVersions,
    ...product.configuration,
    ...product.deploymentSteps,
    ...product.dependencies,
    product.repository?.name,
    product.repository?.defaultBranch,
    product.contentType,
    product.contentGroup?.label,
    ...(product.recentTickets ?? []).map((ticket) => ticket.key),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

function hasAnyKeyword(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function hashProductId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function categoryText(product: ProductCatalogItem): string {
  return [
    product.name,
    product.tagline,
    product.description,
    ...product.domains,
    product.contentType,
    product.contentGroup?.label,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

export function getProductVisualCategory(
  product: ProductCatalogItem,
): ProductVisualCategory {
  const text = categoryText(product);

  if (
    hasAnyKeyword(text, [
      "security",
      "auth",
      "authentication",
      "authorization",
      "access",
      "permission",
      "compliance",
      "privacy",
      "token",
      "encrypt",
      "credential",
    ])
  ) {
    return "security";
  }

  if (
    hasAnyKeyword(text, [
      "performance",
      "reliability",
      "throughput",
      "latency",
      "stability",
      "uptime",
      "capacity",
      "runtime",
      "scale",
    ])
  ) {
    return "performance";
  }

  if (
    hasAnyKeyword(text, [
      "analytics",
      "data",
      "metrics",
      "report",
      "insight",
    ])
  ) {
    return "data";
  }

  if (product.contentType === "fix") {
    return "fixes";
  }

  if (
    product.contentType === "integration" ||
    product.domains.includes("Deployment")
  ) {
    return "integration";
  }

  return "features";
}

export function getProductArtwork(product: ProductCatalogItem): string {
  const category = getProductVisualCategory(product);
  const count = PRODUCT_ARTWORK_COUNTS[category];
  const imageNumber = (hashProductId(product.id) % count) + 1;
  return `/product-catalog/tiles/${category}/${imageNumber}.jpg`;
}

export function buildProductArtworkMap(
  products: ReadonlyArray<ProductCatalogItem>,
): Map<string, string> {
  const artworkByProductId = new Map<string, string>();

  for (const [index, product] of products.entries()) {
    artworkByProductId.set(
      product.id,
      PRODUCT_ARTWORK_SEQUENCE[index % PRODUCT_ARTWORK_SEQUENCE.length],
    );
  }

  return artworkByProductId;
}

function shelfSortValue(product: ProductCatalogItem): number {
  const metrics = product.metrics;
  return (
    (metrics?.recentOneshotRuns ?? 0) * 1000 +
    (metrics?.recentRouterDecisions ?? 0) * 10 +
    (metrics?.oneshotRuns ?? 0) +
    Date.parse(product.lastUpdated)
  );
}

function productsForShelf(
  products: ReadonlyArray<ProductCatalogItem>,
  key: ProductShelfKey,
): ProductCatalogItem[] {
  return products
    .filter((product) => product.shelves.includes(key))
    .sort((a, b) => shelfSortValue(b) - shelfSortValue(a));
}

function buildRepositoryShelfDefinitions(
  products: ReadonlyArray<ProductCatalogItem>,
): Array<Omit<ProductShelf, "products">> {
  const keys = new Set<ProductShelfKey>();
  for (const product of products) {
    for (const key of product.shelves) {
      if (key.startsWith("repo:")) {
        keys.add(key);
      }
    }
  }

  return [...keys]
    .sort((left, right) => {
      const leftProduct = productsForShelf(products, left)[0];
      const rightProduct = productsForShelf(products, right)[0];
      const leftScore = leftProduct ? shelfSortValue(leftProduct) : 0;
      const rightScore = rightProduct ? shelfSortValue(rightProduct) : 0;
      return rightScore - leftScore;
    })
    .map((key) => {
      const representative = productsForShelf(products, key)[0];
      const repoName = representative?.repository?.name ?? key.replace(/^repo:/, "");
      const defaultBranch = representative?.repository?.defaultBranch;
      return {
        key,
        title: `Repo: ${repoName}`,
        subtitle: defaultBranch
          ? `Default branch ${defaultBranch} with recent tickets, branches, and candidates`
          : "Repository-scoped products and runtime evidence",
      };
    });
}

export function filterProducts(
  products: ReadonlyArray<ProductCatalogItem>,
  filters: ProductCatalogFilters,
): ProductCatalogItem[] {
  const query = filters.query.trim().toLowerCase();
  return products.filter((product) => {
    if (filters.factory !== "all" && product.factory !== filters.factory) {
      return false;
    }
    if (filters.status !== "all" && product.status !== filters.status) {
      return false;
    }
    return query ? searchableText(product).includes(query) : true;
  });
}

export function buildProductShelves(
  products: ReadonlyArray<ProductCatalogItem>,
): ProductShelf[] {
  const definitions = [
    ...SHELF_DEFINITIONS,
    ...buildRepositoryShelfDefinitions(products),
  ];

  return definitions.map((definition) => ({
    ...definition,
    products: productsForShelf(products, definition.key),
  })).filter((shelf) => shelf.products.length > 0);
}

export function getFeaturedProduct(
  products: ReadonlyArray<ProductCatalogItem>,
): ProductCatalogItem | null {
  return products.find((product) => product.featured) ?? products[0] ?? null;
}

export function findProductById(id: string): ProductCatalogItem | null {
  return catalogProducts.find((product) => product.id === id) ?? null;
}
