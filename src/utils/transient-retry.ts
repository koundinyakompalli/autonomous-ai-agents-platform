import { isTransientError } from "./retry-classifier.js";

/**
 * Provider-agnostic transient-retry primitives.
 *
 * Two pieces of behaviour are extracted here so multiple consumers (OneShot
 * SQS handlers, Spec Factory conversion worker, future callers) share one
 * implementation:
 *
 * 1. A backoff schedule (`getRetryDelayMs` / `getMaxAttempts`) — exponential-ish
 *    delays in milliseconds, indexed by attempts already made and clamped to
 *    the last entry so any over-shoot still uses the largest backoff.
 *
 * 2. An async runner (`withTransientRetry`) — wraps a function, retries on
 *    transient errors with backoff, rethrows on deterministic errors or once
 *    `maxAttempts` is exhausted, and surfaces each retry decision via an
 *    optional `onRetry` callback (perfect for structured logging).
 *
 * The defaults (15s, 60s, 180s) match
 * `src/spec-factory/compose-conversion.ts#DEFAULT_RETRY_BACKOFF_MS`. OneShot's
 * `consumer-visibility.ts` schedule is in *seconds* and visibility-driven
 * (120s, 300s, 600s) — that callsite owns its own SQS-aware wiring; the
 * helpers here are for in-process retry loops.
 *
 * Tests MUST inject `sleep` (or use fake timers) to keep wall time bounded.
 */

export const DEFAULT_TRANSIENT_RETRY_BACKOFF_MS: ReadonlyArray<number> = [
  15_000,
  60_000,
  180_000,
];

function clampIndex(attemptsMade: number, length: number): number {
  if (length <= 0) return -1;
  if (attemptsMade < 0) return 0;
  if (attemptsMade >= length) return length - 1;
  return attemptsMade;
}

/**
 * Returns the backoff delay in milliseconds for retry number `attemptsMade`
 * (0-based: 0 = delay before first retry, 1 = delay before second retry, ...).
 *
 * Delays past the end of the schedule clamp to the last entry so a runaway
 * loop still waits the maximum backoff rather than 0ms. An empty schedule
 * returns 0 (no delay) — caller decides whether that means "retry immediately"
 * or "give up".
 */
export function getRetryDelayMs(
  attemptsMade: number,
  schedule: ReadonlyArray<number> = DEFAULT_TRANSIENT_RETRY_BACKOFF_MS,
): number {
  const idx = clampIndex(attemptsMade, schedule.length);
  if (idx < 0) return 0;
  return schedule[idx];
}

/**
 * Returns the total number of attempts allowed for one operation: 1 initial
 * attempt + one retry per backoff entry. An empty schedule means "no retries"
 * (just the initial attempt → 1).
 */
export function getMaxAttempts(
  schedule: ReadonlyArray<number> = DEFAULT_TRANSIENT_RETRY_BACKOFF_MS,
): number {
  return schedule.length + 1;
}

export interface RetryEvent {
  /** 1-based attempt number that just failed (i.e. how many retries are about to be triggered). */
  attempt: number;
  /** Milliseconds the runner is about to sleep before the next attempt. */
  delayMs: number;
  /** The error thrown by the failed attempt. */
  error: unknown;
}

export interface WithTransientRetryOptions {
  /** Override the default backoff schedule (ms). */
  schedule?: ReadonlyArray<number>;
  /**
   * Cap on total attempts (initial + retries). Defaults to
   * `getMaxAttempts(schedule)`. Useful when the caller wants a smaller cap
   * than the full schedule allows.
   */
  maxAttempts?: number;
  /**
   * Predicate deciding whether an error is worth retrying. Defaults to the
   * shared {@link isTransientError} classifier. Receives the error message
   * (Error.message or `String(error)` for non-Error throws).
   */
  isTransient?: (message: string) => boolean;
  /** Hook invoked before each backoff sleep. Great for structured logging. */
  onRetry?: (event: RetryEvent) => void | Promise<void>;
  /**
   * Sleep function (ms → Promise<void>). Defaults to `setTimeout`-based.
   * Tests MUST inject a fake or use vi.useFakeTimers to avoid waiting.
   */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Runs `fn`, retrying on transient errors with exponential-ish backoff and
 * rethrowing on deterministic errors or once attempts are exhausted.
 *
 * Behaviour:
 * - First failure runs the predicate. If deterministic → rethrow immediately.
 * - If transient and attempts remain → call `onRetry`, sleep
 *   `getRetryDelayMs(retriesSoFar, schedule)`, then re-invoke.
 * - On exhaustion → rethrow the last error (do not wrap, so callers see the
 *   original stack/code).
 *
 * `onRetry` is awaited if it returns a promise so async logging cannot drop.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: WithTransientRetryOptions = {},
): Promise<T> {
  const schedule = options.schedule ?? DEFAULT_TRANSIENT_RETRY_BACKOFF_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? getMaxAttempts(schedule));
  const sleep = options.sleep ?? defaultSleep;
  const isTransient = options.isTransient ?? isTransientError;
  const onRetry = options.onRetry;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      const msg = errorMessage(error);
      const transient = isTransient(msg);
      const hasAttemptsLeft = attempt < maxAttempts;

      if (!transient || !hasAttemptsLeft) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attempt - 1, schedule);
      if (onRetry) {
        await onRetry({ attempt, delayMs, error });
      }
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}
