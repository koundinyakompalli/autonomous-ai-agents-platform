import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import path from "path";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getPool: () => ({ execute: mocks.execute }),
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
}));

import {
  decideMeridianHandoff,
  maybeCreateMeridianHandoff,
} from "./investigationMeridianHandoff.js";

function executionWithTicketText(text: string, findingOverrides: Record<string, unknown> = {}) {
  return executionWithTicketContext({
    title: "PerformRx investigation",
    descriptionPresent: Boolean(text),
    attachments: [],
    extractedTerms: [text],
  }, findingOverrides);
}

function executionWithTicketContext(
  ticketContextOverrides: Record<string, unknown>,
  findingOverrides: Record<string, unknown> = {},
) {
  return {
    run: {
      id: "inv-test",
      jiraKey: "CPSUP-48576",
      scope: {
        clientId: "PERFORMRX",
        environment: "PROD_REPLICA",
        serviceIds: [],
        ticketContext: {
          source: "jira",
          jiraKey: "CPSUP-48576",
          fetchStatus: "fetched",
          title: "PerformRx investigation",
          descriptionPresent: false,
          commentCount: 0,
          attachments: [],
          extractedTerms: [],
          ...ticketContextOverrides,
        },
      },
    },
    findings: Object.keys(findingOverrides).length > 0
      ? [{
          title: "Data remediation required",
          requiresDataChange: false,
          ...findingOverrides,
        }]
      : [],
    evidence: [],
    rcaAssessment: {
      diagnosisReady: true,
    },
  } as any;
}

const client = {
  id: "PERFORMRX",
  displayName: "PerformRx",
  aliases: ["PerformRx"],
} as any;

function expectedRepoRoot(): string {
  return path.basename(process.cwd()) === "dashboard"
    ? path.dirname(process.cwd())
    : process.cwd();
}

