import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeRepository } from "../orchestrator/database.js";

const {
  fetchGitHubRepositoryMetadataMock,
  searchGitHubRepositoriesByNameMock,
} = vi.hoisted(() => ({
  fetchGitHubRepositoryMetadataMock: vi.fn(),
  searchGitHubRepositoriesByNameMock: vi.fn(),
}));

vi.mock("./github.js", async () => {
  const actual =
    await vi.importActual<typeof import("./github.js")>("./github.js");
  return {
    ...actual,
    fetchGitHubRepositoryMetadata: fetchGitHubRepositoryMetadataMock,
    searchGitHubRepositoriesByName: searchGitHubRepositoriesByNameMock,
  };
});

import {
  resolveExplicitRepoHint,
  type ExplicitRepoResolverDatabase,
} from "./explicit-repo-resolution.js";

const registeredRepo: CodeRepository = {
  id: 10,
  repo_name: "mp-web",
  repo_url: "https://github.com/mhk-repos/mp-web.git",
  description: "MP web",
  default_branch: "master",
  created_at: new Date(),
};
const dataVisorRepo: CodeRepository = {
  id: 13,
  repo_name: "data-visor",
  repo_url: "https://github.com/mhk-repos/cp-datalake-pipeline.git",
  description: "Data Visor",
  default_branch: "main",
  created_at: new Date(),
};
const biDatamartRepo: CodeRepository = {
  id: 20,
  repo_name: "cp-medhok-bi-datamart-monorepo",
  repo_url: "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git",
  description: "BI Data Mart",
  default_branch: "master",
  created_at: new Date(),
};
const coreAppRepo: CodeRepository = {
  id: 1,
  repo_name: "core-app",
  repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
  description: "Core app",
  default_branch: "master",
  created_at: new Date(),
};
const duplicateCoreRepo: CodeRepository = {
  id: 17,
  repo_name: "cp-medhok-monorepo",
  repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
  description: "Duplicate core app row",
  default_branch: "master",
  created_at: new Date(),
};

