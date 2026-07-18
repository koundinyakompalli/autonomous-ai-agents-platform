const MAX_PR_SUMMARY_LENGTH = 60

function normalizeSummary(summary: string | null | undefined): string {
  return (summary ?? '').replace(/\s+/g, ' ').trim()
}

function truncateSummary(summary: string): string {
  if (summary.length <= MAX_PR_SUMMARY_LENGTH) {
    return summary
  }

  return `${summary.slice(0, MAX_PR_SUMMARY_LENGTH - 1).trimEnd()}…`
}

export function buildOneShotPullRequestTitle(input: {
  jiraKey: string
  ticketSummary?: string | null
  wip?: boolean
}): string {
  const jiraKey = input.jiraKey.trim()
  const normalizedSummary = normalizeSummary(input.ticketSummary)
  const titleSummary = normalizedSummary ? truncateSummary(normalizedSummary) : jiraKey
  const baseTitle =
    titleSummary === jiraKey
      ? `OneShot - ${jiraKey}`
      : `OneShot - ${jiraKey}: ${titleSummary}`

  return input.wip ? `${baseTitle} [WIP]` : baseTitle
}
