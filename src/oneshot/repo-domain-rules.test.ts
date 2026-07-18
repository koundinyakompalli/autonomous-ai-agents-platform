import { describe, expect, it } from "vitest";
import type { CodeRepository } from "../orchestrator/database.js";
import { findDeterministicDomainRepoMatches } from "./repo-domain-rules.js";

const availableRepos = [
  {
    id: 1,
    repo_name: "Ai-agents",
    repo_url: "https://github.com/mhk-repos/enterprise-ai-agent-platform.git",
  },
  {
    id: 2,
    repo_name: "core-app",
    repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
  },
  {
    id: 3,
    repo_name: "Document-ai",
    repo_url: "https://github.com/mhk-repos/document-ai.git",
  },
  {
    id: 4,
    repo_name: "cp-autonomous-ai-agents-platform",
    repo_url:
      "https://github.com/mhk-repos/cp-autonomous-ai-agents-platform.git",
  },
  {
    id: 5,
    repo_name: "interop",
    repo_url: "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
  },
] as CodeRepository[];

describe("findDeterministicDomainRepoMatches", () => {
  it("routes specific MCP platform work to Ai-agents", () => {
    const matches = findDeterministicDomainRepoMatches(
      "Add a new internal MCP server for the enterprise AI agent platform.",
      availableRepos,
    );

    expect(matches.map((match) => match.repo.repo_name)).toEqual(["Ai-agents"]);
    expect(matches[0]?.evidence.join("\n")).toContain("mcp server");
  });

  it("does not route a generic standalone MCP mention without platform context", () => {
    const matches = findDeterministicDomainRepoMatches(
      "Investigate MCP behavior in a generic integration note.",
      availableRepos,
    );

    expect(matches).toEqual([]);
  });

  it("routes OneShot platform work to the self-platform repository", () => {
    const matches = findDeterministicDomainRepoMatches(
      "Update OneShot runtime validation in the Specter dashboard.",
      availableRepos,
    );

    expect(matches.map((match) => match.repo.repo_name)).toEqual([
      "cp-autonomous-ai-agents-platform",
    ]);
    expect(matches[0]?.evidence.join("\n")).toContain("oneshot");
  });

  it("routes InterOP clinical engine work to the interoperability repository", () => {
    const matches = findDeterministicDomainRepoMatches(
      "Implement DTR $next-question pass-through for the MCG clinical engine.",
      availableRepos,
    );

    expect(matches.map((match) => match.repo.repo_name)).toEqual(["interop"]);
    expect(matches[0]?.evidence.join("\n")).toContain("dtr");
    expect(matches[0]?.evidence.join("\n")).toContain("mcg");
  });

  it("routes MedPharm CRD and PAS FHIR work to the interoperability repository", () => {
    const matches = findDeterministicDomainRepoMatches(
      "MedPharm CRD PA-list and PAS ClaimResponse behavior need FHIR validation.",
      availableRepos,
    );

    expect(matches.map((match) => match.repo.repo_name)).toEqual(["interop"]);
    expect(matches[0]?.evidence.join("\n")).toContain("medpharm");
    expect(matches[0]?.evidence.join("\n")).toContain("claimresponse");
  });

  it("routes Core web-service contract work to core-app", () => {
    const matches = findDeterministicDomainRepoMatches(
      "Update AuthRestServices submitPreAuth and WSPreAuthInput in medhok-web-services.",
      availableRepos,
    );

    expect(matches.map((match) => match.repo.repo_name)).toEqual(["core-app"]);
    expect(matches[0]?.evidence.join("\n")).toContain("authrestservices");
    expect(matches[0]?.evidence.join("\n")).toContain("submitpreauth");
  });

  it("routes InterOP stories with Core web-service dependencies to both repos", () => {
    const matches = findDeterministicDomainRepoMatches(
      "InterOP PAS $submit needs CoreRestClient support for AuthRestServices submitPreAuth WSPreAuthInput mapping.",
      availableRepos,
    );

    expect(matches.map((match) => match.repo.repo_name)).toEqual([
      "interop",
      "core-app",
    ]);
    expect(matches[0]?.evidence.join("\n")).toContain("pas");
    expect(matches[0]?.evidence.join("\n")).toContain("corerestclient");
    expect(matches[1]?.evidence.join("\n")).toContain("authrestservices");
    expect(matches[1]?.evidence.join("\n")).toContain("wspreauthinput");
  });
});