describe("resolveExplicitRepoHint", () => {
  afterEach(() => {
    vi.resetAllMocks();
    delete process.env.ONESHOT_GITHUB_REPO_OWNERS;
  });

  it("resolves an accessible GitHub repo, upserts it, and selects it", async () => {
    const resolvedRepo: CodeRepository = {
      id: 42,
      repo_name: "cp-new-service",
      repo_url: "https://github.com/mhk-repos/cp-new-service.git",
      description: "New service",
      default_branch: "main",
      created_at: new Date(),
    };
    fetchGitHubRepositoryMetadataMock.mockResolvedValue({
      owner: "mhk-repos",
      repo: "cp-new-service",
      fullName: "mhk-repos/cp-new-service",
      htmlUrl: "https://github.com/mhk-repos/cp-new-service",
      cloneUrl: "https://github.com/mhk-repos/cp-new-service.git",
      description: "New service",
      defaultBranch: "main",
    });
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn().mockResolvedValue(resolvedRepo),
    };

    const result = await resolveExplicitRepoHint(db, "cp-new-service", [
      registeredRepo,
    ]);

    expect(fetchGitHubRepositoryMetadataMock).toHaveBeenCalledWith(
      "mhk-repos",
      "cp-new-service",
      { timeoutMs: 5000 },
    );
    expect(db.upsertCodeRepository).toHaveBeenCalledWith({
      repoName: "cp-new-service",
      repoUrl: "https://github.com/mhk-repos/cp-new-service.git",
      description: "New service",
      defaultBranch: "main",
    });
    expect(result).toMatchObject({
      repo: resolvedRepo,
      profileStatus: "github_resolved",
      selectedReason: "explicit_github_repo",
      githubCandidates: ["mhk-repos/cp-new-service"],
      blockingReasons: [],
    });
  });

  it("resolves an explicit unprofiled mhk-repos repo without requiring repo metadata", async () => {
    const quickSightRepo: CodeRepository = {
      id: 77,
      repo_name: "cp-quicksightassets",
      repo_url: "https://github.com/mhk-repos/cp-quicksightassets.git",
      description: "QuickSight assets",
      default_branch: "main",
      created_at: new Date(),
    };
    fetchGitHubRepositoryMetadataMock.mockResolvedValue({
      owner: "mhk-repos",
      repo: "cp-quicksightassets",
      fullName: "mhk-repos/cp-quicksightassets",
      htmlUrl: "https://github.com/mhk-repos/cp-quicksightassets",
      cloneUrl: "https://github.com/mhk-repos/cp-quicksightassets.git",
      description: "QuickSight assets",
      defaultBranch: "main",
    });
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn().mockResolvedValue(quickSightRepo),
    };

    const result = await resolveExplicitRepoHint(db, "cp-quicksightassets", [
      registeredRepo,
    ]);

    expect(fetchGitHubRepositoryMetadataMock).toHaveBeenCalledWith(
      "mhk-repos",
      "cp-quicksightassets",
      { timeoutMs: 5000 },
    );
    expect(db.upsertCodeRepository).toHaveBeenCalledWith({
      repoName: "cp-quicksightassets",
      repoUrl: "https://github.com/mhk-repos/cp-quicksightassets.git",
      description: "QuickSight assets",
      defaultBranch: "main",
    });
    expect(result).toMatchObject({
      repo: quickSightRepo,
      profileStatus: "github_resolved",
      selectedReason: "explicit_github_repo",
      registeredCandidates: [],
      githubCandidates: ["mhk-repos/cp-quicksightassets"],
      blockingReasons: [],
    });
  });

  it("resolves data-lake-pipeline as the registered DataVisor repo", async () => {
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn().mockResolvedValue(dataVisorRepo),
    };
    fetchGitHubRepositoryMetadataMock.mockResolvedValue({
      owner: "mhk-repos",
      repo: "cp-datalake-pipeline",
      fullName: "mhk-repos/cp-datalake-pipeline",
      htmlUrl: "https://github.com/mhk-repos/cp-datalake-pipeline",
      cloneUrl: "https://github.com/mhk-repos/cp-datalake-pipeline.git",
      description: "Data Visor",
      defaultBranch: "main",
    });

    const result = await resolveExplicitRepoHint(db, "data-lake-pipeline", [
      dataVisorRepo,
      registeredRepo,
    ]);

    expect(fetchGitHubRepositoryMetadataMock).toHaveBeenCalledWith(
      "mhk-repos",
      "cp-datalake-pipeline",
      { timeoutMs: 5000 },
    );
    expect(db.upsertCodeRepository).toHaveBeenCalledWith({
      repoName: "cp-datalake-pipeline",
      repoUrl: "https://github.com/mhk-repos/cp-datalake-pipeline.git",
      description: "Data Visor",
      defaultBranch: "main",
    });
    expect(result).toMatchObject({
      repo: dataVisorRepo,
      profileStatus: "github_resolved",
      selectedReason: "explicit_github_repo",
      registeredCandidates: ["data-visor"],
      githubCandidates: ["mhk-repos/cp-datalake-pipeline"],
      blockingReasons: [],
    });
  });

  it("resolves cp-medhok-bi-datamart-monorepo as a registered OneShot repo", async () => {
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn().mockResolvedValue(biDatamartRepo),
    };
    fetchGitHubRepositoryMetadataMock.mockResolvedValue({
      owner: "mhk-repos",
      repo: "cp-medhok-bi-datamart-monorepo",
      fullName: "mhk-repos/cp-medhok-bi-datamart-monorepo",
      htmlUrl: "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo",
      cloneUrl: "https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git",
      description: "BI Data Mart",
      defaultBranch: "master",
    });

    const result = await resolveExplicitRepoHint(
      db,
      "cp-medhok-bi-datamart-monorepo",
      [biDatamartRepo, registeredRepo],
    );

    expect(result).toMatchObject({
      repo: biDatamartRepo,
      profileStatus: "github_resolved",
      selectedReason: "explicit_github_repo",
      registeredCandidates: ["cp-medhok-bi-datamart-monorepo"],
      githubCandidates: ["mhk-repos/cp-medhok-bi-datamart-monorepo"],
      blockingReasons: [],
    });
  });

  it("dedupes canonical OneShot repo aliases before treating registered matches as ambiguous", async () => {
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn().mockResolvedValue(coreAppRepo),
    };
    fetchGitHubRepositoryMetadataMock.mockResolvedValue({
      owner: "mhk-repos",
      repo: "cp-medhok-monorepo",
      fullName: "mhk-repos/cp-medhok-monorepo",
      htmlUrl: "https://github.com/mhk-repos/cp-medhok-monorepo",
      cloneUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      description: "Core app",
      defaultBranch: "master",
    });

    const result = await resolveExplicitRepoHint(db, "cp-medhok-monorepo", [
      coreAppRepo,
      duplicateCoreRepo,
      registeredRepo,
    ]);

    expect(result).toMatchObject({
      repo: coreAppRepo,
      profileStatus: "github_resolved",
      selectedReason: "explicit_github_repo",
      registeredCandidates: ["core-app"],
      blockingReasons: [],
    });
  });

  it("blocks when GitHub search produces multiple accessible candidates", async () => {
    fetchGitHubRepositoryMetadataMock.mockResolvedValue(null);
    searchGitHubRepositoriesByNameMock.mockResolvedValue([
      {
        owner: "mhk-repos",
        repo: "cp-service",
        fullName: "mhk-repos/cp-service",
        htmlUrl: "https://github.com/mhk-repos/cp-service",
        cloneUrl: "https://github.com/mhk-repos/cp-service.git",
        description: null,
        defaultBranch: "main",
      },
      {
        owner: "mhk-repos",
        repo: "cp-service-api",
        fullName: "mhk-repos/cp-service-api",
        htmlUrl: "https://github.com/mhk-repos/cp-service-api",
        cloneUrl: "https://github.com/mhk-repos/cp-service-api.git",
        description: null,
        defaultBranch: "main",
      },
    ]);
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn(),
    };

    const result = await resolveExplicitRepoHint(db, "cp-service", [
      registeredRepo,
    ]);

    expect(result.repo).toBeNull();
    expect(result.selectedReason).toBe("explicit_repo_unresolved");
    expect(result.blockingReasons[0]).toContain(
      "matched multiple GitHub repositories",
    );
    expect(db.upsertCodeRepository).not.toHaveBeenCalled();
  });

  it("fails closed without a default GitHub owner fallback", async () => {
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn(),
    };

    const result = await resolveExplicitRepoHint(db, "cp-new-service", []);

    expect(result.repo).toBeNull();
    expect(result.selectedReason).toBe("explicit_repo_unresolved");
    expect(result.blockingReasons[0]).toContain("no GitHub owners");
    expect(fetchGitHubRepositoryMetadataMock).not.toHaveBeenCalled();
    expect(searchGitHubRepositoriesByNameMock).not.toHaveBeenCalled();
  });

  it("caps GitHub lookup attempts", async () => {
    process.env.ONESHOT_GITHUB_REPO_OWNERS =
      "one,two,three,four,five,six,seven";
    fetchGitHubRepositoryMetadataMock.mockResolvedValue(null);
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn(),
    };

    const result = await resolveExplicitRepoHint(db, "cp-new-service", []);

    expect(result.repo).toBeNull();
    expect(fetchGitHubRepositoryMetadataMock).toHaveBeenCalledTimes(5);
    expect(searchGitHubRepositoriesByNameMock).not.toHaveBeenCalled();
  });

  it("blocks ambiguous registered repo matches when GitHub cannot disambiguate", async () => {
    fetchGitHubRepositoryMetadataMock.mockResolvedValue(null);
    const duplicateRegisteredRepo: CodeRepository = {
      ...registeredRepo,
      id: 11,
      repo_name: "mp-web-copy",
      repo_url: "https://github.com/mhk-repos/mp-web.git",
    };
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn(),
    };

    const result = await resolveExplicitRepoHint(db, "mhk-repos/mp-web", [
      registeredRepo,
      duplicateRegisteredRepo,
    ]);

    expect(result.repo).toBeNull();
    expect(result.registeredCandidates).toEqual(["mp-web", "mp-web-copy"]);
    expect(result.blockingReasons[0]).toContain(
      "matched multiple registered repositories",
    );
    expect(fetchGitHubRepositoryMetadataMock).toHaveBeenCalledWith(
      "mhk-repos",
      "mp-web",
      { timeoutMs: 5000 },
    );
  });

  it("treats timeout and failed GitHub calls as unresolved", async () => {
    fetchGitHubRepositoryMetadataMock.mockRejectedValue(new Error("timeout"));
    searchGitHubRepositoriesByNameMock.mockRejectedValue(new Error("timeout"));
    const db: ExplicitRepoResolverDatabase = {
      upsertCodeRepository: vi.fn(),
    };

    const result = await resolveExplicitRepoHint(db, "cp-new-service", [
      registeredRepo,
    ]);

    expect(result.repo).toBeNull();
    expect(result.selectedReason).toBe("explicit_repo_unresolved");
    expect(result.blockingReasons[0]).toContain(
      "could not be resolved to a registered or accessible GitHub repository",
    );
  });
});
