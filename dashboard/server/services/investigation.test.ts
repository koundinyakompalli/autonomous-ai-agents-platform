import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadModule() {
  vi.resetModules();
  return import("./investigation.js");
}

function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function stubJiraContextFetch(options: {
  issueKey?: string;
  summary?: string;
  statusName?: string;
  labels?: string[];
  environmentName?: string;
  releaseVersionFieldValue?: string;
  description?: string;
  comments?: string[];
  attachments?: unknown[];
  extraFetch?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined | Promise<undefined>;
} = {}) {
  vi.stubEnv("JIRA_BASE_URL", "https://jira.example.com");
  vi.stubEnv("JIRA_USERNAME", "jira-user@example.com");
  vi.stubEnv("JIRA_TOKEN", "jira-token");

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const extraResponse = await options.extraFetch?.(url, init);
    if (extraResponse) {
      return extraResponse;
    }

    if (url.includes("/rest/api/3/field")) {
      return new Response(JSON.stringify(options.releaseVersionFieldValue
        ? [{ id: "customfield_10136", name: "Release Version", custom: true }]
        : []), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/comment?")) {
      const comments = options.comments ?? ["Case Number:\n12345678901"];
      return new Response(JSON.stringify({
        startAt: 0,
        maxResults: 100,
        total: comments.length,
        comments: comments.map((body, index) => ({
          id: `comment-${index + 1}`,
          created: "2026-05-26T14:00:00.000-0400",
          updated: "2026-05-26T14:05:00.000-0400",
          body: adf(body),
        })),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const issueKeyMatch = url.match(/\/rest\/api\/3\/issue\/([^/?]+)/);
    if (issueKeyMatch && init?.method !== "POST") {
      const issueKey = options.issueKey ?? decodeURIComponent(issueKeyMatch[1] || "CPSUP-55555");
      return new Response(JSON.stringify({
        key: issueKey,
        id: issueKey.split("-")[1] || "55555",
        self: `https://jira.example.com/rest/api/3/issue/${issueKey}`,
        fields: {
          summary: options.summary ?? `${issueKey} investigation`,
          status: { name: options.statusName ?? "Open" },
          ...(options.environmentName ? { environment: options.environmentName } : {}),
          ...(options.releaseVersionFieldValue ? { customfield_10136: { value: options.releaseVersionFieldValue } } : {}),
          labels: options.labels ?? [],
          created: "2026-05-26T09:30:00.000-0400",
          updated: "2026-05-26T14:10:00.000-0400",
          description: adf(options.description ?? "Case Number:\n12345678901"),
          attachment: options.attachments ?? [],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response("not found", { status: 404, statusText: "Not Found" });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function createTestRepo(root: string, repoName: string, fileText: string) {
  const repoPath = path.join(root, repoName);
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  git(repoPath, ["init"]);
  git(repoPath, ["config", "user.name", "Investigation Test"]);
  git(repoPath, ["config", "user.email", "investigation@example.test"]);
  await writeFile(path.join(repoPath, "src", "LetterTemplateService.java"), fileText);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "seed repo"]);
  return repoPath;
}

async function waitForRun<T extends { status: string }>(
  read: () => T,
  predicate: (run: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = read();
    if (predicate(run)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return read();
}

describe("investigation Jira webhook intake", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "");
    [
      "INVESTIGATION_DB_ENABLED",
      "INVESTIGATION_DB_HOST",
      "INVESTIGATION_DB_HOST_TEMPLATE",
      "INVESTIGATION_DB_REMOTE_HOST",
      "INVESTIGATION_DB_REMOTE_HOST_TEMPLATE",
      "INVESTIGATION_DB_REMOTE_PORT",
      "INVESTIGATION_DB_LOCAL_HOST",
      "INVESTIGATION_DB_PORT",
      "INVESTIGATION_DB_LOCAL_PORT",
      "INVESTIGATION_DB_DATABASE",
      "INVESTIGATION_DB_USERNAME",
      "INVESTIGATION_DB_PASSWORD",
      "INVESTIGATION_SSH_HOST",
      "INVESTIGATION_PUBLIC_HOST",
      "INVESTIGATION_BASTION_HOST",
      "INVESTIGATION_SSH_HOST_TEMPLATE",
      "INVESTIGATION_PUBLIC_HOST_TEMPLATE",
      "INVESTIGATION_BASTION_HOST_TEMPLATE",
      "INVESTIGATION_OPERATOR_SSH_USER",
      "INVESTIGATION_OPERATOR_SSH_PASSWORD",
      "INVESTIGATION_SSH_USER",
      "INVESTIGATION_SSH_PASSWORD",
      "INVESTIGATION_SSH_CONTROL_PATH",
      "MERIDIAN_DB_REMOTE_HOST",
      "MERIDIAN_DB_REMOTE_HOST_TEMPLATE",
      "MERIDIAN_DB_REMOTE_PORT",
      "MERIDIAN_DB_DATABASE",
      "MERIDIAN_DB_USERNAME",
      "MERIDIAN_DB_PASSWORD",
      "MERIDIAN_SSH_HOST",
      "MERIDIAN_PUBLIC_HOST",
      "MERIDIAN_BASTION_HOST",
      "MERIDIAN_SSH_HOST_TEMPLATE",
      "MERIDIAN_PUBLIC_HOST_TEMPLATE",
      "MERIDIAN_BASTION_HOST_TEMPLATE",
      "MERIDIAN_SSH_USER",
      "MERIDIAN_SSH_PASSWORD",
      "MERIDIAN_SSH_CONTROL_PATH",
      "INVESTIGATION_SSH_MASTER_HOST",
      "SSH_MASTER_HOST",
    ].forEach((name) => vi.stubEnv(name, ""));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a run when the investigation label is added in Jira", async () => {
    vi.stubEnv("INVESTIGATION_JIRA_TRIGGER_LABEL", "investigation-cockpit");
    stubJiraContextFetch({
      issueKey: "CPSUP-55555",
      summary: "Portal timeout investigation needed",
    });
    const { createInvestigationRunFromJiraWebhook } = await loadModule();

    const result = await createInvestigationRunFromJiraWebhook({
      webhookEvent: "jira:issue_updated",
      issue: {
        key: "CPSUP-55555",
        fields: {
          summary: "Portal timeout investigation needed",
          labels: ["uat", "investigation-cockpit", "mixed"],
        },
      },
      changelog: {
        items: [
          {
            field: "labels",
            fromString: "uat,mixed",
            toString: "uat,mixed,investigation-cockpit",
          },
        ],
      },
      client: "Humana",
    });

    expect(result).toMatchObject({
      accepted: true,
      triggered: true,
      triggerLabel: "investigation-cockpit",
      run: {
        jiraKey: "CPSUP-55555",
        title: "Portal timeout investigation needed",
        client: "Humana",
        environment: "UAT",
        mode: "mixed",
        status: "running",
      },
    });
  });

  it("ignores webhook updates when the trigger label was not added", async () => {
    vi.stubEnv("INVESTIGATION_JIRA_TRIGGER_LABEL", "investigation-cockpit");
    const { createInvestigationRunFromJiraWebhook } = await loadModule();

    const result = await createInvestigationRunFromJiraWebhook({
      webhookEvent: "jira:issue_updated",
      issue: {
        key: "CPSUP-55556",
        fields: {
          summary: "No investigation label yet",
          labels: ["uat", "triage"],
        },
      },
      changelog: {
        items: [
          {
            field: "labels",
            fromString: "uat",
            toString: "uat,triage",
          },
        ],
      },
    });

    expect(result).toMatchObject({
      accepted: true,
      triggered: false,
      reason: "ignored: label investigation-cockpit was not added",
      triggerLabel: "investigation-cockpit",
    });
  });

  it("fails closed for Jira-label runs when Jira context cannot be fetched", async () => {
    vi.stubEnv("INVESTIGATION_JIRA_TRIGGER_LABEL", "investigation-cockpit");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Jira unavailable")));
    const { createInvestigationRunFromJiraWebhook } = await loadModule();

    await expect(createInvestigationRunFromJiraWebhook({
      webhookEvent: "jira:issue_updated",
      issue: {
        key: "CPSUP-55599",
        fields: {
          summary: "Investigation requested from Jira without context access",
          labels: ["investigation-cockpit", "prod"],
        },
      },
      changelog: {
        items: [
          {
            field: "labels",
            fromString: "prod",
            toString: "prod,investigation-cockpit",
          },
        ],
      },
    })).rejects.toMatchObject({
      code: "jira_context_unavailable",
    });
  });

  it("fails closed for command-deck Jira-key runs when Jira context cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Jira unavailable")));
    const { createInvestigationRun } = await loadModule();

    await expect(createInvestigationRun({
      jiraKey: "CPSUP-55598",
      client: "Wellcare",
      operatorDisplay: "Test Operator",
    })).rejects.toMatchObject({
      code: "jira_context_unavailable",
    });
  });

  it("derives Centene prod scope from Jira labels without matching the Client A demo alias", async () => {
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_DATABASE", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_DB_ENABLED", "false");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "");
    vi.stubEnv("INVESTIGATION_TARGETS_JSON", JSON.stringify({
      clients: [
        {
          id: "CENTENE",
          displayName: "Centene",
          aliases: ["Centene", "MedPharm"],
          defaultEnvironment: "PROD_REPLICA",
          serviceIds: ["core-app"],
          repoNames: ["core-app"],
          enabled: true,
        },
      ],
    }));
    stubJiraContextFetch({
      issueKey: "CPSUP-50343",
      summary: "Letter Template Update **Issue with Tool**",
      labels: ["investigation-cockpit", "client-centene", "env-prod", "release-3.18"],
      description: "The client attempted to update the letter template.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50343",
      operatorDisplay: "Test Operator",
    });

    expect(run.client).toBe("Centene");
    expect(run.environment).toBe("PROD-REPLICA");
    expect(run.releaseVersion).toBe("3.18");
    expect(run.title).toBe("Letter Template Update **Issue with Tool**");
    expect(run.targetKey).toBe("centene:prod-replica:client-scope");
  });

  it("derives release scope from Jira Release Version custom field when release label is absent", async () => {
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_DATABASE", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_DB_ENABLED", "false");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "");
    vi.stubEnv("INVESTIGATION_TARGETS_JSON", JSON.stringify({
      clients: [
        {
          id: "HUMANA",
          displayName: "Humana",
          aliases: ["Humana"],
          defaultEnvironment: "PROD_REPLICA",
          serviceIds: ["core-app"],
          enabled: true,
        },
      ],
    }));
    stubJiraContextFetch({
      issueKey: "CPSUP-99999",
      summary: "Humana PROD portlet investigation",
      labels: ["investigation-cockpit", "client-humana", "env-prod"],
      releaseVersionFieldValue: "3.18",
      description: "Humana production support investigation.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-99999",
      operatorDisplay: "Test Operator",
    });

    expect(run.client).toBe("Humana");
    expect(run.environment).toBe("PROD-REPLICA");
    expect(run.releaseVersion).toBe("3.18");
    expect(run.targetKey).toBe("humana:prod-replica:client-scope");
  });

  it("derives a Cockpit DB target from Meridian-style LDAP SSH DB env", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_DB_ENABLED", "false");
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_REMOTE_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_REMOTE_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_DB_DATABASE", "");
    vi.stubEnv("MERIDIAN_DB_REMOTE_HOST", "humana-prod-slave-db.internal");
    vi.stubEnv("MERIDIAN_DB_REMOTE_PORT", "3306");
    vi.stubEnv("MERIDIAN_DB_USERNAME", "operator.db");
    vi.stubEnv("MERIDIAN_DB_PASSWORD", "operator-secret");
    vi.stubEnv("MERIDIAN_DB_DATABASE", "medhok");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_PUBLIC_HOST", "");
    vi.stubEnv("INVESTIGATION_BASTION_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_PUBLIC_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_BASTION_HOST_TEMPLATE", "");
    vi.stubEnv("MERIDIAN_SSH_HOST", "");
    vi.stubEnv("MERIDIAN_PUBLIC_HOST", "");
    vi.stubEnv("MERIDIAN_BASTION_HOST", "");
    vi.stubEnv("SSH_MASTER_HOST", "humana-prod-login.example.test");
    vi.stubEnv("INVESTIGATION_OPERATOR_SSH_USER", "operator.ssh");
    vi.stubEnv("MERIDIAN_SSH_CONTROL_PATH", "/tmp/cockpit-humana-prod.sock");
    vi.stubEnv("INVESTIGATION_TARGETS_JSON", JSON.stringify({
      clients: [
        {
          id: "HUMANA",
          displayName: "Humana",
          aliases: ["Humana"],
          defaultEnvironment: "PROD_REPLICA",
          serviceIds: ["core-app"],
          repoNames: ["core-app"],
          enabled: true,
        },
      ],
    }));
    stubJiraContextFetch({
      issueKey: "CPSUP-46150",
      summary: "Humana PROD queue routing investigation",
      labels: ["investigation-cockpit", "client-humana", "env-prod"],
      releaseVersionFieldValue: "3.18",
      description: "Nurse Review Unassigned portlet AOR/VMD investigation.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-46150",
      operatorDisplay: "Test Operator",
    });

    expect(run.client).toBe("Humana");
    expect(run.environment).toBe("PROD-REPLICA");
    expect(run.releaseVersion).toBe("3.18");
    expect(run.targetKey).toBe("humana:prod-replica:jira-ldap-db");
  });

  it("does not treat environment labels as release labels", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-50344",
      summary: "Centene production investigation",
      labels: ["investigation-cockpit", "client-centene", "environment-production-v3.19"],
      description: "The client attempted a production action.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50344",
      operatorDisplay: "Test Operator",
    });

    expect(run.client).toBe("Wellcare");
    expect(run.environment).toBe("PROD-REPLICA");
    expect(run.releaseVersion).toBeUndefined();
  });

  it("derives Wellcare client from Centene ticket text without inferring prod from prose alone", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-50343",
      summary: "Centene | MedPharm Letter Template Update **Issue with Tool**",
      labels: ["CCIU_TOOL"],
      description: "The MedPharm production letter template loader will not update duplicate request.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50343",
      operatorDisplay: "Test Operator",
    });

    expect(run.client).toBe("Wellcare");
    expect(run.environment).toBe("INT");
    expect(run.targetKey).toBe("wellcare:int:client-scope");
  });

  it("derives Wellcare PROD from compound scheduler and host identifiers", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "");
    vi.stubEnv("INVESTIGATION_TARGETS_JSON", JSON.stringify({ clients: [] }));
    stubJiraContextFetch({
      issueKey: "CPSUP-55769",
      summary: "AGRP-CPPROD1-api_fax_intake WELLCARELOGIN Failure",
      labels: [],
      description: [
        "Job Started . . . : 07/16/2026 07:43:00 EDT",
        "Job Name . . . . : AGRP-CPPROD1-api_fax_intake",
        "Agent Name . . . : WELLCARELOGIN",
        "InfautoJarRunner task failed.",
        "JAR file: '/opt/software/medhok/fax-intake-service/FaxIntakeService-0.0.1-SNAPSHOT.jar'",
      ].join("\n"),
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55769",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "CPSUP-55769",
      client: "Wellcare",
      environment: "PROD-REPLICA",
      status: "queued",
      targetKey: "wellcare:prod-replica:client-scope",
    });
  });

  it("derives an unconfigured client from a structured CP environment identifier", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "");
    vi.stubEnv("INVESTIGATION_TARGETS_JSON", JSON.stringify({ clients: [] }));
    stubJiraContextFetch({
      issueKey: "SUP-200",
      summary: "Northwind CP - Not receiving requests for outbound notifications",
      environmentName: "NORTHWIND---CP-PROD1",
      releaseVersionFieldValue: "3.15",
      labels: [],
      description: "Investigate production behavior after a credential rotation at 09:20 UTC.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "SUP-200",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "SUP-200",
      client: "Northwind",
      environment: "PROD-REPLICA",
      releaseVersion: "3.15",
      status: "queued",
      targetKey: "northwind:prod-replica:client-scope",
    });
  });

  it("routes scheduler JAR evidence to the batch repository before default repos", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "investigation-batch-scope-"));
    try {
      await createTestRepo(
        repoRoot,
        "batch-jobs",
        "package test;\nclass FaxIntakeService { String runner = \"InfautoJarRunner api_fax_intake\"; }\n",
      );
      vi.stubEnv("INVESTIGATION_TARGET_THROTTLE_STORE", "memory");
      vi.stubEnv("INVESTIGATION_CODE_REPO_REFRESH", "false");
      vi.stubEnv("INVESTIGATION_CODE_REPO_BASE", repoRoot);
      vi.stubEnv("INVESTIGATION_AWS_PROFILE", "");
      vi.stubEnv("INVESTIGATION_TARGETS_JSON", JSON.stringify({ clients: [] }));
      stubJiraContextFetch({
        issueKey: "CPSUP-55769",
        summary: "AGRP-CPPROD1-api_fax_intake WELLCARELOGIN Failure",
        labels: [],
        description: [
          "Job Name: AGRP-CPPROD1-api_fax_intake",
          "Agent Name: WELLCARELOGIN",
          "InfautoJarRunner task failed.",
          "JAR file: '/opt/software/medhok/fax-intake-service/FaxIntakeService-0.0.1-SNAPSHOT.jar'",
        ].join("\n"),
      });
      const { createInvestigationRun, getInvestigationRun } = await loadModule();

      const queued = await createInvestigationRun({
        jiraKey: "CPSUP-55769",
        operatorDisplay: "Test Operator",
      });
      const run = await waitForRun(
        () => getInvestigationRun(queued.id),
        (current) => current.status !== "queued" && current.status !== "running",
      );

      expect(run.client).toBe("Wellcare");
      expect(run.environment).toBe("PROD-REPLICA");
      expect(run.evidence.find((evidence) => evidence.analyzer === "code")?.meta).toContain("repo:batch-jobs");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("derives prod-replica from the Jira Environment field when labels are absent", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST_TEMPLATE", "");
    stubJiraContextFetch({
      issueKey: "CPSUP-50343",
      summary: "Centene | MedPharm Letter Template Update **Issue with Tool**",
      labels: ["CCIU_TOOL"],
      environmentName: "WELLCARE---CP-PROD1",
      description: "The MedPharm letter template loader will not update duplicate request.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50343",
      operatorDisplay: "Test Operator",
    });

    expect(run.client).toBe("Wellcare");
    expect(run.environment).toBe("PROD-REPLICA");
    expect(run.targetKey).toBe("wellcare:prod-replica:jira-aws-log-scope");
  });

  it("prefers the Jira Environment field over conflicting environment labels", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST_TEMPLATE", "");
    stubJiraContextFetch({
      issueKey: "CPSUP-50343",
      summary: "Centene | MedPharm Letter Template Update **Issue with Tool**",
      labels: ["CCIU_TOOL", "env-uat-3.18"],
      environmentName: "WELLCARE---CP-PROD1",
      description: "The MedPharm letter template loader will not update duplicate request.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50343",
      operatorDisplay: "Test Operator",
    });

    expect(run.client).toBe("Wellcare");
    expect(run.environment).toBe("PROD-REPLICA");
    expect(run.targetKey).toBe("wellcare:prod-replica:jira-aws-log-scope");
  });

  it("does not treat MedPharm text alone as a Wellcare client signal", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-50349",
      summary: "MedPharm Letter Template Update **Issue with Tool**",
      labels: ["CCIU_TOOL"],
      description: "The MedPharm production letter template loader will not update duplicate request.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50349",
      operatorDisplay: "Test Operator",
    });

    expect(run.client).not.toBe("Wellcare");
    expect(run.targetKey ?? "").not.toContain("wellcare");
  });

  it("uses Jira release scope and ticket signals to synthesize a bounded code target", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "investigation-code-scope-"));
    try {
      await createTestRepo(
        repoRoot,
        "core-app",
        "package test;\nclass LetterTemplateService { String template = \"Letter Template Duplicate Request\"; }\n",
      );

      vi.stubEnv("INVESTIGATION_TARGET_THROTTLE_STORE", "memory");
      vi.stubEnv("INVESTIGATION_CODE_REPO_REFRESH", "false");
      vi.stubEnv("INVESTIGATION_CODE_REPO_BASE", repoRoot);
      vi.stubEnv("INVESTIGATION_CODE_BRANCH_TEMPLATE", "release/{releaseVersion}");
      vi.stubEnv("INVESTIGATION_TARGETS_JSON", JSON.stringify({
        clients: [
          {
            id: "CENTENE",
            displayName: "Centene",
            aliases: ["Centene", "MedPharm"],
            defaultEnvironment: "PROD_REPLICA",
            serviceIds: ["core-app"],
            enabled: true,
          },
        ],
      }));
      stubJiraContextFetch({
        issueKey: "CPSUP-50343",
        summary: "Centene | MedPharm Letter Template Update **Issue with Tool**",
        labels: ["investigation-cockpit", "client-centene", "environment-production", "release-3.19"],
        description: "The client reports the letter template loader will not update duplicate request.",
      });
      const { createInvestigationRun, getInvestigationRun } = await loadModule();

      const queued = await createInvestigationRun({
        jiraKey: "CPSUP-50343",
        operatorDisplay: "Test Operator",
      });
      const run = await waitForRun(
        () => getInvestigationRun(queued.id),
        (current) => current.status !== "queued" && current.status !== "running",
      );

      expect(run.releaseVersion).toBe("3.19");
      expect(run.findings.find((finding) => finding.title === "No approved code target was available for this investigation scope")).toBeUndefined();
      const codeEvidence = run.evidence.find((evidence) => evidence.analyzer === "code");
      expect(codeEvidence?.meta).toContain("repo:core-app");
      expect(codeEvidence?.meta).toContain("branch:release/3.19");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("creates a Jira-scoped runtime target from labels without a preconfigured client target", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_DB_HOST", "127.0.0.1");
    vi.stubEnv("INVESTIGATION_DB_PORT", "3332");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "readonly_operator");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "runtime-secret");
    stubJiraContextFetch({
      issueKey: "CPSUP-50343",
      summary: "Letter Template Update **Issue with Tool**",
      labels: ["investigation-cockpit", "client-centene", "env-prod", "release-3.18"],
      description: "Centene production ticket for letter template investigation.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50343",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "CPSUP-50343",
      client: "Wellcare",
      environment: "PROD-REPLICA",
      releaseVersion: "3.18",
      status: "queued",
      targetKey: "wellcare:prod-replica:jira-ldap-db",
    });
    expect(run.summary).toContain("Wellcare");
  });

  it("uses operator LDAP SSH env credentials as the Jira-scoped DB credential fallback", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_DB_HOST", "127.0.0.1");
    vi.stubEnv("INVESTIGATION_DB_PORT", "3332");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_OPERATOR_SSH_USER", "operator");
    vi.stubEnv("INVESTIGATION_OPERATOR_SSH_PASSWORD", "runtime-secret");
    stubJiraContextFetch({
      issueKey: "CPSUP-50347",
      summary: "Centene production DB diagnostic",
      labels: ["investigation-cockpit", "client-centene", "env-prod"],
      description: "Centene production ticket for readonly DB diagnostics.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50347",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "CPSUP-50347",
      client: "Wellcare",
      environment: "PROD-REPLICA",
      status: "queued",
      targetKey: "wellcare:prod-replica:jira-ldap-db",
    });
  });

  it("does not create a DB target from operator LDAP SSH credentials alone", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_OPERATOR_SSH_USER", "operator");
    vi.stubEnv("INVESTIGATION_OPERATOR_SSH_PASSWORD", "runtime-secret");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST_TEMPLATE", "");
    stubJiraContextFetch({
      issueKey: "CPSUP-50352",
      summary: "Centene production batch log investigation",
      labels: ["investigation-cockpit", "client-centene", "env-prod"],
      description: "Centene production ticket requires CloudWatch review for a batch job failure.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50352",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "CPSUP-50352",
      client: "Wellcare",
      environment: "PROD-REPLICA",
      status: "queued",
      targetKey: "wellcare:prod-replica:jira-aws-log-scope",
    });
  });

  it("creates a Jira-scoped AWS log target when only an AWS profile is configured", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST_TEMPLATE", "");
    stubJiraContextFetch({
      issueKey: "CPSUP-50350",
      summary: "Centene production batch log investigation",
      labels: ["investigation-cockpit", "client-centene", "env-prod"],
      description: "Centene production ticket requires CloudWatch review for a batch job failure.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50350",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "CPSUP-50350",
      client: "Wellcare",
      environment: "PROD-REPLICA",
      status: "queued",
      targetKey: "wellcare:prod-replica:jira-aws-log-scope",
    });
  });

  it("creates a Jira-scoped LDAP SSH host target from a runtime host template", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST_TEMPLATE", "{client}-{env}.ssh.example.test");
    vi.stubEnv("INVESTIGATION_SSH_USER", "operator");
    vi.stubEnv("INVESTIGATION_CONFIG_PROBE_PATHS", "/opt/software/medhok,/opt/software/medhok/batch");
    stubJiraContextFetch({
      issueKey: "CPSUP-50345",
      summary: "Batch job command inspection",
      labels: ["investigation-cockpit", "client-centene", "env-prod", "release-3.19"],
      description: "Centene batch job failed and command/config needs inspection.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50345",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "CPSUP-50345",
      client: "Wellcare",
      environment: "PROD-REPLICA",
      releaseVersion: "3.19",
      status: "queued",
      targetKey: "wellcare:prod-replica:jira-ldap-ssh-host",
    });
  });

  it("creates a Jira-scoped LDAP SSH host target from explicit Jira ticket host context", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_SSH_USER", "operator");
    stubJiraContextFetch({
      issueKey: "CPSUP-50343",
      summary: "Centene | MedPharm Letter Template Update **Issue with Tool**",
      labels: ["investigation-cockpit", "client-centene", "env-prod", "release-3.19"],
      description: [
        "Batch job failed for the letter template update.",
        "Batch Host: centene-prod-batch01.internal.mhk",
        "DB Host: centene-prod-db01.internal.mhk",
      ].join("\n"),
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50343",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "CPSUP-50343",
      client: "Wellcare",
      environment: "PROD-REPLICA",
      releaseVersion: "3.19",
      status: "queued",
      targetKey: "wellcare:prod-replica:jira-ldap-ssh-host",
    });
  });

  it("does not derive an LDAP SSH host target from database endpoint context", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_SSH_USER", "operator");
    stubJiraContextFetch({
      issueKey: "CPSUP-50346",
      summary: "Centene production database check",
      labels: ["investigation-cockpit", "client-centene", "env-prod"],
      description: "DB Host: centene-prod-db01.internal.mhk\nDatabase endpoint must not be used for LDAP SSH.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50346",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "CPSUP-50346",
      client: "Wellcare",
      environment: "PROD-REPLICA",
      status: "queued",
      targetKey: "wellcare:prod-replica:client-scope",
    });
  });

  it("does not derive an LDAP SSH host target from S3 archive source terms", async () => {
    vi.stubEnv("INVESTIGATION_QUEUE_AUTOSTART", "false");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");
    vi.stubEnv("INVESTIGATION_DB_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_HOST", "");
    vi.stubEnv("INVESTIGATION_DB_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_LOCAL_PORT", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST", "");
    vi.stubEnv("INVESTIGATION_SSH_HOST_TEMPLATE", "");
    vi.stubEnv("INVESTIGATION_SSH_USER", "operator");
    stubJiraContextFetch({
      issueKey: "CPSUP-50351",
      summary: "Centene production batch archive check",
      labels: ["investigation-cockpit", "client-centene", "env-prod"],
      description: "AWS evidence source batch-archive-s3-archive is available for metadata-only batch archive lookup.",
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-50351",
      operatorDisplay: "Test Operator",
    });

    expect(run).toMatchObject({
      jiraKey: "CPSUP-50351",
      client: "Wellcare",
      environment: "PROD-REPLICA",
      status: "queued",
      targetKey: "wellcare:prod-replica:jira-aws-log-scope",
    });
  });

  it("does not create a duplicate active run for the same Jira ticket", async () => {
    vi.stubEnv("INVESTIGATION_JIRA_TRIGGER_LABEL", "investigation-cockpit");
    stubJiraContextFetch({
      issueKey: "CPSUP-55557",
      summary: "Investigation requested from Jira",
    });
    const { createInvestigationRunFromJiraWebhook } = await loadModule();

    const payload = {
      webhookEvent: "jira:issue_updated",
      issue: {
        key: "CPSUP-55557",
        fields: {
          summary: "Investigation requested from Jira",
          labels: ["investigation-cockpit", "int"],
        },
      },
      changelog: {
        items: [
          {
            field: "labels",
            fromString: "int",
            toString: "int,investigation-cockpit",
          },
        ],
      },
      client: "Humana",
    };

    const created = await createInvestigationRunFromJiraWebhook(payload);
    const duplicate = await createInvestigationRunFromJiraWebhook(payload);

    expect(created.triggered).toBe(true);
    expect(duplicate).toMatchObject({
      accepted: true,
      triggered: false,
      reason: "ignored: active run already exists for ticket",
      run: {
        jiraKey: "CPSUP-55557",
      },
    });
  });

  it("creates multiple command-deck runs for batch ticket testing", async () => {
    stubJiraContextFetch();
    const { createInvestigationRuns } = await loadModule();

    const result = await createInvestigationRuns({
      operatorDisplay: "Test Operator",
      tickets: [
        {
          jiraKey: "CPSUP-55558",
          title: "First batch investigation",
          client: "Cigna",
          environment: "PROD-REPLICA",
          mode: "mixed",
        },
        {
          jiraKey: "CPSUP-55559",
          title: "Second batch investigation",
          client: "Wellcare",
          environment: "PROD-REPLICA",
          mode: "data-led",
        },
      ],
    });

    expect(result.runs).toHaveLength(2);
    expect(result.runs.map((run) => run.jiraKey)).toEqual(["CPSUP-55558", "CPSUP-55559"]);
    expect(new Set(result.runs.map((run) => run.id)).size).toBe(2);
    expect(result.runs.every((run) => run.environment === "PROD-REPLICA")).toBe(true);
  });

  it("rejects a duplicate outstanding command-deck run", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-55568",
      summary: "Duplicate queue admission test",
    });
    const { createInvestigationRun } = await loadModule();

    const attempts = await Promise.allSettled([
      createInvestigationRun({
        jiraKey: "CPSUP-55568",
        operatorDisplay: "Test Operator",
      }),
      createInvestigationRun({
        jiraKey: "CPSUP-55568",
        operatorDisplay: "Test Operator",
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(rejected?.reason).toMatchObject({
      statusCode: 409,
      code: "active_investigation_exists",
    });
  });

  it("limits Flight Queue to ten outstanding tickets", async () => {
    stubJiraContextFetch();
    const { createInvestigationRun, getInvestigationHealth } = await loadModule();

    for (let index = 0; index < 10; index += 1) {
      await createInvestigationRun({
        jiraKey: `CPSUP-${56000 + index}`,
        title: `Capacity test ${index + 1}`,
        operatorDisplay: "Test Operator",
      });
    }

    expect(getInvestigationHealth().queue).toMatchObject({
      outstandingRuns: 10,
      outstandingCapacity: 10,
    });
    await expect(createInvestigationRun({
      jiraKey: "CPSUP-56010",
      title: "Capacity overflow",
      operatorDisplay: "Test Operator",
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "flight_queue_capacity_reached",
    });
  });

  it("applies env-gated demo confidence overrides to materialized runs", async () => {
    vi.stubEnv("INVESTIGATION_DEMO_CONFIDENCE_OVERRIDES", "CPCLIENT-10697=86%");
    stubJiraContextFetch({
      issueKey: "CPCLIENT-10697",
      summary: "FaxCom demo investigation",
    });
    const { createInvestigationRun, getInvestigationRun, listInvestigationRuns } = await loadModule();

    const created = await createInvestigationRun({
      jiraKey: "CPCLIENT-10697",
      title: "FaxCom demo investigation",
      client: "Demo Client",
      environment: "UAT",
      mode: "mixed",
      operatorDisplay: "Test Operator",
    });

    expect(created.confidence).toBe(0.86);
    expect(getInvestigationRun(created.id).confidence).toBe(0.86);
    expect(listInvestigationRuns().runs.find((run) => run.jiraKey === "CPCLIENT-10697")).toMatchObject({
      confidence: 0.86,
    });
  });

  it("materializes fetched ticket context without raw attachment URLs or unredacted secrets", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-55566",
      summary: "Ticket context materialization",
      description: "Case Number:\n12345678901\nmemberId=abc123 password=plain-text",
      attachments: [{
        id: "att-log",
        filename: "cockpit-context.log",
        mimeType: "text/plain",
        size: 128,
        content: "https://jira.example.com/rest/api/3/attachment/content/att-log",
        created: "2026-05-26T14:00:00.000-0400",
      }],
      extraFetch: (url: string) => {
        if (url === "https://jira.example.com/rest/api/3/attachment/content/att-log") {
          return new Response("Case Number:\n12345678902\nmemberId=M12345 password=secret-pass", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }
        return undefined;
      },
    });
    const { createInvestigationRun } = await loadModule();

    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55566",
      client: "Wellcare",
      operatorDisplay: "Test Operator",
    });
    const serializedRun = JSON.stringify(run);

    expect(run.ticketContext).toMatchObject({
      fetchStatus: "fetched",
      jiraKey: "CPSUP-55566",
      descriptionPresent: true,
      commentCount: 1,
      attachments: [{
        filename: "cockpit-context.log",
        extractionStatus: "text_extracted",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        contentRef: expect.stringMatching(/^jira-attachment:att-log:sha256:/),
      }],
    });
    expect(run.ticketContext?.description).toBeUndefined();
    expect(run.ticketContext?.comments).toBeUndefined();
    expect(run.ticketContext?.identifiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "member_identifier", value: "[REDACTED]", sensitive: true }),
    ]));
    expect(serializedRun).toContain("memberId=[REDACTED]");
    expect(serializedRun).not.toContain("abc123");
    expect(serializedRun).not.toContain("M12345");
    expect(serializedRun).not.toContain("secret-pass");
    expect(serializedRun).not.toContain("https://jira.example.com/rest/api/3/attachment/content/att-log");
  });

  it("attaches Meridian readonly evidence without ticket-specific fixtures", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-55560",
      summary: "PerformRx UAT ePA validation",
    });
    const { attachMeridianEvidence, createInvestigationRun } = await loadModule();
    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55560",
      title: "PerformRx UAT ePA validation",
      client: "PerformRx",
      environment: "UAT",
      mode: "mixed",
      operatorDisplay: "Test Operator",
    });

    const updated = attachMeridianEvidence(run.id, {
      summary: "Meridian confirmed readonly backend diagnostics were attached.",
      recommendation: "Review the attached data and code evidence before remediation.",
      clientSummary: "Readonly Meridian diagnostics were completed.",
      internalAnalysis: "Meridian attached SELECT-only evidence through SSM.",
      validationNotes: "Validate with the same cases in UAT after the code fix.",
      findings: [{
        severity: "medium",
        title: "Config and transaction evidence needs code correlation",
        summary: "The data path has matching transactions and enabled config; no DML was executed.",
        confidence: 0.74,
        requiresAction: "code",
      }],
      evidence: [{
        title: "Meridian read-only diagnostic",
        detail: "Rows were redacted before cockpit display.",
        meta: ["performrx", "uat"],
        trace: [{
          title: "Transaction lookup",
          detail: "Returned affected case transaction rows.",
          safeSql: "SELECT case_id, transaction_type FROM ws_transaction_ncpdp WHERE case_id IN ('26089937163')",
          rowCount: 1,
        }],
      }],
    }, "Test Operator");

    expect(updated.jiraKey).toBe("CPSUP-55560");
    expect(updated.evidence[0]).toMatchObject({
      analyzer: "data",
      title: "Meridian read-only diagnostic",
    });
    expect(updated.evidence[0].meta).toContain("source:MERIDIAN");
    expect(updated.findings[0]).toMatchObject({
      analyzer: "code",
      title: "Config and transaction evidence needs code correlation",
    });
    expect(updated.analyzers.find((analyzer) => analyzer.key === "data")).toMatchObject({
      status: "complete",
    });
    expect(updated.audit[0]).toContain("attached Meridian investigation evidence");
  });

  it("rejects non-readonly Meridian SQL traces", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-55561",
      summary: "Reject unsafe Meridian trace",
    });
    const { attachMeridianEvidence, createInvestigationRun, InvestigationServiceError } = await loadModule();
    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55561",
      title: "Reject unsafe Meridian trace",
      operatorDisplay: "Test Operator",
    });

    expect(() => attachMeridianEvidence(run.id, {
      evidence: [{
        trace: [{
          safeSql: "DELETE FROM ws_transaction_ncpdp WHERE case_id = '26089937163'",
        }],
      }],
    }, "Test Operator")).toThrow(InvestigationServiceError);
  });

  it("stores generated Meridian SQL as a downloadable Cockpit artifact", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-55562",
      summary: "Generated SQL artifact",
    });
    const { attachMeridianEvidence, createInvestigationRun, getMeridianSqlArtifact } = await loadModule();
    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55562",
      title: "Generated SQL artifact",
      operatorDisplay: "Test Operator",
    });

    const updated = attachMeridianEvidence(run.id, {
      summary: "Meridian generated SQL.",
      sql: [
        "/* MERIDIAN generated SQL */",
        "START TRANSACTION;",
        "UPDATE process_flow SET active = 0 WHERE id = 123;",
        "COMMIT;",
      ].join("\n"),
      sqlFilename: "CPSUP-55562_provider_appeals_mgmt.sql",
    }, "Test Operator");

    expect(updated.meridianSqlArtifacts).toHaveLength(1);
    expect(updated.meridianSqlArtifacts?.[0]).toMatchObject({
      filename: "CPSUP-55562_provider_appeals_mgmt.sql",
      contentType: "text/sql",
      updateCount: 1,
      source: "meridian",
    });
    const artifact = getMeridianSqlArtifact(run.id, updated.meridianSqlArtifacts![0].id);
    expect(artifact.content).toContain("UPDATE process_flow");
    expect(JSON.stringify(updated)).not.toContain("UPDATE process_flow");
  });

  it("extracts generated Meridian SQL from the existing output marker format", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-55564",
      summary: "Generated SQL marker artifact",
    });
    const { attachMeridianEvidence, createInvestigationRun, getMeridianSqlArtifact } = await loadModule();
    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55564",
      title: "Generated SQL marker artifact",
      operatorDisplay: "Test Operator",
    });

    const updated = attachMeridianEvidence(run.id, {
      internalAnalysis: [
        "## MERIDIAN SQL Generation",
        "<!-- MERIDIAN_SQL_ATTACHMENT_START filename=\"CPSUP-55564_meridian.sql\" -->",
        "UPDATE process_flow SET active = 0 WHERE id = 456;",
        "<!-- MERIDIAN_SQL_ATTACHMENT_END -->",
      ].join("\n"),
    }, "Test Operator");

    expect(updated.meridianSqlArtifacts?.[0]).toMatchObject({
      filename: "CPSUP-55564_meridian.sql",
      source: "meridian-marker",
      updateCount: 1,
    });
    expect(getMeridianSqlArtifact(run.id, updated.meridianSqlArtifacts![0].id).content).toContain("id = 456");
  });

  it("creates a linked DBA Jira ticket with the generated Meridian SQL attached and assigned to the operator", async () => {
    const fetchMock = stubJiraContextFetch({
      issueKey: "CPSUP-55563",
      summary: "Backend update requiring DBA ticket artifact",
      extraFetch: (url: string, init?: RequestInit) => {
        if (url.endsWith("/rest/api/3/issue") && init?.method === "POST") {
          return new Response(JSON.stringify({ key: "CPSUP-DBA1" }), { status: 201, headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith("/rest/api/3/issue/CPSUP-DBA1/attachments")) {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/rest/api/3/user/search?")) {
          return new Response(JSON.stringify([{ accountId: "operator-account", displayName: "Test Operator", active: true }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/rest/api/3/issue/CPSUP-DBA1/assignee")) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/rest/api/3/issueLink")) {
          return new Response("", { status: 201 });
        }
        return undefined;
      },
    });

    const { attachMeridianEvidence, createInvestigationRun, createMeridianDbaTicket } = await loadModule();
    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55563",
      title: "Backend update requiring DBA ticket artifact",
      operatorDisplay: "Test Operator",
    });
    const updated = attachMeridianEvidence(run.id, {
      summary: "Meridian generated SQL.",
      sql: "UPDATE process_flow SET active = 0 WHERE id = 123;",
      sqlFilename: "CPSUP-55563_provider_appeals_mgmt.sql",
    }, "Test Operator");

    const ticketed = await createMeridianDbaTicket(
      run.id,
      { id: "test.operator@example.com", display: "Test Operator" },
      updated.meridianSqlArtifacts?.[0]?.id,
    );

    expect(ticketed.dbaTicket).toMatchObject({
      key: "CPSUP-DBA1",
      linkedTo: "CPSUP-55563",
      sqlFilename: "CPSUP-55563_provider_appeals_mgmt.sql",
      assignedOperatorDisplay: "Test Operator",
      assigneeAccountId: "operator-account",
      assignmentStatus: "assigned",
      linkStatus: "linked",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira.example.com/rest/api/3/issue/CPSUP-DBA1/attachments",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("creates a DBA Jira ticket when only Jira comments are disabled", async () => {
    vi.stubEnv("ONESHOT_DISABLE_JIRA_COMMENTS", "true");
    const fetchMock = stubJiraContextFetch({
      issueKey: "CPSUP-55566",
      summary: "Backend update requiring DBA ticket with comments disabled",
      extraFetch: (url: string, init?: RequestInit) => {
        if (url.endsWith("/rest/api/3/issue") && init?.method === "POST") {
          return new Response(JSON.stringify({ key: "CPSUP-DBA2" }), { status: 201, headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith("/rest/api/3/issue/CPSUP-DBA2/attachments")) {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/rest/api/3/user/search?")) {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith("/rest/api/3/issueLink")) {
          return new Response("", { status: 201 });
        }
        return undefined;
      },
    });

    const { attachMeridianEvidence, createInvestigationRun, createMeridianDbaTicket } = await loadModule();
    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55566",
      title: "Backend update requiring DBA ticket with comments disabled",
      operatorDisplay: "Test Operator",
    });
    const updated = attachMeridianEvidence(run.id, {
      summary: "Meridian generated SQL.",
      sql: "UPDATE process_flow SET active = 0 WHERE id = 123;",
      sqlFilename: "CPSUP-55566_provider_appeals_mgmt.sql",
    }, "Test Operator");

    const ticketed = await createMeridianDbaTicket(
      run.id,
      { id: "test.operator@example.com", display: "Test Operator" },
      updated.meridianSqlArtifacts?.[0]?.id,
    );

    expect(ticketed.dbaTicket?.key).toBe("CPSUP-DBA2");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira.example.com/rest/api/3/issue",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("blocks a DBA Jira ticket when incident evidence has no causal assessment", async () => {
    const fetchMock = stubJiraContextFetch({
      issueKey: "CPSUP-55567",
      summary: "Member search fails after refresh",
    });
    const { attachMeridianEvidence, createInvestigationRun, createMeridianDbaTicket } = await loadModule();
    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55567",
      title: "Member search fails after refresh",
      operatorDisplay: "Test Operator",
    });
    const updated = attachMeridianEvidence(run.id, {
      summary: "A possible SQL remediation was generated before RCA completion.",
      sql: "UPDATE member_address SET email = NULL WHERE id = 123;",
      sqlFilename: "CPSUP-55567_unproven_remediation.sql",
    }, "Test Operator");

    await expect(createMeridianDbaTicket(
      run.id,
      { id: "test.operator@example.com", display: "Test Operator" },
      updated.meridianSqlArtifacts?.[0]?.id,
    )).rejects.toMatchObject({ code: "causal_resolution_required", statusCode: 409 });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://jira.example.com/rest/api/3/issue",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("blocks approval without a causal assessment and does not append duplicate block events", async () => {
    stubJiraContextFetch({
      issueKey: "CPSUP-55567",
      summary: "Idempotent approval",
    });
    const { approveInvestigationRecommendation, createInvestigationRun } = await loadModule();
    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55567",
      title: "Idempotent approval",
      operatorDisplay: "Test Operator",
    });

    const first = approveInvestigationRecommendation(run.id, "Test Operator");
    const second = approveInvestigationRecommendation(run.id, "Test Operator");

    expect(first.recommendation).toContain("Approval blocked until the causal diagnosis is complete");
    expect(second.events.filter((event) => event.title === "Approval blocked by resolution gate")).toHaveLength(1);
    expect(second.audit.filter((entry) => entry.includes("approval blocked by incomplete causal diagnosis"))).toHaveLength(1);
  });

  it("posts the redacted investigation summary as a Jira comment without raw Meridian SQL", async () => {
    const fetchMock = stubJiraContextFetch({
      issueKey: "CPSUP-55565",
      summary: "Post summary to Jira",
      extraFetch: (url: string, init?: RequestInit) => {
        if (url.endsWith("/rest/api/3/issue/CPSUP-55565/comment") && init?.method === "POST") {
          return new Response(JSON.stringify({ id: "comment-1" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        return undefined;
      },
    });

    const { attachMeridianEvidence, createInvestigationRun, postInvestigationSummary } = await loadModule();
    const run = await createInvestigationRun({
      jiraKey: "CPSUP-55565",
      title: "Post summary to Jira",
      client: "Wellcare",
      operatorDisplay: "Test Operator",
    });
    const updated = attachMeridianEvidence(run.id, {
      summary: "Meridian generated SQL for DBA review.",
      clientSummary: "Readonly evidence was reviewed and a DBA handoff is required.",
      validationNotes: "DBA should execute backup, update, audit, and validation steps.",
      sql: "UPDATE process_flow SET active = 0 WHERE id = 123;",
      sqlFilename: "CPSUP-55565_provider_appeals_mgmt.sql",
    }, "Test Operator");
    expect(updated.jiraDraft.clientSummary).toContain("For ticket CPSUP-55565 (Post summary to Jira):");

    const posted = await postInvestigationSummary(updated.id, "Test Operator");

    expect(posted.status).toBe("awaiting_review");
    expect(posted.audit[0]).toContain("posted the Jira summary comment to CPSUP-55565");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira.example.com/rest/api/3/issue/CPSUP-55565/comment",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls.find(([url, requestInit]) => (
      String(url).endsWith("/rest/api/3/issue/CPSUP-55565/comment")
      && requestInit?.method === "POST"
    )) || [];
    const requestBody = JSON.parse(String(init?.body));
    const serializedBody = JSON.stringify(requestBody);
    expect(serializedBody).toContain("Interim investigation update - RCA incomplete for CPSUP-55565");
    expect(serializedBody).toContain("Resolution gate: not passed");
    expect(serializedBody).toContain("For ticket CPSUP-55565 (Post summary to Jira):");
    expect(serializedBody).toContain("CPSUP-55565_provider_appeals_mgmt.sql");
    expect(serializedBody).not.toContain("UPDATE process_flow");
  });

});
