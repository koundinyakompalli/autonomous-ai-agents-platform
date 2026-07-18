import { describe, expect, it } from "vitest";
import {
  buildProductCatalogFromRows,
  type ProductCatalogBuildInput,
} from "./productCatalog.js";

const baseInput: ProductCatalogBuildInput = {
  generatedAt: new Date("2026-05-18T19:00:00Z"),
  repositories: [
    {
      id: 1,
      repoName: "core-app",
      repoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      description: "Core MedHOK monorepo",
      defaultBranch: "master",
      createdAt: "2026-01-26T08:47:51Z",
      oneshotRuns: 40,
      recentOneshotRuns: 23,
      latestRunUpdatedAt: "2026-05-18T18:50:15Z",
      candidateVersions: 13,
      latestCandidateAt: "2026-05-18T18:41:37Z",
      routerDecisions: 600,
      recentRouterDecisions: 535,
    },
    {
      id: 6,
      repoName: "Ai-agents",
      repoUrl: "https://github.com/mhk-repos/enterprise-ai-agent-platform.git",
      description: "AI Agents platform repository",
      defaultBranch: "master",
      createdAt: "2026-01-26T08:47:51Z",
      oneshotRuns: 0,
      recentOneshotRuns: 0,
      latestRunUpdatedAt: null,
      candidateVersions: 0,
      latestCandidateAt: null,
      routerDecisions: 0,
      recentRouterDecisions: 0,
    },
  ],
  runGroups: [],
  recentRuns: [
    {
      id: 172,
      runGroupId: null,
      repoId: 1,
      jiraKey: "CPDEV-22733",
      state: "pr_open",
      branchName: "master",
      implementationBranch: "oneshot/cpdev-22733-run-172",
      prUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1866",
      createdAt: "2026-05-18T18:16:12Z",
      updatedAt: "2026-05-18T18:50:15Z",
      repoName: "core-app",
      repoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      defaultBranch: "master",
      customerName: "MHK",
      planVersion: 2,
      implementationVersion: 3,
      codeReviewVersion: 1,
      testVersion: 1,
      taskDescription:
        "# Task: CPDEV-22733 Reset Reason Code\n\n## Executive Summary\nWhen an external AI agent user claims a case, the `reason_code` field must be reset for the latest release log entry in the same transaction as the claim operation.\n\n## Problem Statement\nThe claim flow currently leaves stale release reason data behind after a case is claimed.",
      indexedText: null,
    },
  ],
  candidateVersions: [
    {
      repoId: 1,
      oneshotRunId: 172,
      jiraKey: "CPDEV-22733",
      candidateVersion: 1,
      status: "current",
      candidateSha: "deadbeef1234",
      createdAt: "2026-05-18T18:41:37Z",
    },
  ],
  routerTickets: [
    {
      repoId: 1,
      ticketId: "CPDEV-22733",
      outcome: "auto_selected",
      decidedAt: "2026-05-18T18:16:12Z",
    },
  ],
  customerBranches: [
    { customer: "BCBSMA CP", branch: "3.18", isDefault: false },
    { customer: "MHK", branch: "master", isDefault: true },
  ],
  taskCounts: [
    {
      taskType: "DARCI",
      status: "completed",
      count: 984,
      latestUpdate: "2026-05-19T02:30:51Z",
    },
  ],
  recentTasks: [
    {
      id: 2566,
      jiraNumber: "CPSUP-47626",
      status: "posted_to_jira",
      taskType: "DEFECT",
      source: "jira",
      agentName: "DARCI",
      customer: "MHK",
      updatedAt: "2026-05-19T02:31:11Z",
      jiraPostedAt: "2026-05-19T02:31:11Z",
      taskDescription:
        "# Task: CPSUP-47626 Arabic Writing Direction Issue\n\n## Executive Summary\nCVS/Caremark is experiencing a bug in UAT1 where Arabic text displays correctly for single-paragraph content but breaks when denial reason text contains two or more paragraphs. Deep technical analysis identified the root cause as a gap in paragraph-level BiDi rendering for generated letters.\n\n## Problem Statement\nArabic text rendered via the `DER.AltLangText` mail merge tag flips from RTL to LTR and characters become jumbled when the denial reason contains multiple paragraphs.",
    },
    {
      id: 2557,
      jiraNumber: "CPSUP-47948",
      status: "failed",
      taskType: "DEFECT",
      source: "jira",
      agentName: "RIFT",
      customer: "RX - Pharmacy",
      updatedAt: "2026-05-19T06:32:29Z",
      jiraPostedAt: null,
      taskDescription:
        "# Task: CPSUP-47948 Failed analysis\n\n## Problem Statement\nThis failed run should not be shown in Product Catalog.",
    },
  ],
};

