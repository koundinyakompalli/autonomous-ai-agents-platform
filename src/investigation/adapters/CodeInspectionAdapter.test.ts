import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeInspectionAdapter } from "./CodeInspectionAdapter.js";
import { InMemoryCodeTargetRegistry } from "../data/CodeTargetRegistry.js";
import { InMemoryCodeSemanticProfileRegistry } from "../data/CodeSemanticProfileRegistry.js";
import type { InvestigationAdapterRequest } from "../types/investigation.js";

const tempRoots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "code-agent-git-"));
  tempRoots.push(root);
  return root;
}

describe("CodeInspectionAdapter GitHub refresh", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("passes runtime-derived handler and source identities to repository discovery", async () => {
    let discoveryTerms: string[] = [];
    const adapter = new CodeInspectionAdapter(
      new InMemoryCodeTargetRegistry([]),
      5,
      new InMemoryCodeSemanticProfileRegistry([]),
      async (_request, terms) => {
        discoveryTerms = terms;
        return [];
      },
    );

    await adapter.execute({
      runId: "inv-serverless-code-routing",
      jiraKey: "SUP-1",
      adapter: "code",
      scope: {
        clientId: "CLIENT",
        environment: "PROD_REPLICA",
        diagnosticContext: {
          codeEvidenceTerms: [
            "integration_event_filter_oob.lambda_handler",
            "integration_event_filter_oob.py",
          ],
        },
      },
      constraints: { timeoutMs: 10_000, redactionRequired: true },
    });

    expect(discoveryTerms).toEqual(expect.arrayContaining([
      "integration_event_filter_oob.lambda_handler",
      "integration_event_filter_oob.py",
    ]));
  });

  it("scans a fresh remote worktree instead of a stale local checkout", async () => {
    const root = await makeTempRoot();
    const remotePath = path.join(root, "remote.git");
    const seedPath = path.join(root, "seed");
    const staleClonePath = path.join(root, "stale-clone");
    const worktreeBase = path.join(root, "worktrees");

    git(root, ["init", "--bare", remotePath]);
    git(root, ["init", seedPath]);
    git(seedPath, ["config", "user.name", "Code Agent Test"]);
    git(seedPath, ["config", "user.email", "code-agent@example.test"]);
    await writeFile(
      path.join(seedPath, "Service.java"),
      'class Service { String value = "old"; }\n',
    );
    git(seedPath, ["add", "Service.java"]);
    git(seedPath, ["commit", "-m", "initial"]);
    git(seedPath, ["branch", "-M", "main"]);
    git(seedPath, ["remote", "add", "origin", remotePath]);
    git(seedPath, ["push", "origin", "main"]);
    git(remotePath, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    git(root, ["clone", remotePath, staleClonePath]);
    await writeFile(
      path.join(seedPath, "Service.java"),
      'class Service { String value = "FreshNeedle"; }\n',
    );
    git(seedPath, ["add", "Service.java"]);
    git(seedPath, ["commit", "-m", "add fresh code"]);
    git(seedPath, ["push", "origin", "main"]);

    const previousWorktreeBase = process.env.INVESTIGATION_CODE_WORKTREE_BASE;
    process.env.INVESTIGATION_CODE_WORKTREE_BASE = worktreeBase;
    try {
      const adapter = new CodeInspectionAdapter(
        new InMemoryCodeTargetRegistry([
          {
            id: "performrx-batch",
            clientId: "PERFORMRX",
            environment: "UAT",
            repoName: "batch-jobs",
            repoPath: staleClonePath,
            repoUrl: remotePath,
            branch: "main",
            defaultBranch: "main",
            refreshFromRemote: true,
            enabled: true,
          },
        ]),
      );

      const request: InvestigationAdapterRequest = {
        runId: "inv-refresh-test",
        jiraKey: "CPSUP-1",
        adapter: "code",
        scope: {
          clientId: "PERFORMRX",
          environment: "UAT",
          serviceIds: ["epaProcessorBatch"],
          keywords: ["FreshNeedle"],
          repoNames: ["batch-jobs"],
        },
        constraints: {
          timeoutMs: 10_000,
          redactionRequired: true,
        },
      };

      const result = await adapter.execute(request);

      expect(result.findings[0]?.type).toBe("code_path_candidates");
      expect(result.evidence[0]?.metadata?.codeRefresh).toEqual([
        expect.objectContaining({
          repoName: "batch-jobs",
          status: "refreshed",
          branch: "main",
        }),
      ]);
      expect(result.evidence[0]?.metadata?.hits).toEqual([
        expect.objectContaining({
          repoName: "batch-jobs",
          path: "Service.java",
          term: "FreshNeedle",
        }),
      ]);
    } finally {
      if (previousWorktreeBase === undefined) {
        delete process.env.INVESTIGATION_CODE_WORKTREE_BASE;
      } else {
        process.env.INVESTIGATION_CODE_WORKTREE_BASE = previousWorktreeBase;
      }
    }
  });

  it("tries configured branch candidates in order for ticket-derived release branches", async () => {
    const root = await makeTempRoot();
    const remotePath = path.join(root, "remote.git");
    const seedPath = path.join(root, "seed");
    const clonePath = path.join(root, "clone");
    const worktreeBase = path.join(root, "worktrees");

    git(root, ["init", "--bare", remotePath]);
    git(root, ["init", seedPath]);
    git(seedPath, ["config", "user.name", "Code Agent Test"]);
    git(seedPath, ["config", "user.email", "code-agent@example.test"]);
    await writeFile(
      path.join(seedPath, "Job.java"),
      'class Job { String value = "main"; }\n',
    );
    git(seedPath, ["add", "Job.java"]);
    git(seedPath, ["commit", "-m", "initial"]);
    git(seedPath, ["branch", "-M", "master"]);
    git(seedPath, ["remote", "add", "origin", remotePath]);
    git(seedPath, ["push", "origin", "master"]);
    git(remotePath, ["symbolic-ref", "HEAD", "refs/heads/master"]);
    git(seedPath, ["checkout", "-b", "cp-batch-monorepo-3.18"]);
    await writeFile(
      path.join(seedPath, "Job.java"),
      'class Job { String value = "TicketBranchNeedle"; }\n',
    );
    git(seedPath, ["add", "Job.java"]);
    git(seedPath, ["commit", "-m", "release branch"]);
    git(seedPath, ["push", "origin", "cp-batch-monorepo-3.18"]);

    git(root, ["clone", remotePath, clonePath]);

    const previousWorktreeBase = process.env.INVESTIGATION_CODE_WORKTREE_BASE;
    process.env.INVESTIGATION_CODE_WORKTREE_BASE = worktreeBase;
    try {
      const adapter = new CodeInspectionAdapter(
        new InMemoryCodeTargetRegistry([
          {
            id: "centene-batch",
            clientId: "CENTENE",
            environment: "PROD_REPLICA",
            repoName: "batch-jobs",
            repoPath: clonePath,
            repoUrl: remotePath,
            branch: "batch-monorepo-3.18",
            branchCandidates: [
              "batch-monorepo-3.18",
              "cp-batch-monorepo-3.18",
              "3.18",
              "master",
            ],
            defaultBranch: "master",
            refreshFromRemote: true,
            enabled: true,
          },
        ]),
      );

      const request: InvestigationAdapterRequest = {
        runId: "inv-branch-candidates-test",
        jiraKey: "CPSUP-50343",
        adapter: "code",
        scope: {
          clientId: "CENTENE",
          environment: "PROD_REPLICA",
          serviceIds: ["batch"],
          keywords: ["TicketBranchNeedle"],
          repoNames: ["batch-jobs"],
        },
        constraints: {
          timeoutMs: 10_000,
          redactionRequired: true,
        },
      };

      const result = await adapter.execute(request);

      expect(result.findings[0]?.type).toBe("code_path_candidates");
      expect(result.evidence[0]?.metadata?.codeRefresh).toEqual([
        expect.objectContaining({
          repoName: "batch-jobs",
          status: "refreshed",
          branch: "cp-batch-monorepo-3.18",
          attemptedBranches: expect.arrayContaining([
            expect.objectContaining({
              branch: "batch-monorepo-3.18",
              status: "failed",
            }),
            expect.objectContaining({
              branch: "cp-batch-monorepo-3.18",
              status: "resolved",
            }),
          ]),
        }),
      ]);
    } finally {
      if (previousWorktreeBase === undefined) {
        delete process.env.INVESTIGATION_CODE_WORKTREE_BASE;
      } else {
        process.env.INVESTIGATION_CODE_WORKTREE_BASE = previousWorktreeBase;
      }
    }
  });

  it("scans canonical and client hotfix branches in the same release family", async () => {
    const root = await makeTempRoot();
    const remotePath = path.join(root, "remote.git");
    const seedPath = path.join(root, "seed");
    const clonePath = path.join(root, "clone");
    const worktreeBase = path.join(root, "worktrees");

    git(root, ["init", "--bare", remotePath]);
    git(root, ["init", seedPath]);
    git(seedPath, ["config", "user.name", "Code Agent Test"]);
    git(seedPath, ["config", "user.email", "code-agent@example.test"]);
    await writeFile(path.join(seedPath, "Service.java"), 'class Service { String value = "master"; }\n');
    git(seedPath, ["add", "Service.java"]);
    git(seedPath, ["commit", "-m", "initial"]);
    git(seedPath, ["branch", "-M", "master"]);
    git(seedPath, ["remote", "add", "origin", remotePath]);
    git(seedPath, ["push", "origin", "master"]);
    git(remotePath, ["symbolic-ref", "HEAD", "refs/heads/master"]);

    git(seedPath, ["checkout", "-b", "client-services-monorepo-3.20"]);
    await writeFile(path.join(seedPath, "Service.java"), 'class Service { String value = "ReleaseFamilyNeedle canonical"; }\n');
    git(seedPath, ["add", "Service.java"]);
    git(seedPath, ["commit", "-m", "canonical release"]);
    git(seedPath, ["push", "origin", "client-services-monorepo-3.20"]);

    await writeFile(
      path.join(seedPath, "RequestRecord.hbm.xml"),
      '<hibernate-mapping><class name="RequestRecord" table="request_record"><property name="displayLabel"><column name="display_label" length="64"/></property></class></hibernate-mapping>\n',
    );
    await writeFile(
      path.join(seedPath, "MemberMapper.java"),
      [
        'class MemberMapper {',
        '  MemberDocuments document;',
        '  MemberAddress address;',
        '  String memberEmail;',
        ...Array.from({ length: 20 }, (_, index) => `  // unrelated mapper setup ${index}`),
        '  void map(Response response) {',
        '    document = new MemberDocuments();',
        '    document.setFirstName(response.getAor().getFirstName()); document.setLastName(response.getAor().getReleaseTypeDesc());',
        '    memberEmail = response.getTelecom().getEmailAddress();',
        '    address = new MemberAddress();',
        '    address.setEmail(memberEmail);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(seedPath, "MemberDocuments.hbm.xml"),
      '<hibernate-mapping><class name="MemberDocuments" table="member_documents"><property name="firstName"><column name="first_name" length="45"/></property></class></hibernate-mapping>\n',
    );
    await writeFile(
      path.join(seedPath, "MemberAddress.hbm.xml"),
      '<hibernate-mapping><class name="MemberAddress" table="member_address"><property name="email"><column name="email" length="45"/></property></class></hibernate-mapping>\n',
    );
    git(seedPath, ["add", "RequestRecord.hbm.xml", "MemberMapper.java", "MemberDocuments.hbm.xml", "MemberAddress.hbm.xml"]);
    git(seedPath, ["commit", "-m", "add persistence mapping"]);
    git(seedPath, ["push", "origin", "client-services-monorepo-3.20"]);

    git(seedPath, ["checkout", "-b", "client-services-monorepo-3.20-client-hotfix-1"]);
    await writeFile(path.join(seedPath, "Service.java"), 'class Service { String value = "ReleaseFamilyNeedle hotfix"; }\n');
    git(seedPath, ["add", "Service.java"]);
    git(seedPath, ["commit", "-m", "client hotfix"]);
    git(seedPath, ["push", "origin", "client-services-monorepo-3.20-client-hotfix-1"]);
    git(root, ["clone", remotePath, clonePath]);

    const previousWorktreeBase = process.env.INVESTIGATION_CODE_WORKTREE_BASE;
    process.env.INVESTIGATION_CODE_WORKTREE_BASE = worktreeBase;
    try {
      const adapter = new CodeInspectionAdapter(
        new InMemoryCodeTargetRegistry([{
          id: "client-services",
          clientId: "CLIENT",
          environment: "PROD_REPLICA",
          repoName: "client-services",
          repoPath: clonePath,
          repoUrl: remotePath,
          branch: "client-services-monorepo-3.20",
          branchCandidates: ["client-services-monorepo-3.20", "master"],
          branchFamilyPatterns: ["client-services-monorepo-3.20*"],
          defaultBranch: "master",
          refreshFromRemote: true,
          enabled: true,
        }]),
      );
      const request: InvestigationAdapterRequest = {
        runId: "inv-release-family-test",
        jiraKey: "CPSUP-3",
        adapter: "code",
        scope: {
          clientId: "CLIENT",
          environment: "PROD_REPLICA",
          serviceIds: ["client-services"],
          releaseVersion: "3.20",
          keywords: ["ReleaseFamilyNeedle"],
          repoNames: ["client-services"],
          ticketContext: {
            attachments: [{
              id: "payload",
              filename: "response.json",
              extractionStatus: "text_extracted",
              textExcerpt: JSON.stringify({ metadata: { displayLabel: "X".repeat(70) }, aor: { firstName: "X".repeat(47) }, telecom: { emailAddress: "X".repeat(58) } }),
            }],
          },
        },
        constraints: { timeoutMs: 10_000, redactionRequired: true },
      };

      const result = await adapter.execute(request);

      expect(result.evidence[0]?.metadata?.codeRefresh).toEqual(expect.arrayContaining([
        expect.objectContaining({ branch: "client-services-monorepo-3.20", status: "refreshed" }),
        expect.objectContaining({ branch: "client-services-monorepo-3.20-client-hotfix-1", status: "refreshed" }),
      ]));
      expect(result.evidence[0]?.metadata?.hits).toEqual(expect.arrayContaining([
        expect.objectContaining({ branch: "client-services-monorepo-3.20", term: "ReleaseFamilyNeedle" }),
        expect.objectContaining({ branch: "client-services-monorepo-3.20-client-hotfix-1", term: "ReleaseFamilyNeedle" }),
      ]));
      expect(result.evidence[0]?.metadata?.dataFlowHints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tableName: "request_record",
          columns: expect.arrayContaining([
            expect.objectContaining({ name: "display_label", propertyName: "displayLabel" }),
          ]),
        }),
        expect.objectContaining({
          tableName: "member_documents",
          modelName: "MemberDocuments",
          columns: expect.arrayContaining([
            expect.objectContaining({
              name: "first_name",
              propertyName: "firstName",
              linkedFields: expect.arrayContaining(["firstName", "aor.firstName"]),
            }),
          ]),
          linkedFields: expect.arrayContaining(["firstName", "aor.firstName"]),
        }),
        expect.objectContaining({
          tableName: "member_address",
          columns: expect.arrayContaining([
            expect.objectContaining({
              name: "email",
              propertyName: "email",
              linkedFields: expect.arrayContaining(["emailAddress", "telecom.emailAddress"]),
            }),
          ]),
        }),
      ]));
      expect(JSON.stringify(result.evidence[0]?.metadata?.dataFlowHints))
        .not.toMatch(/first_name[^}]*releaseTypeDesc/)
    } finally {
      if (previousWorktreeBase === undefined) {
        delete process.env.INVESTIGATION_CODE_WORKTREE_BASE;
      } else {
        process.env.INVESTIGATION_CODE_WORKTREE_BASE = previousWorktreeBase;
      }
    }
  });

  it("ranks PAResponse eAppeal candidates ahead of generic EPA config hits", async () => {
    const root = await makeTempRoot();
    const repoPath = path.join(root, "core-app");
    await mkdir(
      path.join(repoPath, "MedicalMgmt/src/com/medhok/mm/client/authorization"),
      { recursive: true },
    );
    await mkdir(
      path.join(repoPath, "MedicalMgmt/src/com/medhok/mm/epa/response"),
      { recursive: true },
    );
    await mkdir(path.join(repoPath, "flyway/sql"), { recursive: true });
    await writeFile(
      path.join(
        repoPath,
        "MedicalMgmt/src/com/medhok/mm/client/authorization/IreMgmtDS.java",
      ),
      'class IreMgmtDS { String sql = "SELECT e_appeal_allowed FROM epa_config"; }\n',
    );
    await writeFile(
      path.join(
        repoPath,
        "MedicalMgmt/src/com/medhok/mm/epa/response/CreateRXPAResponse.java",
      ),
      'class CreateRXPAResponse { void write() { paResponse.setIsEAppealSupported("Y"); } }\n',
    );
    await writeFile(
      path.join(repoPath, "flyway/sql/V1__ncpdp_epa_transaction_history.sql"),
      "CREATE TABLE ncpdp_epa_transaction_history (is_eappeal_supported varchar(1));\n",
    );

    const adapter = new CodeInspectionAdapter(
      new InMemoryCodeTargetRegistry([
        {
          id: "performrx-core",
          clientId: "PERFORMRX",
          environment: "UAT",
          repoName: "core-app",
          repoPath,
          enabled: true,
          refreshFromRemote: false,
        },
      ]),
      5,
      new InMemoryCodeSemanticProfileRegistry([
        {
          id: "epa_eappeal_response",
          title: "ePA eAppeal response support",
          summary:
            "Ticket describes PAResponse IsEAppealSupported behavior for denied or partially denied ePA requests.",
          clientId: "PERFORMRX",
          environments: ["UAT"],
          priority: 100,
          matchAll: ["epa", "e appeal"],
          matchAny: ["PAResponse", "IsEAppealSupported", "appeal supported"],
          preferredTerms: [
            "IsEAppealSupported",
            "PAResponse",
            "CreateRXPAResponse",
            "e_appeal_allowed",
            "epa_config",
            "ncpdp_epa_transaction_history",
            "EAppeal",
          ],
          pathBoosts: [
            "paresponse",
            "response",
            "ncpdp",
            "epa",
            "eappeal",
            "appeal",
            "transaction",
            "provider",
          ],
          previewBoosts: [
            "iseappealsupported",
            "paresponse",
            "e_appeal_allowed",
            "epa_config",
            "ncpdp_epa_transaction_history",
          ],
          negativePathTerms: ["test", "mock", "fixture"],
          rules: [
            {
              score: 22,
              reason: "PAResponse with EPA/NCPDP context",
              textAll: ["PAResponse"],
              textAny: [
                "EPA",
                "NCPDP",
                "eAppeal",
                "isEappealSupported",
                "ncpdp_epa_transaction_history",
              ],
            },
            {
              score: -35,
              pathAny: ["DynamicPAResponse"],
              unlessTextAny: [
                "EPA",
                "NCPDP",
                "eAppeal",
                "isEappealSupported",
                "ncpdp_epa_transaction_history",
              ],
            },
          ],
          enabled: true,
        },
      ]),
    );

    const request: InvestigationAdapterRequest = {
      runId: "inv-semantic-test",
      jiraKey: "CPSUP-48576",
      adapter: "code",
      scope: {
        clientId: "PERFORMRX",
        environment: "UAT",
        serviceIds: ["core"],
        keywords: [
          "ePA",
          "E Appeal Allowed",
          "PAResponse",
          "IsEAppealSupported",
        ],
        repoNames: ["core-app"],
        ticketContext: {
          source: "jira",
          jiraKey: "CPSUP-48576",
          fetchStatus: "fetched",
          title: "ePA denied response sends N for IsEAppealSupported",
          description:
            "When an ePA request is Denied or Partially Denied and E Appeal Allowed is enabled under EPA Config, PAResponse should send IsEAppealSupported=Y.",
        },
      },
      constraints: {
        timeoutMs: 10_000,
        redactionRequired: true,
      },
    };

    const result = await adapter.execute(request);

    expect(result.findings[0]?.metadata?.semanticProfileId).toBe(
      "epa_eappeal_response",
    );
    expect(result.findings[0]?.metadata?.strongestCandidate).toContain(
      "CreateRXPAResponse.java",
    );
    const hits = result.evidence[0]?.metadata?.hits as Array<
      Record<string, unknown>
    >;
    expect(hits[0]?.path).toContain("CreateRXPAResponse.java");
    expect(hits[0]?.semanticReasons).toEqual(
      expect.arrayContaining([expect.stringContaining("IsEAppealSupported")]),
    );
  });

  it("down-ranks code owned by a different client module", async () => {
    const root = await makeTempRoot();
    const repoPath = path.join(root, "client-services");
    const magellanPath = path.join(
      repoPath,
      "mm-service-magellan/src/main/java/com/medhok/mm/service/external/ClientPasswordCallback.java",
    );
    const sharedPath = path.join(
      repoPath,
      "ExternalClientServices/src/main/java/com/medhok/mm/service/external/SharedNotificationCredentialService.java",
    );
    await mkdir(path.dirname(magellanPath), { recursive: true });
    await mkdir(path.dirname(sharedPath), { recursive: true });
    await writeFile(magellanPath, 'class ClientPasswordCallback { String signal = "password"; }\n');
    await writeFile(sharedPath, 'class SharedNotificationCredentialService { String signal = "password outboundNotification"; }\n');

    const adapter = new CodeInspectionAdapter(new InMemoryCodeTargetRegistry([{
      id: "clientx-client-services",
      clientId: "CLIENTX",
      environment: "PROD_REPLICA",
      repoName: "client-services",
      repoPath,
      enabled: true,
      refreshFromRemote: false,
    }]));
    const result = await adapter.execute({
      runId: "inv-client-module-ranking",
      jiraKey: "SUP-200",
      adapter: "code",
      scope: {
        clientId: "CLIENTX",
        environment: "PROD_REPLICA",
        serviceIds: ["client-services"],
        keywords: ["password", "outboundNotification"],
        repoNames: ["client-services"],
      },
      constraints: { timeoutMs: 10_000, redactionRequired: true },
    });

    expect(result.findings[0]?.metadata?.strongestCandidate).toContain("SharedNotificationCredentialService.java");
    const hits = result.evidence[0]?.metadata?.hits as Array<Record<string, unknown>>;
    const magellanHit = hits.find(hit => String(hit.path).includes("mm-service-magellan"));
    expect(magellanHit?.semanticReasons).toEqual(expect.arrayContaining([
      expect.stringContaining("does not match investigation scope"),
    ]));
  });

  it("derives loader table terms from first-pass ticket hits instead of static clues", async () => {
    const root = await makeTempRoot();
    const repoPath = path.join(root, "core-app");
    await mkdir(
      path.join(repoPath, "MedicalMgmt/src/com/medhok/mm/server/service"),
      { recursive: true },
    );
    await mkdir(
      path.join(
        repoPath,
        "mm-dynamic-loader-service/src/main/java/com/medhok/mm/dynamic/loader/service",
      ),
      { recursive: true },
    );
    await mkdir(
      path.join(
        repoPath,
        "mm-dynamic-loader-service/src/main/java/com/medhok/mm/dynamic/loader/utils",
      ),
      { recursive: true },
    );
    await writeFile(
      path.join(
        repoPath,
        "MedicalMgmt/src/com/medhok/mm/server/service/BecuReportingService.java",
      ),
      [
        "class BecuReportingService {",
        "  // Validation report tables",
        '  String reportSql = "select * from data_intake.file_load_summary fls "',
        '      + "join data_intake.file_load_detail fld on fld.file_load_summary_id = fls.id "',
        '      + "join medhok.batch_file_run_audit bfra on bfra.id = fls.batch_file_run_audit_id";',
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(
        repoPath,
        "mm-dynamic-loader-service/src/main/java/com/medhok/mm/dynamic/loader/service/DataLoaderBusniessService.java",
      ),
      [
        "class DataLoaderBusniessService {",
        "  void validate() {",
        '    String summary = "data_intake.file_load_summary";',
        '    String detail = "data_intake.file_load_detail";',
        "  }",
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(
        repoPath,
        "mm-dynamic-loader-service/src/main/java/com/medhok/mm/dynamic/loader/utils/LoaderUtils.java",
      ),
      [
        "class LoaderUtils {",
        '  String fieldName = "Letter Template";',
        '  String fieldConfig = "data_loader_config_fields resolves DB column note_type_id";',
        "}",
      ].join("\n"),
    );

    const adapter = new CodeInspectionAdapter(
      new InMemoryCodeTargetRegistry([
        {
          id: "wellcare-core",
          clientId: "WELLCARE",
          environment: "PROD_REPLICA",
          repoName: "core-app",
          repoPath,
          enabled: true,
          refreshFromRemote: false,
        },
      ]),
      5,
    );

    const request: InvestigationAdapterRequest = {
      runId: "inv-loader-discovery-test",
      jiraKey: "CPSUP-50343",
      adapter: "code",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["batch"],
        keywords: ["BECU", "Letter Template"],
        repoNames: ["core-app"],
        ticketContext: {
          source: "jira",
          jiraKey: "CPSUP-50343",
          fetchStatus: "fetched",
          title:
            "Centene | MedPharm Letter Template Update **Issue with Tool**",
          extractedTerms: ["BECU", "Letter Template"],
        },
      },
      constraints: {
        timeoutMs: 10_000,
        redactionRequired: true,
      },
    };

    const result = await adapter.execute(request);

    expect(result.findings[0]?.type).toBe("code_path_candidates");
    const metadata = result.evidence[0]?.metadata as {
      discoveryTrace?: { derivedTerms?: string[]; contextFiles?: string[] };
      dataFlowHints?: Array<{ tableName?: string; sourcePath?: string }>;
      hits?: Array<{ path?: string; term?: string }>;
    };
    expect(metadata.discoveryTrace?.contextFiles).toEqual(
      expect.arrayContaining([
        expect.stringContaining("BecuReportingService.java"),
      ]),
    );
    expect(metadata.discoveryTrace?.derivedTerms).toEqual(
      expect.arrayContaining([
        "data_intake.file_load_summary",
        "data_intake.file_load_detail",
        "medhok.batch_file_run_audit",
        "data_loader_config_fields",
      ]),
    );
    expect(metadata.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("DataLoaderBusniessService.java"),
          term: "data_intake.file_load_summary",
        }),
        expect.objectContaining({
          path: expect.stringContaining("LoaderUtils.java"),
          term: "data_loader_config_fields",
        }),
      ]),
    );
    expect(metadata.dataFlowHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "file_load_summary",
          sourcePath: expect.stringContaining("BecuReportingService.java"),
        }),
        expect.objectContaining({
          tableName: "file_load_detail",
          sourcePath: expect.stringContaining("BecuReportingService.java"),
        }),
        expect.objectContaining({
          tableName: "batch_file_run_audit",
          sourcePath: expect.stringContaining("BecuReportingService.java"),
        }),
      ]),
    );
  });
});
