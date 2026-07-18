export interface ErrorLogFields {
  err?: Error
  error?: unknown
  errorCode?: string
  errorMessage: string
  errorName?: string
  errorStack?: string
}

function stringifyUnknownError(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }

  if (error === undefined) {
    return 'undefined'
  }

  if (error === null) {
    return 'null'
  }

  try {
    const serialized = JSON.stringify(error)
    return serialized === undefined ? String(error) : serialized
  } catch {
    return String(error)
  }
}

export function buildErrorLogFields(error: unknown): ErrorLogFields {
  if (error instanceof Error) {
    const errorCode = (error as NodeJS.ErrnoException).code

    return {
      err: error,
      errorCode: typeof errorCode === 'string' ? errorCode : undefined,
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack,
    }
  }

  return {
    error,
    errorMessage: stringifyUnknownError(error),
  }
}
