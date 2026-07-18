import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyCrossProfileFrequencyFilter,
  bumpProfileVersion,
  buildProfile,
  collectAliasesFor,
  collectDomainsFor,
  emitYaml,
  extractCuratedBlock,
  extractDocumentationDomains,
  extractEndpoints,
  extractFilePathPatterns,
  extractGitVocabulary,
  extractLogCategories,
  extractMavenArtifacts,
  extractPackages,
  extractSymbols,
  extractTables,
  promoteClientTags,
  readExistingHeader,
  splitCamelCase,
  stripMarkdown,
  tokenizeEndpointSegments,
  type ProfileBundle,
} from "./generate-repo-profiles.js";
import { execFileSync } from "node:child_process";

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repoprof-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

describe("extractFilePathPatterns", () => {
  it("emits repo basename and distinctive top-level directories, dropping stoplist", () => {
    const root = makeRepo({
      "src/main/java/Foo.java": "",
      "docs/readme.md": "",
      "mhk-interopt-fhirhelper/src/main/java/X.java": "",
      "lambdas/fhir_processor/src/main.py": "",
      "target/classes/x.class": "",
    });
    const patterns = extractFilePathPatterns(root);
    expect(patterns).toContain(path.basename(root));
    expect(patterns).toContain("mhk-interopt-fhirhelper");
    expect(patterns).toContain("lambdas");
    expect(patterns).not.toContain("src");
    expect(patterns).not.toContain("docs");
    expect(patterns).not.toContain("target");
  });
});

describe("extractPackages", () => {
  it("emits Java package prefixes up to 3 segments", () => {
    const root = makeRepo({
      "service/src/main/java/com/mhkinterop/common/service/CoreRestClient.java":
        "package com.mhkinterop.common.service;\npublic class CoreRestClient {}",
    });
    const packages = extractPackages(root);
    expect(packages).toContain("com.mhkinterop");
    expect(packages).toContain("com.mhkinterop.common");
    expect(packages).not.toContain("com");
  });

  it("only keeps Python packages that resolve to an in-repo top-level module", () => {
    const root = makeRepo({
      "fhir_processor/__init__.py": "",
      "fhir_processor/processor.py":
        "from fhir_processor.submod import x\nimport loguru\nimport os\n",
    });
    const packages = extractPackages(root);
    expect(packages).toContain("fhir_processor.submod");
    expect(packages).not.toContain("loguru");
    expect(packages).not.toContain("os");
  });
});

describe("extractSymbols", () => {
  it("emits Java class/interface/enum/record declarations and filters test classes", () => {
    const root = makeRepo({
      "src/main/java/com/x/Widget.java":
        "package com.x;\npublic class Widget {}",
      "src/main/java/com/x/BarInterface.java":
        "package com.x;\npublic interface BarInterface {}",
      "src/main/java/com/x/Color.java":
        "package com.x;\npublic enum Color { RED, GREEN }",
      "src/test/java/com/x/WidgetTest.java":
        "package com.x;\npublic class WidgetTest {}",
    });
    const symbols = extractSymbols(root);
    expect(symbols).toContain("Widget");
    expect(symbols).toContain("BarInterface");
    expect(symbols).toContain("Color");
    expect(symbols).not.toContain("WidgetTest");
  });

  it("drops noise-listed identifiers", () => {
    const root = makeRepo({
      "src/main/java/X.java": "public class App {}",
      "src/main/java/Y.java": "public class Helper {}",
      "src/main/java/Z.java": "public class InterestingService {}",
    });
    const symbols = extractSymbols(root);
    expect(symbols).toContain("InterestingService");
    expect(symbols).not.toContain("App");
    expect(symbols).not.toContain("Helper");
  });
});

