import { execFile } from "child_process";
import { constants as fsConstants } from "fs";
import * as fs from "fs/promises";
import { createRequire } from "module";
import { promisify } from "util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

export const CLAUDE_CODE_EXECUTABLE_PATH_ENV =
  "CLAUDE_CODE_EXECUTABLE_PATH";
export const DEFAULT_GLOBAL_CLAUDE_EXECUTABLE = "/usr/local/bin/claude";

export type ClaudeExecutableSource =
  | "explicit_option"
  | "environment"
  | "sdk_native_package"
  | "global_fallback";

export type LibcFamily = "glibc" | "musl" | "unknown" | "not_linux";

export interface ClaudeExecutableResolution {
  path: string;
  source: ClaudeExecutableSource;
  platform: NodeJS.Platform;
  arch: string;
  libc: LibcFamily;
  packageSpecifier?: string;
}

export interface ResolveClaudeExecutableOptions {
  explicitPath?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  arch?: string;
  libc?: LibcFamily;
  resolvePackageBinary?: (specifier: string) => string | undefined;
  globalFallbackPath?: string;
}

export interface ValidateClaudeExecutableOptions
  extends ResolveClaudeExecutableOptions {
  runVersionCheck?: boolean;
  versionCheckTimeoutMs?: number;
}

export interface ClaudeExecutableValidationResult
  extends ClaudeExecutableResolution {
  versionOutput?: string;
}

function cleanPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultResolvePackageBinary(specifier: string): string | undefined {
  try {
    return require.resolve(specifier);
  } catch {
    return undefined;
  }
}

export function detectLibcFamily(
  platform: NodeJS.Platform = process.platform,
): LibcFamily {
  if (platform !== "linux") {
    return "not_linux";
  }

  const report = process.report?.getReport?.() as
    | {
        header?: {
          glibcVersionRuntime?: string;
          glibcVersionCompiler?: string;
        };
      }
    | undefined;
  const header = report?.header;

  if (header?.glibcVersionRuntime || header?.glibcVersionCompiler) {
    return "glibc";
  }

  return "unknown";
}

function getNativePackageSpecifier(
  platform: NodeJS.Platform,
  arch: string,
  libc: LibcFamily,
): string | undefined {
  if (platform === "linux") {
    if (arch === "x64" && libc === "glibc") {
      return "@anthropic-ai/claude-agent-sdk-linux-x64/claude";
    }
    return undefined;
  }

  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return `@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude`;
  }

  if (platform === "win32" && (arch === "arm64" || arch === "x64")) {
    return `@anthropic-ai/claude-agent-sdk-win32-${arch}/claude.exe`;
  }

  return undefined;
}

export function resolveClaudeExecutable(
  options: ResolveClaudeExecutableOptions = {},
): ClaudeExecutableResolution {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const libc = options.libc ?? detectLibcFamily(platform);

  const explicitPath = cleanPath(options.explicitPath);
  if (explicitPath) {
    return {
      path: explicitPath,
      source: "explicit_option",
      platform,
      arch,
      libc,
    };
  }

  const envPath = cleanPath(options.env?.[CLAUDE_CODE_EXECUTABLE_PATH_ENV]);
  if (envPath) {
    return {
      path: envPath,
      source: "environment",
      platform,
      arch,
      libc,
    };
  }

  const resolvePackageBinary =
    options.resolvePackageBinary ?? defaultResolvePackageBinary;
  const packageSpecifier = getNativePackageSpecifier(platform, arch, libc);
  if (packageSpecifier) {
    const packagePath = resolvePackageBinary(packageSpecifier);
    if (packagePath) {
      return {
        path: packagePath,
        source: "sdk_native_package",
        platform,
        arch,
        libc,
        packageSpecifier,
      };
    }
  }

  return {
    path: options.globalFallbackPath ?? DEFAULT_GLOBAL_CLAUDE_EXECUTABLE,
    source: "global_fallback",
    platform,
    arch,
    libc,
  };
}

export async function validateClaudeExecutable(
  options: ValidateClaudeExecutableOptions = {},
): Promise<ClaudeExecutableValidationResult> {
  const resolution = resolveClaudeExecutable(options);

  try {
    await fs.access(resolution.path, fsConstants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Claude Code executable is not accessible or not executable at ${resolution.path} ` +
        `(source: ${resolution.source}, platform: ${resolution.platform}, arch: ${resolution.arch}, libc: ${resolution.libc}). ` +
        `Set ${CLAUDE_CODE_EXECUTABLE_PATH_ENV} to a runnable Claude Code executable or ensure the matching SDK native package is installed. ` +
        `Underlying error: ${message}`,
    );
  }

  if (options.runVersionCheck !== false) {
    try {
      const { stdout, stderr } = await execFileAsync(
        resolution.path,
        ["--version"],
        {
          env: options.env,
          timeout: options.versionCheckTimeoutMs ?? 5000,
          windowsHide: true,
        },
      );
      const versionOutput = `${stdout}${stderr}`.trim().slice(0, 300);
      return {
        ...resolution,
        versionOutput,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Claude Code executable failed version check at ${resolution.path} ` +
          `(source: ${resolution.source}, platform: ${resolution.platform}, arch: ${resolution.arch}, libc: ${resolution.libc}). ` +
          `Set ${CLAUDE_CODE_EXECUTABLE_PATH_ENV} to a runnable Claude Code executable. ` +
          `Underlying error: ${message}`,
      );
    }
  }

  return resolution;
}
