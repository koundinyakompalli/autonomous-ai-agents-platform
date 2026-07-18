/**
 * Provider-agnostic transient-vs-deterministic error classifier.
 *
 * "Transient" = network blips, throttling, 5xx, timeouts, contention — the
 * same call retried after a short backoff has a real chance of succeeding.
 * "Deterministic" = bad input, validation, auth, unsupported format, missing
 * configuration, or explicit semantic-failure markers — retrying the same
 * inputs will fail identically, so callers should fail fast instead of
 * burning queue deliveries / token budget / wall time.
 *
 * Default policy: when a message does not clearly match either bucket, return
 * `false` from {@link isTransientError} so callers do NOT hot-spin a futile
 * retry loop on an unknown error.
 *
 * Patterns derived from `src/oneshot/retry-classifier.ts` and the Bedrock /
 * markitdown / ffmpeg classifier in
 * `src/spec-factory/compose-conversion.ts#isTransientConversionError` are
 * carried over here so adopters preserve their semantics. Callers that need
 * extra deterministic markers (e.g. domain-specific `already_applied:` or
 * `MY_FAILURE_MARKER` strings) can layer them via
 * {@link IsDeterministicErrorOptions.extraDeterministicPatterns} without
 * forking this module.
 */

// 429 / throttling / rate-limit signals are technically 4xx but semantically
// transient (the next attempt after backoff has a real chance of succeeding),
// so they are matched FIRST and short-circuit the deterministic 4xx check.
const RATE_LIMIT_TRANSIENT_PATTERN =
  /throttl|too ?many ?requests|rate ?exceed|\b429\b/i;

const TRANSIENT_PATTERN =
  /service ?unavailable|\b5\d\d\b|timed out|timeout|econnreset|econnrefused|etimedout|socket hang up|network|temporar|502|503|504/i;

// Generic deterministic markers (validation, 4xx client errors, auth,
// configuration). Mirrors the spec-factory compose-conversion classifier so
// it can later delegate here. Note: 429 is explicitly excluded above.
const GENERIC_DETERMINISTIC_PATTERN =
  /\b4\d\d\b|validation|unsupported|access ?denied|forbidden|unauthorized|not configured|invalid/i;

// OneShot-derived deterministic markers. Mirrors
// src/oneshot/retry-classifier.ts so that consumer.ts can later delegate.
const ONESHOT_OUTPUT_TOKEN_OVERFLOW =
  /response exceeded the \d+ output token maximum/i;
const ONESHOT_RETROFIT_PREFIX =
  /^(already_applied|retrofit_branch_mismatch|retrofit_source_branch_missing):/i;
const ONESHOT_FAILURE_KIND_MARKERS = [
  "schema_invalid_after_success",
  "structured_output_retries_exhausted",
] as const;

function normalize(message: unknown): string {
  if (typeof message !== "string") return "";
  return message;
}

function matchesAny(
  message: string,
  patterns: ReadonlyArray<string | RegExp>,
): boolean {
  const lower = message.toLowerCase();
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      if (lower.includes(pattern.toLowerCase())) return true;
    } else if (pattern.test(message)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns `true` when the error message looks like a retryable infrastructure
 * blip (throttling / 429 / 5xx / connection reset / timeout / temporary
 * failure). Returns `false` for empty / unknown / deterministic inputs so
 * callers default to "do not retry".
 *
 * Deterministic markers (validation, 4xx, auth, unsupported, "not configured")
 * take precedence over transient phrases — a `422 timeout` is still a bad
 * request, not a blip.
 */
export function isTransientError(message: string): boolean {
  const text = normalize(message);
  if (!text) return false;

  // Rate-limit signals win even when they overlap the generic 4xx pattern:
  // 429 / throttling / "rate exceeded" are infrastructure backpressure, not
  // bad input.
  if (RATE_LIMIT_TRANSIENT_PATTERN.test(text)) {
    return true;
  }

  if (GENERIC_DETERMINISTIC_PATTERN.test(text)) {
    return false;
  }

  return TRANSIENT_PATTERN.test(text);
}

export interface IsDeterministicErrorOptions {
  /**
   * Additional deterministic markers to recognize. Useful when a caller has
   * domain-specific failure strings (e.g. Bedrock segment-too-large, OneShot
   * retrofit prefixes) without forking the core classifier.
   *
   * String patterns are matched case-insensitively as substrings; RegExp
   * patterns are tested against the raw message.
   */
  extraDeterministicPatterns?: ReadonlyArray<string | RegExp>;
}

/**
 * Returns `true` when the error message matches a known deterministic marker
 * — validation / 4xx / auth / unsupported / not-configured, or any of the
 * OneShot-derived markers (output-token overflow, schema_invalid_after_success,
 * structured_output_retries_exhausted, already_applied:/retrofit_*: prefixes).
 *
 * Returns `false` for empty / unknown messages so callers can distinguish
 * "known deterministic" from "unsure" — keeping the OneShot semantics where
 * `isDeterministicFailure('')` is `false`.
 *
 * NOTE: This is NOT the strict logical negation of {@link isTransientError}.
 * Both functions can return `false` for the same ambiguous input, by design:
 * the safe default is "don't retry, don't fail-fast either — let the caller
 * decide based on attempt count / receive count".
 */
export function isDeterministicError(
  message: string,
  options: IsDeterministicErrorOptions = {},
): boolean {
  const text = normalize(message);
  if (!text) return false;

  // OneShot-derived markers (carried over from src/oneshot/retry-classifier.ts).
  if (ONESHOT_RETROFIT_PREFIX.test(text)) return true;
  if (ONESHOT_OUTPUT_TOKEN_OVERFLOW.test(text)) return true;
  for (const marker of ONESHOT_FAILURE_KIND_MARKERS) {
    if (text.includes(marker)) return true;
  }

  // Generic deterministic markers (validation/4xx/auth/unsupported/...). Skip
  // when the message also carries a rate-limit signal (429 / throttling) so
  // the two classifiers stay consistent: rate-limit ≠ deterministic.
  if (
    GENERIC_DETERMINISTIC_PATTERN.test(text) &&
    !RATE_LIMIT_TRANSIENT_PATTERN.test(text)
  ) {
    return true;
  }

  // Caller-supplied extensions (Bedrock/markitdown-specific strings, etc.).
  const extras = options.extraDeterministicPatterns;
  if (extras && extras.length > 0 && matchesAny(text, extras)) {
    return true;
  }

  return false;
}
