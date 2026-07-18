import { rm } from "node:fs/promises";
import path from "node:path";
import type {
  ComposeHardDeleteDbResult,
  ComposeHardDeletePlan,
} from "./compose-database.js";

export interface ComposeHardDeleteRepository {
  getHardDeletePlan(sessionId: number): Promise<ComposeHardDeletePlan>;
  hardDeleteArchivedSession(
    sessionId: number,
  ): Promise<ComposeHardDeleteDbResult>;
}

export interface ComposeHardDeleteObjectStore {
  deletePrefix(s3Prefix: string): Promise<number>;
  deleteArtifactUris?(artifactUris: string[]): Promise<number>;
}

interface FileSystemLike {
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
}

export interface ComposeHardDeleteInput {
  sessionId: number;
  dryRun?: boolean;
  confirm?: string | null;
  auditArtifactBasePath?: string | null;
}

export interface ComposeHardDeleteResult {
  dryRun: boolean;
  plan: ComposeHardDeletePlan;
  confirmationRequired: string;
  uncoveredArtifactUris: string[];
  deletedObjects: number;
  workspaceDeleted: boolean;
  db: ComposeHardDeleteDbResult | null;
}

const DEFAULT_FS: FileSystemLike = { rm };
const PURGED_SOURCE_ARTIFACT_URI =
  /^purged:\/\/source-deletion\/\d+\/(?:chunk|revision)\/\d+$/;

function confirmationToken(sessionId: number): string {
  return `delete-session:${sessionId}`;
}

function normalizeS3Prefix(s3Prefix: string): string {
  const trimmed = s3Prefix.trim().replace(/^\/+/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function s3KeyFromUri(uri: string): string | null {
  if (uri.startsWith("s3://")) {
    try {
      const parsed = new URL(uri);
      return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      return null;
    }
  }

  if (uri.startsWith("file://") || uri.startsWith("/") || uri.includes("://")) {
    return null;
  }

  return uri.replace(/^\/+/, "");
}

function filePathFromUri(uri: string): string | null {
  if (uri.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return null;
    }
  }
  if (uri.startsWith("/")) return uri;
  return null;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  if (!root.trim()) return false;
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

function safeWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error("compose_hard_delete_unsafe_workspace_path");
  }
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    throw new Error("compose_hard_delete_unsafe_workspace_path");
  }
  return resolved;
}

function safeOptionalFileRoot(root: string | null | undefined): string | null {
  const trimmed = root?.trim();
  if (!trimmed) return null;
  if (!path.isAbsolute(trimmed)) {
    throw new Error("compose_hard_delete_unsafe_audit_artifact_base");
  }
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    throw new Error("compose_hard_delete_unsafe_audit_artifact_base");
  }
  return resolved;
}

function uncoveredArtifactUris(
  plan: ComposeHardDeletePlan,
  auditArtifactBasePath: string | null,
  individualS3DeleteEnabled: boolean,
): string[] {
  const s3Prefix = normalizeS3Prefix(plan.s3Prefix);
  const uncovered: string[] = [];

  for (const uri of plan.artifactUris) {
    // Purge replaces required revision/chunk URIs with a validated tombstone.
    // There is no remaining object to delete, so DSR must not treat it as an
    // uncovered external artifact.
    if (PURGED_SOURCE_ARTIFACT_URI.test(uri)) continue;

    const s3Key = s3KeyFromUri(uri);
    if (s3Key) {
      if (s3Prefix && s3Key.startsWith(s3Prefix)) continue;
      if (individualS3DeleteEnabled && uri.startsWith("s3://")) continue;
      uncovered.push(uri);
      continue;
    }

    const filePath = filePathFromUri(uri);
    if (filePath) {
      if (isPathInsideRoot(filePath, plan.workspacePath)) continue;
      if (
        auditArtifactBasePath &&
        isPathInsideRoot(filePath, auditArtifactBasePath)
      ) {
        continue;
      }
      uncovered.push(uri);
      continue;
    }

    uncovered.push(uri);
  }

  return uncovered;
}