describe("buildProductCatalogFromRows", () => {
  it("exposes PR-producing OneShot outcomes and completed Production Support stories", () => {
    const catalog = buildProductCatalogFromRows(baseInput);

    expect(catalog.products.map((product) => product.id)).toEqual(
      ["oneshot-ticket-172-cpdev-22733", "production-support-task-2566-cpsup-47626"],
    );
    const oneShotProducts = catalog.products.filter((product) => product.factory === "OneShot");
    expect(oneShotProducts.every((product) => product.recentTickets?.some((ticket) => ticket.prUrl))).toBe(true);
    expect(oneShotProducts[0]?.shelves).toContain("top_picks");
    expect(oneShotProducts[0]?.featured).toBe(true);
    const supportStory = catalog.products.find(
      (product) => product.id === "production-support-task-2566-cpsup-47626",
    );
    expect(supportStory?.factory).toBe("Production Support");
    expect(supportStory?.shelves).toContain("production_support");
    expect(supportStory?.supportInsight).toEqual({
      defectDescription:
        "Arabic text rendered via the `DER.AltLangText` mail merge tag flips from RTL to LTR and characters become jumbled when the denial reason contains multiple paragraphs.",
      rootCause:
        "Deep technical analysis identified the root cause as a gap in paragraph-level BiDi rendering for generated letters.",
    });
    expect(supportStory?.recentTickets?.[0]).toEqual(
      expect.objectContaining({
        key: "CPSUP-47626",
        source: "task",
        state: "posted_to_jira",
      }),
    );
    expect(catalog.products.find((product) => product.id === "production-support-task-2557-cpsup-47948")).toBeUndefined();
    expect(catalog.products.find((product) => product.id === "repo-1-core-app")).toBeUndefined();
    expect(catalog.products.find((product) => product.id === "live-oneshot-delivery")).toBeUndefined();
    expect(catalog.summary.repositoryCount).toBe(2);
    expect(catalog.summary.customerBranchCount).toBe(2);
    expect(catalog.summary.successfulOutcomeCount).toBe(1);
  });

  it("promotes successful ticket-level OneShot runs to software outcome tiles", () => {
    const catalog = buildProductCatalogFromRows(baseInput);
    const outcome = catalog.products.find(
      (product) => product.id === "oneshot-ticket-172-cpdev-22733",
    );

    expect(outcome?.name).toBe("CPDEV-22733");
    expect(outcome?.contentType).toBe("feature");
    expect(outcome?.tagline).toBe("Feature - core-app on master.");
    expect(outcome?.description).toContain(
      "external AI agent user claims a case",
    );
    expect(outcome?.storyDescription).toContain(
      "same transaction as the claim operation",
    );
    expect(outcome?.storyDescription).toContain("reason_code");
    expect(outcome?.repository?.name).toBe("core-app");
    expect(outcome?.shelves).toEqual(
      expect.arrayContaining([
        "oneshot_tickets",
        "oneshot",
        "trending",
        "recently_added",
        "repo:core-app",
      ]),
    );
    expect(outcome?.supportedVersions).toEqual(
      expect.arrayContaining([
        "Target branch: master",
        "Implementation branch: oneshot/cpdev-22733-run-172",
        "Plan v2",
        "Implementation v3",
      ]),
    );
    expect(outcome?.recentTickets).toEqual([
      expect.objectContaining({
        key: "CPDEV-22733",
        source: "oneshot",
        prUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1866",
      }),
    ]);
    expect(outcome?.deploymentActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Build and deploy",
          kind: "jenkins",
          href: "https://dev.medhokapps.com/hudson/job/git-master-core-build/",
        }),
        expect.objectContaining({
          label: "View PR",
          kind: "github",
          href: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1866",
        }),
        expect.objectContaining({
          label: "Preview",
          kind: "preview",
          href: "https://devaccountqa.mhkdevsandbox.com/cas/login?service=https%3A%2F%2Fclient-a-cp-dev-mhk-core.mhkdevsandbox.com%2Fmedhok%2F",
        }),
      ]),
    );
  });

  it("classifies ticket-level outcome badges from software delivery signals", () => {
    const catalog = buildProductCatalogFromRows({
      ...baseInput,
      repositories: [
        ...baseInput.repositories,
        {
          id: 9,
          repoName: "interop",
          repoUrl: "https://github.com/mhk-repos/cp-medhok-interop.git",
          description: "Integration repository",
          defaultBranch: "main",
          createdAt: "2026-01-26T08:47:51Z",
          oneshotRuns: 2,
          recentOneshotRuns: 2,
          latestRunUpdatedAt: "2026-05-18T18:50:15Z",
          candidateVersions: 0,
          latestCandidateAt: null,
          routerDecisions: 0,
          recentRouterDecisions: 0,
        },
      ],
      recentRuns: [
        {
          ...baseInput.recentRuns[0],
          id: 201,
          repoId: 9,
          jiraKey: "CPDEV-22001",
          branchName: "main",
          implementationBranch: "oneshot/cpdev-22001-integration",
          prUrl: "https://github.com/mhk-repos/cp-medhok-interop/pull/12",
          repoName: "interop",
          repoUrl: "https://github.com/mhk-repos/cp-medhok-interop.git",
          defaultBranch: "main",
        },
        {
          ...baseInput.recentRuns[0],
          id: 202,
          jiraKey: "CPDEV-22002",
          branchName: "hotfix/cpdev-22002",
          implementationBranch: "oneshot/cpdev-22002-bugfix",
          prUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1902",
        },
      ],
    });

    expect(
      catalog.products.find((product) => product.id === "oneshot-ticket-201-cpdev-22001")
        ?.contentType,
    ).toBe("integration");
    expect(
      catalog.products.find((product) => product.id === "oneshot-ticket-202-cpdev-22002")
        ?.contentType,
    ).toBe("fix");
  });

  it("includes completed OneShot rows when they have generated PR URLs", () => {
    const catalog = buildProductCatalogFromRows({
      ...baseInput,
      recentRuns: [
        {
          ...baseInput.recentRuns[0],
          id: 74,
          jiraKey: "CPDEV-21090",
          state: "completed",
          prUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1454",
        },
        {
          ...baseInput.recentRuns[0],
          id: 75,
          jiraKey: "CPDEV-21091",
          state: "completed",
          prUrl: null,
        },
      ],
    });

    expect(catalog.products.map((product) => product.id)).toEqual([
      "oneshot-ticket-74-cpdev-21090",
      "production-support-task-2566-cpsup-47626",
    ]);
    expect(catalog.summary.successfulOutcomeCount).toBe(1);
  });

  it("promotes the newest PR-producing OneShot outcomes into Top Picks", () => {
    const catalog = buildProductCatalogFromRows({
      ...baseInput,
      recentRuns: Array.from({ length: 12 }, (_, index) => ({
        ...baseInput.recentRuns[0],
        id: 300 + index,
        jiraKey: `CPDEV-23${String(index).padStart(3, "0")}`,
        prUrl: `https://github.com/mhk-repos/cp-medhok-monorepo/pull/${1900 + index}`,
        updatedAt: `2026-05-18T18:${String(index).padStart(2, "0")}:00Z`,
      })),
    });

    expect(catalog.products.filter((product) => product.factory === "OneShot")).toHaveLength(12);
    expect(catalog.products[0]?.id).toBe("oneshot-ticket-311-cpdev-23011");
    expect(catalog.products[0]?.featured).toBe(true);
    const oneShotProducts = catalog.products.filter((product) => product.factory === "OneShot");
    expect(oneShotProducts.slice(0, 10).every((product) => product.shelves.includes("top_picks"))).toBe(true);
    expect(oneShotProducts.slice(10).every((product) => !product.shelves.includes("top_picks"))).toBe(true);
  });

  it("falls back to indexed ticket text when linked task text is unavailable", () => {
    const catalog = buildProductCatalogFromRows({
      ...baseInput,
      recentRuns: [
        {
          ...baseInput.recentRuns[0],
          id: 203,
          jiraKey: "CPDEV-22003",
          taskDescription: null,
          indexedText:
            "Summary: Route repository evidence into the Product Catalog drawer so reviewers can see why a story belongs to a product tile.",
        },
      ],
    });

    expect(
      catalog.products.find((product) => product.id === "oneshot-ticket-203-cpdev-22003")
        ?.storyDescription,
    ).toBe(
      "Route repository evidence into the Product Catalog drawer so reviewers can see why a story belongs to a product tile.",
    );
  });

  it("keeps grouped successful OneShot runs as individual task tiles", () => {
    const catalog = buildProductCatalogFromRows({
      ...baseInput,
      runGroups: [
        {
          id: 42,
          jiraKey: "CPDEV-EPIC",
          status: "completed",
          createdAt: "2026-05-17T14:00:00Z",
          updatedAt: "2026-05-18T18:59:00Z",
        },
      ],
      recentRuns: [
        ...baseInput.recentRuns,
        {
          id: 173,
          runGroupId: 42,
          repoId: 1,
          jiraKey: "CPDEV-22734",
          state: "pr_open",
          branchName: "master",
          implementationBranch: "oneshot/cpdev-22734-run-173",
          prUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1867",
          createdAt: "2026-05-18T17:10:00Z",
          updatedAt: "2026-05-18T18:20:00Z",
          repoName: "core-app",
          repoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          defaultBranch: "master",
          customerName: "MHK",
          planVersion: 1,
          implementationVersion: 1,
          codeReviewVersion: 1,
          testVersion: 1,
        },
        {
          id: 174,
          runGroupId: 42,
          repoId: 1,
          jiraKey: "CPDEV-22735",
          state: "pr_open",
          branchName: "master",
          implementationBranch: "oneshot/cpdev-22735-run-174",
          prUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1868",
          createdAt: "2026-05-18T17:20:00Z",
          updatedAt: "2026-05-18T18:30:00Z",
          repoName: "core-app",
          repoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          defaultBranch: "master",
          customerName: "MHK",
          planVersion: 1,
          implementationVersion: 1,
          codeReviewVersion: 1,
          testVersion: 1,
        },
        {
          id: 175,
          runGroupId: 42,
          repoId: 1,
          jiraKey: "CPDEV-22736",
          state: "failed",
          branchName: "master",
          implementationBranch: null,
          prUrl: null,
          createdAt: "2026-05-18T17:30:00Z",
          updatedAt: "2026-05-18T18:40:00Z",
          repoName: "core-app",
          repoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          defaultBranch: "master",
          customerName: "MHK",
          planVersion: null,
          implementationVersion: null,
          codeReviewVersion: null,
          testVersion: null,
        },
      ],
    });
    expect(catalog.products.filter((product) => product.factory === "OneShot").map((product) => product.id)).toEqual([
      "oneshot-ticket-172-cpdev-22733",
      "oneshot-ticket-174-cpdev-22735",
      "oneshot-ticket-173-cpdev-22734",
    ]);
    expect(
      catalog.products.find(
        (product) => product.id === "oneshot-epic-42-cpdev-epic",
      ),
    ).toBeUndefined();
    const latestGroupedTicket = catalog.products.find(
      (product) => product.id === "oneshot-ticket-174-cpdev-22735",
    );

    expect(latestGroupedTicket?.name).toBe("CPDEV-22735");
    expect(latestGroupedTicket?.contentType).toBe("feature");
    expect(latestGroupedTicket?.shelves).toEqual(
      expect.arrayContaining(["oneshot_tickets", "oneshot", "repo:core-app"]),
    );
    expect(latestGroupedTicket?.recentTickets?.map((ticket) => ticket.key)).toEqual([
      "CPDEV-22735",
    ]);
    expect(latestGroupedTicket?.deploymentActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Build and deploy",
          kind: "jenkins",
        }),
        expect.objectContaining({
          label: "View PR",
          kind: "github",
          href: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1868",
        }),
        expect.objectContaining({
          label: "Preview",
          kind: "preview",
        }),
      ]),
    );
  });
});