describe("extractEndpoints", () => {
  it("extracts Spring mappings, JAX-RS paths, Flask routes, and Express routes", () => {
    const root = makeRepo({
      "src/main/java/Spring.java": '@GetMapping("/api/patients") void x() {}',
      "src/main/java/Jaxrs.java": '@Path("/r4/Claim") void y() {}',
      "svc/app.py": '@app.route("/flask/route")\ndef z(): pass',
      "web/server.ts": 'app.get("/node/route", () => {})',
    });
    const endpoints = extractEndpoints(root);
    expect(endpoints).toContain("/api/patients");
    expect(endpoints).toContain("/r4/Claim");
    expect(endpoints).toContain("/flask/route");
    expect(endpoints).toContain("/node/route");
  });
});

describe("extractTables", () => {
  it("extracts CREATE TABLE, @Table, and Liquibase createTable", () => {
    const root = makeRepo({
      "db/migration/V1__init.sql":
        "CREATE TABLE authorization_details (id INT);\nCREATE TABLE IF NOT EXISTS grievance_cases (id INT);",
      "src/main/java/Member.java":
        '@Table(name = "member_profile")\npublic class Member {}',
      "db/changelog/changelog.xml":
        '<createTable tableName="claim_lines"></createTable>',
    });
    const tables = extractTables(root);
    expect(tables).toContain("authorization_details");
    expect(tables).toContain("grievance_cases");
    expect(tables).toContain("member_profile");
    expect(tables).toContain("claim_lines");
  });

  it("skips generic table names and test-fixture tables", () => {
    const root = makeRepo({
      "db/migration/V1.sql": "CREATE TABLE users (id INT);",
      "tests/fixtures/setup.sql":
        "CREATE TABLE authorization_details (id INT);",
    });
    const tables = extractTables(root);
    expect(tables).not.toContain("users");
    expect(tables).not.toContain("authorization_details");
  });

  it("strips SQL comments before extracting table names", () => {
    const root = makeRepo({
      "db/a.sql":
        "-- Create TABLE IF NOT EXISTS to store application properties\nCREATE TABLE fhir_mhk_application_properties (id INT);",
    });
    const tables = extractTables(root);
    expect(tables).toContain("fhir_mhk_application_properties");
    expect(tables).not.toContain("to");
  });

  it("ignores SQL reserved words", () => {
    const root = makeRepo({
      "db/a.sql": "CREATE TABLE select (id INT);",
    });
    expect(extractTables(root)).not.toContain("select");
  });
});

describe("YAML curated preservation", () => {
  it("extracts curated block verbatim when present", () => {
    const yaml = [
      "schema_version: 1",
      "profile_version: 3",
      "generated:",
      "  aliases: []",
      "curated:",
      "  aliases:",
      "    - hand-edited",
      "  domains: []",
      "",
    ].join("\n");
    const curated = extractCuratedBlock(yaml);
    expect(curated).toContain("curated:");
    expect(curated).toContain("- hand-edited");
    expect(curated).not.toContain("schema_version");
  });

  it("falls back to empty curated block when missing", () => {
    const curated = extractCuratedBlock("schema_version: 1\n");
    expect(curated).toMatch(/^curated:\n/);
    expect(curated).toContain("aliases: []");
  });

  it("preserves a `#` comment block immediately preceding curated:", () => {
    const yaml = [
      "generated:",
      "  aliases: []",
      "  domains: []",
      "# -----",
      "# Summary: interop owns FHIR integrations",
      "# -----",
      "curated:",
      "  aliases:",
      "    - preserved",
      "  domains: []",
      "",
    ].join("\n");
    const curated = extractCuratedBlock(yaml);
    expect(curated).toContain("# Summary: interop owns FHIR integrations");
    expect(curated).toContain("- preserved");
  });
});

describe("readExistingHeader / bumpProfileVersion", () => {
  it("reads existing header scalars and bumps profile_version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoprof-hdr-"));
    const file = path.join(tmp, "x.yaml");
    fs.writeFileSync(
      file,
      [
        "schema_version: 1",
        "profile_version: 4",
        'generated_at: "2020-01-01T00:00:00Z"',
        "source_repo_commit_sha: abc123",
        "generated:",
        "  aliases: []",
        "curated:",
        "  aliases: []",
      ].join("\n"),
      "utf8",
    );
    const header = readExistingHeader(file);
    expect(header.schemaVersion).toBe("1");
    expect(header.profileVersion).toBe("4");
    expect(header.generatedAt).toBe("2020-01-01T00:00:00Z");
    expect(header.sourceRepoCommitSha).toBe("abc123");
    expect(bumpProfileVersion(header.profileVersion)).toBe("5");
  });
});

