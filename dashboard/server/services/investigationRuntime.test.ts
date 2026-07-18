import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSshCommandArgs,
  DashboardCloudWatchLogInspectionAdapter,
  DashboardInvestigationControlPlane,
  DashboardMysqlDataDiagnosticsAdapter,
  DashboardS3ArchivedLogInspectionAdapter,
  DashboardSshConfigInspectionAdapter,
  DashboardSsmFileLogInspectionAdapter,
  DashboardWatchdogLogInspectionAdapter,
  AwsInferredHostTargetRegistry,
} from "./investigationRuntime.js";
import { QueryPackRegistry } from "../../../src/investigation/data/QueryPackRegistry.js";
import type {
  InvestigationAdapterRequest,
  InvestigationAdapterResult,
} from "../../../src/investigation/types/investigation.js";
import type { InvestigationConnectionTarget } from "../../../src/investigation/data/ConnectionRegistry.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
  vi.restoreAllMocks();
});

describe("AwsInferredHostTargetRegistry", () => {
  it("keeps a Jira-derived AWS service scope out of EC2 host inference", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    const serviceScope = {
      id: "jira-aws-log-scope",
      scopeKind: "aws_service" as const,
      clientId: "TENANTX",
      environment: "PROD_REPLICA" as const,
      envId: "PROD1",
      awsAccountId: "",
      region: "aws-dynamic",
      instanceId: "jira-aws-log-scope",
      instanceName: "Tenant X PROD AWS service scope",
      vpcId: "",
      subnetId: "",
      networkPath: "ssh_public" as const,
      instanceProfileArn: "",
      expectedRoleName: "",
      awsProfile: "prod",
      sshAllowed: false,
      ssmAllowed: false,
      enabled: true,
    };
    const baseRegistry = {
      resolveTarget: vi.fn(async () => serviceScope),
      listTargets: vi.fn(async () => [serviceScope]),
    };
    const runner = { runText: vi.fn(), runJson: vi.fn() };

    const registry = new AwsInferredHostTargetRegistry(baseRegistry, () => runner);
    const resolved = await registry.resolveTarget("TENANTX", "PROD_REPLICA", serviceScope.id);

    expect(resolved).toBe(serviceScope);
    expect(runner.runText).not.toHaveBeenCalled();
    expect(runner.runJson).not.toHaveBeenCalled();
  });

  it("discovers bounded application log targets separately from the database/login target", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    vi.stubEnv("INVESTIGATION_AWS_DISCOVERY_REGIONS", "us-east-2");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");
    vi.stubEnv("INVESTIGATION_SSH_USER", "operator.ldap");

    const baseRegistry = {
      resolveTarget: vi.fn(async () => null),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => "us-east-2"),
      runJson: vi.fn(async () => ({
        Reservations: [{
          OwnerId: "123456789012",
          Instances: [
            {
              InstanceId: "i-app-1",
              PublicDnsName: "app-1.example.test",
              Tags: [{ Key: "Name", Value: "ACME PROD App 1" }],
            },
            {
              InstanceId: "i-app-2",
              PublicDnsName: "app-2.example.test",
              Tags: [{ Key: "Name", Value: "ACME PROD App 2" }],
            },
            {
              InstanceId: "i-db",
              PublicDnsName: "db.example.test",
              Tags: [{ Key: "Name", Value: "ACME PROD DB SECONDARY" }],
            },
          ],
        }],
      })),
    };

    const registry = new AwsInferredHostTargetRegistry(baseRegistry, () => runner);
    const targets = await registry.resolveRuntimeTargets("ACME", "PROD", "PROD1");

    expect(targets.map((target) => target.instanceId)).toEqual(["i-app-1", "i-app-2"]);
    expect(targets.every((target) => target.sshControlPathDedicated)).toBe(true);
    expect(new Set(targets.map((target) => target.sshControlPath)).size).toBe(2);
    expect(targets.every((target) => target.notes?.includes("separate from the database/login target"))).toBe(true);
  });

  it("infers an operator LDAP SSH host target from Jira-derived client and environment scope", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    vi.stubEnv("INVESTIGATION_AWS_DISCOVERY_REGIONS", "us-east-2");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "acme-prod");
    vi.stubEnv("INVESTIGATION_SSH_USER", "operator.ldap");
    vi.stubEnv("INVESTIGATION_SSH_CONTROL_PATH", "/tmp/cockpit-acme-prod-login.sock");

    const baseRegistry = {
      resolveTarget: vi.fn(async () => null),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => "us-east-2"),
      runJson: vi.fn(async () => ({
        Reservations: [{
          OwnerId: "123456789012",
          Instances: [{
            InstanceId: "i-acmeprodlogin123",
            PublicIpAddress: "203.0.113.10",
            PublicDnsName: "ec2-203-0-113-10.compute-1.amazonaws.com",
            VpcId: "vpc-acme",
            SubnetId: "subnet-acme",
            IamInstanceProfile: { Arn: "arn:aws:iam::123456789012:instance-profile/acme-login-role" },
            Tags: [{ Key: "Name", Value: "ACME PROD LOGIN" }],
          }],
        }],
      })),
    };

    const registry = new AwsInferredHostTargetRegistry(baseRegistry, () => runner);
    const target = await registry.resolveTarget("ACME", "PROD");

    expect(baseRegistry.resolveTarget).toHaveBeenCalledWith("ACME", "PROD", undefined, undefined);
    expect(runner.runJson).toHaveBeenCalledWith(
      expect.arrayContaining([
        "ec2",
        "describe-instances",
        "--region",
        "us-east-2",
        "Name=instance-state-name,Values=running",
      ]),
      expect.any(Object),
    );
    expect(target).toMatchObject({
      clientId: "ACME",
      environment: "PROD",
      envId: "PROD",
      awsProfile: "acme-prod",
      instanceId: "i-acmeprodlogin123",
      instanceName: "ACME PROD LOGIN",
      networkPath: "ssh_public",
      publicHost: "ec2-203-0-113-10.compute-1.amazonaws.com",
      sshUser: "operator.ldap",
      sshAuthMode: "operator_ldap",
      sshAllowed: true,
      sshControlPath: "/tmp/cockpit-acme-prod-login.sock",
      ssmAllowed: false,
    });
  });

  it("uses approved client aliases when AWS resource names differ from the canonical client id", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    vi.stubEnv("INVESTIGATION_AWS_DISCOVERY_REGIONS", "us-east-2");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");

    const discoverySeed = {
      id: "jira-ldap-ssh-discovery",
      scopeKind: "host" as const,
      clientId: "REGIONALPLAN",
      discoveryAliases: ["RHP"],
      environment: "PROD_REPLICA" as const,
      envId: "PROD1",
      awsAccountId: "",
      region: "us-east-2",
      instanceId: "jira-ldap-ssh-discovery",
      instanceName: "Regional Plan PROD LDAP SSH",
      vpcId: "",
      subnetId: "",
      networkPath: "ssh_public" as const,
      instanceProfileArn: "",
      expectedRoleName: "",
      awsProfile: "prod",
      sshAllowed: false,
      ssmAllowed: false,
      enabled: true,
    };
    const runner = {
      runText: vi.fn(async () => "us-east-2"),
      runJson: vi.fn(async () => ({
        Reservations: [{
          OwnerId: "123456789012",
          Instances: [{
            InstanceId: "i-rhpprodlogin123",
            PublicDnsName: "login.example.test",
            Tags: [{ Key: "Name", Value: "RHP PROD LOGIN" }],
          }],
        }],
      })),
    };
    const registry = new AwsInferredHostTargetRegistry({
      resolveTarget: vi.fn(async () => discoverySeed),
      listTargets: vi.fn(async () => [discoverySeed]),
    }, () => runner);

    const target = await registry.resolveTarget("REGIONALPLAN", "PROD_REPLICA", discoverySeed.id);

    expect(runner.runJson).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("*RHP*")]),
      expect.any(Object),
    );
    expect(target).toMatchObject({
      instanceId: "i-rhpprodlogin123",
      instanceName: "RHP PROD LOGIN",
      publicHost: "login.example.test",
      sshAllowed: true,
    });
  });

  it("upgrades a log-only runtime target to an AWS-inferred LDAP SSH host when inference is enabled", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    vi.stubEnv("INVESTIGATION_AWS_DISCOVERY_REGIONS", "");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "acme-prod");
    vi.stubEnv("INVESTIGATION_SSH_USER", "operator.ldap");

    const baseRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "jira-aws-log-scope",
        clientId: "ACME",
        environment: "PROD_REPLICA",
        envId: "PROD1",
        awsAccountId: "",
        region: "us-west-2",
        awsProfile: "acme-prod",
        instanceId: "jira-aws-log-scope",
        instanceName: "ACME PROD_REPLICA LDAP SSH",
        vpcId: "",
        subnetId: "",
        networkPath: "ssh_public",
        sshAllowed: false,
        ssmAllowed: false,
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => "us-east-2"),
      runJson: vi.fn(async () => ({
        Reservations: [{
          OwnerId: "123456789012",
          Instances: [{
            InstanceId: "i-acmeprodreplicalogin123",
            PrivateIpAddress: "10.0.12.20",
            PrivateDnsName: "ip-10-0-12-20.ec2.internal",
            VpcId: "vpc-acme",
            SubnetId: "subnet-acme",
            Tags: [{ Key: "Name", Value: "ACME PROD LOGIN" }],
          }],
        }],
      })),
    };

    const registry = new AwsInferredHostTargetRegistry(baseRegistry, () => runner);
    const target = await registry.resolveTarget("ACME", "PROD_REPLICA", "jira-aws-log-scope");

    expect(runner.runJson).toHaveBeenCalledWith(
      expect.arrayContaining(["--region", "us-west-2"]),
      expect.any(Object),
    );
    expect(target).toMatchObject({
      id: "inferred-acme-prod-replica-i-acmeprodreplicalogin123",
      instanceId: "i-acmeprodreplicalogin123",
      instanceName: "ACME PROD LOGIN",
      publicHost: "ip-10-0-12-20.ec2.internal",
      sshAllowed: true,
      ssmAllowed: false,
    });
    expect(target?.sshControlPath).toContain("cockpit-ssh-acme-prod-replica");
    expect(target?.sshControlPath).toMatch(/\.sock$/);
    expect(target?.sshControlPath).toMatch(/^\/tmp\//);
  });

  it("prefers a prod-replica secondary DB host over primary DB hosts during AWS inference", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");

    const baseRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "jira-aws-log-scope",
        clientId: "CIGNA",
        environment: "PROD_REPLICA",
        envId: "PROD1",
        awsAccountId: "",
        region: "us-east-2",
        awsProfile: "prod",
        instanceId: "jira-aws-log-scope",
        instanceName: "CIGNA PROD_REPLICA LDAP SSH",
        vpcId: "",
        subnetId: "",
        networkPath: "ssh_public",
        sshAllowed: false,
        ssmAllowed: false,
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => "us-east-2"),
      runJson: vi.fn(async (args: string[]) => {
        if (args.includes("--max-results")) {
          throw new Error("EC2 discovery must not cap low-level result pages before scoring candidates");
        }
        return {
          Reservations: [{
            OwnerId: "123456789012",
            Instances: [
              {
                InstanceId: "i-cignaprodprimary",
                PublicDnsName: "ec2-primary.example.test",
                Tags: [{ Key: "Name", Value: "CIGNA PROD DB PRIMARY" }],
              },
              {
                InstanceId: "i-cignaprodsecondary",
                PublicDnsName: "ec2-secondary.example.test",
                Tags: [{ Key: "Name", Value: "CIGNA PROD DB SECONDARY" }],
              },
            ],
          }],
        };
      }),
    };

    const registry = new AwsInferredHostTargetRegistry(baseRegistry, () => runner);
    const target = await registry.resolveTarget("CIGNA", "PROD_REPLICA", "jira-aws-log-scope");

    expect(runner.runJson).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.stringContaining("*CIGNA*PROD*db*"),
      ]),
      expect.any(Object),
    );
    expect(target).toMatchObject({
      instanceId: "i-cignaprodsecondary",
      instanceName: "CIGNA PROD DB SECONDARY",
      publicHost: "ec2-secondary.example.test",
      sshAllowed: true,
      ssmAllowed: false,
    });
  });

  it("uses ticket-derived host roles to replace a mismatched reachable fallback host", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");

    const baseRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "jira-ldap-ssh-host",
        clientId: "WELLCARE",
        environment: "PROD_REPLICA" as const,
        envId: "PROD1",
        awsAccountId: "",
        region: "us-east-2",
        awsProfile: "prod",
        instanceId: "configured-fallback",
        instanceName: "Wellcare PROD-REPLICA login",
        roleHints: ["login"],
        vpcId: "",
        subnetId: "",
        networkPath: "ssh_public" as const,
        publicHost: "db-slave.example.test",
        sshAllowed: true,
        ssmAllowed: false,
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => "us-east-2"),
      runJson: vi.fn(async () => ({
        Reservations: [{
          OwnerId: "123456789012",
          Instances: [
            {
              InstanceId: "i-wellcareprodsecondary",
              PublicDnsName: "db-slave.example.test",
              Tags: [{ Key: "Name", Value: "WELLCARE PROD DB SECONDARY" }],
            },
            {
              InstanceId: "i-wellcareprodlogin",
              PublicDnsName: "login.example.test",
              Tags: [{ Key: "Name", Value: "WELLCARE PROD LOGIN" }],
            },
          ],
        }],
      })),
    };

    const registry = new AwsInferredHostTargetRegistry(baseRegistry, () => runner);
    const target = await registry.resolveTarget("WELLCARE", "PROD_REPLICA", "jira-ldap-ssh-host");

    expect(runner.runJson).toHaveBeenCalled();
    expect(target).toMatchObject({
      instanceId: "i-wellcareprodlogin",
      instanceName: "WELLCARE PROD LOGIN",
      publicHost: "login.example.test",
      databaseHost: "db-slave.example.test",
      databasePort: 3306,
    });
  });

  it("never upgrades prod-replica discovery to a primary or master DB host", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");

    const configuredTarget = {
      id: "jira-aws-log-scope",
      clientId: "CIGNA",
      environment: "PROD_REPLICA" as const,
      envId: "PROD1",
      awsAccountId: "",
      region: "us-east-2",
      awsProfile: "prod",
      instanceId: "jira-aws-log-scope",
      instanceName: "CIGNA PROD_REPLICA LDAP SSH",
      vpcId: "",
      subnetId: "",
      networkPath: "ssh_public" as const,
      sshAllowed: false,
      ssmAllowed: false,
      enabled: true,
    };
    const baseRegistry = {
      resolveTarget: vi.fn(async () => configuredTarget),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => "us-east-2"),
      runJson: vi.fn(async () => ({
        Reservations: [{
          OwnerId: "123456789012",
          Instances: [{
            InstanceId: "i-cignaprodprimary",
            PublicDnsName: "ec2-primary.example.test",
            Tags: [{ Key: "Name", Value: "CIGNA PROD DB PRIMARY" }],
          }],
        }],
      })),
    };

    const registry = new AwsInferredHostTargetRegistry(baseRegistry, () => runner);
    const target = await registry.resolveTarget("CIGNA", "PROD_REPLICA", "jira-aws-log-scope");

    expect(target).toMatchObject({
      id: "jira-aws-log-scope",
      instanceId: "jira-aws-log-scope",
      sshAllowed: false,
      ssmAllowed: false,
    });
    expect(target?.publicHost).toBeUndefined();
  });

  it("ignores dynamic placeholder regions and searches the CP prod region during AWS inference", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    vi.stubEnv("INVESTIGATION_AWS_DISCOVERY_REGIONS", "");
    vi.stubEnv("INVESTIGATION_AWS_REGION", "");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_DEFAULT_REGION", "");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");

    const searchedRegions: string[] = [];
    const baseRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "jira-aws-log-scope",
        clientId: "CIGNA",
        environment: "PROD_REPLICA" as const,
        envId: "PROD1",
        awsAccountId: "",
        region: "aws-dynamic",
        awsProfile: "prod",
        instanceId: "jira-aws-log-scope",
        instanceName: "CIGNA PROD_REPLICA LDAP SSH",
        vpcId: "",
        subnetId: "",
        networkPath: "ssh_public" as const,
        sshAllowed: false,
        ssmAllowed: false,
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => "us-east-1"),
      runJson: vi.fn(async (args: string[]) => {
        const region = args[args.indexOf("--region") + 1] || "";
        searchedRegions.push(region);
        if (region !== "us-east-2") {
          return { Reservations: [] };
        }
        return {
          Reservations: [{
            OwnerId: "123456789012",
            Instances: [{
              InstanceId: "i-cignaprodsecondary",
              PublicDnsName: "ec2-secondary.example.test",
              Tags: [{ Key: "Name", Value: "CIGNA PROD DB SECONDARY" }],
            }],
          }],
        };
      }),
    };

    const registry = new AwsInferredHostTargetRegistry(baseRegistry, () => runner);
    const target = await registry.resolveTarget("CIGNA", "PROD_REPLICA", "jira-aws-log-scope");

    expect(searchedRegions).not.toContain("aws-dynamic");
    expect(searchedRegions).toContain("us-east-2");
    expect(target).toMatchObject({
      instanceId: "i-cignaprodsecondary",
      instanceName: "CIGNA PROD DB SECONDARY",
      publicHost: "ec2-secondary.example.test",
      sshAllowed: true,
      ssmAllowed: false,
    });
  });

  it("uses dynamically discovered AWS regions for any Jira-scoped client", async () => {
    vi.stubEnv("INVESTIGATION_AWS_INFER_HOST_TARGETS", "true");
    vi.stubEnv("INVESTIGATION_AWS_DISCOVERY_REGIONS", "");
    vi.stubEnv("INVESTIGATION_AWS_REGION", "");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_DEFAULT_REGION", "");
    vi.stubEnv("INVESTIGATION_AWS_PROFILE", "prod");

    const searchedRegions: string[] = [];
    const baseRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "jira-aws-log-scope",
        clientId: "ACME",
        environment: "UAT" as const,
        envId: "UAT2",
        awsAccountId: "",
        region: "aws-dynamic",
        awsProfile: "prod",
        instanceId: "jira-aws-log-scope",
        instanceName: "ACME UAT LDAP SSH",
        vpcId: "",
        subnetId: "",
        networkPath: "ssh_public" as const,
        sshAllowed: false,
        ssmAllowed: false,
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => "us-east-1"),
      runJson: vi.fn(async (args: string[]) => {
        if (args.includes("describe-regions")) {
          return { Regions: [{ RegionName: "us-west-2" }] };
        }
        const region = args[args.indexOf("--region") + 1] || "";
        searchedRegions.push(region);
        if (region !== "us-west-2") {
          return { Reservations: [] };
        }
        return {
          Reservations: [{
            OwnerId: "123456789012",
            Instances: [{
              InstanceId: "i-acmeuatdb",
              PrivateDnsName: "ip-10-0-8-12.us-west-2.compute.internal",
              Tags: [{ Key: "Name", Value: "ACME UAT DB" }],
            }],
          }],
        };
      }),
    };

    const registry = new AwsInferredHostTargetRegistry(baseRegistry, () => runner);
    const target = await registry.resolveTarget("ACME", "UAT", "jira-aws-log-scope");

    expect(searchedRegions).toContain("us-west-2");
    expect(target).toMatchObject({
      clientId: "ACME",
      environment: "UAT",
      envId: "UAT2",
      instanceId: "i-acmeuatdb",
      publicHost: "ip-10-0-8-12.us-west-2.compute.internal",
      sshAllowed: true,
      ssmAllowed: false,
    });
  });
});