describe("MERIDIAN investigation handoff decision", () => {
  beforeEach(() => {
    vi.stubEnv("INVESTIGATION_DB_REMOTE_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_REMOTE_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_REMOTE_PORT", "");
    vi.stubEnv("MERIDIAN_DB_REMOTE_HOST", "");
    vi.stubEnv("MERIDIAN_DB_REMOTE_HOST_TEMPLATE", "");
    vi.stubEnv("MERIDIAN_DB_REMOTE_PORT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    mocks.execute.mockReset();
    mocks.spawn.mockReset();
  });

  it("routes backend/case-update tickets to MERIDIAN", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("Please generate the backend update for these case updates."),
      client,
    });

    expect(decision).toMatchObject({
      shouldCreate: true,
      reason: expect.stringContaining("backend/case-update"),
    });
  });

  it("routes BECU tickets to MERIDIAN", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("BECU spreadsheet attached for SQL generation."),
      client,
    });

    expect(decision.shouldCreate).toBe(true);
  });

  it("routes a BECU field removal to MERIDIAN", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("BECU request: Remove AOR Received Date & Time in Production."),
      client,
    });

    expect(decision).toMatchObject({
      shouldCreate: true,
      reason: expect.stringContaining("BECU/CCIU"),
    });
  });

  it("routes an explicit BECU record deletion without treating it as a field clear", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("BECU request: delete the record after dependency validation."),
      client,
    });

    expect(decision.shouldCreate).toBe(true);
  });

  it("routes CCIU tickets to MERIDIAN", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("CCIU spreadsheet attached for SQL generation."),
      client,
    });

    expect(decision).toMatchObject({
      shouldCreate: true,
      reason: expect.stringContaining("BECU/CCIU"),
    });
  });

  it("does not treat a client family name alone as data-change intent", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("BECU member access investigation with no requested backend change."),
      client,
    });

    expect(decision.shouldCreate).toBe(false);
  });

  it("routes backend case edit tickets with spreadsheet attachments to MERIDIAN", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketContext({
        title: "HEALTHSPRING(CIGNA) MHK - Grievance - High - Backend case edit - INC0207271 - 6-29-2026",
        attachments: [{
          id: "357858",
          filename: "Back End Ticket Week 06-26-2026.xlsx",
          extractionStatus: "metadata_only",
        }],
        extractedTerms: ["HEALTHSPRING", "CIGNA", "Grievance", "Backend"],
      }),
      client: {
        id: "CIGNA",
        displayName: "Cigna",
        aliases: ["HealthSpring"],
      } as any,
    });

    expect(decision).toMatchObject({
      shouldCreate: true,
      reason: expect.stringContaining("backend/case-update"),
    });
  });

  it("routes findings that explicitly require data remediation", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("Runtime evidence collected.", {
        analyzer: "data",
        requiresDataChange: true,
      }),
      client,
    });

    expect(decision).toMatchObject({
      shouldCreate: true,
      reason: expect.stringContaining("requires data remediation"),
    });
  });

  it("blocks evidence-derived data remediation until the causal diagnosis is ready", () => {
    const execution = executionWithTicketText("Runtime evidence collected.", {
      analyzer: "data",
      requiresDataChange: true,
    });
    execution.rcaAssessment.diagnosisReady = false;

    const decision = decideMeridianHandoff({ execution, client });

    expect(decision).toMatchObject({
      shouldCreate: false,
      reason: expect.stringContaining("shared resolution gate"),
    });
  });

  it("routes generic SQL remediation tickets to MERIDIAN", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("Please generate SQL remediation for the records in the attached evidence."),
      client,
    });

    expect(decision).toMatchObject({
      shouldCreate: true,
      reason: expect.stringContaining("SQL generation"),
    });
  });

  it("queues the MERIDIAN task through the platform handoff service", async () => {
    mocks.execute
      .mockResolvedValueOnce([[{ id: 7, task_type: "sql_generation" }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 12 }]])
      .mockResolvedValueOnce([{ insertId: 34 }]);

    const result = await maybeCreateMeridianHandoff({
      execution: executionWithTicketText("Please generate SQL remediation for the attached spreadsheet."),
      client,
    });

    expect(result).toMatchObject({
      status: "created",
      taskManagementId: 34,
      reason: expect.stringContaining("MERIDIAN task queued for worker pickup"),
    });
    expect(result.reason).toContain("MERIDIAN worker owns LDAP SSH/client DB connectivity");
    expect(mocks.execute.mock.calls[3][0]).toContain("INSERT INTO task_management");
  });

  it("reports platform DB task creation failures without duplicating the MERIDIAN prefix", async () => {
    const error = new Error();
    Object.assign(error, { code: "ECONNREFUSED" });
    mocks.execute.mockRejectedValueOnce(error);

    const result = await maybeCreateMeridianHandoff({
      execution: executionWithTicketText("Please generate SQL remediation for the attached spreadsheet."),
      client,
    });

    expect(result).toMatchObject({
      status: "failed",
      reason: "platform DB task creation failed: connection refused; code=ECONNREFUSED",
    });
    expect(result.reason).not.toMatch(/^MERIDIAN handoff failed: MERIDIAN handoff failed:/);
  });

  it("starts direct local fallback only when explicitly enabled and the platform DB queue is unavailable", async () => {
    vi.stubEnv("INVESTIGATION_MERIDIAN_DIRECT_FALLBACK", "true");
    vi.stubEnv("MERIDIAN_DB_USERNAME", "");
    vi.stubEnv("MERIDIAN_DB_PASSWORD", "");
    vi.stubEnv("MERIDIAN_DB_DATABASE", "");
    vi.stubEnv("INVESTIGATION_DB_HOST", "performrx-prod-replica-db.internal");
    vi.stubEnv("INVESTIGATION_DB_PORT", "3306");
    vi.stubEnv("INVESTIGATION_DB_DATABASE", "medhok_performrx");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "operator.db");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "operator-secret");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "performrx-prod-login.example.test");
    vi.stubEnv("INVESTIGATION_OPERATOR_SSH_USER", "");
    vi.stubEnv("INVESTIGATION_SSH_USER", "operator.ssh");
    vi.stubEnv("INVESTIGATION_SSH_CONTROL_PATH", "/tmp/performrx-ldap.sock");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    mocks.spawn.mockReturnValueOnce(child);
    const error = new Error();
    Object.assign(error, { code: "ECONNREFUSED" });
    mocks.execute.mockRejectedValueOnce(error);

    const result = await maybeCreateMeridianHandoff({
      execution: executionWithTicketText("Please generate SQL remediation for the attached spreadsheet."),
      client,
    });

    expect(result).toMatchObject({
      status: "created",
      reason: expect.stringContaining("direct local fallback"),
    });
    child.emit("close", 0);
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringContaining("node_modules/tsx/dist/cli.mjs"),
        expect.stringContaining("scripts/meridian-direct-run.ts"),
        "--jira",
        "CPSUP-48576",
      ]),
      expect.objectContaining({
        cwd: expectedRepoRoot(),
        env: expect.objectContaining({
          INVESTIGATION_COCKPIT_API_BASE_URL: expect.stringContaining("/api/investigation"),
        }),
      }),
    );
    const spawnEnv = mocks.spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(spawnEnv.MERIDIAN_DB_USERNAME).toBe("operator.db");
    expect(spawnEnv.MERIDIAN_DB_PASSWORD).toBe("operator-secret");
    expect(spawnEnv.MERIDIAN_DB_DATABASE).toBe("medhok_performrx");
    expect(spawnEnv.MERIDIAN_TARGET_CLIENT_OVERRIDE).toBe("PerformRx");
    expect(spawnEnv.MERIDIAN_TARGET_ENVIRONMENT_OVERRIDE).toBe("PROD_REPLICA");
    const meridianTargets = JSON.parse(spawnEnv.MERIDIAN_TARGETS_JSON || "{}");
    expect(meridianTargets.targets?.[0]).toMatchObject({
      id: "cockpit-performrx-prod-replica-ldap-db",
      clients: ["PerformRx", "PERFORMRX"],
      networkPath: "ldap_ssh",
      remoteHost: "performrx-prod-replica-db.internal",
      remotePort: 3306,
      publicHost: "performrx-prod-login.example.test",
      sshUser: "operator.ssh",
      sshControlPath: "/tmp/performrx-ldap.sock",
      databaseName: "medhok_performrx",
      dbUser: "env://MERIDIAN_DB_USERNAME",
      secretRef: "env://MERIDIAN_DB_PASSWORD",
      ssmAllowed: false,
    });
  });

  it("keeps explicitly configured Meridian target files authoritative for direct fallback", async () => {
    vi.stubEnv("INVESTIGATION_MERIDIAN_DIRECT_FALLBACK", "true");
    vi.stubEnv("MERIDIAN_DB_USERNAME", "");
    vi.stubEnv("MERIDIAN_DB_PASSWORD", "");
    vi.stubEnv("MERIDIAN_DB_DATABASE", "");
    vi.stubEnv("MERIDIAN_TARGETS_FILE", "/secure/meridian-targets.json");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    mocks.spawn.mockReturnValueOnce(child);
    const error = new Error();
    Object.assign(error, { code: "ECONNREFUSED" });
    mocks.execute.mockRejectedValueOnce(error);

    const execution = executionWithTicketText("Please generate SQL remediation for the attached spreadsheet.");
    execution.run.id = "inv-test-explicit-target-file";

    await maybeCreateMeridianHandoff({
      execution,
      client,
    });

    const spawnEnv = mocks.spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(spawnEnv.MERIDIAN_TARGETS_FILE).toBe("/secure/meridian-targets.json");
    expect(spawnEnv.MERIDIAN_TARGETS_JSON).toBeUndefined();
  });

  it("passes the resolved Cockpit private-network DB target to direct Meridian", async () => {
    vi.stubEnv("INVESTIGATION_MERIDIAN_DIRECT_FALLBACK", "true");
    vi.stubEnv("MERIDIAN_TARGETS_JSON", "");
    vi.stubEnv("MERIDIAN_TARGETS_FILE", "");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    mocks.spawn.mockReturnValueOnce(child);
    mocks.execute.mockRejectedValueOnce(Object.assign(new Error(), { code: "ECONNREFUSED" }));

    const execution = executionWithTicketText("Please generate SQL remediation for the attached spreadsheet.");
    execution.run.id = "inv-test-approved-network-target";
    await maybeCreateMeridianHandoff({
      execution,
      client,
      connectionTarget: {
        id: "approved-client-db",
        clientId: "PERFORMRX",
        environment: "PROD_REPLICA",
        envId: "prod-replica",
        topology: "rds_mysql",
        engine: "mysql",
        host: "approved-db.internal",
        port: 3307,
        databaseName: "approved_schema",
        networkPath: "private_vpc",
        authMode: "username_password",
        secretRef: "env://INVESTIGATION_DB_PASSWORD",
        dbUser: "env://INVESTIGATION_DB_USERNAME",
        accessClass: "prod_replica_ro",
        allowedQueryPacks: [],
        phiAccess: false,
        enabled: true,
        sslRequired: false,
      },
    });

    const spawnEnv = mocks.spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    const meridianTargets = JSON.parse(spawnEnv.MERIDIAN_TARGETS_JSON || "{}");
    expect(meridianTargets.targets?.[0]).toMatchObject({
      networkPath: "private_vpc",
      remoteHost: "approved-db.internal",
      remotePort: 3307,
      databaseName: "approved_schema",
      sshAllowed: false,
    });
    child.emit("close", 0);
  });

  it("fails preflight without spawning when LDAP SSH has no approved gateway", async () => {
    vi.stubEnv("INVESTIGATION_MERIDIAN_DIRECT_FALLBACK", "true");
    vi.stubEnv("MERIDIAN_TARGETS_JSON", "");
    vi.stubEnv("MERIDIAN_TARGETS_FILE", "");
    mocks.execute.mockRejectedValueOnce(Object.assign(new Error(), { code: "ECONNREFUSED" }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const execution = executionWithTicketText("Please generate SQL remediation for the attached spreadsheet.");
    execution.run.id = "inv-test-incomplete-access-target";
    const result = await maybeCreateMeridianHandoff({
      execution,
      client,
      connectionTarget: {
        id: "approved-client-db",
        clientId: "PERFORMRX",
        environment: "PROD_REPLICA",
        envId: "prod-replica",
        topology: "rds_mysql",
        engine: "mysql",
        host: "approved-db.internal",
        port: 3306,
        databaseName: "approved_schema",
        networkPath: "ssh_public",
        authMode: "username_password",
        secretRef: "env://INVESTIGATION_DB_PASSWORD",
        dbUser: "env://INVESTIGATION_DB_USERNAME",
        accessClass: "prod_replica_ro",
        allowedQueryPacks: [],
        phiAccess: false,
        enabled: true,
        sslRequired: false,
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("did not resolve an approved SSH gateway"),
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const attachment = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(attachment.findings?.[0]).toMatchObject({
      analyzer: "data",
      title: "Meridian database access unavailable",
    });
    expect(attachment.findings?.[0]?.summary).not.toContain("errorStack");
  });

  it("reuses Cockpit evidence-derived SSH host when direct fallback target env omits SSH host", async () => {
    vi.stubEnv("INVESTIGATION_MERIDIAN_DIRECT_FALLBACK", "true");
    vi.stubEnv("MERIDIAN_TARGETS_JSON", "");
    vi.stubEnv("MERIDIAN_TARGETS_FILE", "");
    vi.stubEnv("INVESTIGATION_DB_HOST", "performrx-prod-replica-db.internal");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "operator.db");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "operator-secret");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_PUBLIC_HOST", "");
    vi.stubEnv("INVESTIGATION_BASTION_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_MASTER_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_PORT", "");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    mocks.spawn.mockReturnValueOnce(child);
    const error = new Error();
    Object.assign(error, { code: "ECONNREFUSED" });
    mocks.execute.mockRejectedValueOnce(error);
    const execution = executionWithTicketText("Please generate SQL remediation for the attached spreadsheet.");
    execution.run.id = "inv-test-evidence-host";
    execution.evidence = [{
      id: "aws-ldap-ssh-scope",
      adapter: "aws",
      title: "Operator LDAP SSH scope",
      summary: "Resolved approved SSH host target.",
      contentType: "application/json",
      metadata: {
        publicHost: "performrx-prod-login-from-evidence.example.test",
        port: 2022,
        sshControlPath: "/tmp/cockpit-performrx-prod.sock",
      },
    }];

    await maybeCreateMeridianHandoff({
      execution,
      client,
    });

    const spawnEnv = mocks.spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    const meridianTargets = JSON.parse(spawnEnv.MERIDIAN_TARGETS_JSON || "{}");
    expect(meridianTargets.targets?.[0]).toMatchObject({
      publicHost: "performrx-prod-login-from-evidence.example.test",
      sshPort: 2022,
      sshControlPath: "/tmp/cockpit-performrx-prod.sock",
    });
    child.emit("close", 0);
  });

  it("uses direct local DB target when Cockpit DB host is loopback and no SSH host is configured", async () => {
    vi.stubEnv("INVESTIGATION_MERIDIAN_DIRECT_FALLBACK", "true");
    vi.stubEnv("MERIDIAN_TARGETS_JSON", "");
    vi.stubEnv("MERIDIAN_TARGETS_FILE", "");
    vi.stubEnv("INVESTIGATION_DB_HOST", "127.0.0.1");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "3332");
    vi.stubEnv("INVESTIGATION_DB_DATABASE", "medhok_local");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "operator.db");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "operator-secret");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_PUBLIC_HOST", "");
    vi.stubEnv("INVESTIGATION_BASTION_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_MASTER_HOST", "");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    mocks.spawn.mockReturnValueOnce(child);
    const error = new Error();
    Object.assign(error, { code: "ECONNREFUSED" });
    mocks.execute.mockRejectedValueOnce(error);
    const execution = executionWithTicketText("Please generate SQL remediation for the attached spreadsheet.");
    execution.run.id = "inv-test-direct-local";

    await maybeCreateMeridianHandoff({
      execution,
      client,
    });

    const spawnEnv = mocks.spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    const meridianTargets = JSON.parse(spawnEnv.MERIDIAN_TARGETS_JSON || "{}");
    expect(meridianTargets.targets?.[0]).toMatchObject({
      networkPath: "direct_local",
      remoteHost: "127.0.0.1",
      remotePort: 3332,
      sshAllowed: false,
      ssmAllowed: false,
      databaseName: "medhok_local",
    });
    expect(meridianTargets.targets?.[0].publicHost).toBeUndefined();
    child.emit("close", 0);
  });

  it("lets Meridian open LDAP SSH when Cockpit DB env points at a local tunnel but remote DB/SSH are configured", async () => {
    vi.stubEnv("INVESTIGATION_MERIDIAN_DIRECT_FALLBACK", "true");
    vi.stubEnv("MERIDIAN_TARGETS_JSON", "");
    vi.stubEnv("MERIDIAN_TARGETS_FILE", "");
    vi.stubEnv("INVESTIGATION_DB_HOST", "127.0.0.1");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "54456");
    vi.stubEnv("INVESTIGATION_DB_REMOTE_HOST", "cigna-prod-replica-db.internal");
    vi.stubEnv("INVESTIGATION_DB_REMOTE_PORT", "3306");
    vi.stubEnv("INVESTIGATION_DB_DATABASE", "medhok");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "operator.db");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "operator-secret");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_PUBLIC_HOST", "");
    vi.stubEnv("INVESTIGATION_BASTION_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_MASTER_HOST", "");
    vi.stubEnv("SSH_MASTER_HOST", "cigna-prod-login.example.test");
    vi.stubEnv("INVESTIGATION_OPERATOR_SSH_USER", "operator.ssh");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    mocks.spawn.mockReturnValueOnce(child);
    const error = new Error();
    Object.assign(error, { code: "ECONNREFUSED" });
    mocks.execute.mockRejectedValueOnce(error);
    const execution = executionWithTicketText("Please generate SQL remediation for the attached spreadsheet.");
    execution.run.id = "inv-test-meridian-ssh-derived";

    await maybeCreateMeridianHandoff({
      execution,
      client,
    });

    const spawnEnv = mocks.spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    const meridianTargets = JSON.parse(spawnEnv.MERIDIAN_TARGETS_JSON || "{}");
    expect(meridianTargets.targets?.[0]).toMatchObject({
      networkPath: "ldap_ssh",
      remoteHost: "cigna-prod-replica-db.internal",
      remotePort: 3306,
      publicHost: "cigna-prod-login.example.test",
      sshUser: "operator.ssh",
      sshAllowed: true,
      ssmAllowed: false,
      databaseName: "medhok",
    });
    child.emit("close", 0);
  });

  it("does not route tool investigations just because ticket text names status reason", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText(
        "The client attempted to update the letter template. This is a valid note type for this LOB, Status, Status Reason.",
      ),
      client: {
        id: "CENTENE",
        displayName: "Centene",
        aliases: ["Centene"],
      } as any,
    });

    expect(decision).toMatchObject({
      shouldCreate: false,
      reason: expect.stringContaining("No backend/case-update"),
    });
  });

  it("does not route non-data analyzer findings to MERIDIAN by data-change flag alone", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("Runtime evidence collected.", {
        analyzer: "aws",
        requiresDataChange: true,
      }),
      client,
    });

    expect(decision.shouldCreate).toBe(false);
  });

  it("skips non-remediation investigations", () => {
    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("API returned 500 and needs code investigation."),
      client,
    });

    expect(decision).toMatchObject({
      shouldCreate: false,
      reason: expect.stringContaining("No backend/case-update"),
    });
  });

  it("can be disabled by env", () => {
    vi.stubEnv("INVESTIGATION_MERIDIAN_HANDOFF_ENABLED", "false");

    const decision = decideMeridianHandoff({
      execution: executionWithTicketText("BECU spreadsheet attached for SQL generation."),
      client,
    });

    expect(decision).toMatchObject({
      shouldCreate: false,
      reason: expect.stringContaining("disabled"),
    });
  });
});