describe("emitYaml round-trip preserves curated block", () => {
  it("emits header + generated + untouched curated", () => {
    const curatedBlock =
      "curated:\n  aliases:\n    - my-curated\n  domains: []\n  packages: []\n  file_path_patterns: []\n  symbols: []\n  endpoints: []\n  tables: []\n";
    const out = emitYaml({
      header: {
        schemaVersion: "1",
        profileVersion: "2",
        generatedAt: "2026-04-29T00:00:00Z",
        sourceRepoCommitSha: "deadbeef",
      },
      generated: {
        aliases: ["x"],
        domains: [],
        packages: [],
        file_path_patterns: [],
        symbols: [],
        endpoints: [],
        tables: [],
      },
      curatedBlock,
    });
    expect(out).toContain("schema_version: 1");
    expect(out).toContain("profile_version: 2");
    expect(out).toContain("source_repo_commit_sha: deadbeef");
    expect(out).toContain("- my-curated");
    // Curated block appears only once in the emitted YAML
    const occurrences = out.match(/^curated:/gm)?.length ?? 0;
    expect(occurrences).toBe(1);
  });
});

describe("buildProfile integration", () => {
  let repoRoot: string;
  let profileDir: string;

  beforeEach(() => {
    repoRoot = makeRepo({
      "mm-module/src/main/java/com/demo/svc/Demo.java":
        "package com.demo.svc;\npublic class DemoService {}",
      "docs/readme.md": "ignored",
      "db/migration/V1__init.sql": "CREATE TABLE demo_table (id INT);",
      "mm-module/src/main/java/com/demo/api/Api.java":
        'package com.demo.api;\n@GetMapping("/demo") class Api {}',
    });
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "repoprof-out-"));
    fs.writeFileSync(
      path.join(profileDir, "client-services.yaml"),
      [
        "schema_version: 1",
        "profile_version: 3",
        'generated_at: "2020-01-01T00:00:00Z"',
        "source_repo_commit_sha: old",
        "generated:",
        "  aliases: []",
        "  domains: []",
        "  packages: []",
        "  file_path_patterns: []",
        "  symbols: []",
        "  endpoints: []",
        "  tables: []",
        "curated:",
        "  aliases:",
        "    - keep-me",
        "  domains: []",
        "  packages: []",
        "  file_path_patterns: []",
        "  symbols: []",
        "  endpoints: []",
        "  tables: []",
      ].join("\n"),
      "utf8",
    );
  });

  it("produces a YAML that preserves curated edits and rewrites generated", () => {
    const bundle = buildProfile({
      repoName: "client-services",
      repoPath: repoRoot,
      profileDir,
    });
    expect(bundle.header.profileVersion).toBe("4");
    expect(bundle.yaml).toContain("- keep-me");
    expect(bundle.yaml).toContain("DemoService");
    expect(bundle.yaml).toContain("demo_table");
  });
});

describe("metadata reuse", () => {
  it("includes metadata aliases for the given repo", () => {
    const aliases = collectAliasesFor("interop");
    expect(aliases).toContain("interop");
    expect(aliases).toContain("cp-interoperability-monorepo");
  });

  it("unions metadata domains with REPO_DOMAIN_RULES phrases", () => {
    const domains = collectDomainsFor("interop");
    expect(domains).toContain("fhir");
    expect(domains).toContain("cds-hooks");
  });
});

// ---------------------------------------------------------------------------
// v2 additions
// ---------------------------------------------------------------------------

