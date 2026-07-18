// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProductCatalogItem,
  ProductCatalogResponse,
} from "../product-catalog/types.js";
import { ProductCatalogPage } from "./ProductCatalogPage.js";

beforeEach(() => {
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function firstProductCard(name: RegExp) {
  const [button] = screen.getAllByRole("button", { name });
  expect(button).toBeTruthy();
  return button;
}

function outputProduct(
  overrides: Partial<ProductCatalogItem> = {},
): ProductCatalogItem {
  return {
    id: "oneshot-ticket-172-cpdev-22733",
    name: "CPDEV-22733",
    tagline: "Feature - core-app on master.",
    description: "Successful OneShot ticket outcome.",
    factory: "OneShot",
    status: "production_ready",
    domains: ["Repository Intelligence", "Feature Delivery"],
    shelves: ["oneshot_tickets", "trending", "recently_added", "repo:core-app"],
    supportedVersions: [
      "Target branch: master",
      "Implementation branch: oneshot/cpdev-22733-run-172",
    ],
    configuration: ["Repository profile #1", "OneShot run #172"],
    deploymentSteps: ["Route ticket", "Open PR"],
    deploymentActions: [
      {
        label: "Build and deploy",
        href: "https://dev.medhokapps.com/hudson/job/git-master-core-build/",
        kind: "jenkins",
      },
      {
        label: "View PR",
        href: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1866",
        kind: "github",
      },
      {
        label: "Preview",
        href: "https://devaccountqa.mhkdevsandbox.com/cas/login?service=https%3A%2F%2Fclient-a-cp-dev-mhk-core.mhkdevsandbox.com%2Fmedhok%2F",
        kind: "preview",
      },
    ],
    dependencies: ["code_repositories", "oneshot_runs"],
    evidenceLinks: [],
    knownLimitations: [],
    lastUpdated: "2026-05-18",
    contentType: "feature",
    storyDescription:
      "When an external AI agent user claims a case, the reason code must be reset for the latest release log entry in the same transaction as the claim operation.",
    accent: {
      primary: "#e50914",
      secondary: "#450a0a",
      image: "linear-gradient(135deg, #120507 0%, #7f1d1d 48%, #050505 100%)",
    },
    repository: {
      id: 1,
      name: "core-app",
      url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      defaultBranch: "master",
    },
    metrics: {
      oneshotRuns: 40,
      recentOneshotRuns: 23,
      candidateVersions: 13,
      routerDecisions: 600,
      recentRouterDecisions: 535,
    },
    recentTickets: [
      {
        key: "CPDEV-22733",
        source: "oneshot",
        state: "pr_open",
        branch: "master",
        prUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1866",
        updatedAt: "2026-05-18T18:50:15.000Z",
      },
    ],
    ...overrides,
  };
}

function supportReel(
  overrides: Partial<ProductCatalogItem> = {},
): ProductCatalogItem {
  return {
    id: "production-support-task-2566-cpsup-47626",
    name: "CPSUP-47626",
    tagline: "DARCI - posted to Jira",
    description:
      "Production Support task CPSUP-47626 was handled by DARCI and posted back to Jira.",
    factory: "Production Support",
    status: "production_ready",
    domains: ["Support Operations", "Jira Automation"],
    shelves: ["production_support", "recently_added", "production_ready"],
    supportedVersions: ["Agent: DARCI", "Task type: DEFECT", "Customer: MHK"],
    configuration: ["Task management row #2566", "Source: jira"],
    deploymentSteps: ["Open Jira ticket", "Review posted support note"],
    dependencies: ["agents", "task_management", "Jira API"],
    evidenceLinks: [
      {
        label: "CPSUP-47626",
        href: "https://mhkjira.atlassian.net/browse/CPSUP-47626",
        kind: "jira",
      },
    ],
    knownLimitations: [
      "Production Support stories reflect the sampled task_management activity.",
    ],
    supportInsight: {
      defectDescription:
        "Arabic text rendered via DER.AltLangText flips from RTL to LTR when denial text contains multiple paragraphs.",
      rootCause:
        "Root cause was identified as a gap in paragraph-level BiDi rendering for generated letters.",
    },
    lastUpdated: "2026-05-19",
    accent: {
      primary: "#f97316",
      secondary: "#431407",
      image: "linear-gradient(135deg, #170a04 0%, #9a3412 48%, #050505 100%)",
    },
    metrics: {
      taskCount: 1,
    },
    recentTickets: [
      {
        key: "CPSUP-47626",
        source: "task",
        state: "posted_to_jira",
        branch: "MHK",
        updatedAt: "2026-05-19T02:31:11.000Z",
      },
    ],
    ...overrides,
  };
}

function mockCatalog(products: ProductCatalogItem[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async (): Promise<ProductCatalogResponse> => ({
        generatedAt: "2026-05-18T19:00:00.000Z",
        summary: {
          repositoryCount: 1,
          customerBranchCount: 2,
          recentTicketCount: products.length,
          oneshotRunCount: 40,
          successfulOutcomeCount: products.length,
          ticketOutcomeCount: products.length,
          epicOutcomeCount: 0,
          taskCount: 984,
        },
        products,
      }),
    } as Response),
  );
}

