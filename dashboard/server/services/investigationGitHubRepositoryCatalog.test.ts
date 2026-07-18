import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRepositoryDiscoveryQueries,
  discoverGitHubRepositoriesForTicket,
  selectRepositoryDiscoveryTerms,
} from "./investigationGitHubRepositoryCatalog.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("investigation GitHub repository catalog", () => {
  it("selects technical terms without sending identifiers or generic ticket prose", () => {
    expect(selectRepositoryDiscoveryTerms([
      "request",
      "1234567890",
      "INC000010000000",
      "CLIENT---CP-PROD1",
      "externalEventType",
      "QueueProcessor",
      "production",
      "event-publishing-service",
    ])).toEqual([
      "QueueProcessor",
      "externalEventType",
      "event-publishing-service",
    ]);
  });

  it("combines runtime contract fields and values for cross-repository discovery", () => {
    expect(buildRepositoryDiscoveryQueries(["messageFormat", "ContractValue"]).some((query) =>
      query.includes("messageFormat") && query.includes("ContractValue"),
    )).toBe(true);
  });

  it("discovers and ranks repositories from bounded organization code search", async () => {
    vi.stubEnv("INVESTIGATION_GITHUB_CATALOG_TEST_LIVE", "true");
    vi.stubEnv("GITHUB_TOKEN", "read-only-test-token");
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
      const term = url.searchParams.get("q")?.split(" ")[0];
      const items = term === "externalEventType"
        ? [
            {
              path: "publisher/src/EventPublisher.java",
              repository: {
                name: "event-utilities",
                full_name: "example-org/event-utilities",
                clone_url: "https://github.com/example-org/event-utilities.git",
                default_branch: "master",
                description: "Shared event producers",
              },
            },
          ]
        : [];
      return new Response(JSON.stringify({ items }), { status: 200 });
    }));

    const repositories = await discoverGitHubRepositoriesForTicket({
      organization: "example-org",
      terms: ["request", "externalEventType"],
    });

    expect(repositories).toEqual([
      expect.objectContaining({
        name: "event-utilities",
        defaultBranch: "master",
        matchedTerms: ["externalEventType"],
        matchedPaths: ["publisher/src/EventPublisher.java"],
      }),
    ]);
  });
});