describe("stripMarkdown + splitCamelCase helpers", () => {
  it("strips code fences, inline code, HTML, headings, bullets, and emphasis", () => {
    const md = [
      "# Heading",
      "",
      "Some **bold** text with `inline code` and *emphasis*.",
      "",
      "```",
      "this is a fenced block",
      "```",
      "",
      "- bullet item",
      "- another bullet",
      "",
      "<div>some html</div>",
      "",
      "[link label](https://example.com)",
    ].join("\n");
    const stripped = stripMarkdown(md);
    expect(stripped).not.toContain("fenced block");
    expect(stripped).not.toContain("<div>");
    expect(stripped).not.toContain("`");
    expect(stripped).toContain("link label");
    expect(stripped).toContain("bullet item");
    expect(stripped).toContain("Heading");
  });

  it("splits camelCase / PascalCase / ALLCAPS runs correctly", () => {
    expect(splitCamelCase("CoreRestClient")).toEqual([
      "core",
      "rest",
      "client",
    ]);
    expect(splitCamelCase("getAuthInquiry")).toEqual([
      "get",
      "auth",
      "inquiry",
    ]);
    expect(splitCamelCase("XMLHttpRequest")).toEqual([
      "xml",
      "http",
      "request",
    ]);
    expect(splitCamelCase("member")).toEqual(["member"]);
  });
});

describe("extractDocumentationDomains", () => {
  it("surfaces multi-word Title-Case noun phrases and frequent lowercase tokens from README", () => {
    const root = makeRepo({
      "README.md": [
        "# Batch Jobs",
        "",
        "This service owns the Fax Intake Queue and correspondence processing.",
        "It handles fax intake for downstream workflows. Fax intake is critical.",
        "Correspondence events route through the correspondence processor.",
        "The Fax Intake Queue accepts barcoded faxes.",
        "Correspondence is persisted by the correspondence watcher.",
        "Correspondence jobs dequeue from the correspondence queue.",
        "Correspondence retries are also handled in correspondence batches.",
      ].join("\n"),
    });
    const domains = extractDocumentationDomains(root);
    expect(domains.some((d) => d.includes("fax intake queue"))).toBe(true);
    expect(domains).toContain("correspondence");
  });

  it("ignores code fences and HTML so code samples do not leak into vocabulary", () => {
    const root = makeRepo({
      "README.md": [
        "# API",
        "",
        "```java",
        "public class ShouldNotLeakClassName {",
        "  void method() {}",
        "}",
        "```",
        "<script>alert('no')</script>",
      ].join("\n"),
    });
    const domains = extractDocumentationDomains(root);
    expect(
      domains.some(
        (d) =>
          d.includes("shouldnotleakclassname") ||
          d.includes("shouldNotLeakClassName"),
      ),
    ).toBe(false);
    expect(domains).not.toContain("script");
  });

  it("returns empty list when no doc files exist", () => {
    const root = makeRepo({
      "src/main/java/Foo.java": "public class Foo {}",
    });
    expect(extractDocumentationDomains(root)).toEqual([]);
  });
});

describe("extractGitVocabulary", () => {
  it("returns commit-subject tokens and camelCase symbols, stripping ticket keys and merges", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repoprof-git-"));
    execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.email", "t@t"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", root, "config", "user.name", "t"], {
      stdio: "ignore",
    });
    // Write a file once so each commit has something to record.
    fs.writeFileSync(path.join(root, "r.txt"), "x", "utf8");
    execFileSync("git", ["-C", root, "add", "r.txt"], { stdio: "ignore" });
    const commits = [
      "CPDEV-111: Implement FhirQuestionPackage logic for CDS hooks",
      "CPDEV-112: Update FhirQuestionPackage handling for questionnaire flow",
      "CPDEV-113: CdsHooks questionnaire packaging fix for FhirQuestionPackage",
      "Merge branch 'main' into dev",
      "Revert bad changes",
      "[maven-release-plugin] prepare release",
      "CPDEV-114: Refine questionnaire packaging and FhirQuestionPackage tests",
    ];
    for (let i = 0; i < commits.length; i++) {
      fs.writeFileSync(path.join(root, "r.txt"), String(i), "utf8");
      execFileSync("git", ["-C", root, "add", "r.txt"], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "commit", "-q", "-m", commits[i]], {
        stdio: "ignore",
      });
    }

    const vocab = extractGitVocabulary(root);
    expect(vocab.domains).toContain("questionnaire");
    expect(vocab.symbols).toContain("FhirQuestionPackage");
    expect(vocab.domains.some((d) => /^cpdev/.test(d))).toBe(false);
    expect(vocab.domains.some((d) => d === "merge" || d === "revert")).toBe(
      false,
    );
  });

  it("returns empty result on non-git directory without throwing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repoprof-nogit-"));
    expect(extractGitVocabulary(root)).toEqual({ domains: [], symbols: [] });
  });
});

