import { isDeterministicFailure } from "../oneshot/retry-classifier.js";

export type AgentFailureCategory =
  | "sdk_timeout"
  | "turn_limit"
  | "output_token_cap"
  | "process_sigkill"
  | "process_exit"
  | "runtime_bug"
  | "analysis_incomplete"
  | "provider_transient"
  | "deterministic"
  | "unknown";

export interface AgentFailureClassification {
  category: AgentFailureCategory;
  label: string;
  retryable: boolean;
  deterministic: boolean;
}

export function classifyAgentFailure(
  errorMessage: string | undefined | null,
): AgentFailureClassification {
  const message = errorMessage ?? "";

  if (/response exceeded the \d+ output token maximum/i.test(message)) {
    return {
      category: "output_token_cap",
      label: "Output Token Cap",
      retryable: false,
      deterministic: true,
    };
  }
  if (
    /Cannot read properties of undefined/i.test(message) ||
    /\brequire is not defined\b/i.test(message)
  ) {
    return {
      category: "runtime_bug",
      label: "Runtime Bug",
      retryable: false,
      deterministic: true,
    };
  }
  if (isDeterministicFailure(message)) {
    return {
      category: "deterministic",
      label: "Deterministic Failure",
      retryable: false,
      deterministic: true,
    };
  }
  if (
    /SDK timeout after\s+\d+ms/i.test(message) ||
    /SDK_(?:POST_TOOL_)?IDLE_TIMEOUT\b/i.test(message)
  ) {
    return {
      category: "sdk_timeout",
      label: "SDK Timeout",
      retryable: true,
      deterministic: false,
    };
  }
  if (/Turn limit exceeded\s+\(max:\s*\d+\)/i.test(message)) {
    return {
      category: "turn_limit",
      label: "Turn Limit",
      retryable: true,
      deterministic: false,
    };
  }
  if (/Claude Code process terminated by signal\s+SIGKILL/i.test(message)) {
    return {
      category: "process_sigkill",
      label: "Process SIGKILL",
      retryable: true,
      deterministic: false,
    };
  }
  if (/Claude Code process exited with code\s+1/i.test(message)) {
    return {
      category: "process_exit",
      label: "Process Exit",
      retryable: true,
      deterministic: false,
    };
  }
  if (/Analysis incomplete/i.test(message)) {
    return {
      category: "analysis_incomplete",
      label: "Analysis Incomplete",
      retryable: true,
      deterministic: false,
    };
  }
  if (
    /\bretrofit_source_lookup_failed\b/i.test(message) ||
    /\bsource_(?:pr|commit|branch)_lookup_failed\b/i.test(message) ||
    /\btarget_branch_lookup_failed\b/i.test(message) ||
    /\b(ThrottlingException|TooManyRequestsException|ServiceUnavailable|InternalServerException|rate limit|timeout)\b/i.test(
      message,
    ) ||
    /\bfetch failed\b/i.test(message) ||
    /\b(UND_ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b/i.test(
      message,
    )
  ) {
    return {
      category: "provider_transient",
      label: "Provider Transient",
      retryable: true,
      deterministic: false,
    };
  }
  return {
    category: "unknown",
    label: "Unknown Failure",
    retryable: false,
    deterministic: false,
  };
}