function dataRequest(overrides: Partial<InvestigationAdapterRequest> = {}): InvestigationAdapterRequest {
  return {
    runId: "inv-db-operator-test",
    jiraKey: "CPCLIENT-55570",
    adapter: "data",
    scope: {
      clientId: "WELLCARE",
      environment: "UAT",
      serviceIds: ["claims"],
      keywords: ["claim"],
    },
    constraints: {
      timeoutMs: 60_000,
      redactionRequired: true,
    },
    ...overrides,
  };
}

function dbTarget(overrides: Partial<InvestigationConnectionTarget> = {}): InvestigationConnectionTarget {
  return {
    id: "wellcare-uat-db",
    clientId: "WELLCARE",
    environment: "UAT",
    envId: "UAT1",
    topology: "rds_mysql",
    engine: "mysql",
    host: "mysql.internal",
    port: 3306,
    databaseName: "medhok",
    networkPath: "vpn",
    authMode: "username_password",
    secretRef: "env://SHARED_DB_PASSWORD",
    dbUser: "shared_db_user",
    accessClass: "lower_ro",
    allowedQueryPacks: ["operator_claim_lookup"],
    phiAccess: false,
    enabled: true,
    sslRequired: false,
    ...overrides,
  };
}

function adapterResult(overrides: Partial<InvestigationAdapterResult> = {}): InvestigationAdapterResult {
  return {
    findings: [],
    evidence: [],
    telemetry: {
      durationMs: 1,
      requestsIssued: 0,
    },
    ...overrides,
  };
}

