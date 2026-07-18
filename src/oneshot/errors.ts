export type OneShotErrorCategory =
  | "git_operation"
  | "llm_provider"
  | "llm_output"
  | "s3_storage"
  | "db_operation"
  | "workspace"
  | "github_api"
  | "ticket_quality"
  | "budget"
  | "agent_logic"
  | "test_runner_skipped"
  | "ci_failure"
  | "unknown";

export interface ClassifiedError {
  category: OneShotErrorCategory;
  retryable: boolean;
  message: string;
  originalError?: string;
  suggestion?: string;
}

interface PatternRule {
  category: OneShotErrorCategory;
  retryable: boolean;
  patterns: string[];
  suggestion: string;
}

const PATTERN_RULES: PatternRule[] = [
  {
    category: "workspace",
    retryable: true,
    patterns: ["workspace_checkout_timeout"],
    suggestion: "Check workspace storage health and file system permissions",
  },
  {
    category: "git_operation",
    retryable: true,
    patterns: [
      "worktree",
      "git clone",
      "git fetch",
      "git push",
      "git reset",
      "not available locally",
      "lock",
      "index.lock",
    ],
    suggestion: "Check EFS mount health and git remote connectivity",
  },
  {
    category: "agent_logic",
    retryable: true,
    patterns: ["SDK_IDLE_TIMEOUT", "SDK timeout after"],
    suggestion:
      "Inspect OneShot planner timeout diagnostics; retry may succeed with larger planning budgets or stronger grounding evidence",
  },
  {
    category: "llm_provider",
    retryable: true,
    patterns: [
      "throttl",
      "rate limit",
      "429",
      "503",
      "timeout",
      "ETIMEDOUT",
      "ECONNRESET",
      "bedrock",
      "overloaded",
    ],
    suggestion: "Check Bedrock/OpenAI service health; retry may resolve",
  },
  {
    category: "llm_output",
    retryable: false,
    patterns: [
      "structured output failed validation",
      "Unexpected token",
      "JSON",
      "parse",
      "empty output",
      "Corrupted artifact JSON",
    ],
    suggestion: "Check prompt and output schema for incompatibilities",
  },
  {
    category: "s3_storage",
    retryable: true,
    patterns: [
      "PutObject",
      "GetObject",
      "S3",
      "NoSuchKey",
      "Empty artifact body",
    ],
    suggestion: "Check S3 bucket permissions and regional availability",
  },
  {
    category: "db_operation",
    retryable: true,
    patterns: [
      "ECONNREFUSED",
      "ER_LOCK_DEADLOCK",
      "Connection lost",
      "PROTOCOL_CONNECTION_LOST",
    ],
    suggestion: "Check database connectivity and connection pool health",
  },
  {
    category: "workspace",
    retryable: true,
    patterns: ["ENOSPC", "EACCES", "EPERM", "disk full"],
    suggestion: "Check workspace storage health and file system permissions",
  },
  {
    category: "github_api",
    retryable: false,
    patterns: ["GitHub pull request", "422", "status 403"],
    suggestion: "Check GitHub token permissions and PR state",
  },
  {
    category: "ticket_quality",
    retryable: false,
    patterns: [
      "Gate score",
      "not found for oneshot",
      "not eligible",
      "Missing qualification",
    ],
    suggestion: "Review ticket content and qualification criteria",
  },
  {
    category: "budget",
    retryable: false,
    patterns: [
      "budget_exceeded",
      "token_budget_exceeded",
      "verification_budget_exhausted",
      "cost budget",
      "budget exhausted",
      "maximum age of 24 hours",
      "exhausted the maximum of",
      "stage attempt(s)",
    ],
    suggestion: "Increase budget limits or reduce task complexity",
  },
  {
    category: "agent_logic",
    retryable: false,
    patterns: [
      "completed without producing any file changes",
      "implementer disagrees with code review",
      "code reviewer blocked the implementation from proceeding",
    ],
    suggestion: "Review agent output and plan for logical conflicts",
  },
  {
    category: "test_runner_skipped",
    retryable: false,
    patterns: [
      "Declared runnable test",
      "test command(s) were skipped",
      "were skipped",
    ],
    suggestion:
      "Investigate why declared test commands did not run; check pom.xml/pytest config and runner availability",
  },
  {
    category: "ci_failure",
    retryable: false,
    patterns: [
      "GitHub CI is pending",
      "GitHub CI is failing",
      "across commit and pull request checks",
      "check run(s)",
    ],
    suggestion:
      "Inspect the GitHub Actions workflow run for the failing/pending check",
  },
];

// github_api rate limit is retryable (special case checked before main loop)
const GITHUB_RATE_LIMIT_PATTERNS = ["rate limit"];

const TOKEN_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // x-access-token in git URL
  { pattern: /x-access-token:[^@]+@/g, replacement: "x-access-token:***@" },
  // Authorization: Bearer
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: "Bearer ***" },
  // AWS access key IDs
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "AKIA***" },
  // Long alphanumeric strings that look like tokens (60+ chars to avoid false positives on SHAs)
  { pattern: /\b[A-Za-z0-9_-]{60,}\b/g, replacement: "***" },
];

