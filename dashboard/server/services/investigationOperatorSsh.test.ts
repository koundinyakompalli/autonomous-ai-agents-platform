import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureOperatorSshControlMaster,
  type EnsureOperatorSshControlMasterOptions,
} from "./investigationOperatorSsh.js";
import type { InvestigationHostTarget } from "../../../src/investigation/index.js";

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

function target(controlPath: string): InvestigationHostTarget {
  return {
    id: "inferred-cigna-prod-replica",
    clientId: "CIGNA",
    environment: "PROD_REPLICA",
    envId: "PROD1",
    awsAccountId: "123456789012",
    region: "us-east-2",
    instanceId: "i-secondary",
    instanceName: "CIGNA PROD DB SECONDARY",
    vpcId: "vpc-1",
    subnetId: "subnet-1",
    networkPath: "ssh_public",
    instanceProfileArn: "",
    expectedRoleName: "",
    publicHost: "ec2-203-0-113-10.compute-1.amazonaws.com",
    sshPort: 22,
    sshUser: "operator",
    sshAuthMode: "operator_ldap",
    sshControlPath: controlPath,
    sshAllowed: true,
    ssmAllowed: false,
    enabled: true,
  };
}

describe("ensureOperatorSshControlMaster", () => {
  it("reuses an active ControlMaster without touching sshpass", async () => {
    const execFileAsync = vi.fn(async () => ({ stdout: "Master running", stderr: "" }));

    const result = await ensureOperatorSshControlMaster({
      hostTarget: target("/tmp/cockpit-active.sock"),
      operatorSshPassword: "secret-password",
      jiraKey: "CPSUP-52676",
      clientId: "CIGNA",
      environment: "PROD-REPLICA",
    }, {
      execFileAsync,
      env: { USER: "operator" } as NodeJS.ProcessEnv,
    });

    expect(result.status).toBe("active");
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(execFileAsync.mock.calls[0][0]).toBe("ssh");
  });

  it("opens a ControlMaster with sshpass and deletes the temp password file", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cockpit-operator-ssh-test-"));
    const controlPath = path.join(tempDir, "ctrl.sock");
    let checkCount = 0;
    let passwordFileFromCommand = "";
    const execFileAsync: EnsureOperatorSshControlMasterOptions["execFileAsync"] = vi.fn(async (file, args) => {
      if (file === "ssh" && args.includes("-O") && args.includes("check")) {
        checkCount += 1;
        if (checkCount === 1) {
          throw new Error("No such file or directory");
        }
        return { stdout: "Master running", stderr: "" };
      }
      if (file === "/approved/sshpass") {
        passwordFileFromCommand = args[1];
        expect(args.join(" ")).not.toContain("secret-password");
        writeFileSync(controlPath, "socket", { mode: 0o600 });
        return { stdout: "", stderr: "" };
      }
      if (file === "ssh" && args.some((arg) => arg.includes("logger -t COCKPIT-MERIDIAN"))) {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    try {
      const result = await ensureOperatorSshControlMaster({
        hostTarget: target(controlPath),
        operatorSshPassword: "secret-password",
        jiraKey: "CPSUP-52676",
        clientId: "CIGNA",
        environment: "PROD-REPLICA",
        operatorDisplay: "Local Developer",
      }, {
        execFileAsync,
        env: {
          USER: "operator",
          INVESTIGATION_SSHPASS_BIN: "/approved/sshpass",
        } as NodeJS.ProcessEnv,
      });

      expect(result.status).toBe("opened");
      expect(passwordFileFromCommand).toContain("password-");
      expect(execFileAsync).toHaveBeenCalledWith(
        "/approved/sshpass",
        expect.arrayContaining(["-f", passwordFileFromCommand, "ssh", "-M", "-S", controlPath]),
        expect.any(Object),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports password_required when no socket or password is available", async () => {
    const execFileAsync = vi.fn(async () => {
      throw new Error("No such file or directory");
    });

    const result = await ensureOperatorSshControlMaster({
      hostTarget: target("/tmp/cockpit-missing.sock"),
      jiraKey: "CPSUP-52676",
      clientId: "CIGNA",
      environment: "PROD-REPLICA",
    }, {
      execFileAsync,
      env: { USER: "operator" } as NodeJS.ProcessEnv,
    });

    expect(result.status).toBe("password_required");
  });
});
