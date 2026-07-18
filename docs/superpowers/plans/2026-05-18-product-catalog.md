# Product Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a top-level Netflix-like Product Catalog screen that showcases products from multiple factories and exposes operational details per product.

**Architecture:** Add `/product-catalog` as a dashboard route, backed by a typed curated frontend dataset. Keep catalog data, filtering/shelf-building logic, React page rendering, and CSS styling separated so a backend catalog source can replace the static dataset later without rewriting the UI.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Testing Library, CSS modules-by-convention via imported CSS file, existing dashboard routing through `App.tsx`.

---

## File Structure

- Create `dashboard/src/product-catalog/types.ts`
  - Owns product catalog TypeScript types, status/factory/filter unions, and shelf model.
- Create `dashboard/src/product-catalog/catalogData.ts`
  - Owns the curated v1 product dataset and pure helper functions for search, factory/status filters, shelf building, featured product lookup, and product lookup by id.
- Create `dashboard/src/product-catalog/catalogData.test.ts`
  - Covers pure data helpers without rendering React.
- Create `dashboard/src/product-catalog/ProductCatalog.css`
  - Owns the Netflix-like black surface, billboard, shelves, cards, hover expansion, detail overlay, and responsive behavior.
- Create `dashboard/src/routes/ProductCatalogPage.tsx`
  - Owns page state, search/filter controls, shelf rendering, card selection, Escape handling, and detail overlay rendering.
- Create `dashboard/src/routes/ProductCatalogPage.test.tsx`
  - Covers rendering and key interactions.
- Modify `dashboard/src/App.tsx`
  - Adds `/product-catalog` route normalization and renders `ProductCatalogPage`.
- Modify `dashboard/src/App.test.tsx`
  - Adds route/nav tests for Product Catalog.
- Modify `dashboard/src/components/DashboardNav.tsx`
  - Adds `Product Catalog` to the shared top-level nav.
- Modify `dashboard/src/production-support/ProductionSupportPage.tsx`
  - Adds `Product Catalog` to the Production Support side nav so this top-level surface is reachable from that top-level page too.

---

### Task 1: Route And Global Navigation

**Files:**
- Modify: `dashboard/src/App.test.tsx`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/components/DashboardNav.tsx`
- Create: `dashboard/src/routes/ProductCatalogPage.tsx`

- [ ] **Step 1: Write failing Product Catalog route/nav tests**

Update `dashboard/src/App.test.tsx` with a Product Catalog mock and two tests:

```tsx
vi.mock("./routes/ProductCatalogPage.js", () => ({
  ProductCatalogPage: () => <main aria-label="Product Catalog">Product Catalog</main>,
}));

