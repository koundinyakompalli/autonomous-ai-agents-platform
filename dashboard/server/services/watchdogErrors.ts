export class WatchdogServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "watchdog_error",
  ) {
    super(message);
    this.name = "WatchdogServiceError";
  }
}