describe("extractMavenArtifacts", () => {
  it("keeps repo-owned artifactIds and drops dependency noise", () => {
    const root = makeRepo({
      "mm-service-cvs/pom.xml": [
        "<project>",
        "  <parent>",
        "    <artifactId>spring-boot-starter-parent</artifactId>",
        "  </parent>",
        "  <artifactId>mm-service-cvs</artifactId>",
        "  <dependencies>",
        "    <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>",
        "    <dependency><artifactId>jackson-databind</artifactId></dependency>",
        "  </dependencies>",
        "</project>",
      ].join("\n"),
      "mm-service-aetna/pom.xml": [
        "<project>",
        "  <artifactId>mm-service-aetna</artifactId>",
        "</project>",
      ].join("\n"),
      "mm-service-CVS-PBM/pom.xml": [
        "<project>",
        "  <artifactId>mm-service-CVS-PBM</artifactId>",
        "</project>",
      ].join("\n"),
    });
    const result = extractMavenArtifacts(root);
    expect(result.artifactIds).toContain("mm-service-cvs");
    expect(result.artifactIds).toContain("mm-service-aetna");
    expect(result.artifactIds).toContain("mm-service-CVS-PBM");
    expect(result.artifactIds).not.toContain("spring-boot-starter-parent");
    expect(result.artifactIds).not.toContain("spring-boot-starter-web");
    expect(result.artifactIds).not.toContain("jackson-databind");
    expect(result.clientTags).toContain("cvs");
    expect(result.clientTags).toContain("pbm");
    expect(result.clientTags).toContain("aetna");
  });
});

describe("tokenizeEndpointSegments", () => {
  it("splits endpoints on /, camelCase, -, _ and drops HTTP verbs and short tokens", () => {
    const tokens = tokenizeEndpointSegments([
      "/getAuthInquiry/{id}",
      "/r4/cds-services",
      "/fhir/Patient",
      "$submit",
    ]);
    expect(tokens).toContain("auth");
    expect(tokens).toContain("inquiry");
    expect(tokens).toContain("cds");
    expect(tokens).toContain("services");
    expect(tokens).toContain("fhir");
    expect(tokens).toContain("patient");
    expect(tokens).toContain("submit");
    expect(tokens).not.toContain("get");
    expect(tokens).not.toContain("r4");
    expect(tokens).not.toContain("id");
  });
});

describe("extractLogCategories", () => {
  it("captures Java bracketed log category prefixes", () => {
    const root = makeRepo({
      "src/main/java/com/demo/Intake.java": [
        "package com.demo;",
        "public class Intake {",
        "  private static final org.slf4j.Logger log = null;",
        '  void accept() { log.info("[AuthorizationIntake] case accepted {}", id); }',
        '  void fail() { log.warn("[FaxDispatcher] timeout"); }',
        "}",
      ].join("\n"),
    });
    const cats = extractLogCategories(root);
    expect(cats).toContain("authorizationintake");
    expect(cats).toContain("faxdispatcher");
  });

  it("ignores test files", () => {
    const root = makeRepo({
      "src/test/java/FoobarTest.java":
        'public class FoobarTest { void t() { log.info("[ShouldNotLeak] x"); } }',
    });
    expect(extractLogCategories(root)).toEqual([]);
  });
});

