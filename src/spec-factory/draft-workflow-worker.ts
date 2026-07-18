import { createHash } from "node:crypto";
import type {
  ClaimedDraftStageRun,
  DraftStageArtifactPointer,
  DraftStageExecutionOutput,
  DraftWorkflowStage,
} from "./draft-workflow-types.js";
import type { ImmutableArtifactStore } from "./storage/immutable-s3-artifact-store.js";

export interface DraftWorkflowStore {
  claimNextDraftStage(input: {
    workerId: string;
    leaseMs?: number;
  }): Promise<ClaimedDraftStageRun | null>;
  completeDraftStage(input: {
    stageRun: ClaimedDraftStageRun;
    result: DraftStageExecutionOutput;
    durationMs: number;
  }): Promise<boolean>;
  failDraftStage(input: {
    stageRun: ClaimedDraftStageRun;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    durationMs: number;
  }): Promise<boolean>;
}

export type DraftStageHandler = (
  stageRun: ClaimedDraftStageRun,
) => Promise<DraftStageExecutionOutput>;

export interface DraftWorkflowWorkerOptions {
  workerId: string;
  leaseMs?: number;
  concurrency?: number;
  handlers: Partial<Record<DraftWorkflowStage, DraftStageHandler>>;
  artifactStore?: ImmutableArtifactStore;
}

export class DraftWorkflowWorker {
  private readonly concurrency: number;

  constructor(
    private readonly store: DraftWorkflowStore,
    private readonly options: DraftWorkflowWorkerOptions,
  ) {
    this.concurrency = Math.max(1, Math.min(16, options.concurrency ?? 2));
  }

  async drain(): Promise<number> {
    let completed = 0;
    while (true) {
      const claimed = await Promise.all(
        Array.from({ length: this.concurrency }, () =>
          this.store.claimNextDraftStage({
            workerId: this.options.workerId,
            leaseMs: this.options.leaseMs,
          }),
        ),
      );
      const runs = deduplicateClaims(claimed.filter(isClaimedStage));
      if (runs.length === 0) return completed;
      const results = await Promise.all(runs.map((run) => this.execute(run)));
      completed += results.filter(Boolean).length;
    }
  }

  private async execute(stageRun: ClaimedDraftStageRun): Promise<boolean> {
    const startedAt = Date.now();
    const handler = this.options.handlers[stageRun.stageName];
    if (!handler) {
      await this.store.failDraftStage({
        stageRun,
        errorCode: "draft_stage_handler_missing",
        errorMessage: `No handler is configured for ${stageRun.stageName}`,
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
      return false;
    }
    try {
      const hydratedRun = await this.hydratePriorOutputs(stageRun);
      const result = await handler(hydratedRun);
      const persistedResult = await this.persistStageOutput(stageRun, result);
      return this.store.completeDraftStage({
        stageRun,
        result: persistedResult,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = classifyDraftStageError(message);
      await this.store.failDraftStage({
        stageRun,
        errorCode,
        errorMessage: message,
        retryable: isRetryableDraftStageError(message),
        durationMs: Date.now() - startedAt,
      });
      return false;
    }
  }

  private async hydratePriorOutputs(
    stageRun: ClaimedDraftStageRun,
  ): Promise<ClaimedDraftStageRun> {
    const priorOutputs: ClaimedDraftStageRun["priorOutputs"] = {};
    for (const [stage, value] of Object.entries(stageRun.priorOutputs)) {
      if (!isArtifactPointer(value)) {
        priorOutputs[stage as DraftWorkflowStage] = value;
        continue;
      }
      if (!this.options.artifactStore) {
        throw new Error("draft_stage_artifact_store_required");
      }
      const body = await this.options.artifactStore.read(value.artifactUri);
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (body.byteLength !== value.bytes || sha256 !== value.sha256) {
        throw new Error(`draft_stage_artifact_verification_failed:${stage}`);
      }
      priorOutputs[stage as DraftWorkflowStage] = JSON.parse(
        body.toString("utf8"),
      );
    }
    return { ...stageRun, priorOutputs };
  }

  private async persistStageOutput(
    stageRun: ClaimedDraftStageRun,
    result: DraftStageExecutionOutput,
  ): Promise<DraftStageExecutionOutput> {
    if (!this.options.artifactStore) return result;
    const body = Buffer.from(JSON.stringify(result.output ?? null), "utf8");
    const artifact = await this.options.artifactStore.write({
      workspacePath: `spec-factory/workflows/${stageRun.workflowId}`,
      relativePath: `stages/${stageRun.stageName}/attempt-${stageRun.attemptCount}.json`,
      content: body,
    });
    const pointer: DraftStageArtifactPointer = {
      artifactUri: artifact.artifactUri,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    };
    return {
      ...result,
      databaseOutput: pointer,
      outputArtifactUri: artifact.artifactUri,
      outputSha256: artifact.sha256,
      outputBytes: artifact.bytes,
    };
  }
}

function isArtifactPointer(value: unknown): value is DraftStageArtifactPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pointer = value as Partial<DraftStageArtifactPointer>;
  return (
    typeof pointer.artifactUri === "string" &&
    typeof pointer.sha256 === "string" &&
    typeof pointer.bytes === "number"
  );
}

function isClaimedStage(
  value: ClaimedDraftStageRun | null,
): value is ClaimedDraftStageRun {
  return value !== null;
}

function deduplicateClaims(
  runs: ClaimedDraftStageRun[],
): ClaimedDraftStageRun[] {
  const seen = new Set<number>();
  return runs.filter((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
}

function classifyDraftStageError(message: string): string {
  if (/timeout|timed out/i.test(message)) return "provider_timeout";
  if (/throttl|429|503|service unavailable/i.test(message)) {
    return "provider_unavailable";
  }
  if (/validation/i.test(message)) return "validation_failed";
  if (/not qualified|needs_repo/i.test(message)) return "not_qualified";
  return "draft_stage_failed";
}

function isRetryableDraftStageError(message: string): boolean {
  return /timeout|timed out|throttl|429|500|502|503|504|service unavailable|ECONNRESET|ETIMEDOUT/i.test(
    message,
  );
}
