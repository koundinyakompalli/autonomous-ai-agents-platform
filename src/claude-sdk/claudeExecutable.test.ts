import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_EXECUTABLE_PATH_ENV,
  resolveClaudeExecutable,
  validateClaudeExecutable,
} from "./claudeExecutable.js";

describe("Claude executable resolution", () => {
  it("uses the explicit option before environment and package resolution", () => {
    const result = resolveClaudeExecutable({
      explicitPath: " /explicit/claude ",
      env: {
        [CLAUDE_CODE_EXECUTABLE_PATH_ENV]: "/env/claude",
      },
      resolvePackageBinary: () => "/native/claude",
      platform: "linux",
      arch: "x64",
      libc: "glibc",
    });

    expect(result).toEqual(
      expect.objectContaining({
        path: "/explicit/claude",
        source: "explicit_option",
      }),
    );
  });

  it("uses the environment path before package resolution", () => {
    const result = resolveClaudeExecutable({
      env: {
        [CLAUDE_CODE_EXECUTABLE_PATH_ENV]: " /env/claude ",
      },
      resolvePackageBinary: () => "/native/claude",
      platform: "linux",
      arch: "x64",
      libc: "glibc",
    });

    expect(result).toEqual(
      expect.objectContaining({
        path: "/env/claude",
        source: "environment",
      }),
    );
  });

  it("selects the Linux x64 glibc SDK package without probing musl first", () => {
    const calls: string[] = [];
    const result = resolveClaudeExecutable({
      env: {},
      platform: "linux",
      arch: "x64",
      libc: "glibc",
      resolvePackageBinary: (specifier) => {
        calls.push(specifier);
        if (specifier === "@anthropic-ai/claude-agent-sdk-linux-x64/claude") {
          return "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";
        }
        return undefined;
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        path: "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
        source: "sdk_native_package",
        packageSpecifier: "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
      }),
    );
    expect(calls).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    ]);
    expect(calls.join(" ")).not.toContain("musl");
  });

  it("falls back to the global Claude executable when no native package is available", () => {
    const result = resolveClaudeExecutable({
      env: {},
      platform: "linux",
      arch: "x64",
      libc: "glibc",
      resolvePackageBinary: () => undefined,
      globalFallbackPath: "/usr/local/bin/claude",
    });

    expect(result).toEqual(
      expect.objectContaining({
        path: "/usr/local/bin/claude",
        source: "global_fallback",
      }),
    );
  });

  it("fails validation clearly when the resolved executable is missing", async () => {
    const missingPath = path.join(
      os.tmpdir(),
      `missing-claude-${Date.now()}`,
    );

    await expect(
      validateClaudeExecutable({
        explicitPath: missingPath,
        env: {},
        runVersionCheck: false,
      }),
    ).rejects.toThrow(/Claude Code executable is not accessible/);
  });

  it("runs a lightweight version check for an executable path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-exec-"));
    const executablePath = path.join(dir, "claude");
    await fs.writeFile(executablePath, "#!/bin/sh\necho claude-test 1.0\n");
    await fs.chmod(executablePath, 0o755);

    const result = await validateClaudeExecutable({
      explicitPath: executablePath,
      env: {},
    });

    expect(result).toEqual(
      expect.objectContaining({
        path: executablePath,
        source: "explicit_option",
        versionOutput: "claude-test 1.0",
      }),
    );
  });
});
