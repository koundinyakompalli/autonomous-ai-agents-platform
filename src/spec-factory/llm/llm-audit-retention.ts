import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LlmAuditArtifactRetentionCandidate,
  LlmAuditArtifactRetentionStore,
} from "./llm-audit.js";

export interface LlmAuditArtifactRetentionOptions {
  olderThanDays?: number;
  limit?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface LlmAuditArtifactRetentionFailure {
  auditCallId: number;
  uri: string | null;
  errorMessage: string;
}

export interface LlmAuditArtifactRetentionSuccess {
  auditCallId: number;
  artifactUrisDeleted: string[];
}

export interface LlmAuditArtifactRetentionResult {
  dryRun: boolean;
  auditArtifactBase: string;
  createdBefore: string;
  inspected: number;
  cleaned: number;
  wouldClean: number;
  deletedArtifacts: number;
  failed: number;
  skippedUnsupported: number;
  successes: LlmAuditArtifactRetentionSuccess[];
  failures: LlmAuditArtifactRetentionFailure[];
}

interface FileSystemLike {
  rm(path: string, options: { force: boolean }): Promise<void>;
}

const DEFAULT_LLM_AUDIT_ARTIFACT_RETENTION_DAYS = 30;
const DEFAULT_LLM_AUDIT_ARTIFACT_LIMIT = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.floor(value);
}

function normalizeArtifactBase(artifactBase: string): string {
  const trimmed = artifactBase.trim();
  if (!trimmed) {
    throw new Error("auditArtifactBase is required for LLM audit retention");
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error("auditArtifactBase must be an absolute path");
  }
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    throw new Error("auditArtifactBase must not be the filesystem root");
  }
  return resolved;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueArtifactUris(
  candidate: LlmAuditArtifactRetentionCandidate,
): string[] {
  return [
    ...new Set(
      [candidate.redactedPromptUri, candidate.redactedResponseUri].filter(
        (uri): uri is string => Boolean(uri),
      ),
    ),
  ];
}

function filePathForUri(uri: string, artifactBase: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`unsupported audit artifact URI:${uri}`);
  }
  if (parsed.protocol !== "file:") {
    throw new Error(`unsupported audit artifact URI scheme:${parsed.protocol}`);
  }
  const resolvedPath = path.resolve(fileURLToPath(parsed));
  const relative = path.relative(artifactBase, resolvedPath);
  if (
    resolvedPath === artifactBase ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`audit artifact URI is outside audit artifact base:${uri}`);
  }
  return resolvedPath;
}

export class LlmAuditArtifactRetentionCleaner {
  constructor(
    private readonly repository: LlmAuditArtifactRetentionStore,
    private readonly artifactBase: string,
    private readonly fs: FileSystemLike = { rm },
  ) {}

  async cleanupAuditArtifacts(
    options: LlmAuditArtifactRetentionOptions = {},
  ): Promise<LlmAuditArtifactRetentionResult> {
    const artifactBase = normalizeArtifactBase(this.artifactBase);
    const olderThanDays = positiveIntegerOption(
      options.olderThanDays,
      DEFAULT_LLM_AUDIT_ARTIFACT_RETENTION_DAYS,
      "olderThanDays",
    );
    const limit = positiveIntegerOption(
      options.limit,
      DEFAULT_LLM_AUDIT_ARTIFACT_LIMIT,
      "limit",
    );
    const dryRun = Boolean(options.dryRun);
    const now = options.now ?? new Date();
    const createdBefore = new Date(now.getTime() - olderThanDays * MS_PER_DAY);
    const candidates =
      await this.repository.listAuditArtifactsForRetention({
        createdBefore,
        limit,
      });

    const successes: LlmAuditArtifactRetentionSuccess[] = [];
    const failures: LlmAuditArtifactRetentionFailure[] = [];
    let cleaned = 0;
    let wouldClean = 0;
    let deletedArtifacts = 0;
    let skippedUnsupported = 0;

    for (const candidate of candidates) {
      const uris = uniqueArtifactUris(candidate);
      try {
        const paths = uris.map((uri) => filePathForUri(uri, artifactBase));
        if (dryRun) {
          wouldClean += 1;
          continue;
        }
        for (const artifactPath of paths) {
          await this.fs.rm(artifactPath, { force: true });
        }
        await this.repository.clearAuditArtifactUris(candidate.id);
        cleaned += 1;
        deletedArtifacts += paths.length;
        successes.push({
          auditCallId: candidate.id,
          artifactUrisDeleted: uris,
        });
      } catch (error) {
        const message = errorMessage(error);
        if (message.startsWith("unsupported audit artifact URI scheme:")) {
          skippedUnsupported += 1;
          continue;
        }
        failures.push({
          auditCallId: candidate.id,
          uri: uris.find((uri) => message.includes(uri)) ?? null,
          errorMessage: message,
        });
      }
    }

    return {
      dryRun,
      auditArtifactBase: artifactBase,
      createdBefore: createdBefore.toISOString(),
      inspected: candidates.length,
      cleaned,
      wouldClean,
      deletedArtifacts,
      failed: failures.length,
      skippedUnsupported,
      successes,
      failures,
    };
  }
}
