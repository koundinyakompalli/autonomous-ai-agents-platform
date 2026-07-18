export interface ComposeS3ReachabilityRepository {
  listComposeS3Prefixes(input: {
    rootPrefix: string;
    limit: number;
  }): Promise<string[]>;
}

export interface ComposeS3ReachabilityObjectStore {
  listKeys(input: {
    prefix: string;
    continuationToken?: string;
  }): Promise<{ keys: string[]; nextContinuationToken: string | null }>;
  deleteKeys(keys: string[]): Promise<number>;
}

export interface ComposeS3ReachabilityGcInput {
  rootPrefix: string;
  dryRun?: boolean;
  limit?: number;
}

export interface ComposeS3ReachabilityGcResult {
  dryRun: boolean;
  rootPrefix: string;
  reachablePrefixes: number;
  inspectedObjects: number;
  reachableObjects: number;
  orphanObjects: number;
  deletedObjects: number;
  truncated: boolean;
  orphanKeys: string[];
}

const DEFAULT_LIMIT = 1000;

function normalizeRootPrefix(rootPrefix: string): string {
  const trimmed = rootPrefix.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed === "/") {
    throw new Error("compose_s3_reachability_gc_unsafe_prefix");
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("compose_s3_reachability_gc_limit_invalid");
  }
  return Math.floor(value);
}

function normalizePrefixes(prefixes: string[]): string[] {
  return [...new Set(prefixes.map(normalizeRootPrefix))].sort();
}

function isReachable(key: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

export class ComposeS3ReachabilityGc {
  constructor(
    private readonly repository: ComposeS3ReachabilityRepository,
    private readonly objectStore: ComposeS3ReachabilityObjectStore,
  ) {}

  async cleanupOrphanedObjects(
    input: ComposeS3ReachabilityGcInput,
  ): Promise<ComposeS3ReachabilityGcResult> {
    const rootPrefix = normalizeRootPrefix(input.rootPrefix);
    const limit = positiveInteger(input.limit, DEFAULT_LIMIT);
    const dryRun = input.dryRun !== false;
    const reachablePrefixes = normalizePrefixes(
      await this.repository.listComposeS3Prefixes({
        rootPrefix,
        limit,
      }),
    );

    const orphanKeys: string[] = [];
    let inspectedObjects = 0;
    let reachableObjects = 0;
    let continuationToken: string | undefined;
    let truncated = false;

    do {
      const page = await this.objectStore.listKeys({
        prefix: rootPrefix,
        continuationToken,
      });

      for (const key of page.keys) {
        if (inspectedObjects >= limit) {
          truncated = true;
          break;
        }
        inspectedObjects += 1;
        if (isReachable(key, reachablePrefixes)) {
          reachableObjects += 1;
        } else {
          orphanKeys.push(key);
        }
      }

      if (truncated) break;
      continuationToken = page.nextContinuationToken ?? undefined;
    } while (continuationToken);

    const deletedObjects =
      dryRun || orphanKeys.length === 0
        ? 0
        : await this.objectStore.deleteKeys(orphanKeys);

    return {
      dryRun,
      rootPrefix,
      reachablePrefixes: reachablePrefixes.length,
      inspectedObjects,
      reachableObjects,
      orphanObjects: orphanKeys.length,
      deletedObjects,
      truncated,
      orphanKeys,
    };
  }
}