describe("ProductCatalogPage", () => {
  it("renders the RDS-backed catalog shell without curated fallback tiles", () => {
    render(<ProductCatalogPage />);

    expect(screen.getByRole("main", { name: "Product Catalog" })).toBeTruthy();
    expect(screen.queryByText("CoreApp Preview Deployments")).toBeFalsy();
    expect(screen.queryByText("Jira AI Result Posting")).toBeFalsy();
    expect(screen.getByText("No products match this view.")).toBeTruthy();
  });

  it("renders live RDS catalog products when the API responds", async () => {
    mockCatalog([
      outputProduct(),
      supportReel(),
      {
        ...outputProduct({
          id: "live-oneshot-delivery",
          name: "Live OneShot Delivery",
          contentType: undefined,
          recentTickets: [],
        }),
      },
    ]);

    render(<ProductCatalogPage />);

    expect((await screen.findAllByRole("button", { name: /CPDEV-22733 product card/i })).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("region", { name: "Production Support Stories" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /CPSUP-47626 production support story/i }),
    ).toBeTruthy();
    const supportStory = screen.getByRole("button", {
      name: /CPSUP-47626 production support story/i,
    });
    expect(supportStory.querySelector(".pc-reel-status")?.textContent).toBe("DARCI");
    expect(
      screen.getByRole("heading", { name: "Preview before Merge" }),
    ).toBeTruthy();
    expect(screen.getByText(/Feature introduced in OneShot/i)).toBeTruthy();
    expect(screen.getByRole("region", { name: "OneShot Tickets" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Repo: core-app" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Preview before Merge product card/i }),
    ).toBeFalsy();
    expect(screen.getAllByText("Feature").length).toBeGreaterThan(0);
    expect(
      firstProductCard(/CPDEV-22733/i).getAttribute("style"),
    ).toContain("/product-catalog/tiles/");
    expect(screen.queryByText("Movie")).toBeFalsy();
    expect(screen.queryByText("Series")).toBeFalsy();
    expect(screen.getByText("Live RDS")).toBeTruthy();
  });

  it("opens Production Support story details with defect and root-cause analysis", async () => {
    mockCatalog([outputProduct(), supportReel()]);

    render(<ProductCatalogPage />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /CPSUP-47626 production support story/i,
      }),
    );

    const dialog = screen.getByRole("dialog", { name: "CPSUP-47626 details" });
    expect(within(dialog).getByText("DARCI - posted to Jira")).toBeTruthy();
    expect(within(dialog).getByText("Production ready")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Defect" })).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Arabic text rendered via DER.AltLangText flips from RTL to LTR when denial text contains multiple paragraphs.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Root cause" })).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Root cause was identified as a gap in paragraph-level BiDi rendering for generated letters.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "CPSUP-47626" })).toBeTruthy();
  });

  it("shows deployment action buttons for OneShot outcome tiles", async () => {
    mockCatalog([outputProduct()]);

    render(<ProductCatalogPage />);

    fireEvent.click(
      (await screen.findAllByRole("button", { name: /CPDEV-22733 product card/i }))[0],
    );

    const dialog = screen.getByRole("dialog", { name: "CPDEV-22733 details" });
    expect(within(dialog).getByText("Story")).toBeTruthy();
    expect(
      within(dialog).getByText(/external AI agent user claims a case/i),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("link", { name: /Build and deploy/i }).getAttribute("href"),
    ).toBe("https://dev.medhokapps.com/hudson/job/git-master-core-build/");
    expect(
      within(dialog).getByRole("link", { name: /View PR/i }).getAttribute("href"),
    ).toBe("https://github.com/mhk-repos/cp-medhok-monorepo/pull/1866");
    expect(
      within(dialog).getByRole("link", { name: /Preview/i }).getAttribute("href"),
    ).toBe(
      "https://devaccountqa.mhkdevsandbox.com/cas/login?service=https%3A%2F%2Fclient-a-cp-dev-mhk-core.mhkdevsandbox.com%2Fmedhok%2F",
    );
  });

  it("filters products by search", async () => {
    mockCatalog([
      outputProduct(),
      outputProduct({
        id: "oneshot-ticket-168-cpdev-22651",
        name: "CPDEV-22651",
        tagline: "Fix - cp-batch on master.",
        contentType: "fix",
      }),
    ]);
    render(<ProductCatalogPage />);

    await screen.findAllByRole("button", { name: /CPDEV-22733 product card/i });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search products" }), {
      target: { value: "22651" },
    });

    expect(firstProductCard(/CPDEV-22651/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /CPDEV-22733/i }),
    ).toBeFalsy();
  });

  it("keeps output tiles visible under the OneShot factory filter", async () => {
    mockCatalog([outputProduct()]);
    render(<ProductCatalogPage />);

    await screen.findAllByRole("button", { name: /CPDEV-22733 product card/i });
    fireEvent.click(screen.getByRole("button", { name: "OneShot" }));

    expect(firstProductCard(/CPDEV-22733/i)).toBeTruthy();
  });

  it("opens and closes product details", async () => {
    mockCatalog([outputProduct()]);
    render(<ProductCatalogPage />);

    fireEvent.click(
      (await screen.findAllByRole("button", { name: /CPDEV-22733 product card/i }))[0],
    );

    const dialog = screen.getByRole("dialog", {
      name: "CPDEV-22733 details",
    });
    expect(within(dialog).getByText("How to configure")).toBeTruthy();
    expect(within(dialog).getByText("Supported versions")).toBeTruthy();
    expect(within(dialog).getByText("Deployment steps")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", {
        name: "CPDEV-22733 details",
      }),
    ).toBeFalsy();
  });

  it("shows an empty state when no products match", async () => {
    mockCatalog([outputProduct()]);
    render(<ProductCatalogPage />);

    await screen.findAllByRole("button", { name: /CPDEV-22733 product card/i });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search products" }), {
      target: { value: "zzzz-no-match" },
    });

    expect(screen.getByText("No products match this view.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset catalog filters" }));
    expect(firstProductCard(/CPDEV-22733/i)).toBeTruthy();
  });
});
