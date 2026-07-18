import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getVisibilityTimeoutFromEnv,
  getTransientRetryDelaySeconds,
  getTransientRetryMaxAttempts,
  resetBackoffScheduleCache,
  TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
} from "./consumer-visibility.js";

const ENV_NAME = "ONESHOT_TEST_VISIBILITY_TIMEOUT_SECONDS";

describe("getVisibilityTimeoutFromEnv", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the default when the env var is unset", () => {
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(1800);
  });

  it("returns the default when the env var is empty string", () => {
    vi.stubEnv(ENV_NAME, "");
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(1800);
  });

  it("returns the default when the env var is whitespace-only", () => {
    vi.stubEnv(ENV_NAME, "   ");
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(1800);
  });

  it("returns the parsed value when the env var is a positive integer", () => {
    vi.stubEnv(ENV_NAME, "120");
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(120);
  });

  it("returns the parsed value after trimming surrounding whitespace", () => {
    vi.stubEnv(ENV_NAME, "  240  ");
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(240);
  });

  it("returns the default when the env var is zero (not meaningful for SQS)", () => {
    vi.stubEnv(ENV_NAME, "0");
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(1800);
  });

  it("returns the default when the env var is negative", () => {
    vi.stubEnv(ENV_NAME, "-30");
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(1800);
  });

  it("returns the default when the env var is non-numeric", () => {
    vi.stubEnv(ENV_NAME, "foo");
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(1800);
  });

  it("does NOT clamp large values (SQS itself enforces the 12h upper bound)", () => {
    // Chosen well above the SQS max of 43200 to document intent.
    vi.stubEnv(ENV_NAME, "86400");
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(86400);
  });

  it("parseInt semantics: 120.9 is parsed as 120", () => {
    // parseInt with radix 10 truncates trailing non-digits; this is the
    // expected coercion for env-string inputs.
    vi.stubEnv(ENV_NAME, "120.9");
    expect(getVisibilityTimeoutFromEnv(ENV_NAME, 1800)).toBe(120);
  });
});

describe("getTransientRetryDelaySeconds", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetBackoffScheduleCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetBackoffScheduleCache();
  });

  it("returns 120 for receiveCount=1 with default schedule", () => {
    expect(getTransientRetryDelaySeconds(1)).toBe(120);
  });

  it("returns 300 for receiveCount=2 with default schedule", () => {
    expect(getTransientRetryDelaySeconds(2)).toBe(300);
  });

  it("returns 600 for receiveCount=3 with default schedule", () => {
    expect(getTransientRetryDelaySeconds(3)).toBe(600);
  });

  it("returns null for receiveCount=4 (exhausted)", () => {
    expect(getTransientRetryDelaySeconds(4)).toBeNull();
  });

  it("returns null for receiveCount=5 (exhausted)", () => {
    expect(getTransientRetryDelaySeconds(5)).toBeNull();
  });

  it("returns null for receiveCount=0 (invalid edge case)", () => {
    expect(getTransientRetryDelaySeconds(0)).toBeNull();
  });

  it("uses a custom schedule from env var", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "60,180,360");
    resetBackoffScheduleCache();
    expect(getTransientRetryDelaySeconds(1)).toBe(60);
    expect(getTransientRetryDelaySeconds(2)).toBe(180);
    expect(getTransientRetryDelaySeconds(3)).toBe(360);
    expect(getTransientRetryDelaySeconds(4)).toBeNull();
  });

  it("falls back to default schedule when env var is empty", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "");
    resetBackoffScheduleCache();
    expect(getTransientRetryDelaySeconds(1)).toBe(120);
    expect(getTransientRetryDelaySeconds(2)).toBe(300);
    expect(getTransientRetryDelaySeconds(3)).toBe(600);
  });

  it("falls back to default schedule when env var is non-numeric", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "foo,bar,baz");
    resetBackoffScheduleCache();
    expect(getTransientRetryDelaySeconds(1)).toBe(120);
    expect(getTransientRetryDelaySeconds(3)).toBe(600);
  });

  it("falls back to default schedule when env var contains zeros", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "0,300,600");
    resetBackoffScheduleCache();
    expect(getTransientRetryDelaySeconds(1)).toBe(120);
  });

  it("falls back to default schedule when env var contains negative values", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "-60,300,600");
    resetBackoffScheduleCache();
    expect(getTransientRetryDelaySeconds(1)).toBe(120);
  });

  it("falls back to default schedule when env var has fewer than three entries", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "30,90");
    resetBackoffScheduleCache();
    expect(getTransientRetryDelaySeconds(1)).toBe(120);
    expect(getTransientRetryDelaySeconds(2)).toBe(300);
    expect(getTransientRetryDelaySeconds(3)).toBe(600);
    expect(getTransientRetryDelaySeconds(4)).toBeNull();
  });

  it("falls back to default schedule when env var has more than three entries", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "60,120,300,600");
    resetBackoffScheduleCache();
    expect(getTransientRetryDelaySeconds(1)).toBe(120);
    expect(getTransientRetryDelaySeconds(2)).toBe(300);
    expect(getTransientRetryDelaySeconds(3)).toBe(600);
    expect(getTransientRetryDelaySeconds(4)).toBeNull();
  });
});

describe("getTransientRetryMaxAttempts", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetBackoffScheduleCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetBackoffScheduleCache();
  });

  it("returns 3 for the default schedule '120,300,600'", () => {
    expect(getTransientRetryMaxAttempts()).toBe(3);
  });

  it("returns 3 for a custom 2-entry schedule because it falls back to default", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "30,90");
    resetBackoffScheduleCache();
    expect(getTransientRetryMaxAttempts()).toBe(3);
  });

  it("returns 3 for a custom 4-entry schedule because it falls back to default", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "60,120,300,600");
    resetBackoffScheduleCache();
    expect(getTransientRetryMaxAttempts()).toBe(3);
  });

  it("returns 3 (default) when env var is invalid", () => {
    vi.stubEnv("ONESHOT_TRANSIENT_RETRY_BACKOFF_SECONDS", "bad,input");
    resetBackoffScheduleCache();
    expect(getTransientRetryMaxAttempts()).toBe(3);
  });

  it("exports constants for fixed retry count and exhaustion delivery", () => {
    expect(TRANSIENT_RETRY_MAX_ATTEMPTS).toBe(3);
    expect(TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT).toBe(4);
  });
});