describe("DashboardMysqlDataDiagnosticsAdapter", () => {
  const queryPackRegistry = new QueryPackRegistry([
    {
      id: "operator_claim_lookup",
      description: "Bounded claim lookup for operator credential tests.",
      environments: ["UAT"],
      allowedTables: ["claim_status"],
      parameterNames: [],
      sql: "SELECT claim_id, status FROM claim_status LIMIT 10",
      maxRows: 10,
      timeoutMs: 3_000,
      redactionTags: ["operational_metadata_only"],
    },
  ]);

  it("uses runtime operator DB credentials instead of target/shared credentials", async () => {
    process.env.INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS = "true";
    process.env.INVESTIGATION_DB_USERNAME = "operator.ldap";
    process.env.INVESTIGATION_DB_PASSWORD = "operator-password";
    process.env.INVESTIGATION_DB_DATABASE = "operator_db";
    process.env.SHARED_DB_PASSWORD = "target-secret";

    const target = dbTarget();
    const connectionRegistry = {
      resolveTarget: vi.fn(async () => target),
      listTargets: vi.fn(async () => [target]),
    };
    const secretResolver = {
      resolve: vi.fn(async () => ({ password: "target-secret" })),
    };
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql === "SELECT @@session.transaction_read_only AS session_readonly") {
          return [[{ session_readonly: 1 }], []];
        }
        if (sql === "SELECT claim_id, status FROM claim_status LIMIT 10") {
          return [[{ claim_id: "CLM-123", status: "PENDING" }], []];
        }
        return [[], []];
      }),
      end: vi.fn(async () => undefined),
    };
    const connectionFactory = vi.fn(async (config: unknown) => {
      return Object.assign(connection, { __config: config });
    });

    const adapter = new DashboardMysqlDataDiagnosticsAdapter(
      connectionRegistry,
      undefined,
      queryPackRegistry,
      undefined,
      undefined,
      secretResolver,
      connectionFactory as never,
    );

    const result = await adapter.execute(dataRequest());

    expect(secretResolver.resolve).not.toHaveBeenCalled();
    expect(connectionFactory).toHaveBeenCalledWith(expect.objectContaining({
      user: "operator.ldap",
      password: "operator-password",
      database: "operator_db",
    }));
    expect(connectionFactory).not.toHaveBeenCalledWith(expect.objectContaining({
      user: "shared_db_user",
      password: "target-secret",
    }));
    expect(connection.query).toHaveBeenCalledWith("SET SESSION max_execution_time=10000, SESSION transaction_read_only=ON");
    expect(result.telemetry.rowsRead).toBe(1);
    expect(JSON.stringify(result)).not.toContain("operator-password");
    expect(JSON.stringify(result)).not.toContain("shared_db_user");
  });

  it("fails closed when operator credential mode is enabled without runtime LDAP credentials", async () => {
    process.env.INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS = "true";
    delete process.env.INVESTIGATION_DB_USERNAME;
    delete process.env.INVESTIGATION_DB_PASSWORD;
    delete process.env.MERIDIAN_DB_USERNAME;
    delete process.env.MERIDIAN_DB_PASSWORD;

    const target = dbTarget();
    const connectionRegistry = {
      resolveTarget: vi.fn(async () => target),
      listTargets: vi.fn(async () => [target]),
    };
    const secretResolver = {
      resolve: vi.fn(async () => ({ password: "target-secret" })),
    };
    const connectionFactory = vi.fn();

    const adapter = new DashboardMysqlDataDiagnosticsAdapter(
      connectionRegistry,
      undefined,
      queryPackRegistry,
      undefined,
      undefined,
      secretResolver,
      connectionFactory as never,
    );

    const result = await adapter.execute(dataRequest());

    expect(secretResolver.resolve).not.toHaveBeenCalled();
    expect(connectionFactory).not.toHaveBeenCalled();
    expect(result.findings[0]).toMatchObject({
      adapter: "data",
      type: "database_access_failure",
      title: "Operator database credential mode is not configured",
    });
    expect(result.findings[0]?.summary).toContain("INVESTIGATION_DB_USERNAME");
  });

  it("blocks SSM host-side DB auth when operator credential mode is required", async () => {
    process.env.INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS = "true";
    process.env.INVESTIGATION_DB_USERNAME = "operator.ldap";
    process.env.INVESTIGATION_DB_PASSWORD = "operator-password";

    const target = dbTarget({
      topology: "ec2_mysql",
      networkPath: "ssm",
      hostTargetId: "wellcare-host",
      hostAuthFile: "/etc/profile.d/db-auth.sh",
    });
    const connectionRegistry = {
      resolveTarget: vi.fn(async () => target),
      listTargets: vi.fn(async () => [target]),
    };
    const hostTargetRegistry = {
      resolveTarget: vi.fn(),
      listTargets: vi.fn(),
    };
    const connectionFactory = vi.fn();

    const adapter = new DashboardMysqlDataDiagnosticsAdapter(
      connectionRegistry,
      hostTargetRegistry,
      queryPackRegistry,
      undefined,
      undefined,
      undefined,
      connectionFactory as never,
    );

    const result = await adapter.execute(dataRequest());

    expect(hostTargetRegistry.resolveTarget).not.toHaveBeenCalled();
    expect(connectionFactory).not.toHaveBeenCalled();
    expect(result.findings[0]).toMatchObject({
      adapter: "data",
      type: "database_access_failure",
      title: "Operator database credential mode blocked host-side DB diagnostics",
    });
    expect(JSON.stringify(result)).not.toContain("/etc/profile.d/db-auth.sh");
  });

  it("falls back to a code-derived workflow queue-routing diagnostic in the dashboard data adapter", async () => {
    process.env.INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS = "true";
    process.env.INVESTIGATION_DB_USERNAME = "operator.ldap";
    process.env.INVESTIGATION_DB_PASSWORD = "operator-password";
    process.env.INVESTIGATION_DB_DATABASE = "medhok";

    const target = dbTarget({
      clientId: "HUMANA",
      environment: "PROD_REPLICA",
      envId: "PROD2",
      allowedQueryPacks: [],
      accessClass: "prod_readonly_replica",
    });
    const connectionRegistry = {
      resolveTarget: vi.fn(async () => target),
      listTargets: vi.fn(async () => [target]),
    };
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql === "SELECT @@session.transaction_read_only AS session_readonly") {
          return [[{ session_readonly: 1 }], []];
        }
        if (sql.includes("FROM adhok_business_process abp") && sql.includes("FROM adhok_business_task abt")) {
          return [[{
            source_name: "current_config",
            scope_key: "AOR Review -> MA BP AOR Review",
            total_rows: "1",
            enabled_rows: "1",
            disabled_or_null_rows: "0",
            latest_update_at: "2026-07-10 09:00:00",
          }], []];
        }
        return [[], []];
      }),
      end: vi.fn(async () => undefined),
    };
    const connectionFactory = vi.fn(async (config: unknown) => {
      return Object.assign(connection, { __config: config });
    });

    const adapter = new DashboardMysqlDataDiagnosticsAdapter(
      connectionRegistry,
      undefined,
      queryPackRegistry,
      undefined,
      undefined,
      undefined,
      connectionFactory as never,
    );

    const result = await adapter.execute(dataRequest({
      jiraKey: "CPSUP-46150",
      scope: {
        clientId: "HUMANA",
        environment: "PROD_REPLICA",
        serviceIds: ["core-app"],
        repoNames: ["core-app"],
        ticketContext: {
          source: "jira",
          jiraKey: "CPSUP-46150",
          fetchStatus: "fetched",
          title: "AOR Review and VMD subtask visible in Nurse Review Unassigned portlet",
        },
        diagnosticContext: {
          codeEvidenceTerms: ["QueueAuthorization", "process_flow", "adhok_business_task"],
          dataFlowHints: [
            {
              sourceRepo: "core-app",
              sourcePath: "mm-shared-services/src/main/java/com/medhok/mm/shared/service/BPMSharedService.java",
              artifactType: "hql_literal",
              tableName: "queue_authorization",
            },
            {
              sourceRepo: "core-app",
              sourcePath: "MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/ProcessFlow.hbm.xml",
              artifactType: "hibernate_mapping",
              tableName: "process_flow",
              columns: [{ name: "active_group", propertyName: "activeGroup" }],
            },
          ],
        },
      },
    }));
    const traceSteps = result.telemetry.traceSteps ?? [];

    expect(traceSteps.find((step) => step.phase === "select_query_pack")).toMatchObject({
      queryPackId: "appcode_workflow_queue_routing",
    });
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("FROM adhok_business_process abp"));
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("FROM adhok_business_task abt"));
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("'AOR Review'"));
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("'VMD'"));
    expect(result.evidence[0]?.summary).toContain("appcode_workflow_queue_routing");
  });
});

