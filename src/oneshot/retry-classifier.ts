/**
 * Classifies provider-side failures into retryable (transient) vs deterministic.
 *
 * A deterministic failure is one where requeueing the same inputs will produce
 * the same failure — retrying wastes SQS deliveries, token budget, and wall
 * time. The consumer should call `failRun` instead of requeueing.
 *
 * Patterns covered:
 *
 * - Claude Code output cap overflow ("response exceeded the N output token
 *   maximum") — the model hit the configured maxOutputTokens; retry without
 *   raising the cap will overflow again at the same point.
 *
 * - `schema_invalid_after_success` and
 *   `retrofit_contract_missing_after_normalization` failureKinds — SDK returned
 *   output but plan/review validation rejected it. Same model + same schema
 *   produces the same invalid shape.
 *
 * - `structured_output_retries_exhausted` failureKind — provider already
 *   burned its internal repair attempts; consumer-level retry adds nothing.
 *
 * - `already_applied` retrofit outcomes — planner proved the source change is
 *   already patch-equivalent on the target branch, so retrying cannot produce
 *   missing retrofit work.
 *
 * - `retrofit_branch_mismatch` / `retrofit_source_branch_missing` outcomes —
 *   qualification metadata and repository state conflict with the run inputs.
 */
export function isDeterministicFailure(errorMessage: string): boolean {
  if (!errorMessage) return false;

  if (
    /^(already_applied|retrofit_branch_mismatch|retrofit_source_branch_missing):/i.test(
      errorMessage,
    )
  ) {
    return true;
  }

  if (/response exceeded the \d+ output token maximum/i.test(errorMessage)) {
    return true;
  }

  if (errorMessage.includes("schema_invalid_after_success")) {
    return true;
  }

  if (errorMessage.includes("retrofit_contract_missing_after_normalization")) {
    return true;
  }

  if (errorMessage.includes("structured_output_retries_exhausted")) {
    return true;
  }

  return false;
}
