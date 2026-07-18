/**
 * Parses a per-stage SQS visibility-timeout override from the environment.
 *
 * Each OneShot consumer has a prod-appropriate default (planner 1800s,
 * implementer longer, etc.) but local dev benefits from much shorter
 * timeouts so retryable validation failures cycle back into the queue in
 * seconds rather than tens of minutes. Rather than hard-coding a local
 * default, each consumer reads `ONESHOT_<STAGE>_VISIBILITY_TIMEOUT_SECONDS`
 * and falls back to its prod default when unset or invalid.
 *
 * The helper returns `defaultSeconds` when:
 *   - the env var is unset or empty/whitespace
 *   - the value is not a positive integer
 *
 * It does NOT clamp to the SQS upper bound (43200 = 12h); SQS itself
 * rejects out-of-range values at ChangeMessageVisibility time, which is
 * the correct place for that validation.
 */
export function getVisibilityTimeoutFromEnv(
  envName: string,
  defaultSeconds: number,
): number {
  const raw = process.env[envName];
  if (!raw || !raw.trim()) {
    return defaultSeconds;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultSeconds;
  }
  return parsed;
}

export const DEFAULT_TRANSIENT_RETRY_BACKOFF_SCHEDULE = [120, 300, 600] as const;
export const TRANSIENT_RETRY_MAX_ATTEMPTS =
  DEFAULT_TRANSIENT_RETRY_BACKOFF_SCHEDULE.length;
export const TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT =
  TRANSIENT_RETRY_MAX_ATTEMPTS + 1;

/**
 * Returns the SQS visibility-timeout delay in seconds for a transient-retry
 * attempt, based on `receiveCount` and the `ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS`
 * environment variable (default `'120,300,600'`).
 *
 * - receiveCount=1 → schedule[0] (120s by default)
 * - receiveCount=2 → schedule[1] (300s by default)
 * - receiveCount=3 → schedule[2] (600s by default)
 * - receiveCount>=4 → null (exhausted; caller should DLQ or fail)
 *
 * The env var is parsed on first call and cached for the process lifetime.
 * On invalid/empty input, or when the schedule does not have exactly three
 * entries, the default schedule is used.
 */
let cachedBackoffSchedule: readonly number[] | null = null;

function getBackoffSchedule(): readonly number[] {
  if (cachedBackoffSchedule !== null) {
    return cachedBackoffSchedule;
  }
  const raw = process.env['ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS'];
  if (!raw || !raw.trim()) {
    cachedBackoffSchedule = DEFAULT_TRANSIENT_RETRY_BACKOFF_SCHEDULE;
    return cachedBackoffSchedule;
  }
  const parts = raw.split(',').map((s) => Number.parseInt(s.trim(), 10));
  if (
    parts.length !== TRANSIENT_RETRY_MAX_ATTEMPTS ||
    parts.some((v) => !Number.isFinite(v) || v <= 0)
  ) {
    cachedBackoffSchedule = DEFAULT_TRANSIENT_RETRY_BACKOFF_SCHEDULE;
    return cachedBackoffSchedule;
  }
  cachedBackoffSchedule = parts;
  return cachedBackoffSchedule;
}

export function getTransientRetryDelaySeconds(receiveCount: number): number | null {
  const schedule = getBackoffSchedule();
  const index = receiveCount - 1;
  if (index < 0 || index >= schedule.length) {
    return null;
  }
  return schedule[index];
}

/**
 * Returns the total number of transient retry attempts allowed before
 * exhaustion, derived from the active backoff schedule length.
 * Equals the fixed schedule length (default 3 for '120,300,600').
 */
export function getTransientRetryMaxAttempts(): number {
  return TRANSIENT_RETRY_MAX_ATTEMPTS;
}

/**
 * Resets the cached backoff schedule. Intended for use in tests only.
 * @internal
 */
export function resetBackoffScheduleCache(): void {
  cachedBackoffSchedule = null;
}
