export class IdempotencyConflictError extends Error {
  constructor(message = "idempotency_key_reused") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class ResearchBudgetError extends Error {
  constructor(readonly reason: string) {
    super(`research_budget_rejected:${reason}`);
    this.name = "ResearchBudgetError";
  }
}

export class SourceRestoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRestoreUnavailableError";
  }
}
