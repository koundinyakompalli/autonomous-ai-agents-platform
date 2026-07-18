export const MAX_TASK_PROCESSING_ATTEMPTS = 3;

export function nextTaskProcessingRetryCount(
  retryCount: number | null | undefined,
): number {
  return (retryCount ?? 0) + 1;
}

export function hasExhaustedTaskProcessingAttempts(
  retryCount: number | null | undefined,
): boolean {
  return (retryCount ?? 0) >= MAX_TASK_PROCESSING_ATTEMPTS;
}

export function willExhaustTaskProcessingAttempts(
  retryCount: number | null | undefined,
): boolean {
  return (
    nextTaskProcessingRetryCount(retryCount) >= MAX_TASK_PROCESSING_ATTEMPTS
  );
}
