const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|api[_-]?key|private[_-]?key|authorization)/i;

const SECRET_ASSIGNMENT_PATTERN =
  /\b((?:[\w.-]*)(?:token|secret|password|api[_-]?key|private[_-]?key)(?:[\w.-]*)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;

const BEARER_TOKEN_PATTERN = /\b(Authorization\s*:\s*Bearer\s+)[^\s]+/gi;
const BARE_BEARER_TOKEN_PATTERN =
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const DATABASE_DSN_PATTERN =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s'"<>]+/gi;
const AWS_ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GITHUB_TOKEN_PATTERN =
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET KEY)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|SECRET KEY)-----/g;

export function redactSensitiveText(value: string): string {
  return value
    .replace(PEM_PRIVATE_KEY_PATTERN, "[REDACTED]")
    .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(BARE_BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(DATABASE_DSN_PATTERN, "[REDACTED]")
    .replace(AWS_ACCESS_KEY_ID_PATTERN, "[REDACTED]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED]");
}

export function redactSensitiveObject(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[REDACTED]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveObject(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redactSensitiveObject(nested, depth + 1);
  }
  return output;
}