describe("DashboardInvestigationControlPlane runtime probe gates", () => {
  it("continues to code probe after runtime application failures without forcing DB diagnostics", async () => {
    const awsAdapter = {
      kind: "aws" as const,
      execute: vi.fn(async () => adapterResult()),
    };
    const hostAdapter = {
      kind: "host" as const,
      execute: vi.fn(async () => adapterResult({
        findings: [{
          id: "host-runtime-500",
          adapter: "host",
          type: "cloudwatch_log_evidence",
          severity: "high",
          confidence: 0.84,
          title: "CloudWatch found HTTP 500 runtime failures",
          summary: "Observed HTTP/status code(s): 500.",
          evidenceRefs: ["host-evidence"],
          requiresCodeChange: true,
          requiresDataChange: false,
          metadata: {
            statusCodes: ["500"],
            runtimeApplicationFailure: true,
          },
        }],
        evidence: [{
          id: "host-evidence",
          adapter: "host",
          title: "CloudWatch runtime log search",
          summary: "CloudWatch returned redacted runtime samples.",
          contentType: "application/json",
          metadata: {
            redactedSamples: [{
              message: "FaxComRestServiceClient failed with status: 500 while calling archive endpoint.",
            }],
          },
        }],
      })),
    };
    const codeAdapter = {
      kind: "code" as const,
      execute: vi.fn(async () => adapterResult({
        findings: [{
          id: "code-config",
          adapter: "code",
          type: "code_path_candidates",
          severity: "medium",
          confidence: 0.74,
          title: "Code Agent found repository-configuration candidate evidence",
          summary: "Found runtime endpoint configuration candidate evidence.",
          evidenceRefs: ["code-config-evidence"],
          requiresCodeChange: true,
          requiresDataChange: false,
          metadata: {
            remediationSurface: "repository_configuration",
          },
        }],
        evidence: [{
          id: "code-config-evidence",
          adapter: "code",
          title: "Code Agent strict validation scan",
          summary: "Found application.properties candidate evidence.",
          contentType: "application/json",
          metadata: {
            hits: [{
              path: "src/main/resources/application.properties",
              preview: "faxcom.endpoint=https://redacted.example",
            }],
          },
        }],
      })),
    };
    const dataAdapter = {
      kind: "data" as const,
      execute: vi.fn(async () => adapterResult()),
    };
    const controlPlane = new DashboardInvestigationControlPlane({
      aws: awsAdapter,
      host: hostAdapter,
      code: codeAdapter,
      data: dataAdapter,
    } as never);

    const run = controlPlane.createRun({
      jiraKey: "CPCLIENT-55570",
      title: "FaxCom runtime failures",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["fax-intake-service"],
        keywords: ["FaxCom", "HTTP 500"],
        repoNames: [],
      },
    });

    await controlPlane.executeRun(run);

    expect(hostAdapter.execute).toHaveBeenCalledTimes(1);
    expect(codeAdapter.execute).toHaveBeenCalledTimes(1);
    expect(dataAdapter.execute).not.toHaveBeenCalled();
    expect(codeAdapter.execute.mock.calls[0]?.[0].scope.keywords).toEqual(expect.arrayContaining([
      "FaxComRestServiceClient",
    ]));
  });

  it("reruns deployed-config SSH probe with code-derived scheduler/config terms", async () => {
    const awsAdapter = {
      kind: "aws" as const,
      execute: vi.fn(async () => adapterResult()),
    };
    const hostAdapter = {
      kind: "host" as const,
      execute: vi.fn(async (request: InvestigationAdapterRequest) => adapterResult({
        findings: [{
          id: `${request.runId}-ssh-config-no-evidence`,
          adapter: "host",
          type: "ssh_config_no_evidence",
          severity: "info",
          confidence: 0.55,
          title: "LDAP SSH deployed jar/properties probe did not find matching files",
          summary: "The first bounded search had only broad ticket terms.",
          evidenceRefs: [`${request.runId}-ssh-config-evidence`],
          requiresCodeChange: false,
          requiresDataChange: false,
        }],
        evidence: [{
          id: `${request.runId}-ssh-config-evidence`,
          adapter: "host",
          title: "LDAP SSH deployed jar/properties probe",
          summary: "LDAP SSH searched approved config roots and found 0 deployed candidates.",
          contentType: "application/json",
          metadata: {
            matchedFiles: [],
            searchTerms: request.scope.keywords,
          },
        }],
      })),
      executeDeployedConfigOnly: vi.fn(async (request: InvestigationAdapterRequest) => adapterResult({
        findings: [{
          id: `${request.runId}-ssh-config-evidence`,
          adapter: "host",
          type: "ssh_config_evidence",
          severity: "medium",
          confidence: 0.78,
          title: "LDAP SSH deployed jar/properties probe found candidates",
          summary: "Found deployed jar/properties candidates using code-derived terms.",
          evidenceRefs: [`${request.runId}-ssh-config-evidence`],
          requiresCodeChange: true,
          requiresDataChange: false,
        }],
        evidence: [{
          id: `${request.runId}-ssh-config-evidence`,
          adapter: "host",
          title: "LDAP SSH deployed jar/properties probe",
          summary: "LDAP SSH searched approved config roots and found deployed candidates.",
          contentType: "application/json",
          metadata: {
            matchedFiles: ["/opt/software/medhok/payments-loader/payments_main.properties"],
            searchTerms: request.scope.keywords,
          },
        }],
      })),
    };
    const codeAdapter = {
      kind: "code" as const,
      execute: vi.fn(async (request: InvestigationAdapterRequest) => adapterResult({
        findings: [{
          id: `${request.runId}-batch-scheduler-config-candidates`,
          adapter: "code",
          type: "batch_scheduler_config_candidates",
          severity: "medium",
          confidence: 0.72,
          title: "Code Agent found batch scheduler/config candidate evidence",
          summary: "Found scheduler XML and client-config YAML candidates.",
          evidenceRefs: [`${request.runId}-code-evidence`],
          requiresCodeChange: true,
          requiresDataChange: false,
          metadata: {
            schedulerTerms: [
              "/opt/software/medhok/payments-loader/run_payments",
              "payments_main.properties",
            ],
          },
        }],
        evidence: [{
          id: `${request.runId}-code-evidence`,
          adapter: "code",
          title: "Code Agent strict validation scan",
          summary: "Found scheduler/config evidence.",
          contentType: "application/json",
          metadata: {
            batchSchedulerDiscovery: {
              schedulerTerms: [
                "/opt/software/medhok/payments-loader/run_payments",
                "payments_main.properties",
              ],
              schedulerHits: [{
                path: "client/cp/prod/CLIENT-CPPROD-payments_loader.xml",
                preview: "<command_string>/opt/software/medhok/payments-loader/run_payments</command_string>",
              }],
              configHits: [{
                path: "prod1/jar_runner/client-cp-prod-prod1-jar_runner-payments_loader.yaml",
                preview: "JVM_PROPS: \"main.properties=payments_main.properties\"",
              }],
            },
          },
        }],
      })),
    };
    const dataAdapter = {
      kind: "data" as const,
      execute: vi.fn(async () => adapterResult()),
    };
    const controlPlane = new DashboardInvestigationControlPlane({
      aws: awsAdapter,
      host: hostAdapter,
      code: codeAdapter,
      data: dataAdapter,
    } as never);

    const run = controlPlane.createRun({
      jiraKey: "CPSUP-55800",
      title: "Payments loader batch config validation",
      scope: {
        clientId: "CLIENT",
        environment: "PROD_REPLICA",
        serviceIds: [],
        keywords: ["Payments loader batch job failed"],
        repoNames: ["batch-jobs"],
      },
    });

    const result = await controlPlane.executeRun(run);
    const retryRequest = hostAdapter.executeDeployedConfigOnly.mock.calls[0]?.[0];

    expect(hostAdapter.execute).toHaveBeenCalledTimes(1);
    expect(hostAdapter.executeDeployedConfigOnly).toHaveBeenCalledTimes(1);
    expect(retryRequest?.scope.keywords).toEqual(expect.arrayContaining([
      "payments_main.properties",
      "/opt/software/medhok/payments-loader/run_payments",
      "payments-loader",
      "run_payments",
    ]));
    expect(result.findings.some((finding) => finding.type === "ssh_config_no_evidence")).toBe(false);
    expect(result.evidence.find((artifact) => artifact.id.endsWith("ssh-config-evidence"))?.metadata?.matchedFiles).toEqual([
      "/opt/software/medhok/payments-loader/payments_main.properties",
    ]);
    expect(result.nextStep.reason).not.toContain("Deployed jar/properties evidence is mandatory");
  });

  it("runs DB diagnostics after code only when code evidence points to DB state", async () => {
    const awsAdapter = {
      kind: "aws" as const,
      execute: vi.fn(async () => adapterResult()),
    };
    const hostAdapter = {
      kind: "host" as const,
      execute: vi.fn(async () => adapterResult()),
    };
    const codeAdapter = {
      kind: "code" as const,
      execute: vi.fn(async () => adapterResult({
        findings: [{
          id: "code-db-state",
          adapter: "code",
          type: "code_path_candidates",
          severity: "medium",
          confidence: 0.74,
          title: "Code Agent found repository DB-state candidate evidence",
          summary: "Repository path references transaction_status table validation.",
          evidenceRefs: ["code-db-evidence"],
          requiresCodeChange: true,
          requiresDataChange: false,
          metadata: {
            remediationSurface: "database_state_validation",
            table: "transaction_status",
          },
        }],
        evidence: [{
          id: "code-db-evidence",
          adapter: "code",
          title: "Code Agent strict validation scan",
          summary: "Found query path candidate for transaction_status.",
          contentType: "application/json",
          metadata: {
            hits: [{
              path: "src/main/java/com/medhok/ClaimStatusRepository.java",
              preview: "SELECT status FROM transaction_status WHERE claim_id = ?",
            }],
          },
        }],
      })),
    };
    const dataAdapter = {
      kind: "data" as const,
      execute: vi.fn(async () => adapterResult()),
    };
    const controlPlane = new DashboardInvestigationControlPlane({
      aws: awsAdapter,
      host: hostAdapter,
      code: codeAdapter,
      data: dataAdapter,
    } as never);

    const run = controlPlane.createRun({
      jiraKey: "CPSUP-49835",
      title: "Claim status investigation",
      scope: {
        clientId: "HUMANA",
        environment: "PROD_REPLICA",
        serviceIds: [],
        keywords: ["ClaimStatusRepository"],
        repoNames: ["core-app"],
      },
    });

    await controlPlane.executeRun(run);

    expect(hostAdapter.execute).not.toHaveBeenCalled();
    expect(codeAdapter.execute).toHaveBeenCalledTimes(1);
    expect(dataAdapter.execute).toHaveBeenCalledTimes(1);
    expect(codeAdapter.execute.mock.invocationCallOrder[0]).toBeLessThan(
      dataAdapter.execute.mock.invocationCallOrder[0],
    );
  });
});

