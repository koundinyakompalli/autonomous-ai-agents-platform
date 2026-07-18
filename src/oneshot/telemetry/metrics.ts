/**
 * Custom metrics for the oneshot pipeline.
 *
 * All instruments are created eagerly at module load via the `@opentelemetry/api`
 * facade. When OTEL is disabled the global API returns noop instruments, so
 * recording calls are safe to make unconditionally.
 */

import { metrics } from "@opentelemetry/api";

const METER_NAME = "specter-oneshot";
type MetricAttributes = Record<string, string | number | boolean>;

function getMeter() {
  return metrics.getMeter(METER_NAME);
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/** Duration of a oneshot stage execution in milliseconds. */
export const runDurationHistogram = getMeter().createHistogram(
  "oneshot.run.duration_ms",
  {
    description: "Duration of a oneshot stage in milliseconds",
    unit: "ms",
  },
);

/** Cost of a oneshot stage in USD. */
export const runCostHistogram = getMeter().createHistogram(
  "oneshot.run.cost_usd",
  {
    description: "Cost of a oneshot stage in USD",
    unit: "usd",
  },
);

/** LLM invocation latency in milliseconds. */
export const llmLatencyHistogram = getMeter().createHistogram(
  "oneshot.llm.latency_ms",
  {
    description: "LLM invocation latency in milliseconds",
    unit: "ms",
  },
);

/** LLM token usage per invocation. */
export const llmTokensHistogram = getMeter().createHistogram(
  "oneshot.llm.tokens",
  {
    description: "LLM token usage per invocation",
    unit: "tokens",
  },
);

/** Time spent waiting to acquire a repo-cache lease. */
export const repoCacheLockWaitHistogram = getMeter().createHistogram(
  "oneshot.workspace.repo_cache_lock_wait_ms",
  {
    description: "Time spent waiting to acquire a repo-cache lease",
    unit: "ms",
  },
);

/** Time spent holding a repo-cache lease. */
export const repoCacheLockHoldHistogram = getMeter().createHistogram(
  "oneshot.workspace.repo_cache_lock_hold_ms",
  {
    description: "Time spent holding a repo-cache lease by operation phase",
    unit: "ms",
  },
);

/** Time spent waiting to acquire a run-worktree lease. */
export const workspaceLockWaitHistogram = getMeter().createHistogram(
  "oneshot.workspace.lock_wait_ms",
  {
    description: "Time spent waiting to acquire a run-worktree lease",
    unit: "ms",
  },
);

/** Duration of git fetch operations. */
export const repoFetchDurationHistogram = getMeter().createHistogram(
  "oneshot.workspace.repo_fetch_ms",
  {
    description: "Duration of repo-cache fetch operations",
    unit: "ms",
  },
);

/** Duration of first-time bare mirror hydration. */
export const repoCacheColdHydrationDurationHistogram =
  getMeter().createHistogram("oneshot.workspace.repo_cache_cold_hydration_ms", {
    description: "Duration of first-time repo-cache bare mirror hydration",
    unit: "ms",
  });

/** Duration of worktree preparation operations. */
export const worktreePrepareDurationHistogram = getMeter().createHistogram(
  "oneshot.workspace.prepare_ms",
  {
    description: "Duration of OneShot worktree preparation",
    unit: "ms",
  },
);

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/** Count of oneshot stage outcomes (success / failed / escalated / blocked). */
export const runOutcomeCounter = getMeter().createCounter(
  "oneshot.run.outcome",
  {
    description: "Count of oneshot stage outcomes",
  },
);

/** Count of review revision loops. */
export const reviewLoopCounter = getMeter().createCounter(
  "oneshot.review.loops",
  {
    description: "Count of review revision loops",
  },
);

/** Count of verification (code-review / test) loops. */
export const verificationLoopCounter = getMeter().createCounter(
  "oneshot.verification.loops",
  {
    description: "Count of verification (code-review/test) loops",
  },
);

/** Count of workspace reuse vs. fresh creation. */
export const workspaceReuseCounter = getMeter().createCounter(
  "oneshot.workspace.reuse",
  {
    description: "Count of workspace reuse vs. creation",
  },
);

/** Count of lease acquire retries under contention. */
export const leaseAcquireRetryCounter = getMeter().createCounter(
  "oneshot.workspace.lease_acquire_retry",
  {
    description: "Count of workspace lease acquire retries",
  },
);

/** Count of expired lease reclaims. */
export const leaseReclaimCounter = getMeter().createCounter(
  "oneshot.workspace.lease_reclaim",
  {
    description: "Count of expired workspace lease reclaims",
  },
);

/** Count of workers that lost a lease fencing token mid-operation. */
export const leaseLostCounter = getMeter().createCounter(
  "oneshot.workspace.lease_lost",
  {
    description:
      "Count of workspace lease losses detected by fencing token verification",
  },
);

/** Count of workspace lease heartbeat failures. */
export const leaseHeartbeatFailureCounter = getMeter().createCounter(
  "oneshot.workspace.lease_heartbeat_failure",
  {
    description: "Count of workspace lease heartbeat failures",
  },
);

/** Count of workspace cleanup attempts skipped because a lease is active. */
export const workspaceCleanupSkippedCounter = getMeter().createCounter(
  "oneshot.workspace.cleanup_skipped",
  {
    description:
      "Count of workspace cleanup attempts skipped because a workspace lease is active",
  },
);

/** Count of candidate SHA mismatches detected by workspace/candidate guards. */
export const candidateShaMismatchCounter = getMeter().createCounter(
  "oneshot.workspace.candidate_sha_mismatch",
  {
    description: "Count of candidate SHA mismatch detections",
  },
);

/** Bytes removed from ephemeral scratch cleanup. */
export const scratchCleanupBytesCounter = getMeter().createCounter(
  "oneshot.workspace.scratch_cleanup_bytes",
  {
    description: "Bytes removed from ephemeral scratch cleanup",
    unit: "By",
  },
);

/** Count of failed ephemeral scratch cleanup attempts. */
export const scratchCleanupFailureCounter = getMeter().createCounter(
  "oneshot.workspace.scratch_cleanup_failures",
  {
    description: "Count of failed ephemeral scratch cleanup attempts",
  },
);

/** Count of blocked bash commands. */
export const bashBlockedCounter = getMeter().createCounter(
  "oneshot.bash.blocked",
  {
    description: "Count of blocked bash commands",
  },
);

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Record standard metrics for a completed stage in a single call.
 *
 * @param stage    - Pipeline stage name (e.g. 'planning', 'implementation')
 * @param outcome  - Terminal outcome for this stage execution
 * @param durationMs - Wall-clock duration in milliseconds
 * @param costUsd  - Optional LLM cost in USD
 * @param tokenCount - Optional total token count
 */
export function recordStageMetrics(
  stage: string,
  outcome: "success" | "failed" | "escalated" | "blocked",
  durationMs: number,
  costUsd?: number,
  tokenCount?: number,
  extraAttributes: MetricAttributes = {},
): void {
  const attributes = { stage, outcome, ...extraAttributes };

  runDurationHistogram.record(durationMs, attributes);
  runOutcomeCounter.add(1, attributes);

  if (costUsd !== undefined) {
    runCostHistogram.record(costUsd, attributes);
  }

  if (tokenCount !== undefined) {
    llmTokensHistogram.record(tokenCount, {
      stage,
      outcome,
      token_type: "total",
      ...extraAttributes,
    });
  }
}

export function recordLlmMetrics(
  stage: string,
  provider: string,
  durationMs: number,
  tokensUsed?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
  costUsd?: number,
  extraAttributes: MetricAttributes = {},
): void {
  const baseAttributes = { stage, provider, ...extraAttributes };
  llmLatencyHistogram.record(durationMs, baseAttributes);

  if (costUsd !== undefined) {
    runCostHistogram.record(costUsd, baseAttributes);
  }

  if (!tokensUsed) {
    return;
  }

  const input = tokensUsed.input ?? 0;
  const output = tokensUsed.output ?? 0;
  const cacheRead = tokensUsed.cacheRead ?? 0;
  const cacheWrite = tokensUsed.cacheWrite ?? 0;
  const total = input + output + cacheRead + cacheWrite;

  if (input > 0) {
    llmTokensHistogram.record(input, {
      stage,
      provider,
      token_type: "input",
      ...extraAttributes,
    });
  }
  if (output > 0) {
    llmTokensHistogram.record(output, {
      stage,
      provider,
      token_type: "output",
      ...extraAttributes,
    });
  }
  if (cacheRead > 0) {
    llmTokensHistogram.record(cacheRead, {
      stage,
      provider,
      token_type: "cache_read",
      ...extraAttributes,
    });
  }
  if (cacheWrite > 0) {
    llmTokensHistogram.record(cacheWrite, {
      stage,
      provider,
      token_type: "cache_write",
      ...extraAttributes,
    });
  }
  if (total > 0) {
    llmTokensHistogram.record(total, {
      stage,
      provider,
      token_type: "total",
      ...extraAttributes,
    });
  }
}
