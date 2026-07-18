const ONESHOT_AGENT_NAMES = new Set([
  "QUALIFIER",
  "PLANNER",
  "REVIEWER",
  "IMPLEMENTER",
  "CODE_REVIEWER",
  "TESTER",
]);

export function getAgentDoneLabel(
  agentName: string | null | undefined,
): string | null {
  return getAgentTerminalLabel(agentName, "DONE");
}

export function getAgentFailedLabel(
  agentName: string | null | undefined,
): string | null {
  return getAgentTerminalLabel(agentName, "FAILED");
}

function getAgentTerminalLabel(
  agentName: string | null | undefined,
  suffix: "DONE" | "FAILED",
): string | null {
  const normalizedAgentName = agentName?.trim().toUpperCase();
  if (!normalizedAgentName || ONESHOT_AGENT_NAMES.has(normalizedAgentName)) {
    return null;
  }

  const labelPrefix = normalizedAgentName
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return labelPrefix ? `${labelPrefix}_${suffix}` : null;
}

export function withDoneLabelExclusion(
  jql: string | null | undefined,
  agentName: string | null | undefined,
): string {
  return withLabelExclusion(jql, [getAgentDoneLabel(agentName)]);
}

export function withDoneAndFailedLabelExclusion(
  jql: string | null | undefined,
  agentName: string | null | undefined,
): string {
  return withLabelExclusion(jql, [
    getAgentDoneLabel(agentName),
    getAgentFailedLabel(agentName),
  ]);
}

function withLabelExclusion(
  jql: string | null | undefined,
  labels: Array<string | null>,
): string {
  const trimmedJql = jql?.trim() ?? "";
  const missingLabels = labels
    .filter((label): label is string => !!label)
    .filter((label) => {
      const labelRegex = new RegExp(`\\b${escapeRegExp(label)}\\b`, "i");
      return !labelRegex.test(trimmedJql);
    });
  if (!trimmedJql || missingLabels.length === 0) {
    return trimmedJql;
  }

  const orderByMatch = /\s+ORDER\s+BY\s+/i.exec(trimmedJql);
  const exclusion = `labels not in (${missingLabels.join(", ")})`;
  if (!orderByMatch || orderByMatch.index === undefined) {
    return `${trimmedJql} AND ${exclusion}`;
  }

  const filterClause = trimmedJql.slice(0, orderByMatch.index).trimEnd();
  const orderByClause = trimmedJql.slice(orderByMatch.index).trimStart();
  return `${filterClause} AND ${exclusion} ${orderByClause}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
