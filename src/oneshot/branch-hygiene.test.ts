import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanGeneratedBranchChanges,
  isBlockedGeneratedPath,
} from "./branch-hygiene.js";
import { getCurrentHeadSha, listChangedFiles } from "./git.js";

const tempRepos: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

async function writeFile(repoPath: string, relativePath: string, body: string) {
  const absolutePath = path.join(repoPath, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, body, "utf8");
}

async function fileExists(repoPath: string, relativePath: string) {
  try {
    await fs.stat(path.join(repoPath, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function createRepo(): Promise<string> {
  const repoPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "oneshot-branch-hygiene-"),
  );
  tempRepos.push(repoPath);
  runGit(repoPath, ["init", "-q"]);
  runGit(repoPath, ["config", "user.name", "OneShot Branch Hygiene Test"]);
  runGit(repoPath, ["config", "user.email", "oneshot@example.com"]);
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    tempRepos
      .splice(0)
      .map((repoPath) => fs.rm(repoPath, { recursive: true, force: true })),
  );
});

describe("isBlockedGeneratedPath", () => {
  it("blocks generated/cache paths but preserves root Maven settings", () => {
    expect(isBlockedGeneratedPath(".m2/repository/com/acme/lib.jar")).toBe(
      true,
    );
    expect(
      isBlockedGeneratedPath(
        "medhok-ocr-manager/.m2/repository/io/netty/netty-common.jar",
      ),
    ).toBe(true);
    expect(isBlockedGeneratedPath("service/target/classes/App.class")).toBe(
      true,
    );
    expect(isBlockedGeneratedPath("ui/node_modules/react/index.js")).toBe(true);
    expect(isBlockedGeneratedPath(".m2/settings.xml")).toBe(false);
    expect(isBlockedGeneratedPath("medhok-ocr-manager/.m2/settings.xml")).toBe(
      false,
    );
    expect(isBlockedGeneratedPath("src/main/java/App.java")).toBe(false);
  });
});

describe("cleanGeneratedBranchChanges", () => {
  it("removes new generated files, restores tracked generated files, and leaves valid source changes", async () => {
    const repoPath = await createRepo();

    await writeFile(repoPath, "src/App.java", "class App {}\n");
    await writeFile(repoPath, ".m2/settings.xml", "<settings />\n");
    await writeFile(repoPath, "service/target/generated.txt", "baseline\n");
    runGit(repoPath, ["add", "."]);
    runGit(repoPath, ["commit", "-qm", "base"]);
    const baseSha = await getCurrentHeadSha(repoPath);

    await writeFile(repoPath, "src/App.java", "class App { int value; }\n");
    await writeFile(repoPath, "service/target/generated.txt", "polluted\n");
    await writeFile(
      repoPath,
      ".m2/repository/com/acme/private-lib.jar",
      "binary-ish\n",
    );
    runGit(repoPath, ["add", "."]);
    runGit(repoPath, ["commit", "-qm", "provider output"]);
    const providerSha = await getCurrentHeadSha(repoPath);

    const summary = await cleanGeneratedBranchChanges({
      workspacePath: repoPath,
      baseRef: baseSha,
      currentHead: providerSha,
    });

    expect(summary.removedFiles).toEqual([
      ".m2/repository/com/acme/private-lib.jar",
    ]);
    expect(summary.preservedFiles).toEqual(["service/target/generated.txt"]);
    expect(summary.blockedFiles).toEqual([]);
    await expect(
      fs.readFile(path.join(repoPath, "service/target/generated.txt"), "utf8"),
    ).resolves.toBe("baseline\n");
    await expect(
      fs.readFile(path.join(repoPath, ".m2/settings.xml"), "utf8"),
    ).resolves.toBe("<settings />\n");
    await expect(
      fileExists(repoPath, ".m2/repository/com/acme/private-lib.jar"),
    ).resolves.toBe(false);

    runGit(repoPath, ["add", "-A"]);
    runGit(repoPath, ["commit", "-qm", "clean candidate"]);
    await expect(listChangedFiles(repoPath, baseSha, "HEAD")).resolves.toEqual([
      "src/App.java",
    ]);
  });

  it("removes nested Maven repository output from module-local builds", async () => {
    const repoPath = await createRepo();

    await writeFile(
      repoPath,
      "medhok-ocr-manager/src/App.java",
      "class App {}\n",
    );
    await writeFile(
      repoPath,
      "medhok-ocr-manager/.m2/settings.xml",
      "<settings />\n",
    );
    runGit(repoPath, ["add", "."]);
    runGit(repoPath, ["commit", "-qm", "base"]);
    const baseSha = await getCurrentHeadSha(repoPath);

    await writeFile(
      repoPath,
      "medhok-ocr-manager/src/App.java",
      "class App { int value; }\n",
    );
    await writeFile(
      repoPath,
      "medhok-ocr-manager/.m2/repository/io/netty/netty-common.jar",
      "binary-ish\n",
    );
    runGit(repoPath, ["add", "."]);
    runGit(repoPath, ["commit", "-qm", "provider output"]);
    const providerSha = await getCurrentHeadSha(repoPath);

    const summary = await cleanGeneratedBranchChanges({
      workspacePath: repoPath,
      baseRef: baseSha,
      currentHead: providerSha,
    });

    expect(summary.removedFiles).toEqual([
      "medhok-ocr-manager/.m2/repository/io/netty/netty-common.jar",
    ]);
    expect(summary.preservedFiles).toEqual([]);
    expect(summary.blockedFiles).toEqual([]);
    await expect(
      fs.readFile(
        path.join(repoPath, "medhok-ocr-manager/.m2/settings.xml"),
        "utf8",
      ),
    ).resolves.toBe("<settings />\n");
    await expect(
      fileExists(
        repoPath,
        "medhok-ocr-manager/.m2/repository/io/netty/netty-common.jar",
      ),
    ).resolves.toBe(false);

    runGit(repoPath, ["add", "-A"]);
    runGit(repoPath, ["commit", "-qm", "clean candidate"]);
    await expect(listChangedFiles(repoPath, baseSha, "HEAD")).resolves.toEqual([
      "medhok-ocr-manager/src/App.java",
    ]);
  });
});