describe("DashboardWatchdogLogInspectionAdapter", () => {
  it("turns Watchdog CloudWatch FaxCom samples into host evidence", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mcpCaller = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "healthcheck") {
        return { status: "ok" };
      }
      if (name === "build_investigation_scope") {
        return {
          status: "ok",
          scope: {
            clientId: "WELLCARE",
            environment: "PROD_REPLICA",
            logGroups: ["/CP/WELLCARE/PROD/fax-intake-service"],
          },
        };
      }
      if (name === "search_logs_by_client") {
        return {
          status: "ok",
          search_id: "wdg-search-1",
          summary_counts: {
            total_matches: 7,
            returned_samples: 2,
            regions: { "us-east-2": 7 },
            log_groups: { "/CP/WELLCARE/PROD/fax-intake-service": 7 },
          },
          top_samples: [
            {
              timestamp: "2026-06-08T15:54:00.000Z",
              log_group_name: "/CP/WELLCARE/PROD/fax-intake-service",
              log_stream: "i-redacted",
              message: "FaxComRestServiceClient :: Fax move failed with status: 500, body: Unexpected error occurred.",
            },
            {
              timestamp: "2026-06-08T15:54:02.000Z",
              log_group_name: "/CP/WELLCARE/PROD/fax-intake-service",
              log_stream: "i-redacted",
              message: "FaxComArchiveService :: Failed to archive 90 faxes for uniqueJobId REDACTED.",
            },
          ],
        };
      }
      throw new Error(`Unexpected MCP tool ${name}`);
    });

    const adapter = new DashboardWatchdogLogInspectionAdapter(undefined, mcpCaller);
    const request: InvestigationAdapterRequest = {
      runId: "inv-watchdog-test",
      jiraKey: "CPCLIENT-55570",
      adapter: "host",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["fax-intake-service"],
        keywords: ["FaxCom", "REST API", "FaxComRestServiceClient", "uniqueJobId", "HTTP 500", "Unexpected error"],
        repoNames: ["batch-jobs"],
        codeVersion: "3.19",
        timeWindow: {
          startTs: "2026-06-08T14:00:00.000Z",
          endTs: "2026-06-08T18:00:00.000Z",
        },
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
      },
    };

    const result = await adapter.execute(request);

    expect(calls.map((call) => call.name)).toEqual([
      "healthcheck",
      "build_investigation_scope",
      "search_logs_by_client",
    ]);
    expect(calls[2]?.args).toMatchObject({
      query_spec: expect.objectContaining({
        keywords: expect.arrayContaining(["FaxCom", "FaxComRestServiceClient", "uniqueJobId"]),
        exact_phrases: expect.arrayContaining(["HTTP 500", "Unexpected error"]),
        component_filters: ["fax-intake-service"],
      }),
    });
    expect((calls[2]?.args.query_spec as { keywords: string[] }).keywords).not.toEqual(expect.arrayContaining([
      "subsessionId",
      "archive",
      "move",
      "download",
    ]));
    expect(result.findings[0]).toMatchObject({
      adapter: "host",
      type: "watchdog_log_evidence",
      title: "Watchdog found HTTP 500 runtime failures",
      severity: "high",
      requiresCodeChange: false,
      requiresDataChange: false,
    });
    expect(result.evidence[0]).toMatchObject({
      adapter: "host",
      title: "Watchdog CloudWatch log search",
      metadata: expect.objectContaining({
        searchId: "wdg-search-1",
        redactedSamples: expect.arrayContaining([
          expect.objectContaining({
            logGroup: "/CP/WELLCARE/PROD/fax-intake-service",
          }),
        ]),
      }),
    });
  });
});