export function sanitizeErrorMessage(message: string): string {
  try {
    let sanitized = message;
    for (const { pattern, replacement } of TOKEN_PATTERNS) {
      sanitized = sanitized.replace(pattern, replacement);
    }
    return sanitized;
  } catch {
    return message;
  }
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const NON_RETRYABLE_HANDOFF_PATTERNS = [
  "Missing required OneShot queue environment variable",
  "access denied",
  "AccessDenied",
  "AuthorizationError",
  "branch mismatch",
  "workflow-scope",
];

function isGitHubWorkflowImpactTimeout(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes(
      "unable to determine if workflow can be created or updated due to timeout",
    ) ||
    (lower.includes("workflow") &&
      lower.includes("scope may be required") &&
      lower.includes("timeout") &&
      lower.includes("unable to determine"))
  );
}

export function classifyHandoffError(error: unknown): ClassifiedError {
  const message = extractMessage(error);
  const lower = message.toLowerCase();
  const sanitized = sanitizeErrorMessage(message);

  if (isGitHubWorkflowImpactTimeout(message)) {
    return {
      category: "git_operation",
      retryable: true,
      message: sanitized,
      originalError: error instanceof Error ? error.stack : undefined,
      suggestion:
        "Retry branch creation; GitHub could not determine workflow impact before timing out",
    };
  }

  if (lower.includes("timed out acquiring oneshot workspace lease repo-cache:")) {
    return {
      category: "workspace",
      retryable: true,
      message: sanitized,
      originalError: error instanceof Error ? error.stack : undefined,
      suggestion: "Retry after repo-cache lease contention clears",
    };
  }

  for (const pattern of NON_RETRYABLE_HANDOFF_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return {
        category: lower.includes("branch mismatch")
          ? "git_operation"
          : lower.includes("queue environment")
            ? "unknown"
            : "github_api",
        retryable: false,
        message: sanitized,
        originalError: error instanceof Error ? error.stack : undefined,
        suggestion:
          "Fix handoff configuration or permissions before retrying",
      };
    }
  }

  const classified = classifyError(message);
  if (classified.retryable && classified.category !== "unknown") {
    return classified;
  }

  const sqsTransientPatterns = [
    "throttlingexception",
    "serviceunavailable",
    "requestexpired",
    "networkingerror",
    "econnreset",
    "etimedout",
    "socket hang up",
    "connect econnrefused",
    "sqs",
  ];
  for (const pattern of sqsTransientPatterns) {
    if (lower.includes(pattern)) {
      return {
        category: "unknown",
        retryable: true,
        message: sanitized,
        originalError: error instanceof Error ? error.stack : undefined,
        suggestion: "Retry transient SQS/AWS handoff failure",
      };
    }
  }

  return {
    category: "unknown",
    retryable: false,
    message: sanitized,
    originalError: error instanceof Error ? error.stack : undefined,
    suggestion: "Inspect CloudWatch logs for this handoff failure",
  };
}

/**
 * Classifies whether a handoff (qualification-to-planning) error is retryable.
 * Retryable: transient SQS/AWS errors (network, throttle, timeout) and
 * workspace lease timeouts. Non-retryable: config errors, auth failures,
 * branch mismatches, and workflow-scope rejections.
 */
export function isHandoffRetryableError(error: unknown): boolean {
  return classifyHandoffError(error).retryable;
}

export function classifyError(
  error: unknown,
  _context?: { stage?: string },
): ClassifiedError {
  try {
    const rawMessage = extractMessage(error);
    const lower = rawMessage.toLowerCase();

    // Special case: github_api + rate limit is retryable
    for (const p of GITHUB_RATE_LIMIT_PATTERNS) {
      if (lower.includes(p)) {
        const isGitHub = lower.includes("github") || lower.includes("gh ");
        if (isGitHub) {
          return {
            category: "github_api",
            retryable: true,
            message: sanitizeErrorMessage(rawMessage),
            originalError: error instanceof Error ? error.stack : undefined,
            suggestion: "GitHub API rate limit hit; retry after backoff",
          };
        }
      }
    }

    // S3 AccessDenied special case: only classify as s3_storage if "s3" is also present
    if (lower.includes("accessdenied") && lower.includes("s3")) {
      return {
        category: "s3_storage",
        retryable: true,
        message: sanitizeErrorMessage(rawMessage),
        originalError: error instanceof Error ? error.stack : undefined,
        suggestion: "Check S3 bucket permissions and regional availability",
      };
    }

    for (const rule of PATTERN_RULES) {
      for (const pattern of rule.patterns) {
        if (lower.includes(pattern.toLowerCase())) {
          return {
            category: rule.category,
            retryable: rule.retryable,
            message: sanitizeErrorMessage(rawMessage),
            originalError: error instanceof Error ? error.stack : undefined,
            suggestion: rule.suggestion,
          };
        }
      }
    }

    return {
      category: "unknown",
      retryable: false,
      message: sanitizeErrorMessage(rawMessage),
      originalError: error instanceof Error ? error.stack : undefined,
      suggestion: "Inspect CloudWatch logs for this run",
    };
  } catch {
    return {
      category: "unknown",
      retryable: false,
      message: "Failed to classify error",
      suggestion: "Inspect CloudWatch logs for this run",
    };
  }
}
