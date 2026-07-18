import { afterEach, describe, expect, it, vi } from "vitest";
import net from "net";
import { EventEmitter } from "events";
import {
  buildMeridianLdapSshTunnelArgs,
  MERIDIANWorker,
  resolveMeridianDbCredentialsFromEnv,
  type MeridianTarget,
} from "./MERIDIANWorker.js";

const baseTarget: MeridianTarget = {
  id: "wellcare-prod-slave",
  clients: ["Wellcare"],
  environments: ["PROD"],
  networkPath: "ssh_public",
  remoteHost: "wellcare-prod-slave.internal",
  remotePort: 3306,
  publicHost: "wellcare-prod-login.example.com",
  sshUser: "operator.ldap",
  sshAuthMode: "operator_ldap",
  sshAllowed: true,
  ssmAllowed: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("MERIDIAN LDAP SSH DB tunnel", () => {
  it("builds an operator LDAP SSH local port forward to the target database", () => {
    const args = buildMeridianLdapSshTunnelArgs(baseTarget, 15432, {
      MERIDIAN_SSH_CONTROL_PATH: "/tmp/meridian-ldap.sock",
    } as NodeJS.ProcessEnv);

    expect(args).toEqual([
      "-N",
      "-L",
      "127.0.0.1:15432:wellcare-prod-slave.internal:3306",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=1",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPath=/tmp/meridian-ldap.sock",
      "-o",
      "ControlPersist=5m",
      "operator.ldap@wellcare-prod-login.example.com",
    ]);
  });

  it("lets operator env override the target ssh user and port", () => {
    const args = buildMeridianLdapSshTunnelArgs(
      { ...baseTarget, sshUser: "configured.user", sshPort: 22 },
      15432,
      {
        MERIDIAN_SSH_USER: "env.operator",
        MERIDIAN_SSH_PORT: "2022",
      } as NodeJS.ProcessEnv,
    );

    expect(args).toContain("-p");
    expect(args).toContain("2022");
    expect(args.at(-1)).toBe("env.operator@wellcare-prod-login.example.com");
  });

  it("rejects SSM network paths for Meridian DB access", () => {
    expect(() =>
      buildMeridianLdapSshTunnelArgs(
        { ...baseTarget, networkPath: "ssm", ssmAllowed: false },
        15432,
      ),
    ).toThrow(/SSM is disabled for MERIDIAN/);
  });

  it("rejects targets that still allow SSM", () => {
    expect(() =>
      buildMeridianLdapSshTunnelArgs(
        { ...baseTarget, ssmAllowed: true },
        15432,
      ),
    ).toThrow(/ssmAllowed=true/);
  });

  it("accepts a successful ControlMaster mux exit when the forwarded DB port is ready", async () => {
    const worker = new MERIDIANWorker(process.cwd(), false);
    const workerInternals = worker as unknown as {
      waitForPort: (port: number, timeoutMs: number, label?: string) => Promise<void>;
      waitForLdapSshStartup: (
        target: MeridianTarget,
        localPort: number,
        child: Pick<EventEmitter, "once">,
        stderrTail: string[],
      ) => Promise<void>;
    };
    const waitForPort = vi.spyOn(workerInternals, "waitForPort").mockResolvedValue(undefined);
    const child = new EventEmitter();

    const startup = workerInternals.waitForLdapSshStartup(baseTarget, 15432, child, []);
    child.emit("exit", 0);

    await expect(startup).resolves.toBeUndefined();
    expect(waitForPort).toHaveBeenCalledWith(
      15432,
      5000,
      "muxed LDAP SSH local DB tunnel port",
    );
  });

  it("fails a successful ControlMaster mux exit when the forwarded DB port is not ready", async () => {
    const worker = new MERIDIANWorker(process.cwd(), false);
    const workerInternals = worker as unknown as {
      waitForPort: (port: number, timeoutMs: number, label?: string) => Promise<void>;
      waitForLdapSshStartup: (
        target: MeridianTarget,
        localPort: number,
        child: Pick<EventEmitter, "once">,
        stderrTail: string[],
      ) => Promise<void>;
    };
    vi.spyOn(workerInternals, "waitForPort").mockRejectedValue(
      new Error("Timed out waiting for test port"),
    );
    const child = new EventEmitter();

    const startup = workerInternals.waitForLdapSshStartup(baseTarget, 15432, child, []);
    child.emit("exit", 0);

    await expect(startup).rejects.toThrow(/successful mux client exit/);
  });

  it("uses a loopback direct-local DB endpoint without opening LDAP SSH", async () => {
    const server = net.createServer();
    server.on("connection", (socket) => socket.end());
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("test server did not receive a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
    const worker = new MERIDIANWorker(process.cwd(), false);
    try {
      const endpoint = await (worker as unknown as {
        prepareDbEndpoint: (
          target: MeridianTarget,
        ) => Promise<{ host: string; port: number; accessPath: string; tunnel?: unknown }>;
      }).prepareDbEndpoint({
        ...baseTarget,
        networkPath: "direct_local",
        remoteHost: "127.0.0.1",
        remotePort: port,
        publicHost: undefined,
        sshAllowed: false,
      });

      expect(endpoint).toEqual({
        host: "127.0.0.1",
        port,
        accessPath: "direct_local",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses an approved private-network DB endpoint without opening LDAP SSH", async () => {
    const server = net.createServer();
    server.on("connection", (socket) => socket.end());
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("test server did not receive a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
    const worker = new MERIDIANWorker(process.cwd(), false);
    try {
      const endpoint = await (worker as unknown as {
        prepareDbEndpoint: (
          target: MeridianTarget,
        ) => Promise<{ host: string; port: number; accessPath: string; tunnel?: unknown }>;
      }).prepareDbEndpoint({
        ...baseTarget,
        networkPath: "private_vpc",
        remoteHost: "127.0.0.1",
        remotePort: port,
        publicHost: undefined,
        sshAllowed: false,
      });

      expect(endpoint).toEqual({
        host: "127.0.0.1",
        port,
        accessPath: "direct_network",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports unreachable loopback direct-local DB endpoints clearly", async () => {
    const server = net.createServer();
    server.on("connection", (socket) => socket.end());
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("test server did not receive a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const worker = new MERIDIANWorker(process.cwd(), false);

    await expect((worker as unknown as {
      prepareDbEndpoint: (target: MeridianTarget) => Promise<unknown>;
    }).prepareDbEndpoint({
      ...baseTarget,
      networkPath: "direct_local",
      remoteHost: "127.0.0.1",
      remotePort: port,
      publicHost: undefined,
      sshAllowed: false,
    })).rejects.toThrow(/direct local DB endpoint is not reachable/);
  });

  it("rejects direct-local DB endpoints that are not loopback", async () => {
    const worker = new MERIDIANWorker(process.cwd(), false);

    await expect((worker as unknown as {
      prepareDbEndpoint: (target: MeridianTarget) => Promise<unknown>;
    }).prepareDbEndpoint({
      ...baseTarget,
      networkPath: "direct_local",
      remoteHost: "cigna-prod-db.internal",
      publicHost: undefined,
      sshAllowed: false,
    })).rejects.toThrow(/direct-local DB access is only allowed for loopback hosts/);
  });

  it("reuses Cockpit DB env credentials when Meridian-specific DB env is not set", () => {
    const credentials = resolveMeridianDbCredentialsFromEnv(baseTarget, {
      INVESTIGATION_DB_USERNAME: "cockpit.ldap",
      INVESTIGATION_DB_PASSWORD: "cockpit-secret",
      INVESTIGATION_DB_DATABASE: "medhok_prod",
    } as NodeJS.ProcessEnv);

    expect(credentials).toEqual({
      username: "cockpit.ldap",
      password: "cockpit-secret",
      database: "medhok_prod",
    });
  });

  it("uses Cockpit DB env credentials in operator mode when Meridian DB aliases are not set", async () => {
    vi.stubEnv("MERIDIAN_REQUIRE_OPERATOR_DB_CREDENTIALS", "true");
    vi.stubEnv("MERIDIAN_DB_USERNAME", "");
    vi.stubEnv("MERIDIAN_DB_PASSWORD", "");
    vi.stubEnv("MERIDIAN_DB_DATABASE", "");
    vi.stubEnv("INVESTIGATION_DB_USERNAME", "cockpit.ldap");
    vi.stubEnv("INVESTIGATION_DB_PASSWORD", "cockpit-secret");
    vi.stubEnv("INVESTIGATION_DB_DATABASE", "medhok_prod");

    const worker = new MERIDIANWorker(process.cwd(), false);
    const credentials = await (worker as unknown as {
      resolveDbCredentials: (
        target: MeridianTarget,
        awsContext: { env: NodeJS.ProcessEnv; profileArgs: string[] },
      ) => Promise<{ username: string; password: string; database: string; operatorRuntime?: boolean }>;
    }).resolveDbCredentials(baseTarget, { env: process.env, profileArgs: [] });

    expect(credentials).toMatchObject({
      username: "cockpit.ldap",
      password: "cockpit-secret",
      database: "medhok_prod",
      operatorRuntime: true,
    });
  });

  it("resolves Cockpit-style target dbUser and secretRef env references", () => {
    const credentials = resolveMeridianDbCredentialsFromEnv(
      {
        ...baseTarget,
        dbUser: "env://INVESTIGATION_DB_USERNAME",
        secretRef: "env://INVESTIGATION_DB_PASSWORD",
        databaseName: "medhok_target",
      },
      {
        INVESTIGATION_DB_USERNAME: "target.ldap",
        INVESTIGATION_DB_PASSWORD: "target-secret",
      } as NodeJS.ProcessEnv,
    );

    expect(credentials).toEqual({
      username: "target.ldap",
      password: "target-secret",
      database: "medhok_target",
    });
  });

  it("can use the Cockpit LDAP SSH user as the DB LDAP username when a password is configured", () => {
    const credentials = resolveMeridianDbCredentialsFromEnv(
      { ...baseTarget, sshUser: undefined },
      {
        INVESTIGATION_SSH_USER: "ssh.ldap",
        INVESTIGATION_DB_PASSWORD: "db-secret",
      } as NodeJS.ProcessEnv,
    );

    expect(credentials.username).toBe("ssh.ldap");
    expect(credentials.password).toBe("db-secret");
    expect(credentials.database).toBe("medhok");
  });
});

describe("MERIDIAN direct Jira fetch", () => {
  it("uses process env Jira credentials when the polling worker has not loaded agent credentials", async () => {
    vi.stubEnv("JIRA_BASE_URL", "https://jira.example.test");
    vi.stubEnv("JIRA_USERNAME", "direct-user@example.test");
    vi.stubEnv("JIRA_TOKEN", "direct-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: "CPSUP-52676", fields: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const worker = new MERIDIANWorker(process.cwd(), false);
    const issue = await (worker as unknown as {
      fetchIssue: (jiraNumber: string) => Promise<{ key: string }>;
    }).fetchIssue("CPSUP-52676");

    expect(issue.key).toBe("CPSUP-52676");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://jira.example.test/rest/api/3/issue/CPSUP-52676"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("direct-user@example.test:direct-token").toString("base64")}`,
        }),
      }),
    );
  });

  it("fails direct Jira fetch clearly when credentials are missing", async () => {
    vi.stubEnv("JIRA_BASE_URL", "https://jira.example.test");
    vi.stubEnv("JIRA_USERNAME", "");
    vi.stubEnv("JIRA_TOKEN", "");

    const worker = new MERIDIANWorker(process.cwd(), false);

    await expect((worker as unknown as {
      fetchIssue: (jiraNumber: string) => Promise<unknown>;
    }).fetchIssue("CPSUP-52676")).rejects.toThrow(
      "JIRA_USERNAME and JIRA_TOKEN are required for MERIDIAN",
    );
  });
});

describe("MERIDIAN Cockpit scope", () => {
  it("uses explicit Cockpit client and environment scope over broad Jira fields", () => {
    vi.stubEnv("MERIDIAN_TARGET_CLIENT_OVERRIDE", "Resolved Client");
    vi.stubEnv("MERIDIAN_TARGET_ENVIRONMENT_OVERRIDE", "PROD_REPLICA");
    vi.stubEnv("MERIDIAN_TARGETS_JSON", JSON.stringify({
      targets: [{
        id: "resolved-client-prod",
        clients: ["Resolved Client"],
        environments: ["PROD_REPLICA"],
        remoteHost: "db.example.test",
      }],
    }));

    const worker = new MERIDIANWorker(process.cwd(), false);
    const target = (worker as unknown as {
      resolveTarget: (issue: {
        key: string;
        names: Record<string, string>;
        fields: Record<string, unknown>;
      }) => MeridianTarget;
    }).resolveTarget({
      key: "SUP-1",
      names: {
        customfield_client: "Client",
        customfield_environment: "Environment",
      },
      fields: {
        customfield_client: "Broad Parent Client",
        customfield_environment: "PROD1",
      },
    });

    expect(target.id).toBe("resolved-client-prod");
  });
});