describe("DashboardCloudWatchLogInspectionAdapter", () => {
  it("probes service-specific log groups and ranks FaxCom API groups before generic batch groups", async () => {
    const describePrefixes: string[] = [];
    const searchedGroups: string[] = [];
    const hostRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "wellcare-prod-login",
        clientId: "WELLCARE",
        environment: "PROD_REPLICA" as const,
        envId: "PROD1",
        awsAccountId: "239350186085",
        region: "us-east-2",
        awsProfile: "prod",
        instanceId: "i-1234567890abcdef0",
        instanceName: "WELLCARE PROD LOGIN",
        vpcId: "vpc-redacted",
        subnetId: "subnet-redacted",
        networkPath: "ssm" as const,
        publicHost: "198.51.100.10",
        sshPort: 22,
        sshAuthMode: "operator_ldap" as const,
        instanceProfileArn: "arn:aws:iam::239350186085:instance-profile/WELLCARE",
        expectedRoleName: "WELLCARE",
        ssmAllowed: true,
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(),
      runJson: vi.fn(async (args: string[]) => {
        if (args.includes("describe-log-groups")) {
          const prefix = args[args.indexOf("--log-group-name-prefix") + 1] || "";
          describePrefixes.push(prefix);
          if (prefix === "/CP/WELLCARE/PROD1/batch/fax-intake-service") {
            return { logGroups: [{ logGroupName: "/CP/WELLCARE/PROD1/batch/fax-intake-service" }] };
          }
          if (prefix === "/CP/WELLCARE/PROD1") {
            return {
              logGroups: [
                { logGroupName: "/CP/WELLCARE/PROD1/batch/CorrespondenceUtility" },
                { logGroupName: "/CP/WELLCARE/PROD1/batch/batch-workflow-watcher" },
                { logGroupName: "/CP/WELLCARE/PROD1/batch/queue-monitor" },
                { logGroupName: "/CP/WELLCARE/PROD1/ws" },
                { logGroupName: "/CP/WELLCARE/PROD1/ws/catalina" },
              ],
            };
          }
          return { logGroups: [] };
        }
        if (args.includes("filter-log-events")) {
          searchedGroups.push(args[args.indexOf("--log-group-name") + 1] || "");
          return { events: [] };
        }
        throw new Error(`Unexpected AWS args ${args.join(" ")}`);
      }),
    };

    const adapter = new DashboardCloudWatchLogInspectionAdapter(hostRegistry, () => runner);
    const result = await adapter.execute({
      runId: "inv-cloudwatch-selection-test",
      jiraKey: "CPCLIENT-55570",
      adapter: "host",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["fax-intake-service"],
        keywords: ["FaxCom", "DMR queue", "fax IDs", "specific queues", "HTTP 500", "Unexpected error"],
        timeWindow: {
          startTs: "2026-06-08T14:00:00.000Z",
          endTs: "2026-06-08T22:00:00.000Z",
        },
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
      },
    });

    expect(describePrefixes).toContain("/CP/WELLCARE/PROD1/batch/fax-intake-service");
    expect(searchedGroups[0]).toBe("/CP/WELLCARE/PROD1/batch/fax-intake-service");
    expect(searchedGroups).toEqual(expect.arrayContaining([
      "/CP/WELLCARE/PROD1/ws",
      "/CP/WELLCARE/PROD1/ws/catalina",
    ]));
    expect(result.evidence[0]?.metadata).toMatchObject({
      targetId: "wellcare-prod-login",
      instanceId: "i-1234567890abcdef0",
      publicHost: "198.51.100.10",
      sshPort: 22,
      sshAuthMode: "operator_ldap",
    });
    expect(result.evidence[0]?.metadata?.traceSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Select bounded CloudWatch log groups",
        detail: expect.stringContaining("/CP/WELLCARE/PROD1/batch/fax-intake-service"),
      }),
    ]));
  });

  it("ranks ticket-derived extract surfaces before generic processor log groups", async () => {
    const describePrefixes: string[] = [];
    const searchedGroups: string[] = [];
    const hostRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "acme-prod-login",
        clientId: "ACME",
        environment: "PROD" as const,
        envId: "PROD1",
        awsAccountId: "123456789012",
        region: "us-west-1",
        awsProfile: "prod",
        instanceId: "i-1234567890abcdef0",
        instanceName: "ACME PROD Login",
        vpcId: "vpc-redacted",
        subnetId: "subnet-redacted",
        networkPath: "ssm" as const,
        instanceProfileArn: "arn:aws:iam::123456789012:instance-profile/ACME",
        expectedRoleName: "ACME",
        ssmAllowed: true,
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(),
      runJson: vi.fn(async (args: string[]) => {
        if (args.includes("describe-log-groups")) {
          const prefix = args[args.indexOf("--log-group-name-prefix") + 1] || "";
          describePrefixes.push(prefix);
          if (prefix === "/CP/ACME/PROD1/batch/AssessmentQA_Extract") {
            return { logGroups: [{ logGroupName: "/CP/ACME/PROD1/batch/AssessmentQA_Extract" }] };
          }
          if (prefix === "/CP/ACME/PROD1") {
            return {
              logGroups: [
                { logGroupName: "/CP/ACME/PROD1/batch/cms-processor" },
                { logGroupName: "/CP/ACME/PROD1/batch/AssessmentQA_Extract" },
                { logGroupName: "/CP/ACME/PROD1/batch/batch-workflow-watcher" },
              ],
            };
          }
          return { logGroups: [] };
        }
        if (args.includes("filter-log-events")) {
          searchedGroups.push(args[args.indexOf("--log-group-name") + 1] || "");
          return { events: [] };
        }
        throw new Error(`Unexpected AWS args ${args.join(" ")}`);
      }),
    };

    const adapter = new DashboardCloudWatchLogInspectionAdapter(hostRegistry, () => runner);
    await adapter.execute({
      runId: "inv-cloudwatch-extract-selection-test",
      jiraKey: "SUPPORT-55571",
      adapter: "host",
      scope: {
        clientId: "ACME",
        environment: "PROD",
        serviceIds: ["QA Assessment Extract", "acme-backend"],
        keywords: ["QA Assessment Extract", "assessment extract correction"],
        timeWindow: {
          startTs: "2026-06-08T14:00:00.000Z",
          endTs: "2026-06-08T22:00:00.000Z",
        },
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
      },
    });

    expect(describePrefixes).toContain("/CP/ACME/PROD1/batch/AssessmentQA_Extract");
    expect(searchedGroups[0]).toBe("/CP/ACME/PROD1/batch/AssessmentQA_Extract");
    expect(searchedGroups.indexOf("/CP/ACME/PROD1/batch/AssessmentQA_Extract"))
      .toBeLessThan(searchedGroups.indexOf("/CP/ACME/PROD1/batch/cms-processor"));
  });

  it("uses configured CloudWatch scope templates and per-scope regions instead of broad prefix discovery", async () => {
    const describeCalls: Array<{ prefix: string; region: string }> = [];
    const searchedGroups: Array<{ group: string; region: string }> = [];
    const hostRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "wellcare-prod-login",
        clientId: "WELLCARE",
        environment: "PROD_REPLICA" as const,
        envId: "PROD1",
        awsAccountId: "239350186085",
        region: "us-east-2",
        awsProfile: "prod",
        instanceId: "i-1234567890abcdef0",
        instanceName: "WELLCARE PROD LOGIN",
        vpcId: "vpc-redacted",
        subnetId: "subnet-redacted",
        networkPath: "ssm" as const,
        instanceProfileArn: "arn:aws:iam::239350186085:instance-profile/WELLCARE",
        expectedRoleName: "WELLCARE",
        ssmAllowed: true,
        cloudWatchLogScopes: [
          {
            id: "ws-west",
            kind: "ws" as const,
            nameTemplate: "/CP/{clientId}/{envId}/ws",
            region: "us-west-1",
            default: true,
          },
          {
            id: "batch-east",
            kind: "batch" as const,
            prefixTemplate: "/CP/{clientId}/{envId}/batch/",
            region: "us-east-2",
            maxGroups: 1,
          },
          {
            id: "core-east",
            kind: "core" as const,
            prefixTemplate: "/CP/{clientId}/{envId}/core/",
            region: "us-east-2",
            maxGroups: 1,
          },
          {
            id: "cas-east",
            kind: "cas" as const,
            prefixTemplate: "/CP/{clientId}/{envId}/cas",
            region: "us-east-2",
            maxGroups: 1,
          },
          {
            id: "peer-portal-west",
            kind: "portal" as const,
            prefixTemplate: "/CP/{clientId}/{envId}PEER/portal",
            region: "us-west-1",
            maxGroups: 1,
          },
          {
            id: "spagobi-east",
            kind: "spagobi" as const,
            prefixTemplate: "/CP/{clientId}/{envId}/spagobi/",
            region: "us-east-2",
            maxGroups: 1,
          },
          {
            id: "knowage-east",
            kind: "knowage" as const,
            prefixTemplate: "/CP/{clientId}/{envId}/knowage/",
            region: "us-east-2",
            maxGroups: 1,
          },
        ],
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(),
      runJson: vi.fn(async (args: string[]) => {
        if (args.includes("describe-log-groups")) {
          const region = args[args.indexOf("--region") + 1] || "";
          const prefix = args[args.indexOf("--log-group-name-prefix") + 1] || "";
          describeCalls.push({ prefix, region });
          if (prefix === "/CP/WELLCARE/PROD1/batch/") {
            return {
              logGroups: [
                { logGroupName: "/CP/WELLCARE/PROD1/batch/fax-intake-service" },
                { logGroupName: "/CP/WELLCARE/PROD1/batch/other-program" },
              ],
            };
          }
          if (prefix === "/CP/WELLCARE/PROD1/core/") {
            return {
              logGroups: [
                { logGroupName: "/CP/WELLCARE/PROD1/core/core-app" },
                { logGroupName: "/CP/WELLCARE/PROD1/core/admin" },
              ],
            };
          }
          if (prefix === "/CP/WELLCARE/PROD1/cas") {
            return {
              logGroups: [
                { logGroupName: "/CP/WELLCARE/PROD1/cas" },
              ],
            };
          }
          if (prefix === "/CP/WELLCARE/PROD1PEER/portal") {
            return {
              logGroups: [
                { logGroupName: "/CP/WELLCARE/PROD1PEER/portal" },
              ],
            };
          }
          if (prefix === "/CP/WELLCARE/PROD1/knowage/") {
            return {
              logGroups: [
                { logGroupName: "/CP/WELLCARE/PROD1/knowage/server" },
              ],
            };
          }
          return { logGroups: [] };
        }
        if (args.includes("filter-log-events")) {
          searchedGroups.push({
            group: args[args.indexOf("--log-group-name") + 1] || "",
            region: args[args.indexOf("--region") + 1] || "",
          });
          return { events: [] };
        }
        throw new Error(`Unexpected AWS args ${args.join(" ")}`);
      }),
    };

    const adapter = new DashboardCloudWatchLogInspectionAdapter(hostRegistry, () => runner);
    const result = await adapter.execute({
      runId: "inv-configured-cloudwatch-scope-test",
      jiraKey: "CPCLIENT-55570",
      adapter: "host",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["fax-intake-service", "core-app"],
        keywords: ["FaxCom", "HTTP 500", "batch queue", "application error", "Knowage report error", "CAS login failure", "PEER portal outage"],
        timeWindow: {
          startTs: "2026-06-08T14:00:00.000Z",
          endTs: "2026-06-08T22:00:00.000Z",
        },
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
      },
    });

    expect(describeCalls).toEqual([
      { prefix: "/CP/WELLCARE/PROD1/batch/", region: "us-east-2" },
      { prefix: "/CP/WELLCARE/PROD1/core/", region: "us-east-2" },
      { prefix: "/CP/WELLCARE/PROD1/cas", region: "us-east-2" },
      { prefix: "/CP/WELLCARE/PROD1PEER/portal", region: "us-west-1" },
      { prefix: "/CP/WELLCARE/PROD1/knowage/", region: "us-east-2" },
    ]);
    expect(describeCalls).not.toContainEqual(expect.objectContaining({ prefix: "/CP/WELLCARE/PROD1" }));
    expect(describeCalls).not.toContainEqual(expect.objectContaining({ prefix: "/CP/WELLCARE/PROD1/spagobi/" }));
    expect(searchedGroups).toEqual(expect.arrayContaining([
      { group: "/CP/WELLCARE/PROD1/batch/fax-intake-service", region: "us-east-2" },
      { group: "/CP/WELLCARE/PROD1/core/core-app", region: "us-east-2" },
      { group: "/CP/WELLCARE/PROD1/cas", region: "us-east-2" },
      { group: "/CP/WELLCARE/PROD1PEER/portal", region: "us-west-1" },
      { group: "/CP/WELLCARE/PROD1/knowage/server", region: "us-east-2" },
      { group: "/CP/WELLCARE/PROD1/ws", region: "us-west-1" },
    ]));
    expect(result.evidence[0]?.metadata).toMatchObject({
      configuredScopesUsed: true,
      selectedGroupRegions: {
        "/CP/WELLCARE/PROD1/ws": "us-west-1",
        "/CP/WELLCARE/PROD1/batch/fax-intake-service": "us-east-2",
        "/CP/WELLCARE/PROD1/core/core-app": "us-east-2",
        "/CP/WELLCARE/PROD1/cas": "us-east-2",
        "/CP/WELLCARE/PROD1PEER/portal": "us-west-1",
        "/CP/WELLCARE/PROD1/knowage/server": "us-east-2",
      },
    });
    expect(result.evidence[0]?.metadata?.traceSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Select bounded CloudWatch log groups",
        detail: expect.stringContaining("configured CloudWatch scope(s)"),
      }),
    ]));
  });
});