describe("promoteClientTags", () => {
  it("surfaces customer tokens from mm-service-* top-level dirs for client-services", () => {
    const root = makeRepo({
      "mm-service-bcbsma/pom.xml": "<project/>",
      "mm-service-CVS-PBM/pom.xml": "<project/>",
      "mm-service-Aultcare/pom.xml": "<project/>",
      "ExternalClientServicesModel/pom.xml": "<project/>",
    });
    const promoted = promoteClientTags(root, "client-services");
    expect(promoted.domains).toContain("bcbsma");
    expect(promoted.domains).toContain("cvs");
    expect(promoted.domains).toContain("pbm");
    expect(promoted.domains).toContain("aultcare");
    expect(promoted.aliases).toContain("BCBSMA");
    expect(promoted.aliases).toContain("CVS");
    expect(promoted.aliases).toContain("PBM");
  });

  it("returns empty for non-client-services repos", () => {
    const root = makeRepo({ "mm-service-anything/pom.xml": "<project/>" });
    expect(promoteClientTags(root, "interop")).toEqual({
      aliases: [],
      domains: [],
    });
  });
});

describe("applyCrossProfileFrequencyFilter", () => {
  function bundleFixture(
    repoName: string,
    overrides: Partial<ProfileBundle["generated"]>,
  ): ProfileBundle {
    const base: ProfileBundle = {
      repoName,
      repoPath: "/fake/" + repoName,
      yamlPath: "/fake/" + repoName + ".yaml",
      yaml: "",
      curatedBlock:
        "curated:\n  aliases: []\n  domains: []\n  packages: []\n  file_path_patterns: []\n  symbols: []\n  endpoints: []\n  tables: []\n",
      header: {
        schemaVersion: "1",
        profileVersion: "1",
        generatedAt: "2026-04-29T00:00:00Z",
        sourceRepoCommitSha: "abc",
      },
      generated: {
        aliases: [],
        domains: [],
        packages: [],
        file_path_patterns: [],
        symbols: [],
        endpoints: [],
        tables: [],
        ...overrides,
      },
    };
    return base;
  }

  it("drops tokens that appear in >= threshold profiles from domains/symbols only", () => {
    const bundles = [
      bundleFixture("a", {
        domains: ["common", "unique-a"],
        aliases: ["common"],
      }),
      bundleFixture("b", { domains: ["common", "unique-b"] }),
      bundleFixture("c", {
        domains: ["common", "unique-c"],
        symbols: ["Shared"],
      }),
      bundleFixture("d", {
        domains: ["common", "unique-d"],
        symbols: ["Shared"],
      }),
      bundleFixture("e", {
        domains: ["common", "unique-e"],
        symbols: ["Shared"],
      }),
      bundleFixture("f", {
        domains: ["common", "unique-f"],
        symbols: ["Shared"],
      }),
    ];
    applyCrossProfileFrequencyFilter(bundles);
    for (const b of bundles) {
      expect(b.generated.domains).not.toContain("common");
      expect(b.generated.symbols).not.toContain("Shared");
    }
    // uniques preserved
    expect(bundles[0].generated.domains).toContain("unique-a");
    // Aliases preserved even when the same token was common elsewhere.
    expect(bundles[0].generated.aliases).toContain("common");
  });

  it("leaves rarely-shared tokens intact when below threshold", () => {
    const bundles = [
      bundleFixture("a", { domains: ["shared", "unique-a"] }),
      bundleFixture("b", { domains: ["shared", "unique-b"] }),
      bundleFixture("c", { domains: ["unique-c"] }),
      bundleFixture("d", { domains: ["unique-d"] }),
    ];
    applyCrossProfileFrequencyFilter(bundles);
    // "shared" appears in 2 of 4 (< threshold 4), should be kept
    expect(bundles[0].generated.domains).toContain("shared");
  });
});
