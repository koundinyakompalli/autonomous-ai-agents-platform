import { createHash, randomUUID } from "crypto";
import {
  accessSync,
  constants,
  promises as fs,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { registerRepoFromPath as defaultRegisterRepoFromPath } from "../claude-sdk/index.js";
import type { ComposeMessageRole } from "./compose-types.js";
import {
  loadMhkOrganizationalContext,
  MHK_ORGANIZATIONAL_CONTEXT_FILENAME,
} from "./organizational-context.js";
import type { ImmutableArtifactStore } from "./storage/immutable-s3-artifact-store.js";

type RegisterRepo = (repoPath: string, explicitId?: string) => string;
const DEFAULT_SCRATCH_BASE = path.join(os.tmpdir(), "spec-factory-compose");

export interface ComposeWorkspaceMessage {
  role: ComposeMessageRole;
  content: string;
}

export interface ComposeWorkspaceSource {
  sourceId: number;
  filename: string;
  content: string;
}

export interface WorkspaceManifestFile {
  path: string;
  kind:
    | "chat"
    | "context"
    | "repositories"
    | "source"
    | "source-index"
    | "artifact";
  bytes: number;
  sha256: string;
  artifactUri?: string;
  sourceId?: number;
}

export interface WorkspaceManifestSource {
  sourceId: number;
  filename: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface WorkspaceManifest {
  manifestVersion: 1 | 2;
  sessionId: number | null;
  workspacePath: string;
  files: WorkspaceManifestFile[];
  sourceInventory: WorkspaceManifestSource[];
  updatedAt: string;
}

export interface UpsertComposeWorkspaceManifestInput {
  sessionId: number;
  workspacePath: string;
  manifestJson: WorkspaceManifest;
  manifestBytes: number;
  manifestSha256: string;
}

export interface ComposeWorkspaceManifestStore {
  upsertWorkspaceManifest(
    input: UpsertComposeWorkspaceManifestInput,
  ): Promise<void>;
  getWorkspaceManifest?(sessionId: number): Promise<WorkspaceManifest | null>;
}

export interface AttachComposeWorkspaceInput {
  sessionId: number;
  durableWorkspacePath: string;
  purpose: string;
  taskId?: number | string | null;
  allowMissingDurableWorkspace?: boolean;
}

export interface AttachedComposeWorkspace {
  sessionId: number;
  durableWorkspacePath: string;
  localWorkspacePath: string;
  purpose: string;
  taskId: number | string | null;
  attachedAt: string;
}

export interface ComposeWorkspaceManagerOptions {
  scratchBase?: string;
  manifestStore?: ComposeWorkspaceManifestStore;
  artifactStore?: ImmutableArtifactStore;
  organizationalContextProvider?: () => string;
}

export interface WriteComposeWorkspaceArtifactInput {
  workspacePath: string;
  relativePath: string;
  content: string | Buffer;
}

export interface AttachComposeRepositoriesInput {
  workspacePath: string;
  repositories: Array<{
    repoName: string;
    workspacePath: string;
    headSha?: string | null;
  }>;
}

export interface ComposeWorkspaceArtifactRef {
  artifactUri: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface BackfillComposeWorkspaceManifestInput {
  sessionId: number;
  workspacePath: string;
}

export interface BackfillComposeWorkspaceManifestResult {
  sessionId: number;
  manifestVersion: 2;
  fileCount: number;
  migratedFileCount: number;
  reusedFileCount: number;
  manifestSha256: string;
}

function renderChatMarkdown(messages: ComposeWorkspaceMessage[]): string {
  if (messages.length === 0) return "# Conversation\n\n_(no messages yet)_\n";
  const body = messages.map((m) => `**${m.role}**: ${m.content}`).join("\n\n");
  return `# Conversation\n\n${body}\n`;
}

function safeSourceFilename(source: ComposeWorkspaceSource): string {
  const base = (source.filename.split(/[\\/]/).pop() ?? "source").replace(
    /[^A-Za-z0-9._-]/g,
    "_",
  );
  const withExtension = base.toLowerCase().endsWith(".md")
    ? base
    : `${base}.md`;
  return `${source.sourceId}-${withExtension}`;
}

function renderSourcesIndex(
  entries: Array<{ filename: string; source: ComposeWorkspaceSource }>,
): string {
  if (entries.length === 0)
    return "# Sources\n\n_(no converted sources yet)_\n";
  const body = entries
    .map(
      ({ filename, source }) =>
        `- [${filename}](sources/${filename}) — source ${source.sourceId}`,
    )
    .join("\n");
  return `# Sources\n\n${body}\n`;
}

function safePathSegment(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "workspace";
}

function resolveWorkspaceRelativePath(input: {
  workspacePath: string;
  relativePath: string;
}): { absolutePath: string; relativePath: string } {
  const raw = input.relativePath.trim();
  const posixPath = raw.replace(/\\/g, "/");
  const normalized = path.posix.normalize(posixPath);
  if (
    !raw ||
    path.isAbsolute(raw) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("relativePath must stay inside the workspace");
  }
  const workspaceRoot = path.resolve(input.workspacePath);
  const absolutePath = path.resolve(workspaceRoot, ...normalized.split("/"));
  const relativeFromRoot = path.relative(workspaceRoot, absolutePath);
  if (
    relativeFromRoot === "" ||
    relativeFromRoot.startsWith("..") ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error("relativePath must stay inside the workspace");
  }
  return { absolutePath, relativePath: normalized };
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function manifestFile(
  kind: WorkspaceManifestFile["kind"],
  relativePath: string,
  content: string,
  extra: Pick<WorkspaceManifestFile, "sourceId"> = {},
): WorkspaceManifestFile {
  return {
    path: relativePath,
    kind,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content).digest("hex"),
    ...extra,
  };
}

function workspaceManifestIsImmutable(
  manifest: WorkspaceManifest | null,
): manifest is WorkspaceManifest & { manifestVersion: 2 } {
  return Boolean(
    manifest?.manifestVersion === 2 &&
    manifest.files.every((file) => Boolean(file.artifactUri?.trim())),
  );
}

function parsedWorkspaceManifest(
  value: unknown,
  sessionId: number,
): WorkspaceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid_workspace_manifest:${sessionId}`);
  }
  const manifest = value as Partial<WorkspaceManifest>;
  if (
    (manifest.manifestVersion !== 1 && manifest.manifestVersion !== 2) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.sourceInventory)
  ) {
    throw new Error(`invalid_workspace_manifest:${sessionId}`);
  }
  return manifest as WorkspaceManifest;
}

function manifestKind(relativePath: string): WorkspaceManifestFile["kind"] {
  if (relativePath === "chat.md") return "chat";
  if (relativePath === "context.md") return "context";
  if (relativePath === "repositories.md") return "repositories";
  if (relativePath === "sources-index.md") return "source-index";
  if (relativePath.startsWith("sources/")) return "source";
  return "artifact";
}

function sourceIdFromManifestPath(relativePath: string): number | undefined {
  const match = /^sources\/(\d+)-/.exec(relativePath);
  if (!match) return undefined;
  const sourceId = Number(match[1]);
  return Number.isSafeInteger(sourceId) && sourceId > 0 ? sourceId : undefined;
}

function safeWorkspaceBackfillPath(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error("workspace_manifest_backfill_unsafe_workspace_path");
  }
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    throw new Error("workspace_manifest_backfill_unsafe_workspace_path");
  }
  return resolved;
}

function pathIsInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function assertComposeWorkspaceBaseReady(workspaceBase: string): void {
  const base = workspaceBase.trim();
  if (!base) {
    throw new Error("COMPOSE_WORKSPACE_BASE is required");
  }
  let stats;
  try {
    stats = statSync(base);
  } catch (error) {
    throw new Error(
      `COMPOSE_WORKSPACE_BASE ${base} must already exist before startup`,
      { cause: error },
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`COMPOSE_WORKSPACE_BASE ${base} must be a directory`);
  }
  try {
    accessSync(base, constants.W_OK);
    const probe = path.join(
      base,
      `.compose-workspace-probe-${process.pid}-${Date.now()}`,
    );
    writeFileSync(probe, "ok", { encoding: "utf8", flag: "wx" });
    unlinkSync(probe);
  } catch (error) {
    throw new Error(`COMPOSE_WORKSPACE_BASE ${base} must be writable`, {
      cause: error,
    });
  }
}

export class ComposeWorkspaceManager {
  constructor(
    private readonly registerRepo: RegisterRepo = defaultRegisterRepoFromPath,
    private readonly options: ComposeWorkspaceManagerOptions = {},
  ) {}

  private get scratchBase(): string {
    return this.options.scratchBase?.trim() || DEFAULT_SCRATCH_BASE;
  }

  private async materializeOrganizationalContext(
    workspacePath: string,
  ): Promise<void> {
    const organizationalContext =
      this.options.organizationalContextProvider?.() ??
      loadMhkOrganizationalContext();
    if (!organizationalContext.trim()) {
      throw new Error("spec_factory_organizational_context_empty");
    }
    await fs.writeFile(
      path.join(workspacePath, MHK_ORGANIZATIONAL_CONTEXT_FILENAME),
      organizationalContext,
      "utf8",
    );
  }

  private async deriveWorkspaceManifest(
    input: BackfillComposeWorkspaceManifestInput,
  ): Promise<WorkspaceManifest> {
    const files: WorkspaceManifestFile[] = [];
    const sourceInventory: WorkspaceManifestSource[] = [];
    const walk = async (
      directory: string,
      relativeDirectory = "",
    ): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingPathError(error) && !relativeDirectory) return;
        throw error;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (
          entry.name === "session-manifest.json" ||
          entry.name === ".tmp" ||
          entry.name === ".workspace-attach.json" ||
          entry.name === MHK_ORGANIZATIONAL_CONTEXT_FILENAME
        ) {
          continue;
        }
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(absolutePath, relativePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const content = await fs.readFile(absolutePath);
        const sourceId = sourceIdFromManifestPath(relativePath);
        const file: WorkspaceManifestFile = {
          path: relativePath,
          kind: manifestKind(relativePath),
          bytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
          ...(sourceId ? { sourceId } : {}),
        };
        files.push(file);
        if (file.kind === "source" && sourceId) {
          sourceInventory.push({
            sourceId,
            filename: path.posix.basename(relativePath),
            path: relativePath,
            bytes: file.bytes,
            sha256: file.sha256,
          });
        }
      }
    };
    await walk(input.workspacePath);
    return {
      manifestVersion: 1,
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      files,
      sourceInventory,
      updatedAt: new Date().toISOString(),
    };
  }

  private async loadWorkspaceManifestForBackfill(
    input: BackfillComposeWorkspaceManifestInput,
  ): Promise<WorkspaceManifest> {
    const stored = this.options.manifestStore?.getWorkspaceManifest
      ? await this.options.manifestStore.getWorkspaceManifest(input.sessionId)
      : null;
    if (stored) return stored;
    try {
      const body = await fs.readFile(
        path.join(input.workspacePath, "session-manifest.json"),
        "utf8",
      );
      return parsedWorkspaceManifest(JSON.parse(body), input.sessionId);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      return this.deriveWorkspaceManifest(input);
    }
  }

  async backfillImmutableManifest(
    input: BackfillComposeWorkspaceManifestInput,
  ): Promise<BackfillComposeWorkspaceManifestResult> {
    if (!this.options.artifactStore || !this.options.manifestStore) {
      throw new Error("immutable_workspace_manifest_backfill_not_configured");
    }
    const workspacePath = safeWorkspaceBackfillPath(input.workspacePath);
    const normalizedInput = { ...input, workspacePath };
    const current =
      await this.loadWorkspaceManifestForBackfill(normalizedInput);
    if (current.sessionId !== null && current.sessionId !== input.sessionId) {
      throw new Error(`workspace_manifest_session_mismatch:${input.sessionId}`);
    }
    let migratedFileCount = 0;
    let reusedFileCount = 0;
    const files: WorkspaceManifestFile[] = [];
    for (const file of current.files) {
      const target = resolveWorkspaceRelativePath({
        workspacePath,
        relativePath: file.path,
      });
      let artifactUri = file.artifactUri?.trim() || "";
      if (artifactUri.startsWith("s3://")) {
        const content = await this.options.artifactStore.read(artifactUri);
        const sha256 = createHash("sha256").update(content).digest("hex");
        if (content.byteLength !== file.bytes || sha256 !== file.sha256) {
          throw new Error(
            `workspace_manifest_verification_failed:${file.path}`,
          );
        }
        reusedFileCount += 1;
      } else {
        const [workspaceRealPath, artifactRealPath] = await Promise.all([
          fs.realpath(workspacePath),
          fs.realpath(target.absolutePath),
        ]);
        if (!pathIsInside(artifactRealPath, workspaceRealPath)) {
          throw new Error(`workspace_manifest_path_escape:${file.path}`);
        }
        const content = await fs.readFile(artifactRealPath);
        const sha256 = createHash("sha256").update(content).digest("hex");
        if (content.byteLength !== file.bytes || sha256 !== file.sha256) {
          throw new Error(
            `workspace_manifest_verification_failed:${file.path}`,
          );
        }
        const artifact = await this.options.artifactStore.write({
          workspacePath,
          relativePath: target.relativePath,
          content,
        });
        if (artifact.bytes !== file.bytes || artifact.sha256 !== file.sha256) {
          throw new Error(`workspace_manifest_artifact_mismatch:${file.path}`);
        }
        artifactUri = artifact.artifactUri;
        migratedFileCount += 1;
      }
      files.push({ ...file, artifactUri });
    }
    const manifest: WorkspaceManifest = {
      ...current,
      manifestVersion: 2,
      sessionId: input.sessionId,
      workspacePath,
      files,
      updatedAt: new Date().toISOString(),
    };
    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = createHash("sha256")
      .update(manifestBody)
      .digest("hex");
    let tmpPath: string | null = null;
    try {
      await fs.access(workspacePath, constants.F_OK);
      tmpPath = path.join(
        workspacePath,
        `.session-manifest-${randomUUID()}.tmp`,
      );
      await fs.writeFile(tmpPath, manifestBody, "utf8");
      await fs.rename(
        tmpPath,
        path.join(workspacePath, "session-manifest.json"),
      );
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    } finally {
      if (tmpPath) await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }
    await this.options.manifestStore.upsertWorkspaceManifest({
      sessionId: input.sessionId,
      workspacePath,
      manifestJson: manifest,
      manifestBytes: Buffer.byteLength(manifestBody, "utf8"),
      manifestSha256,
    });
    return {
      sessionId: input.sessionId,
      manifestVersion: 2,
      fileCount: files.length,
      migratedFileCount,
      reusedFileCount,
      manifestSha256,
    };
  }

  /**
   * Materialize the session workspace for an agent run and register it as an
   * SDK repo. `sources/*.md` are written by the conversion worker; here we
   * (re)write chat.md from the message history and, when provided, context.md.
   * Returns the SDK repoId for runAgent({ repoIds: [repoId] }).
   */
  async prepare(input: {
    sessionId?: number | null;
    workspacePath: string;
    messages: ComposeWorkspaceMessage[];
    sources?: ComposeWorkspaceSource[];
    contextMarkdown?: string;
    repositoryContextMarkdown?: string;
  }): Promise<string> {
    await fs.mkdir(input.workspacePath, { recursive: true });
    const sourcesDir = path.join(input.workspacePath, "sources");
    await fs.mkdir(sourcesDir, { recursive: true });
    const files: WorkspaceManifestFile[] = [];
    const sourceInventory: WorkspaceManifestSource[] = [];

    const chatMarkdown = renderChatMarkdown(input.messages);
    await fs.writeFile(
      path.join(input.workspacePath, "chat.md"),
      chatMarkdown,
      "utf8",
    );
    files.push(manifestFile("chat", "chat.md", chatMarkdown));

    await this.materializeOrganizationalContext(input.workspacePath);

    if (input.contextMarkdown) {
      await fs.writeFile(
        path.join(input.workspacePath, "context.md"),
        input.contextMarkdown,
        "utf8",
      );
      files.push(manifestFile("context", "context.md", input.contextMarkdown));
    }

    if (input.repositoryContextMarkdown) {
      await fs.writeFile(
        path.join(input.workspacePath, "repositories.md"),
        input.repositoryContextMarkdown,
        "utf8",
      );
      files.push(
        manifestFile(
          "repositories",
          "repositories.md",
          input.repositoryContextMarkdown,
        ),
      );
    }

    if (input.sources) {
      await fs.rm(sourcesDir, { recursive: true, force: true });
      await fs.mkdir(sourcesDir, { recursive: true });
      const entries = input.sources.map((source) => ({
        source,
        filename: safeSourceFilename(source),
      }));
      for (const { filename, source } of entries) {
        const relativePath = `sources/${filename}`;
        await fs.writeFile(
          path.join(sourcesDir, filename),
          source.content,
          "utf8",
        );
        const file = manifestFile("source", relativePath, source.content, {
          sourceId: source.sourceId,
        });
        files.push(file);
        sourceInventory.push({
          sourceId: source.sourceId,
          filename,
          path: relativePath,
          bytes: file.bytes,
          sha256: file.sha256,
        });
      }
      const sourcesIndex = renderSourcesIndex(entries);
      await fs.writeFile(
        path.join(input.workspacePath, "sources-index.md"),
        sourcesIndex,
        "utf8",
      );
      files.push(
        manifestFile("source-index", "sources-index.md", sourcesIndex),
      );
    }

    if (this.options.artifactStore) {
      for (const file of files) {
        const content = await fs.readFile(
          path.join(input.workspacePath, file.path),
        );
        const artifact = await this.options.artifactStore.write({
          workspacePath: input.workspacePath,
          relativePath: file.path,
          content,
        });
        if (artifact.bytes !== file.bytes || artifact.sha256 !== file.sha256) {
          throw new Error(`workspace_manifest_artifact_mismatch:${file.path}`);
        }
        file.artifactUri = artifact.artifactUri;
      }
    }

    const manifest: WorkspaceManifest = {
      manifestVersion: this.options.artifactStore ? 2 : 1,
      sessionId: input.sessionId ?? null,
      workspacePath: input.workspacePath,
      files,
      sourceInventory,
      updatedAt: new Date().toISOString(),
    };
    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(
      path.join(input.workspacePath, "session-manifest.json"),
      manifestBody,
      "utf8",
    );
    if (
      this.options.manifestStore &&
      typeof input.sessionId === "number" &&
      Number.isInteger(input.sessionId)
    ) {
      await this.options.manifestStore.upsertWorkspaceManifest({
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        manifestJson: manifest,
        manifestBytes: Buffer.byteLength(manifestBody, "utf8"),
        manifestSha256: createHash("sha256").update(manifestBody).digest("hex"),
      });
    }

    return this.registerRepo(input.workspacePath);
  }

  async attach(
    input: AttachComposeWorkspaceInput,
  ): Promise<AttachedComposeWorkspace> {
    const sessionScratchRoot = path.join(
      this.scratchBase,
      String(input.sessionId),
    );
    await fs.mkdir(sessionScratchRoot, { recursive: true });
    const purpose = safePathSegment(input.purpose);
    const taskSegment =
      input.taskId === null || input.taskId === undefined
        ? "scratch"
        : safePathSegment(String(input.taskId));
    const localWorkspacePath = await fs.mkdtemp(
      path.join(sessionScratchRoot, `${purpose}-${taskSegment}-`),
    );
    const durableManifest =
      this.options.artifactStore &&
      this.options.manifestStore?.getWorkspaceManifest
        ? await this.options.manifestStore.getWorkspaceManifest(input.sessionId)
        : null;
    const immutableManifestReady =
      workspaceManifestIsImmutable(durableManifest);
    let durableWorkspaceExists = true;
    if (immutableManifestReady) {
      durableWorkspaceExists = false;
    } else {
      try {
        await fs.access(input.durableWorkspacePath, constants.F_OK);
      } catch (error) {
        if (!input.allowMissingDurableWorkspace || !isMissingPathError(error)) {
          throw error;
        }
        durableWorkspaceExists = false;
        await fs.mkdir(input.durableWorkspacePath, { recursive: true });
      }
    }
    if (durableWorkspaceExists) {
      await fs.cp(input.durableWorkspacePath, localWorkspacePath, {
        recursive: true,
        force: true,
      });
    }
    if (durableManifest && this.options.artifactStore) {
      for (const file of durableManifest.files) {
        if (!file.artifactUri) continue;
        const content = await this.options.artifactStore.read(file.artifactUri);
        const sha256 = createHash("sha256").update(content).digest("hex");
        if (content.byteLength !== file.bytes || sha256 !== file.sha256) {
          throw new Error(
            `workspace_manifest_verification_failed:${file.path}`,
          );
        }
        const target = resolveWorkspaceRelativePath({
          workspacePath: localWorkspacePath,
          relativePath: file.path,
        });
        await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
        await fs.writeFile(target.absolutePath, content);
      }
    }
    await this.materializeOrganizationalContext(localWorkspacePath);
    const attached: AttachedComposeWorkspace = {
      sessionId: input.sessionId,
      durableWorkspacePath: input.durableWorkspacePath,
      localWorkspacePath,
      purpose: input.purpose,
      taskId: input.taskId ?? null,
      attachedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(localWorkspacePath, ".workspace-attach.json"),
      `${JSON.stringify(attached, null, 2)}\n`,
      "utf8",
    );
    return attached;
  }

  async attachRepositories(
    input: AttachComposeRepositoriesInput,
  ): Promise<void> {
    const reposDir = path.join(input.workspacePath, "repos");
    await fs.mkdir(reposDir, { recursive: true });
    const attached: Array<{
      repoName: string;
      workspacePath: string;
      headSha: string | null;
    }> = [];
    for (const repository of input.repositories) {
      const repoName = safePathSegment(repository.repoName);
      const sourcePath = path.resolve(repository.workspacePath);
      const stats = await fs.stat(sourcePath);
      if (!stats.isDirectory()) {
        throw new Error(`research_repository_not_directory:${repoName}`);
      }
      const linkPath = path.join(reposDir, repoName);
      try {
        const existing = await fs.lstat(linkPath);
        if (!existing.isSymbolicLink()) {
          throw new Error(`research_repository_link_conflict:${repoName}`);
        }
        const currentTarget = path.resolve(
          reposDir,
          await fs.readlink(linkPath),
        );
        if (currentTarget !== sourcePath) {
          await fs.unlink(linkPath);
          await fs.symlink(sourcePath, linkPath, "dir");
        }
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        await fs.symlink(sourcePath, linkPath, "dir");
      }
      attached.push({
        repoName,
        workspacePath: sourcePath,
        headSha: repository.headSha?.trim() || null,
      });
    }
    await fs.writeFile(
      path.join(input.workspacePath, "research-repositories.json"),
      `${JSON.stringify({ repositories: attached }, null, 2)}\n`,
      "utf8",
    );
  }

  async detach(
    input: Pick<AttachedComposeWorkspace, "localWorkspacePath">,
  ): Promise<void> {
    await fs.rm(input.localWorkspacePath, { recursive: true, force: true });
  }

  async cleanupLocal(sessionId: number): Promise<void> {
    await fs.rm(path.join(this.scratchBase, String(sessionId)), {
      recursive: true,
      force: true,
    });
  }

  async writeArtifact(
    input: WriteComposeWorkspaceArtifactInput,
  ): Promise<ComposeWorkspaceArtifactRef> {
    const { absolutePath, relativePath } = resolveWorkspaceRelativePath(input);
    const body = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, "utf8");
    const expectedSha256 = createHash("sha256").update(body).digest("hex");
    const expectedBytes = body.byteLength;
    const tmpDir = path.join(input.workspacePath, ".tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmpPath, body);
      const written = await fs.readFile(tmpPath);
      const actualSha256 = createHash("sha256").update(written).digest("hex");
      if (
        written.byteLength !== expectedBytes ||
        actualSha256 !== expectedSha256
      ) {
        throw new Error("artifact verification failed");
      }
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.rename(tmpPath, absolutePath);
      const durableArtifact = this.options.artifactStore
        ? await this.options.artifactStore.write({
            workspacePath: input.workspacePath,
            relativePath,
            content: body,
          })
        : null;
      return {
        artifactUri: durableArtifact?.artifactUri ?? `file://${absolutePath}`,
        relativePath,
        bytes: expectedBytes,
        sha256: expectedSha256,
      };
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
}