describe("DashboardSsmFileLogInspectionAdapter", () => {
  it("reads bounded SSM file-log output and redacts runtime samples", async () => {
    const sentCommands: string[][] = [];
    const hostRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "wellcare-prod-login",
        clientId: "WELLCARE",
        environment: "PROD_REPLICA" as const,
        envId: "PROD1",
        awsAccountId: "239350186085",
        region: "us-east-2",
        awsProfile: "prod",
        instanceId: "i-1234567890abcdef0",
        instanceName: "WELLCARE PROD LOGIN",
        vpcId: "vpc-redacted",
        subnetId: "subnet-redacted",
        networkPath: "ssm" as const,
        instanceProfileArn: "arn:aws:iam::239350186085:instance-profile/WELLCARE",
        expectedRoleName: "WELLCARE",
        ssmAllowed: true,
        logRoots: ["/medhok/logs"],
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(),
      runJson: vi.fn(async (args: string[]) => {
        sentCommands.push(args);
        if (args.includes("send-command")) {
          return { Command: { CommandId: "cmd-1" } };
        }
        if (args.includes("get-command-invocation")) {
          return {
            Status: "Success",
            StandardOutputContent: [
              "###FILE:/medhok/logs/fax-intake-service/api_fax_intake/file.log.2026-06-08.log.zip",
              "FaxComRestServiceClient :: Fax move failed with status: 500, body: Unexpected error occurred for member=1234567890.",
            ].join("\n"),
            StandardErrorContent: "",
          };
        }
        throw new Error(`Unexpected AWS args ${args.join(" ")}`);
      }),
    };

    const adapter = new DashboardSsmFileLogInspectionAdapter(hostRegistry, () => runner);
    const request: InvestigationAdapterRequest = {
      runId: "inv-ssm-file-test",
      jiraKey: "CPCLIENT-55570",
      adapter: "host",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["fax-intake-service"],
        keywords: ["FaxCom", "FaxComRestServiceClient", "HTTP 500", "Unexpected error"],
        repoNames: ["batch-jobs"],
        codeVersion: "3.19",
        timeWindow: {
          startTs: "2026-06-08T00:00:00.000Z",
          endTs: "2026-06-09T00:00:00.000Z",
        },
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
        maxArtifacts: 20,
      },
    };

    const result = await adapter.execute(request);

    expect(sentCommands[0]).toEqual(expect.arrayContaining(["ssm", "send-command", "--document-name", "AWS-RunShellScript"]));
    expect(sentCommands[0]?.join(" ")).toContain("2026-06-08");
    expect(sentCommands[0]?.join(" ")).toContain("/medhok/logs");
    expect(result.findings[0]).toMatchObject({
      adapter: "host",
      type: "ssm_file_log_evidence",
      title: "SSM file logs found HTTP 500 runtime failures",
      severity: "high",
      requiresCodeChange: true,
    });
    expect(result.evidence[0]).toMatchObject({
      adapter: "host",
      title: "SSM file-log runtime search",
      metadata: expect.objectContaining({
        commandId: "cmd-1",
        redactedSamples: [
          expect.objectContaining({
            location: "/medhok/logs/fax-intake-service/api_fax_intake/file.log.2026-06-08.log.zip",
            message: expect.stringContaining("member=[REDACTED]"),
          }),
        ],
      }),
    });
  });

  it("redacts SSM SendCommand access-denied details", async () => {
    const hostRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "wellcare-prod-login",
        clientId: "WELLCARE",
        environment: "PROD_REPLICA" as const,
        envId: "PROD1",
        awsAccountId: "239350186085",
        region: "us-east-2",
        awsProfile: "prod",
        instanceId: "i-1234567890abcdef0",
        instanceName: "WELLCARE PROD LOGIN",
        vpcId: "vpc-redacted",
        subnetId: "subnet-redacted",
        networkPath: "ssm" as const,
        instanceProfileArn: "arn:aws:iam::239350186085:instance-profile/WELLCARE",
        expectedRoleName: "WELLCARE",
        ssmAllowed: true,
        logRoots: ["/medhok/logs"],
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(),
      runJson: vi.fn(async () => {
        throw new Error("Command failed: aws --profile prod ssm send-command --parameters {\"commands\":[\"cat /medhok/logs/file.log\"]}\n\nAn error occurred (AccessDeniedException) when calling the SendCommand operation: User: arn:aws:sts::000000000000:assumed-role/example/operator@example.com is not authorized to perform: ssm:SendCommand");
      }),
    };

    const adapter = new DashboardSsmFileLogInspectionAdapter(hostRegistry, () => runner);
    const result = await adapter.execute({
      runId: "inv-ssm-denied-test",
      jiraKey: "CPCLIENT-55570",
      adapter: "host",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["fax-intake-service"],
        keywords: ["FaxCom", "HTTP 500"],
        timeWindow: {
          startTs: "2026-06-08T00:00:00.000Z",
          endTs: "2026-06-09T00:00:00.000Z",
        },
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
      },
    });

    expect(result.findings[0]).toMatchObject({
      type: "ssm_file_log_unavailable",
      summary: expect.stringContaining("not authorized for ssm:SendCommand"),
    });
    expect(result.findings[0]?.summary).not.toContain("operator@example.com");
    expect(result.findings[0]?.summary).not.toContain("cat /medhok/logs");
    expect(result.evidence[0]?.summary).not.toContain("assumed-role");
  });
});

