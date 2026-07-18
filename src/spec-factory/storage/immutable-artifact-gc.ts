export interface ImmutableArtifactReachabilityRepository {
  listReferencedArtifactKeys(input: {
    rootPrefix: string;
    limit: number;
  }): Promise<{ keys: string[]; truncated: boolean }>;
}

export interface ImmutableArtifactGcObjectStore {
  listKeys(input: { prefix: string; continuationToken?: string }): Promise<{
    keys: string[];
    objects?: Array<{ key: string; lastModified: Date | null }>;
    nextContinuationToken: string | null;
  }>;
  deleteKeys(keys: string[]): Promise<number>;
}

export interface ImmutableArtifactGcResult {
  dryRun: boolean;
  inspected: number;
  referenced: number;
  gracePeriodSkipped: number;
  unknownAgeSkipped: number;
  referenceScanTruncated: boolean;
  orphaned: number;
  deleted: number;
  truncated: boolean;
  orphanKeys: string[];
}

export class ImmutableArtifactReachabilityGc {
  constructor(
    private readonly repository: ImmutableArtifactReachabilityRepository,
    private readonly objectStore: ImmutableArtifactGcObjectStore,
  ) {}

  async cleanup(
    input: {
      rootPrefix?: string;
      olderThanHours?: number;
      limit?: number;
      dryRun?: boolean;
      now?: Date;
    } = {},
  ): Promise<ImmutableArtifactGcResult> {
    const rootPrefix = safeManagedPrefix(
      input.rootPrefix ?? immutableArtifactRootPrefix(),
    );
    const limit = boundedPositive(input.limit, 5_000, 100_000);
    const cutoff = new Date(
      (input.now ?? new Date()).getTime() -
        boundedPositive(input.olderThanHours, 24, 24 * 365) * 3_600_000,
    );
    const referenceScan = await this.repository.listReferencedArtifactKeys({
      rootPrefix,
      limit,
    });
    if (referenceScan.truncated) {
      return {
        dryRun: input.dryRun !== false,
        inspected: 0,
        referenced: 0,
        gracePeriodSkipped: 0,
        unknownAgeSkipped: 0,
        referenceScanTruncated: true,
        orphaned: 0,
        deleted: 0,
        truncated: true,
        orphanKeys: [],
      };
    }
    const referenced = new Set(referenceScan.keys);
    const orphanKeys: string[] = [];
    let inspected = 0;
    let referencedCount = 0;
    let gracePeriodSkipped = 0;
    let unknownAgeSkipped = 0;
    let continuationToken: string | undefined;
    let truncated = false;
    do {
      const page = await this.objectStore.listKeys({
        prefix: rootPrefix,
        continuationToken,
      });
      const objects =
        page.objects ?? page.keys.map((key) => ({ key, lastModified: null }));
      for (const object of objects) {
        if (inspected >= limit) {
          truncated = true;
          break;
        }
        inspected += 1;
        if (referenced.has(object.key)) {
          referencedCount += 1;
          continue;
        }
        if (!object.lastModified) {
          unknownAgeSkipped += 1;
          continue;
        }
        if (object.lastModified >= cutoff) {
          gracePeriodSkipped += 1;
          continue;
        }
        orphanKeys.push(object.key);
      }
      if (truncated) break;
      continuationToken = page.nextContinuationToken ?? undefined;
    } while (continuationToken);
    const dryRun = input.dryRun !== false;
    const deleted =
      dryRun || orphanKeys.length === 0
        ? 0
        : await this.objectStore.deleteKeys(orphanKeys);
    return {
      dryRun,
      inspected,
      referenced: referencedCount,
      gracePeriodSkipped,
      unknownAgeSkipped,
      referenceScanTruncated: false,
      orphaned: orphanKeys.length,
      deleted,
      truncated,
      orphanKeys,
    };
  }
}

export function immutableArtifactRootPrefix(
  basePrefix = "spec-factory",
): string {
  const prefix = normalizePrefix(basePrefix);
  const segments = prefix.split("/").filter(Boolean);
  return segments.at(-1) === "workspaces" ? prefix : `${prefix}workspaces/`;
}

function safeManagedPrefix(value: string): string {
  const prefix = normalizePrefix(value);
  const segments = prefix.split("/").filter(Boolean);
  if (segments.at(-1) !== "workspaces") {
    throw new Error("immutable_artifact_gc_unsafe_prefix");
  }
  return prefix;
}

function normalizePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix === "*") {
    throw new Error("immutable_artifact_gc_unsafe_prefix");
  }
  return `${prefix}/`;
}

function boundedPositive(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value!)));
}
