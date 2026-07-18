import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildDarciEvidencePack } from "./evidencePack.js";

const tempRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "darci-evidence-"));
  tempRoots.push(root);
  await mkdir(join(root, "core-app", "src", "main", "java", "com", "mhk"), {
    recursive: true,
  });
  await writeFile(
    join(
      root,
      "core-app",
      "src",
      "main",
      "java",
      "com",
      "mhk",
      "AuthService.java",
    ),
    [
      "package com.mhk;",
      "class AuthService {",
      "  void resetPassword() {",
      '    throw new IllegalStateException("password reset token expired");',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

describe("buildDarciEvidencePack", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("extracts ticket terms and includes bounded rg hits from the workspace", async () => {
    const workspace = await makeWorkspace();

    const pack = await buildDarciEvidencePack({
      repositoryPath: workspace,
      defectDescription:
        "Password reset fails in AuthService with IllegalStateException",
      additionalContext: "Users see password reset token expired",
    });

    expect(pack).toContain("## DARCI Deterministic Evidence Pack");
    expect(pack).toContain("AuthService.java");
    expect(pack).toContain("IllegalStateException");
    expect(pack).toContain("Start from the preflight hits");
  });

  it("extracts bounded error signals from stack traces and ticket context", async () => {
    const workspace = await makeWorkspace();

    const pack = await buildDarciEvidencePack({
      repositoryPath: workspace,
      defectDescription: "Checkout fails with NullPointerException",
      additionalContext: [
        "java.lang.NullPointerException: Cannot read field claimId",
        "at com.mhk.claims.ClaimService.load(ClaimService.java:44)",
        "at com.mhk.claims.ClaimController.get(ClaimController.java:18)",
      ].join("\n"),
    });

    expect(pack).toContain("### Error Signals");
    expect(pack).toContain("NullPointerException");
    expect(pack).toContain("ClaimService.java:44");
  });

  it("returns control guidance when no repository path is available", async () => {
    const pack = await buildDarciEvidencePack({
      defectDescription: "NullPointerException in ClaimService",
    });

    expect(pack).toContain("Repository preflight scan unavailable");
    expect(pack).toContain("Stop broad searching");
  });
});