describe("App product catalog route", () => {
  it("renders the Product Catalog screen from /product-catalog", () => {
    window.history.pushState({}, "", "/product-catalog");

    render(<App />);

    expect(screen.getByRole("main", { name: "Product Catalog" })).toBeTruthy();
  });

  it("shows Product Catalog in the global dashboard navigation", () => {
    window.history.pushState({}, "", "/");

    render(<App />);

    expect(screen.getByRole("button", { name: "Product Catalog" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the route/nav test and verify it fails**

Run:

```bash
cd dashboard
npm test -- src/App.test.tsx
```

Expected: FAIL because `./routes/ProductCatalogPage.js` does not exist and `/product-catalog` is not handled yet.

- [ ] **Step 3: Add route support**

Update `dashboard/src/App.tsx`:

```tsx
import { ProductCatalogPage } from "./routes/ProductCatalogPage.js";
```

Extend `SupportedPath`:

```tsx
type SupportedPath =
  | "/"
  | "/oneshot"
  | "/production-support"
  | "/product-catalog"
  | "/watchdog"
  | "/watchdog/intro";
```

Update `normalizePathname`:

```tsx
if (pathname.startsWith("/product-catalog")) return "/product-catalog";
```

Add route state:

```tsx
const isProductCatalog = pathname === "/product-catalog";
const isDocumentPage =
  isOneShot || isProductionSupport || isProductCatalog || isWatchdog || isWatchdogIntro;
```

Add render branch before Watchdog:

```tsx
) : isProductCatalog ? (
  <ProductCatalogPage />
) : isWatchdogIntro ? (
```

Create a temporary route component so the import resolves before the full page is built in Task 3:

```tsx
export function ProductCatalogPage() {
  return <main aria-label="Product Catalog">Product Catalog</main>;
}
```

- [ ] **Step 4: Add global nav item**

Update `dashboard/src/components/DashboardNav.tsx` path unions to include `"/product-catalog"` and add this button after `OneShot`:

```tsx
<button
  type="button"
  onClick={() => onNavigate("/product-catalog")}
  disabled={currentPath === "/product-catalog"}
  aria-current={currentPath === "/product-catalog" ? "page" : undefined}
  title={currentPath === "/product-catalog" ? "Current view" : undefined}
  style={navButtonStyle(currentPath === "/product-catalog")}
>
  Product Catalog
</button>
```

- [ ] **Step 5: Run route/nav test and verify it passes**

Run:

```bash
cd dashboard
npm test -- src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit route/nav checkpoint**

```bash
git add dashboard/src/App.tsx dashboard/src/App.test.tsx dashboard/src/components/DashboardNav.tsx dashboard/src/routes/ProductCatalogPage.tsx
git commit -m "Add Product Catalog route"
```

---

### Task 2: Typed Catalog Data And Pure Helpers

**Files:**
- Create: `dashboard/src/product-catalog/types.ts`
- Create: `dashboard/src/product-catalog/catalogData.ts`
- Create: `dashboard/src/product-catalog/catalogData.test.ts`

- [ ] **Step 1: Write failing data helper tests**

Create `dashboard/src/product-catalog/catalogData.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildProductShelves,
  catalogProducts,
  filterProducts,
  findProductById,
  getFeaturedProduct,
} from "./catalogData.js";

describe("product catalog data", () => {
  it("seeds products from multiple factories", () => {
    expect(catalogProducts.length).toBeGreaterThanOrEqual(6);
    expect(new Set(catalogProducts.map((product) => product.factory)).size).toBeGreaterThanOrEqual(3);
    expect(catalogProducts.some((product) => product.factory === "OneShot")).toBe(true);
  });

  it("filters products by search query across operational fields", () => {
    const matches = filterProducts(catalogProducts, {
      factory: "all",
      status: "all",
      query: "preview",
    });

    expect(matches.map((product) => product.id)).toContain("coreapp-preview-deployments");
  });

  it("filters products by factory and status", () => {
    const matches = filterProducts(catalogProducts, {
      factory: "OneShot",
      status: "production_ready",
      query: "",
    });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((product) => product.factory === "OneShot")).toBe(true);
    expect(matches.every((product) => product.status === "production_ready")).toBe(true);
  });

  it("builds populated shelves and hides empty shelves", () => {
    const shelves = buildProductShelves(
      filterProducts(catalogProducts, { factory: "all", status: "all", query: "" }),
    );

    expect(shelves.length).toBeGreaterThan(2);
    expect(shelves.every((shelf) => shelf.products.length > 0)).toBe(true);
    expect(shelves.map((shelf) => shelf.title)).toContain("Recently Built");
  });

  it("finds featured and selected products", () => {
    expect(getFeaturedProduct(catalogProducts)?.id).toBe("coreapp-preview-deployments");
    expect(findProductById("jira-ai-result-posting")?.name).toBe("Jira AI Result Posting");
  });
});
```

- [ ] **Step 2: Run the data test and verify it fails**

Run:

```bash
cd dashboard
npm test -- src/product-catalog/catalogData.test.ts
```

Expected: FAIL because catalog modules do not exist.

- [ ] **Step 3: Create catalog types**

Create `dashboard/src/product-catalog/types.ts`:

```ts
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
  | "featured"
  | "recently_built"
  | "production_ready"
  | "needs_configuration"
  | "oneshot"
  | "production_support"
  | "spec_factory";

export interface ProductEvidenceLink {
  label: string;
  href: string;
  kind: "doc" | "jira" | "github" | "runbook" | "dashboard";
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
  dependencies: string[];
  evidenceLinks: ProductEvidenceLink[];
  knownLimitations: string[];
  lastUpdated: string;
  accent: {
    primary: string;
    secondary: string;
    image: string;
  };
  featured?: boolean;
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
```

- [ ] **Step 4: Create curated dataset and helpers**

Create `dashboard/src/product-catalog/catalogData.ts` with at least these exported functions:

```ts
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
    shelves: ["featured", "recently_built", "production_ready", "oneshot"],
    supportedVersions: ["CoreApp 2026.x", "Provider Portal 2026.x"],
    configuration: ["Repo profile", "Preview deploy mapping", "GitHub app access", "Deploy authorization"],
    deploymentSteps: ["Create candidate branch", "Request preview deploy", "Validate preview URL", "Attach evidence", "Approve merge"],
    dependencies: ["GitHub App", "ECS dashboard API", "Terraform preview target"],
    evidenceLinks: [
      { label: "OneShot preview runbook", href: "/docs/ONESHOT_PREVIEW_RUNBOOK.md", kind: "runbook" },
      { label: "CoreApp preview contract", href: "/docs/coreapp-preview-build-contract.md", kind: "doc" },
    ],
    knownLimitations: ["Requires configured preview target per supported repository."],
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
    shelves: ["recently_built", "production_ready", "production_support"],
    supportedVersions: ["Jira Cloud", "DARCI", "HERMES"],
    configuration: ["Jira credentials", "Agent labels", "Task management row", "Result S3 object"],
    deploymentSteps: ["Complete AI task", "Load result markdown", "Post Jira comment", "Add done label", "Mark posted_to_jira"],
    dependencies: ["Jira API", "S3 results bucket", "task_management table"],
    evidenceLinks: [
      { label: "DARCI debugging guide", href: "/docs/DARCI_DEBUGGING_GUIDE.md", kind: "doc" },
    ],
    knownLimitations: ["Comment posting depends on Jira API availability and issue permissions."],
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
    shelves: ["recently_built", "needs_configuration", "oneshot"],
    supportedVersions: ["Configured repo profiles", "GitHub repositories"],
    configuration: ["Repository profile YAML", "Routing weights", "Ticket context", "Default branch metadata"],
    deploymentSteps: ["Generate repo profile", "Publish routing weights", "Run qualification", "Confirm selected repo"],
    dependencies: ["config/repo-profiles", "repo router weights", "Jira ticket body"],
    evidenceLinks: [
      { label: "Repo router weights", href: "/config/repo-router/weights.yaml", kind: "doc" },
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
    shelves: ["featured", "production_ready", "oneshot"],
    supportedVersions: ["GitHub repos", "Node and Java workers"],
    configuration: ["Prompt bundle", "Worker images", "Workspace leases", "GitHub credentials"],
    deploymentSteps: ["Qualify ticket", "Plan work", "Build branch", "Review code", "Run tests", "Open PR"],
    dependencies: ["SQS stage queues", "ECS workers", "GitHub App", "Workspace storage"],
    evidenceLinks: [
      { label: "OneShot runbook", href: "/docs/ONESHOT_RUNBOOK.md", kind: "runbook" },
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
    deploymentSteps: ["Deploy dashboard", "Expose /api/state", "Poll task state", "Review failures"],
    dependencies: ["Dashboard server", "Orchestrator database", "Agent registry"],
    evidenceLinks: [
      { label: "Production Support dashboard", href: "/production-support", kind: "dashboard" },
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
    deploymentSteps: ["Select spec", "Extract milestones", "Generate backlog", "Review scope", "Publish Jira issues"],
    dependencies: ["Atlassian access", "Product templates", "Reviewer approval"],
    evidenceLinks: [],
    knownLimitations: ["Catalog entry documents intended capability before runtime automation is generally available."],
    lastUpdated: "2026-05-18",
    accent: {
      primary: "#facc15",
      secondary: "#422006",
      image: "linear-gradient(135deg, #1c1917 0%, #713f12 52%, #111827 100%)",
    },
  },
];

const SHELF_DEFINITIONS: ReadonlyArray<Omit<ProductShelf, "products">> = [
  { key: "featured", title: "Featured", subtitle: "High-signal capabilities to start with" },
  { key: "recently_built", title: "Recently Built", subtitle: "Newly productized platform work" },
  { key: "production_ready", title: "Production Ready", subtitle: "Ready to configure or use" },
  { key: "needs_configuration", title: "Needs Configuration", subtitle: "Available after environment setup" },
  { key: "oneshot", title: "Factory: OneShot", subtitle: "Brownfield feature delivery products" },
  { key: "production_support", title: "Factory: Production Support", subtitle: "Support automation and operational AI" },
  { key: "spec_factory", title: "Upcoming / Spec Factory", subtitle: "Next factory capabilities" },
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
  ]
    .join(" ")
    .toLowerCase();
}

export function filterProducts(
  products: ReadonlyArray<ProductCatalogItem>,
  filters: ProductCatalogFilters,
): ProductCatalogItem[] {
  const query = filters.query.trim().toLowerCase();
  return products.filter((product) => {
    if (filters.factory !== "all" && product.factory !== filters.factory) return false;
    if (filters.status !== "all" && product.status !== filters.status) return false;
    return query ? searchableText(product).includes(query) : true;
  });
}

export function buildProductShelves(
  products: ReadonlyArray<ProductCatalogItem>,
): ProductShelf[] {
  return SHELF_DEFINITIONS.map((definition) => ({
    ...definition,
    products: products.filter((product) => product.shelves.includes(definition.key)),
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
```

- [ ] **Step 5: Run the data test and verify it passes**

Run:

```bash
cd dashboard
npm test -- src/product-catalog/catalogData.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit data checkpoint**

```bash
git add dashboard/src/product-catalog/types.ts dashboard/src/product-catalog/catalogData.ts dashboard/src/product-catalog/catalogData.test.ts
git commit -m "Add Product Catalog data model"
```

---

### Task 3: Product Catalog Page Interactions

**Files:**
- Create: `dashboard/src/routes/ProductCatalogPage.test.tsx`
- Create: `dashboard/src/routes/ProductCatalogPage.tsx`
- Create: `dashboard/src/product-catalog/ProductCatalog.css`

- [ ] **Step 1: Write failing page interaction tests**

Create `dashboard/src/routes/ProductCatalogPage.test.tsx`:

```tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProductCatalogPage } from "./ProductCatalogPage.js";

describe("ProductCatalogPage", () => {
  it("renders the Netflix-style product catalog surface", () => {
    render(<ProductCatalogPage />);

    expect(screen.getByRole("main", { name: "Product Catalog" })).toBeTruthy();
    expect(screen.getByText("CoreApp Preview Deployments")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Recently Built" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Jira AI Result Posting/i })).toBeTruthy();
  });

  it("filters products by search", async () => {
    const user = userEvent.setup();
    render(<ProductCatalogPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "jira");

    expect(screen.getByRole("button", { name: /Jira AI Result Posting/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /CoreApp Preview Deployments/i })).toBeFalsy();
  });

  it("filters products by factory tab", async () => {
    const user = userEvent.setup();
    render(<ProductCatalogPage />);

    await user.click(screen.getByRole("button", { name: "Production Support" }));

    expect(screen.getByRole("button", { name: /Jira AI Result Posting/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /OneShot Feature Delivery/i })).toBeFalsy();
  });

  it("opens and closes product details", async () => {
    const user = userEvent.setup();
    render(<ProductCatalogPage />);

    await user.click(screen.getByRole("button", { name: /Jira AI Result Posting/i }));

    const dialog = screen.getByRole("dialog", { name: "Jira AI Result Posting details" });
    expect(within(dialog).getByText("How to configure")).toBeTruthy();
    expect(within(dialog).getByText("Supported versions")).toBeTruthy();
    expect(within(dialog).getByText("Deployment steps")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Jira AI Result Posting details" })).toBeFalsy();
  });

  it("shows an empty state when no products match", async () => {
    const user = userEvent.setup();
    render(<ProductCatalogPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "zzzz-no-match");

    expect(screen.getByText("No products match this view.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reset catalog filters" }));
    expect(screen.getByRole("button", { name: /CoreApp Preview Deployments/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run page test and verify it fails**

Run:

```bash
cd dashboard
npm test -- src/routes/ProductCatalogPage.test.tsx
```

Expected: FAIL because the page component does not exist.

- [ ] **Step 3: Create minimal page implementation**

Create `dashboard/src/routes/ProductCatalogPage.tsx` with:

```tsx
import { useEffect, useMemo, useState } from "react";
import {
  FACTORY_FILTERS,
  STATUS_FILTERS,
  buildProductShelves,
  catalogProducts,
  filterProducts,
  getFeaturedProduct,
} from "../product-catalog/catalogData.js";
import type {
  ProductCatalogItem,
  ProductFactory,
  ProductStatus,
} from "../product-catalog/types.js";
import "../product-catalog/ProductCatalog.css";

const STATUS_LABEL: Record<ProductStatus | "all", string> = {
  all: "All statuses",
  production_ready: "Production ready",
  needs_configuration: "Needs configuration",
  preview: "Preview",
  upcoming: "Upcoming",
};

function crossNavigate(path: "/" | "/oneshot" | "/production-support" | "/watchdog") {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function ProductCard({
  product,
  onSelect,
}: {
  product: ProductCatalogItem;
  onSelect: (product: ProductCatalogItem) => void;
}) {
  return (
    <button
      type="button"
      className="pc-card"
      style={{ background: product.accent.image }}
      onClick={() => onSelect(product)}
      aria-label={`${product.name} product card`}
    >
      <span className="pc-card-shine" />
      <span className="pc-card-title">{product.name}</span>
      <span className="pc-card-meta">
        {product.factory} · {STATUS_LABEL[product.status]}
      </span>
    </button>
  );
}

function DetailSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="pc-detail-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function ProductDetailOverlay({
  product,
  onClose,
}: {
  product: ProductCatalogItem;
  onClose: () => void;
}) {
  return (
    <div className="pc-overlay-backdrop" onClick={onClose}>
      <aside
        className="pc-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`${product.name} details`}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="pc-detail-close" onClick={onClose} aria-label="Close product details">
          ×
        </button>
        <div className="pc-detail-art" style={{ background: product.accent.image }} />
        <div className="pc-detail-body">
          <div className="pc-eyebrow">{product.factory}</div>
          <h2>{product.name}</h2>
          <p>{product.description}</p>
          <div className="pc-detail-badges">
            <span>{STATUS_LABEL[product.status]}</span>
            {product.supportedVersions.slice(0, 2).map((version) => (
              <span key={version}>{version}</span>
            ))}
          </div>
          <DetailSection title="How to configure" items={product.configuration} />
          <DetailSection title="Supported versions" items={product.supportedVersions} />
          <DetailSection title="Deployment steps" items={product.deploymentSteps} />
          <DetailSection title="Dependencies" items={product.dependencies} />
          <DetailSection title="Known limitations" items={product.knownLimitations} />
          {product.evidenceLinks.length > 0 && (
            <section className="pc-detail-section">
              <h3>Evidence and links</h3>
              <div className="pc-links">
                {product.evidenceLinks.map((link) => (
                  <a key={link.href} href={link.href}>
                    {link.label}
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

export function ProductCatalogPage() {
  const [factory, setFactory] = useState<ProductFactory | "all">("all");
  const [status, setStatus] = useState<ProductStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<ProductCatalogItem | null>(null);

  const filteredProducts = useMemo(
    () => filterProducts(catalogProducts, { factory, status, query }),
    [factory, query, status],
  );
  const shelves = useMemo(() => buildProductShelves(filteredProducts), [filteredProducts]);
  const featuredProduct = getFeaturedProduct(filteredProducts) ?? getFeaturedProduct(catalogProducts);

  useEffect(() => {
    if (!selectedProduct) return;
    if (!filteredProducts.some((product) => product.id === selectedProduct.id)) {
      setSelectedProduct(null);
    }
  }, [filteredProducts, selectedProduct]);

  useEffect(() => {
    if (!selectedProduct) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedProduct(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedProduct]);

  const resetFilters = () => {
    setFactory("all");
    setStatus("all");
    setQuery("");
  };

  return (
    <div className="pc-scope">
      <nav className="pc-topbar" aria-label="Product Catalog navigation">
        <button type="button" className="pc-logo" onClick={() => resetFilters()}>
          Product Catalog
        </button>
        <div className="pc-nav-links">
          <button type="button" onClick={() => crossNavigate("/")}>Floor</button>
          <button type="button" onClick={() => crossNavigate("/oneshot")}>OneShot</button>
          <button type="button" onClick={() => crossNavigate("/production-support")}>Production Support</button>
          <button type="button" onClick={() => crossNavigate("/watchdog")}>Watchdog</button>
        </div>
        <label className="pc-search">
          <span>Search products</span>
          <input
            type="search"
            aria-label="Search products"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search products"
          />
        </label>
      </nav>

      <main className="pc-main" aria-label="Product Catalog">
        <div className="pc-filter-row" aria-label="Factory filters">
          {FACTORY_FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              className={factory === item ? "is-active" : ""}
              onClick={() => setFactory(item)}
            >
              {item === "all" ? "All" : item}
            </button>
          ))}
          <select
            aria-label="Status filter"
            value={status}
            onChange={(event) => setStatus(event.target.value as ProductStatus | "all")}
          >
            {STATUS_FILTERS.map((item) => (
              <option key={item} value={item}>
                {STATUS_LABEL[item]}
              </option>
            ))}
          </select>
        </div>

        {featuredProduct && (
          <section className="pc-billboard" style={{ background: featuredProduct.accent.image }}>
            <div className="pc-billboard-content">
              <div className="pc-eyebrow">Featured Product</div>
              <h1>{featuredProduct.name}</h1>
              <p>{featuredProduct.description}</p>
              <div className="pc-billboard-actions">
                <button type="button" onClick={() => setSelectedProduct(featuredProduct)}>
                  View details
                </button>
                <span>{featuredProduct.factory}</span>
                <span>{STATUS_LABEL[featuredProduct.status]}</span>
              </div>
            </div>
          </section>
        )}

        {shelves.length === 0 ? (
          <section className="pc-empty">
            <h2>No products match this view.</h2>
            <button type="button" onClick={resetFilters}>Reset catalog filters</button>
          </section>
        ) : (
          <div className="pc-shelves">
            {shelves.map((shelf) => (
              <section key={shelf.key} className="pc-shelf" aria-label={shelf.title}>
                <div className="pc-shelf-header">
                  <h2>{shelf.title}</h2>
                  <p>{shelf.subtitle}</p>
                </div>
                <div className="pc-row">
                  {shelf.products.map((product) => (
                    <ProductCard key={product.id} product={product} onSelect={setSelectedProduct} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {selectedProduct && (
        <ProductDetailOverlay product={selectedProduct} onClose={() => setSelectedProduct(null)} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add initial CSS import target**

Create `dashboard/src/product-catalog/ProductCatalog.css` with minimal selectors needed for tests and layout. Full Netflix polish happens in Task 4:

```css
.pc-scope {
  min-height: 100vh;
  background: #050505;
  color: #fff;
  font-family: Inter, system-ui, sans-serif;
}

.pc-topbar,
.pc-filter-row,
.pc-row,
.pc-billboard-actions,
.pc-detail-badges,
.pc-nav-links {
  display: flex;
}

.pc-detail {
  background: #111;
}
```

- [ ] **Step 5: Run page interaction test and verify it passes**

Run:

```bash
cd dashboard
npm test -- src/routes/ProductCatalogPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit page interaction checkpoint**

```bash
git add dashboard/src/routes/ProductCatalogPage.tsx dashboard/src/routes/ProductCatalogPage.test.tsx dashboard/src/product-catalog/ProductCatalog.css
git commit -m "Add Product Catalog page interactions"
```

---

### Task 4: Netflix-Style Visual Polish

**Files:**
- Modify: `dashboard/src/product-catalog/ProductCatalog.css`
- Modify: `dashboard/src/routes/ProductCatalogPage.tsx`

- [ ] **Step 1: Replace minimal CSS with production styling**

Update `dashboard/src/product-catalog/ProductCatalog.css` so the screen strongly resembles Netflix:

```css
.pc-scope {
  min-height: 100vh;
  background:
    radial-gradient(circle at 20% 0%, rgba(229, 9, 20, 0.18), transparent 30%),
    linear-gradient(180deg, #050505 0%, #090909 52%, #020202 100%);
  color: #fff;
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow-x: hidden;
}

.pc-topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  height: 68px;
  align-items: center;
  justify-content: space-between;
  gap: 22px;
  padding: 0 44px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.94), rgba(0, 0, 0, 0.58));
  backdrop-filter: blur(16px);
}

.pc-logo {
  border: 0;
  background: transparent;
  color: #e50914;
  font-size: 24px;
  font-weight: 900;
  letter-spacing: -0.03em;
  cursor: pointer;
}

.pc-nav-links {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-right: auto;
}

.pc-nav-links button,
.pc-filter-row button {
  border: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.68);
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}

.pc-nav-links button:hover,
.pc-filter-row button:hover,
.pc-filter-row button.is-active {
  color: #fff;
}

.pc-search {
  display: flex;
  align-items: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.56);
  font-size: 12px;
}

.pc-search span {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.pc-search input {
  width: 230px;
  height: 36px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.58);
  color: #fff;
  padding: 0 12px;
  outline: none;
}

.pc-main {
  padding-bottom: 72px;
}

.pc-filter-row {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 18px 44px 4px;
}

.pc-filter-row select {
  margin-left: auto;
  height: 34px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  background: #0f0f0f;
  color: #fff;
  padding: 0 10px;
}

.pc-billboard {
  position: relative;
  min-height: clamp(360px, 46vw, 560px);
  margin-top: -90px;
  padding: 170px 44px 70px;
  background-size: cover;
  isolation: isolate;
}

.pc-billboard::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background:
    linear-gradient(90deg, rgba(0, 0, 0, 0.92) 0%, rgba(0, 0, 0, 0.58) 42%, rgba(0, 0, 0, 0.08) 100%),
    linear-gradient(0deg, #050505 0%, transparent 34%);
}

.pc-billboard-content {
  max-width: 720px;
}

.pc-eyebrow {
  color: #e50914;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.pc-billboard h1 {
  margin: 12px 0 14px;
  font-size: clamp(44px, 7vw, 84px);
  line-height: 0.92;
  letter-spacing: -0.06em;
}

.pc-billboard p {
  max-width: 640px;
  color: rgba(255, 255, 255, 0.82);
  font-size: 17px;
  line-height: 1.48;
}

.pc-billboard-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 24px;
}

.pc-billboard-actions button {
  height: 42px;
  border: 0;
  border-radius: 4px;
  background: #fff;
  color: #111;
  padding: 0 20px;
  font-weight: 850;
  cursor: pointer;
}

.pc-billboard-actions span,
.pc-detail-badges span {
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 0 10px;
  background: rgba(255, 255, 255, 0.13);
  color: rgba(255, 255, 255, 0.82);
  font-size: 12px;
}

.pc-shelves {
  position: relative;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 28px;
  margin-top: -42px;
}

.pc-shelf {
  padding-left: 44px;
}

.pc-shelf-header {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 10px;
}

.pc-shelf h2 {
  margin: 0;
  font-size: 21px;
  letter-spacing: -0.02em;
}

.pc-shelf p {
  margin: 0;
  color: rgba(255, 255, 255, 0.46);
  font-size: 12px;
}

.pc-row {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  overflow-y: visible;
  padding: 12px 44px 34px 0;
  scrollbar-width: none;
}

.pc-row::-webkit-scrollbar {
  display: none;
}

.pc-card {
  position: relative;
  min-width: 270px;
  height: 152px;
  border: 0;
  border-radius: 4px;
  color: #fff;
  padding: 16px;
  text-align: left;
  overflow: hidden;
  cursor: pointer;
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.45);
  transform-origin: center;
  transition: transform 0.18s ease, box-shadow 0.18s ease, z-index 0.18s ease;
}

.pc-card:hover,
.pc-card:focus-visible {
  z-index: 8;
  transform: scale(1.14);
  box-shadow: 0 28px 70px rgba(0, 0, 0, 0.72);
  outline: 2px solid rgba(255, 255, 255, 0.7);
}

.pc-card::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.76));
}

.pc-card-title,
.pc-card-meta {
  position: relative;
  z-index: 2;
  display: block;
}

.pc-card-title {
  margin-top: 76px;
  font-size: 18px;
  font-weight: 900;
  letter-spacing: -0.03em;
}

.pc-card-meta {
  margin-top: 6px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 12px;
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.pc-card:hover .pc-card-meta,
.pc-card:focus-visible .pc-card-meta {
  opacity: 1;
  transform: translateY(0);
}

.pc-empty {
  margin: 40px 44px;
  padding: 46px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
}

.pc-empty button {
  height: 38px;
  border: 0;
  border-radius: 4px;
  background: #e50914;
  color: #fff;
  padding: 0 14px;
  font-weight: 800;
  cursor: pointer;
}

.pc-overlay-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(0, 0, 0, 0.56);
  display: flex;
  justify-content: flex-end;
  animation: pc-fade 0.16s ease both;
}

.pc-detail {
  width: min(560px, 100vw);
  height: 100vh;
  background: #111;
  overflow-y: auto;
  box-shadow: -28px 0 90px rgba(0, 0, 0, 0.74);
  animation: pc-slide 0.2s ease both;
}

.pc-detail-close {
  position: fixed;
  right: 18px;
  top: 18px;
  z-index: 2;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.78);
  color: #fff;
  font-size: 24px;
  cursor: pointer;
}

.pc-detail-art {
  height: 260px;
  background-size: cover;
}

.pc-detail-body {
  padding: 26px;
}

.pc-detail-body h2 {
  margin: 8px 0 10px;
  font-size: 34px;
  line-height: 1;
  letter-spacing: -0.04em;
}

.pc-detail-body p {
  color: rgba(255, 255, 255, 0.76);
  line-height: 1.5;
}

.pc-detail-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 18px 0 26px;
}

.pc-detail-section {
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding: 18px 0;
}

.pc-detail-section h3 {
  margin: 0 0 10px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.62);
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.pc-detail-section ul {
  margin: 0;
  padding-left: 18px;
  color: rgba(255, 255, 255, 0.84);
}

.pc-links {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pc-links a {
  color: #fff;
  text-decoration-color: rgba(229, 9, 20, 0.8);
}

@keyframes pc-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes pc-slide {
  from { transform: translateX(42px); }
  to { transform: translateX(0); }
}

@media (max-width: 780px) {
  .pc-topbar {
    height: auto;
    align-items: flex-start;
    flex-direction: column;
    padding: 16px 18px;
  }

  .pc-nav-links {
    flex-wrap: wrap;
  }

  .pc-search,
  .pc-search input {
    width: 100%;
  }

  .pc-filter-row,
  .pc-billboard,
  .pc-shelf {
    padding-left: 18px;
    padding-right: 18px;
  }

  .pc-billboard {
    margin-top: 0;
    padding-top: 72px;
  }

  .pc-card {
    min-width: 224px;
  }

  .pc-detail {
    width: 100vw;
  }
}
```

- [ ] **Step 2: Make small JSX adjustments required by final CSS**

If class names differ after implementation, update `ProductCatalogPage.tsx` so all selectors above are used exactly. Preserve accessibility labels from Task 3.

- [ ] **Step 3: Re-run page tests after visual polish**

Run:

```bash
cd dashboard
npm test -- src/routes/ProductCatalogPage.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Commit visual checkpoint**

```bash
git add dashboard/src/product-catalog/ProductCatalog.css dashboard/src/routes/ProductCatalogPage.tsx
git commit -m "Polish Product Catalog Netflix layout"
```

---

### Task 5: Production Support Cross-Link

**Files:**
- Modify: `dashboard/src/production-support/ProductionSupportPage.tsx`
- Modify: `dashboard/src/production-support/ProductionSupportPage.test.tsx`

- [ ] **Step 1: Write failing Production Support navigation test**

Add to `dashboard/src/production-support/ProductionSupportPage.test.tsx`:

```tsx
it("links to Product Catalog from the Specter navigation", async () => {
  render(<ProductionSupportPage />);

  expect(await screen.findByRole("main", { name: "Production Support" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Product Catalog" })).toBeTruthy();
});
```

- [ ] **Step 2: Run the Production Support test and verify it fails**

Run:

```bash
cd dashboard
npm test -- src/production-support/ProductionSupportPage.test.tsx
```

Expected: FAIL because the button is absent.

- [ ] **Step 3: Add Product Catalog side-nav link**

Update `crossNavigate` type:

```ts
function crossNavigate(path: "/" | "/oneshot" | "/production-support" | "/product-catalog" | "/watchdog") {
```

Import `PackageSearch` or `Library` from `lucide-react`, then add a side-nav button in the Specter group:

```tsx
<button type="button" className="ps-nav-item" onClick={() => crossNavigate("/product-catalog")}>
  <PackageSearch size={16} strokeWidth={1.8} />
  <span>Product Catalog</span>
</button>
```

- [ ] **Step 4: Run Production Support test and verify it passes**

Run:

```bash
cd dashboard
npm test -- src/production-support/ProductionSupportPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit cross-link checkpoint**

```bash
git add dashboard/src/production-support/ProductionSupportPage.tsx dashboard/src/production-support/ProductionSupportPage.test.tsx
git commit -m "Link Product Catalog from support console"
```

---

### Task 6: Full Verification And Browser Review

**Files:**
- No planned source changes unless verification finds a defect.

- [ ] **Step 1: Run focused dashboard tests**

Run:

```bash
cd dashboard
npm test -- src/App.test.tsx src/product-catalog/catalogData.test.ts src/routes/ProductCatalogPage.test.tsx src/production-support/ProductionSupportPage.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run dashboard build**

Run:

```bash
cd dashboard
npm run build
```

Expected: PASS.

- [ ] **Step 3: Start local dashboard**

Run:

```bash
cd dashboard
npm run dev
```

Expected: Vite and dashboard server start; open `/product-catalog`.

- [ ] **Step 4: Browser review**

Open the local dashboard Product Catalog route and verify:

- The first viewport has a Netflix-like black surface.
- The hero billboard dominates the first view.
- Product shelves scroll horizontally.
- Hovering a card enlarges it and reveals metadata.
- Selecting a card opens the detail overlay.
- Search and factory/status filters work.
- Mobile width does not overlap text or controls.

- [ ] **Step 5: Final quality checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional source changes.

- [ ] **Step 6: Final implementation commit if needed**

If verification required fixes after the previous task commits:

```bash
git add dashboard/src docs/superpowers
git commit -m "Verify Product Catalog screen"
```

Expected: clean working tree except ignored local artifacts.
