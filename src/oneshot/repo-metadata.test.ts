import { describe, expect, it } from "vitest";
import {
  AI_AGENTS_REPO_SLUG,
  buildDraftRepoCardsFromInventory,
  dedupeOneShotEnabledRepos,
  getOneShotRepoMetadata,
  getRepoMentionTokens,
  isMpRepository,
  isOneShotMetadataPrepCandidate,
  isOneShotRepoEnabled,
  ONE_SHOT_REPO_METADATA,
} from "./repo-metadata.js";

describe("OneShot repo metadata", () => {
  it("enables recognized non-MP repos and keeps MP repos disabled", () => {
    expect(
      isOneShotRepoEnabled({
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      }),
    ).toBe(true);
    expect(
      isOneShotRepoEnabled({
        repo_name: "interop",
        repo_url:
          "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
      }),
    ).toBe(true);
    expect(
      isOneShotRepoEnabled({
        repo_name: "data-visor",
        repo_url: "https://github.com/mhk-repos/cp-datalake-pipeline.git",
      }),
    ).toBe(true);
    expect(
      isOneShotRepoEnabled({
        repo_name: "cp-medhok-bi-datamart-monorepo",
        repo_url:
          "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git",
      }),
    ).toBe(true);
    expect(
      isOneShotRepoEnabled({
        repo_name: "BI-datamart",
        repo_url:
          "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git",
      }),
    ).toBe(true);
    expect(
      isOneShotRepoEnabled({
        repo_name: "React-based-new-ui",
        repo_url: "https://github.com/mhk-repos/cp-mhk-smart-prominence.git",
      }),
    ).toBe(true);
    expect(
      isOneShotRepoEnabled({
        repo_name: "Document-ai",
        repo_url: "https://github.com/mhk-repos/document-ai.git",
      }),
    ).toBe(true);
    expect(
      isOneShotRepoEnabled({
        repo_name: "Ai-agents",
        repo_url:
          "https://github.com/mhk-repos/enterprise-ai-agent-platform.git",
      }),
    ).toBe(true);
    expect(
      isOneShotRepoEnabled({
        repo_name: "cp-autonomous-ai-agents-platform",
        repo_url:
          "https://github.com/mhk-repos/cp-autonomous-ai-agents-platform.git",
      }),
    ).toBe(true);

    const mpRepo = {
      repo_name: "mp-web",
      repo_url: "https://github.com/mhk-repos/mp-web.git",
    };

    expect(isMpRepository(mpRepo)).toBe(true);
    expect(isOneShotRepoEnabled(mpRepo)).toBe(false);
    expect(
      isOneShotRepoEnabled({
        repo_name: "mp-product-client-configs",
        repo_url: "https://github.com/mhk-repos/mp-product-client-configs.git",
      }),
    ).toBe(false);
    expect(
      ONE_SHOT_REPO_METADATA.filter(
        (metadata) => metadata.productFamily !== "mp",
      ).map((metadata) => metadata.repoName),
    ).toHaveLength(11);
    expect(
      ONE_SHOT_REPO_METADATA.filter(
        (metadata) => metadata.productFamily !== "mp",
      ).every((metadata) => metadata.oneshotEnabled),
    ).toBe(true);
  });

  it("exposes the Ai-agents canonical slug", () => {
    expect(AI_AGENTS_REPO_SLUG).toBe("enterprise-ai-agent-platform");
    const meta = getOneShotRepoMetadata({
      repo_name: "Ai-agents",
      repo_url:
        "https://github.com/mhk-repos/enterprise-ai-agent-platform.git",
    });
    expect(meta?.githubSlug).toBe(AI_AGENTS_REPO_SLUG);
    expect(meta?.oneshotEnabled).toBe(true);
  });

  it("maps stale BI Datamart DB names to canonical metadata by GitHub slug", () => {
    expect(
      getOneShotRepoMetadata({
        repo_name: "BI-datamart",
        repo_url:
          "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git",
      })?.repoName,
    ).toBe("cp-medhok-bi-datamart-monorepo");
  });

  it("prefers GitHub slug when a stale DB name points at a different AI repo", () => {
    expect(
      getOneShotRepoMetadata({
        repo_name: "Ai-agents",
        repo_url:
          "https://github.com/mhk-repos/cp-autonomous-ai-agents-platform.git",
      })?.repoName,
    ).toBe("cp-autonomous-ai-agents-platform");
  });

  it("dedupes enabled repos by canonical OneShot identity and prefers canonical DB names", () => {
    const repos = dedupeOneShotEnabledRepos([
      {
        id: 17,
        repo_name: "cp-medhok-monorepo",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      },
      {
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      },
      {
        id: 16,
        repo_name: "BI-datamart",
        repo_url:
          "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git",
      },
      {
        id: 20,
        repo_name: "cp-medhok-bi-datamart-monorepo",
        repo_url:
          "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git",
      },
    ]);

    expect(repos.map((repo) => [repo.id, repo.repo_name])).toEqual([
      [1, "core-app"],
      [20, "cp-medhok-bi-datamart-monorepo"],
    ]);
  });

  it("matches reviewed repository metadata case-insensitively", () => {
    expect(
      isOneShotRepoEnabled({
        repo_name: "CORE-APP",
        repo_url: "https://github.com/mhk-repos/CP-MEDHOK-MONOREPO.git",
      }),
    ).toBe(true);
    expect(
      isMpRepository({
        repo_name: "MP-WEB",
        repo_url: "https://github.com/mhk-repos/MP-WEB.git",
      }),
    ).toBe(true);
  });

  it("excludes mp repos from OneShot metadata prep candidates", () => {
    expect(isOneShotMetadataPrepCandidate({ name: "cp-new-service" })).toBe(
      true,
    );
    expect(isOneShotMetadataPrepCandidate({ name: "document-ai" })).toBe(true);
    expect(
      isOneShotMetadataPrepCandidate({ name: "enterprise-ai-agent-platform" }),
    ).toBe(true);
    expect(
      isOneShotMetadataPrepCandidate({ name: "mp-product-client-configs" }),
    ).toBe(false);
  });

  it("builds draft cards from GitHub inventory without enabling unreviewed cp repos", () => {
    const cards = buildDraftRepoCardsFromInventory([
      {
        name: "cp-medhok-monorepo",
        fullName: "mhk-repos/cp-medhok-monorepo",
        htmlUrl: "https://github.com/mhk-repos/cp-medhok-monorepo",
        defaultBranch: "master",
      },
      {
        name: "cp-new-service",
        fullName: "mhk-repos/cp-new-service",
        htmlUrl: "https://github.com/mhk-repos/cp-new-service",
      },
      {
        name: "cp-interoperability-monorepo",
        fullName: "mhk-repos/cp-interoperability-monorepo",
        htmlUrl: "https://github.com/mhk-repos/cp-interoperability-monorepo",
      },
      {
        name: "cp-datalake-pipeline",
        fullName: "mhk-repos/cp-datalake-pipeline",
        htmlUrl: "https://github.com/mhk-repos/cp-datalake-pipeline",
      },
      {
        name: "cp-medhok-bi-datamart-monorepo",
        fullName: "mhk-repos/cp-medhok-bi-datamart-monorepo",
        htmlUrl: "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo",
        defaultBranch: "master",
      },
      {
        name: "cp-mhk-smart-prominence",
        fullName: "mhk-repos/cp-mhk-smart-prominence",
        htmlUrl: "https://github.com/mhk-repos/cp-mhk-smart-prominence",
        defaultBranch: "master",
      },
      {
        name: "document-ai",
        fullName: "mhk-repos/document-ai",
        htmlUrl: "https://github.com/mhk-repos/document-ai",
      },
      {
        name: "enterprise-ai-agent-platform",
        fullName: "mhk-repos/enterprise-ai-agent-platform",
        htmlUrl: "https://github.com/mhk-repos/enterprise-ai-agent-platform",
      },
      {
        name: "cp-autonomous-ai-agents-platform",
        fullName: "mhk-repos/cp-autonomous-ai-agents-platform",
        htmlUrl:
          "https://github.com/mhk-repos/cp-autonomous-ai-agents-platform",
      },
      {
        name: "mp-web",
        fullName: "mhk-repos/mp-web",
        htmlUrl: "https://github.com/mhk-repos/mp-web",
      },
    ]);

    expect(cards.map((card) => card.githubSlug)).toEqual([
      "cp-medhok-monorepo",
      "cp-new-service",
      "cp-interoperability-monorepo",
      "cp-datalake-pipeline",
      "cp-medhok-bi-datamart-monorepo",
      "cp-mhk-smart-prominence",
      "document-ai",
      "enterprise-ai-agent-platform",
      "cp-autonomous-ai-agents-platform",
    ]);
    expect(cards[0]).toMatchObject({
      repoName: "core-app",
      oneshotEnabled: true,
      reviewStatus: "enabled",
    });
    expect(cards[1]).toMatchObject({
      repoName: "cp-new-service",
      oneshotEnabled: false,
      reviewStatus: "draft",
      productFamily: "cp",
    });
    expect(cards[2]).toMatchObject({
      repoName: "interop",
      oneshotEnabled: true,
      reviewStatus: "enabled",
    });
    expect(cards[3]).toMatchObject({
      repoName: "data-visor",
      oneshotEnabled: true,
      reviewStatus: "enabled",
    });
    expect(cards[4]).toMatchObject({
      repoName: "cp-medhok-bi-datamart-monorepo",
      oneshotEnabled: true,
      reviewStatus: "enabled",
    });
    expect(cards[5]).toMatchObject({
      repoName: "React-based-new-ui",
      oneshotEnabled: true,
      reviewStatus: "enabled",
    });
    expect(cards[6]).toMatchObject({
      repoName: "Document-ai",
      oneshotEnabled: true,
      reviewStatus: "enabled",
    });
    expect(cards[7]).toMatchObject({
      repoName: "Ai-agents",
      oneshotEnabled: true,
      reviewStatus: "enabled",
    });
    expect(cards[8]).toMatchObject({
      repoName: "cp-autonomous-ai-agents-platform",
      oneshotEnabled: true,
      reviewStatus: "enabled",
    });
  });

  it("includes explicit aliases for Core web services, InterOP, DataVisor, and BI Data Mart routing", () => {
    expect(
      getRepoMentionTokens({
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      }),
    ).toEqual(
      expect.arrayContaining([
        "core web services",
        "mhk core api",
        "medhok-web-services",
        "ws-doc-api",
        "authrestservices",
        "rxparestservices",
      ]),
    );
    expect(
      ONE_SHOT_REPO_METADATA.find(
        (metadata) => metadata.repoName === "core-app",
      )?.domains,
    ).toEqual(
      expect.arrayContaining(["rest-api-contracts", "swagger-openapi"]),
    );
    expect(
      getRepoMentionTokens({
        repo_name: "interop",
        repo_url:
          "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
      }),
    ).toEqual(
      expect.arrayContaining([
        "crd",
        "dtr",
        "pas",
        "medpharm",
        "interqual",
        "mcg",
      ]),
    );
    expect(
      getRepoMentionTokens({
        repo_name: "data-visor",
        repo_url: "https://github.com/mhk-repos/cp-datalake-pipeline.git",
      }),
    ).toContain("data-lake-pipeline");
    expect(
      getRepoMentionTokens({
        repo_name: "cp-medhok-bi-datamart-monorepo",
        repo_url:
          "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git",
      }),
    ).toEqual(
      expect.arrayContaining([
        "bi-datamart",
        "member data mart",
        "bi data mart",
      ]),
    );
  });
});
