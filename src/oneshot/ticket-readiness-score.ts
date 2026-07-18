import { createHash } from 'node:crypto'
import type mysql from 'mysql2/promise'

export const ONESHOT_TICKET_READINESS_RUBRIC_VERSION = 'v1.0'
export const ONESHOT_TICKET_READINESS_DETECTION_PATTERNS_VERSION = 'v1.0'

const WEIGHTS = {
  acceptance_criteria: 35,
  substantive_description: 20,
  expected_behavior_scope: 15,
  repo_file_service_hints: 15,
  testing_notes: 10,
  out_of_scope_constraints: 5,
} as const

type Signal = keyof typeof WEIGHTS

function sourceHash(title: string, taskDescription: string): string {
  return createHash('sha1').update(`${title}\n---\n${taskDescription}`).digest('hex')
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function plain(value: string): string {
  return normalize(
    value
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/[#>*_\-|]+/g, ' '),
  )
}

function words(value: string): number {
  return plain(value).split(/\s+/).filter(Boolean).length
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function scoreTicketReadinessForIntake(input: {
  title: string
  taskDescription: string
  acceptanceCriteriaPresent?: boolean
}) {
  const text = `${input.title}\n${input.taskDescription}`
  const description = plain(input.taskDescription)
  const titleOnly =
    description.length === 0 ||
    description.toLowerCase() === plain(input.title).toLowerCase()
  const veryShort =
    words(input.taskDescription) < 12 &&
    description.length < 100 &&
    words(text) <= Math.max(words(input.title) + 8, 16)
  const missingDescription = titleOnly || veryShort
  const signals: Record<Signal, boolean> = {
    acceptance_criteria:
      input.acceptanceCriteriaPresent === true ||
      hasAny(text, [
        /(^|\n)\s*(?:#{1,6}\s*)?(?:acceptance\s+criteria|acceptance|ac)\s*[:#-]/i,
        /\b(?:given|when|then)\b[\s\S]{0,700}\b(?:given|when|then)\b[\s\S]{0,700}\b(?:given|when|then)\b/i,
        /\b(?:done|accepted|complete)\s+when\b/i,
        /\b(?:verify|ensure)\s+that\b/i,
      ]),
    substantive_description:
      !missingDescription &&
      (words(input.taskDescription) >= 25 ||
        description.length >= 180 ||
        /\b(?:overview|description|summary|problem|background|context)\b/i.test(text)),
    expected_behavior_scope: hasAny(text, [
      /\b(?:expected|desired|current)\s+behavior\b/i,
      /\b(?:scope|requirement|requirements|should|must|needs?\s+to|preserve|keep|exclude|include|show|hide)\b/i,
      /\b(?:from|target)\s*[:#-]/i,
      /\b(?:as a|so that)\b/i,
    ]),
    repo_file_service_hints: hasAny(text, [
      /\b(?:repo|repository|service|server|helper|component|module|class|method|endpoint|api|controller|worker|dashboard)\b/i,
      /\b(?:file|path|package)\s*[:#-]/i,
      /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|java|kt|py|sql|xml|yml|yaml|json)\b/i,
      /\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|java|kt|py|sql|xml|yml|yaml|json)\b/i,
      /\b(?:core-app|provider-portal|batch|client-services|interop|fhir|medhok)\b/i,
    ]),
    testing_notes: hasAny(text, [
      /\b(?:testing\s+notes?|test\s+plan|unit\s+tests?|integration\s+tests?|regression\s+tests?)\b/i,
      /\b(?:unit|integration|regression)\s+coverage\b/i,
      /\b(?:add|create|include|run|write)\b[\s\S]{0,80}\btests?\b/i,
      /\bfixture\s+validation\s+tests?\b/i,
      /\b(?:verify|validated?|run)\s+(?:the\s+)?(?:test|tests|suite|query|job|workflow)\b/i,
    ]),
    out_of_scope_constraints: hasAny(text, [
      /\b(?:out\s+of\s+scope|not\s+in\s+scope|non-?goals?|do\s+not|don't|without\s+(?:changing|altering|modifying|touching)|unchanged|must\s+not)\b/i,
      /\b(?:no|not)\b[\s\S]{0,80}\b(?:behavior|flow|exports?|columns?|policy)\b[\s\S]{0,40}\bchange\b/i,
    ]),
  }

  const breakdown = Object.fromEntries(
    Object.entries(signals).map(([signal, present]) => [
      signal,
      present ? WEIGHTS[signal as Signal] : 0,
    ]),
  ) as Record<Signal, number>
  let score = Object.values(breakdown).reduce((sum, value) => sum + value, 0)
  if (missingDescription) {
    score = Math.min(score, 29)
  }
  const tier =
    missingDescription || score < 30
      ? 'missing_description'
      : score >= 80
        ? 'strong'
        : score >= 60
          ? 'adequate'
          : 'weak'
  const retrofit =
    /(^|\n)\s*(?:#{1,6}\s*)?retrofit\s*[:#-]/i.test(text) &&
    /(^|\n)\s*(?:#{1,6}\s*)?from\s*[:#-]/i.test(text) &&
    /(^|\n)\s*(?:#{1,6}\s*)?target\s*[:#-]/i.test(text)
  const cpdev =
    [
      /(^|\n)\s*(?:#{1,6}\s*)?summary\s*[:#-]/i,
      /(^|\n)\s*(?:#{1,6}\s*)?(?:overview|description)\s*[:#-]/i,
      /(^|\n)\s*(?:#{1,6}\s*)?acceptance\s+criteria\s*[:#-]/i,
      /(^|\n)\s*(?:#{1,6}\s*)?technical\s+details?\s*[:#-]/i,
    ].filter((pattern) => pattern.test(text)).length >= 3
  const templateFit =
    tier === 'missing_description'
      ? 'missing_description'
      : retrofit
        ? 'retrofit_template'
        : cpdev
          ? 'cpdev_template'
          : tier === 'strong' || tier === 'adequate'
            ? 'non_template_clear'
            : 'non_template_weak'

  return {
    score,
    tier,
    templateFit,
    signals,
    breakdown,
    missingSignals: Object.entries(signals)
      .filter(([, present]) => !present)
      .map(([signal]) => signal),
    rubricVersion: ONESHOT_TICKET_READINESS_RUBRIC_VERSION,
    detectionPatternsVersion: ONESHOT_TICKET_READINESS_DETECTION_PATTERNS_VERSION,
    sourceTextSha: sourceHash(input.title, input.taskDescription),
  }
}

export async function persistTicketReadinessScore(
  executor: mysql.Pool | mysql.PoolConnection,
  input: {
    taskManagementId: number
    title: string
    taskDescription?: string | null
    scoreSource: 'intake' | 'backfill'
    acceptanceCriteriaPresent?: boolean
  },
): Promise<void> {
  if (!input.taskManagementId || input.taskManagementId <= 0) {
    return
  }
  const taskDescription = input.taskDescription ?? ''
  const score = scoreTicketReadinessForIntake({
    title: input.title,
    taskDescription,
    acceptanceCriteriaPresent: input.acceptanceCriteriaPresent,
  })
  try {
    await executor.query(
      `INSERT IGNORE INTO oneshot_ticket_readiness_scores
         (task_management_id, rubric_version, detection_patterns_version,
          source_text_sha, score_source, score_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.taskManagementId,
        score.rubricVersion,
        score.detectionPatternsVersion,
        score.sourceTextSha,
        input.scoreSource,
        JSON.stringify(score),
      ],
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE') {
      return
    }
    throw error
  }
}