function individualS3ArtifactUris(plan: ComposeHardDeletePlan): string[] {
  const prefix = normalizeS3Prefix(plan.s3Prefix);
  return [
    ...new Set(
      plan.artifactUris.filter((uri) => {
        if (!uri.startsWith("s3://")) return false;
        const key = s3KeyFromUri(uri);
        return Boolean(key && (!prefix || !key.startsWith(prefix)));
      }),
    ),
  ];
}

function auditArtifactFilePaths(
  plan: ComposeHardDeletePlan,
  auditArtifactBasePath: string | null,
): string[] {
  if (!auditArtifactBasePath) return [];
  return [
    ...new Set(
      plan.artifactUris
        .map(filePathFromUri)
        .filter((filePath): filePath is string => Boolean(filePath))
        .filter(
          (filePath) =>
            isPathInsideRoot(filePath, auditArtifactBasePath) &&
            !isPathInsideRoot(filePath, plan.workspacePath),
        )
        .map((filePath) => path.resolve(filePath)),
    ),
  ];
}

export class ComposeHardDeleteService {
  constructor(
    private readonly repository: ComposeHardDeleteRepository,
    private readonly fs: FileSystemLike = DEFAULT_FS,
    private readonly objectStore?: ComposeHardDeleteObjectStore,
  ) {}

  async hardDeleteSession(
    input: ComposeHardDeleteInput,
  ): Promise<ComposeHardDeleteResult> {
    const dryRun = input.dryRun !== false;
    const plan = await this.repository.getHardDeletePlan(input.sessionId);
    const requiredConfirmation = confirmationToken(input.sessionId);
    const auditArtifactBasePath = safeOptionalFileRoot(
      input.auditArtifactBasePath,
    );
    const uncovered = uncoveredArtifactUris(
      plan,
      auditArtifactBasePath,
      Boolean(this.objectStore?.deleteArtifactUris),
    );
    const individualS3Artifacts = individualS3ArtifactUris(plan);
    const auditArtifactPaths = auditArtifactFilePaths(
      plan,
      auditArtifactBasePath,
    );

    if (dryRun) {
      return {
        dryRun,
        plan,
        confirmationRequired: requiredConfirmation,
        uncoveredArtifactUris: uncovered,
        deletedObjects: 0,
        workspaceDeleted: false,
        db: null,
      };
    }

    if (input.confirm !== requiredConfirmation) {
      throw new Error("compose_hard_delete_confirmation_required");
    }
    if (plan.status !== "archived") {
      throw new Error("compose_hard_delete_requires_archived_session");
    }
    if (uncovered.length > 0) {
      throw new Error(
        `compose_hard_delete_uncovered_artifact_uri:${uncovered[0]}`,
      );
    }
    const workspacePath = safeWorkspacePath(plan.workspacePath);
    if (plan.s3Prefix.trim() && !this.objectStore) {
      throw new Error("compose_hard_delete_object_store_required");
    }

    let deletedObjects = plan.s3Prefix.trim()
      ? await this.objectStore!.deletePrefix(plan.s3Prefix)
      : 0;
    if (individualS3Artifacts.length > 0) {
      if (!this.objectStore?.deleteArtifactUris) {
        throw new Error("compose_hard_delete_individual_object_store_required");
      }
      deletedObjects += await this.objectStore.deleteArtifactUris(
        individualS3Artifacts,
      );
    }
    for (const artifactPath of auditArtifactPaths) {
      await this.fs.rm(artifactPath, { recursive: false, force: true });
    }
    await this.fs.rm(workspacePath, { recursive: true, force: true });
    const db = await this.repository.hardDeleteArchivedSession(input.sessionId);

    return {
      dryRun,
      plan,
      confirmationRequired: requiredConfirmation,
      uncoveredArtifactUris: uncovered,
      deletedObjects,
      workspaceDeleted: true,
      db,
    };
  }
}