describe("DashboardSshConfigInspectionAdapter", () => {
  function sshHostTarget() {
    return {
      id: "wellcare-prod-login",
      clientId: "WELLCARE",
      environment: "PROD_REPLICA" as const,
      envId: "PROD1",
      awsAccountId: "239350186085",
      region: "us-east-2",
      awsProfile: "prod",
      instanceId: "i-1234567890abcdef0",
      instanceName: "WELLCARE PROD LOGIN",
      vpcId: "vpc-redacted",
      subnetId: "subnet-redacted",
      networkPath: "ssh_public" as const,
      publicHost: "198.51.100.10",
      sshPort: 22,
      sshUser: "operator.ldap",
      sshAuthMode: "operator_ldap" as const,
      sshAllowed: true,
      configProbePaths: ["/opt/software/medhok", "/medhok"],
      configProbeMaxMatches: 8,
      instanceProfileArn: "arn:aws:iam::239350186085:instance-profile/WELLCARE",
      expectedRoleName: "WELLCARE",
      ssmAllowed: false,
      enabled: true,
    };
  }

  it("lets operator LDAP env override target-file SSH user and control path", () => {
    const args = buildSshCommandArgs(
      {
        ...sshHostTarget(),
        sshUser: "target.user",
        sshControlPath: "/private/tmp/target.sock",
      },
      "printf probe-ok",
      {
        INVESTIGATION_SSH_USER: "runtime.user",
        INVESTIGATION_SSH_CONTROL_PATH: "/private/tmp/runtime.sock",
      },
    );

    expect(args).toContain("runtime.user@198.51.100.10");
    expect(args).toContain("ControlPath=/private/tmp/runtime.sock");
    expect(args).not.toContain("target.user@198.51.100.10");
    expect(args).not.toContain("ControlPath=/private/tmp/target.sock");
  });

  it("keeps target-file SSH identity before env fallback for non-LDAP targets", () => {
    const args = buildSshCommandArgs(
      {
        ...sshHostTarget(),
        sshAuthMode: "ssh_agent" as const,
        sshUser: "target.user",
        sshControlPath: "/private/tmp/target.sock",
      },
      "printf probe-ok",
      {
        INVESTIGATION_SSH_USER: "runtime.user",
        INVESTIGATION_SSH_CONTROL_PATH: "/private/tmp/runtime.sock",
      },
    );

    expect(args).toContain("target.user@198.51.100.10");
    expect(args).toContain("ControlPath=/private/tmp/target.sock");
    expect(args).not.toContain("runtime.user@198.51.100.10");
    expect(args).not.toContain("ControlPath=/private/tmp/runtime.sock");
  });

  it("uses LDAP SSH target settings to collect redacted deployed jar/properties evidence", async () => {
    const hostRegistry = {
      resolveTarget: vi.fn(async () => sshHostTarget()),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => [
        "###MATCHED_FILE:/opt/software/medhok/claims-loader/ClaimsLoader-medhok-4.2.jar",
        "###MATCHED_FILE:/opt/software/medhok/claims-loader/claims_main.properties",
        "###MATCHED_FILE:/opt/software/medhok/claims-loader/run_claims_loader.sh",
        "###FILE:/opt/software/medhok/claims-loader/ClaimsLoader-medhok-4.2.jar",
        "path=/opt/software/medhok/claims-loader/ClaimsLoader-medhok-4.2.jar",
        "jar.manifest=Implementation-Version: 4.2",
        "jar.entry=com/medhok/claims/ClaimsDownloadHandler.class",
        "###FILE:/opt/software/medhok/claims-loader/run_claims_loader.sh",
        "launch.command=java -jar ClaimsLoader-medhok-4.2.jar -ExcludeInactive=\"Y\"",
        "###FILE:/opt/software/medhok/claims-loader/claims_main.properties",
        "claims.baseUrl=https://claims.example.test/api",
        "claims.password=super-secret-value",
        "claims.pageSize=20000",
        "property.key=claims.pageSize=present",
      ].join("\n")),
    };

    const adapter = new DashboardSshConfigInspectionAdapter(hostRegistry, runner);
    const result = await adapter.execute({
      runId: "inv-ssh-config-test",
      jiraKey: "CPCLIENT-55570",
      adapter: "host",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["claims-loader"],
        keywords: ["ClaimsApi", "pageSize", "HTTP 500", "client-cp-prod-prod1-jar_runner-legacy_watcher.yaml"],
        repoNames: ["batch-jobs"],
        codeVersion: "4.2",
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
        maxArtifacts: 20,
      },
    });

    expect(runner.runText).toHaveBeenCalledWith(
      expect.objectContaining({
        publicHost: "198.51.100.10",
        sshUser: "operator.ldap",
        sshAuthMode: "operator_ldap",
      }),
      expect.stringContaining("*.jar"),
      expect.any(Object),
    );
    expect(runner.runText).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining("jar.entry="),
      expect.any(Object),
    );
    expect(runner.runText).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining("score_candidates"),
      expect.any(Object),
    );
    expect(runner.runText).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining("VERSION_PATTERN"),
      expect.any(Object),
    );
    expect(runner.runText).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining("###MATCHED_FILE"),
      expect.any(Object),
    );
    expect(runner.runText.mock.calls[0]?.[1]).toContain("claims-loader-file");
    expect(runner.runText.mock.calls[0]?.[1]).not.toContain("legacy-watcher");
    expect(runner.runText.mock.calls[0]?.[1]).not.toContain("legacy_watcher.yaml");
    expect(runner.runText.mock.calls[0]?.[1]).not.toContain("/opt/software/medhok/batch-jobs");
    expect(runner.runText.mock.calls[0]?.[1]).not.toContain("/opt/software/medhok/batch_jobs");
    expect(result.findings[0]).toMatchObject({
      adapter: "host",
      type: "ssh_config_evidence",
      title: "LDAP SSH deployed jar/properties probe found candidates",
      requiresCodeChange: true,
    });
    expect(result.evidence[0]).toMatchObject({
      adapter: "host",
      title: "LDAP SSH deployed jar/properties probe",
      metadata: expect.objectContaining({
        sshAuthMode: "operator_ldap",
        matchedFiles: [
          "/opt/software/medhok/claims-loader/ClaimsLoader-medhok-4.2.jar",
          "/opt/software/medhok/claims-loader/claims_main.properties",
          "/opt/software/medhok/claims-loader/run_claims_loader.sh",
        ],
        launchCommands: [
          {
            location: "/opt/software/medhok/claims-loader/run_claims_loader.sh",
            command: "java -jar ClaimsLoader-medhok-4.2.jar -ExcludeInactive=\"Y\"",
          },
        ],
        jarManifestVersions: [
          {
            location: "/opt/software/medhok/claims-loader/ClaimsLoader-medhok-4.2.jar",
            manifest: "Implementation-Version: 4.2",
          },
        ],
        exactDirectories: expect.arrayContaining([
          "/opt/software/medhok/claims-loader",
        ]),
        redactedSamples: expect.arrayContaining([
          expect.objectContaining({
            message: "jar.manifest=Implementation-Version: 4.2",
          }),
          expect.objectContaining({
            message: "jar.entry=com/medhok/claims/ClaimsDownloadHandler.class",
          }),
          expect.objectContaining({
            message: "claims.baseUrl=[REDACTED]",
          }),
          expect.objectContaining({
            message: "claims.password=[REDACTED]",
          }),
          expect.objectContaining({
            message: "claims.pageSize=20000",
          }),
        ]),
      }),
    });
  });

  it("keeps ticket-derived component directories ahead of verbose code evidence terms", async () => {
    const hostRegistry = {
      resolveTarget: vi.fn(async () => ({
        ...sshHostTarget(),
        id: "acme-prod-login",
        clientId: "ACME",
        environment: "PROD" as const,
        envId: "PROD1",
        instanceName: "ACME PROD Login",
        publicHost: "198.51.100.11",
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => ""),
    };

    const adapter = new DashboardSshConfigInspectionAdapter(hostRegistry, runner);
    await adapter.execute({
      runId: "inv-ssh-config-component-rank-test",
      jiraKey: "SUPPORT-55571",
      adapter: "host",
      scope: {
        clientId: "ACME",
        environment: "PROD",
        serviceIds: ["QA Assessment Extract"],
        keywords: ["CR Enhance QA Assessment Extract", "assessment extract correction"],
        diagnosticContext: {
          codeEvidenceTerms: [
            "InsertAssessmentReportingAudit_Job",
            "Insert_Assessment_Reporting_Audit_Job",
            "insert-assessment-reporting-audit-job",
            "cp-medhok-data-extract-monorepo/AssesmentQAExtract/src/main/java/com/medhok/mm/App.java",
          ],
        },
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
        maxArtifacts: 20,
      },
    });

    const script = String(runner.runText.mock.calls[0]?.[1] || "");
    expect(script).toContain("/opt/software/medhok/AssessmentQA_Extract");
    expect(script).not.toContain("/opt/software/medhok/InsertAssessmentReportingAudit_Job");
  });

  it("reports LDAP SSH control-socket session refusal as an actionable operator setup issue", async () => {
    const hostRegistry = {
      resolveTarget: vi.fn(async () => sshHostTarget()),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(async () => {
        throw new Error("Command failed: ssh\nmux_client_request_session: session request failed: Session open refused by peer\nPermission denied (publickey,password).");
      }),
    };

    const adapter = new DashboardSshConfigInspectionAdapter(hostRegistry, runner);
    const result = await adapter.execute({
      runId: "inv-ssh-config-refused-test",
      jiraKey: "CPCLIENT-55570",
      adapter: "host",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["claims-loader"],
        keywords: ["ClaimsApi"],
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
        maxArtifacts: 20,
      },
    });

    expect(result.findings[0]).toMatchObject({
      type: "ssh_config_unavailable",
      summary: expect.stringContaining("control socket is present but refused a command session"),
    });
    expect(result.evidence[0]?.summary).toContain("dedicated no-session LDAP SSH control master");
  });
});

describe("DashboardS3ArchivedLogInspectionAdapter", () => {
  it("reads bounded gzip archived logs from S3 and redacts runtime samples", async () => {
    const s3Commands: string[][] = [];
    const hostRegistry = {
      resolveTarget: vi.fn(async () => ({
        id: "wellcare-prod-login",
        clientId: "WELLCARE",
        environment: "PROD_REPLICA" as const,
        envId: "PROD1",
        awsAccountId: "239350186085",
        region: "us-east-2",
        awsProfile: "prod",
        instanceId: "i-1234567890abcdef0",
        instanceName: "WELLCARE PROD LOGIN",
        vpcId: "vpc-redacted",
        subnetId: "subnet-redacted",
        networkPath: "ssm" as const,
        instanceProfileArn: "arn:aws:iam::239350186085:instance-profile/WELLCARE",
        expectedRoleName: "WELLCARE",
        ssmAllowed: true,
        logRoots: ["/medhok/logs"],
        s3LogArchives: [{
          bucket: "example-runtime-log-archive",
          prefixTemplate: "{clientId}/{envId}/{date}/",
          region: "us-east-2",
        }],
        enabled: true,
      })),
      listTargets: vi.fn(async () => []),
    };
    const runner = {
      runText: vi.fn(),
      runBuffer: vi.fn(),
      runJson: vi.fn(async (args: string[]) => {
        s3Commands.push(args);
        return {
          Contents: [{
            Key: "WELLCARE/PROD1/2026-06-08/fax-intake-service/file.log.2026-06-08.gz",
            Size: 1024,
          }],
        };
      }),
    };
    runner.runBuffer.mockResolvedValue(gzipSync([
      "unrelated line",
      "FaxComRestServiceClient :: image download failed with HTTP RESPONSE STATUS CODE : 500 for member=1234567890",
    ].join("\n")));

    const adapter = new DashboardS3ArchivedLogInspectionAdapter(hostRegistry, () => runner);
    const request: InvestigationAdapterRequest = {
      runId: "inv-s3-archive-test",
      jiraKey: "CPCLIENT-55570",
      adapter: "host",
      scope: {
        clientId: "WELLCARE",
        environment: "PROD_REPLICA",
        serviceIds: ["fax-intake-service"],
        keywords: ["FaxCom", "FaxComRestServiceClient", "HTTP 500", "image download"],
        repoNames: ["batch-jobs"],
        codeVersion: "3.19",
        timeWindow: {
          startTs: "2026-06-08T00:00:00.000Z",
          endTs: "2026-06-09T00:00:00.000Z",
        },
      },
      constraints: {
        timeoutMs: 60_000,
        redactionRequired: true,
        maxArtifacts: 20,
      },
    };

    const result = await adapter.execute(request);

    expect(s3Commands[0]).toEqual(expect.arrayContaining(["s3api", "list-objects-v2"]));
    expect(s3Commands[0]?.join(" ")).toContain("WELLCARE/PROD1/2026-06-08/");
    expect(runner.runBuffer).toHaveBeenCalledWith(expect.arrayContaining([
      "s3",
      "cp",
      "s3://example-runtime-log-archive/WELLCARE/PROD1/2026-06-08/fax-intake-service/file.log.2026-06-08.gz",
    ]), expect.any(Object));
    expect(result.findings[0]).toMatchObject({
      adapter: "host",
      type: "s3_archive_log_evidence",
      title: "S3 archived logs found HTTP 500 runtime failures",
      severity: "high",
      requiresCodeChange: true,
    });
    expect(result.evidence[0]).toMatchObject({
      adapter: "host",
      title: "S3 archived runtime-log search",
      metadata: expect.objectContaining({
        redactedSamples: [
          expect.objectContaining({
            location: "s3://example-runtime-log-archive/WELLCARE/PROD1/2026-06-08/fax-intake-service/file.log.2026-06-08.gz",
            message: expect.stringContaining("member=[REDACTED]"),
          }),
        ],
      }),
    });
  });
});
