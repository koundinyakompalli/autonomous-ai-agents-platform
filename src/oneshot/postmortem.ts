import type { OneShotRun, OneShotArtifact } from './types.js'
import type { OneShotRunEvent } from './database/events.js'
import { type ClassifiedError, classifyError } from './errors.js'

export interface PostmortemTimelineEntry {
  stage: string
  version: number
  durationMs: number | null
  costUsd: number | null
  tokensUsed: number | null
  modelCostUsage?: unknown
  outcome: 'success' | 'failed' | 'skipped'
}

export interface OneShotPostmortem {
  runId: number
  jiraKey: string
  failedAtStage: string | null
  errorClassification: ClassifiedError
  timeline: PostmortemTimelineEntry[]
  totalCostUsd: number
  totalDurationMs: number
  totalTokensUsed: number
  stagesCompleted: number
  stagesTotal: number
  suggestion: string
  generatedAt: string
}

function num(value: unknown): number {
  if (typeof value === 'number' && !Number.isNaN(value)) return value
  return 0
}

function normalizeStageName(stage: string | null | undefined): string | null {
  if (!stage) {
    return null
  }

  switch (stage) {
    case 'plan':
    case 'trace':
    case 'verify':
    case 'planning':
      return 'planning'
    case 'review':
    case 'reviewing':
      return 'review'
    case 'implementation':
    case 'implementing':
      return 'implementation'
    case 'code_review':
    case 'code_reviewing':
      return 'code_review'
    case 'test_result':
    case 'testing':
      return 'testing'
    case 'qualification':
      return 'qualification'
    default:
      return stage
  }
}

function mapStageToArtifactStage(stage: string | null | undefined): string | null {
  switch (normalizeStageName(stage)) {
    case 'planning':
      return 'plan'
    case 'review':
      return 'review'
    case 'implementation':
      return 'implementation'
    case 'code_review':
      return 'code_review'
    case 'testing':
      return 'test_result'
    case 'qualification':
      return 'qualification'
    default:
      return null
  }
}

function findFailedStage(
  run: OneShotRun,
  events: OneShotRunEvent[],
  preferredFailedStage?: string | null,
): string | null {
  if (preferredFailedStage) {
    return normalizeStageName(preferredFailedStage)
  }

  // Walk events in reverse to find the last state_transition to 'failed'
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.event_type === 'state_transition' && ev.to_state === 'failed') {
      return normalizeStageName(ev.stage ?? ev.from_state ?? null)
    }
  }

  // Fallback: derive from run state
  if (run.state === 'failed') {
    // Infer stage from the most recent version counters
    if (run.current_test_version != null) return 'testing'
    if (run.current_code_review_version != null) return 'code_review'
    if (run.current_implementation_version != null) return 'implementation'
    if (run.current_review_version != null) return 'review'
    if (run.current_plan_version != null) return 'planning'
    return 'qualification'
  }

  return null
}

function buildTimeline(
  artifacts: OneShotArtifact[],
  events: OneShotRunEvent[],
  failedAtStage: string | null,
): PostmortemTimelineEntry[] {
  const failedArtifactStage = mapStageToArtifactStage(failedAtStage)
  type OrderedTimelineEntry = PostmortemTimelineEntry & { orderMs: number }

  // Sort by created_at ascending, then by version ascending
  const sorted = [...artifacts].sort((a, b) => {
    const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    if (timeDiff !== 0) return timeDiff
    return a.version - b.version
  })

  const artifactEntries: OrderedTimelineEntry[] = sorted.map((artifact) => {
    const meta = (artifact.metadata_json ?? {}) as Record<string, unknown>
    const isCompleted = artifact.status === 'completed'
    const metadataIndicatesFailure =
      artifact.stage === 'test_result' &&
      typeof meta.passed === 'boolean' &&
      meta.passed === false
    const isFailed = artifact.stage === failedArtifactStage && (!isCompleted || metadataIndicatesFailure)
    const outcome: PostmortemTimelineEntry['outcome'] = isFailed
      ? 'failed'
      : isCompleted
        ? 'success'
        : 'skipped'

    return {
      stage: artifact.stage,
      version: artifact.version,
      durationMs: num(meta.stage_duration_ms) || null,
      costUsd: num(meta.stage_cost_usd) || null,
      tokensUsed: num(meta.stage_tokens_used) || null,
      ...(meta.model_cost_usage ? { modelCostUsage: meta.model_cost_usage } : {}),
      outcome,
      orderMs: new Date(artifact.created_at).getTime(),
    }
  })
  const artifactStageVersions = new Set(
    sorted.map((artifact) => `${artifact.stage}:${artifact.version}`),
  )

  const failedAttemptEntries: OrderedTimelineEntry[] = events
    .filter((event) => event.event_type === 'stage_attempt_metrics')
    .map((event): OrderedTimelineEntry | null => {
      const meta = (event.metadata_json ?? {}) as Record<string, unknown>
      const reason = typeof meta.reason === 'string' ? meta.reason : ''
      if (!reason.includes('failed_attempt')) {
        return null
      }
      const stage = normalizeStageName(event.stage) ?? 'unknown'
      const artifactStage = mapStageToArtifactStage(stage)
      const version = num(meta.version) || 0
      if (artifactStage && artifactStageVersions.has(`${artifactStage}:${version}`)) {
        return null
      }
      return {
        stage,
        version,
        durationMs: num(meta.stage_duration_ms) || null,
        costUsd: num(meta.stage_cost_usd) || null,
        tokensUsed: num(meta.stage_tokens_used) || null,
        ...(meta.model_cost_usage ? { modelCostUsage: meta.model_cost_usage } : {}),
        outcome: 'failed' as const,
        orderMs: new Date(event.occurred_at).getTime(),
      }
    })
    .filter((entry): entry is OrderedTimelineEntry => entry !== null)

  return [...artifactEntries, ...failedAttemptEntries]
    .sort((a, b) => {
      const timeDiff = a.orderMs - b.orderMs
      if (timeDiff !== 0) return timeDiff
      return a.version - b.version
    })
    .map(({ orderMs: _orderMs, ...entry }) => entry)
}

export function buildPostmortem(
  run: OneShotRun,
  events: OneShotRunEvent[],
  artifacts: OneShotArtifact[],
  preferredFailedStage?: string | null,
): OneShotPostmortem {
  const failedAtStage = findFailedStage(run, events, preferredFailedStage)
  const timeline = buildTimeline(artifacts, events, failedAtStage)

  let totalCostUsd = 0
  let totalDurationMs = 0
  let totalTokensUsed = 0
  let stagesCompleted = 0

  for (const entry of timeline) {
    totalCostUsd += num(entry.costUsd)
    totalDurationMs += num(entry.durationMs)
    totalTokensUsed += num(entry.tokensUsed)
    if (entry.outcome === 'success') stagesCompleted++
  }

  const errorClassification = classifyError(run.last_error ?? 'Unknown failure')

  const stageContext = failedAtStage
    ? ` Failure occurred during the "${failedAtStage}" stage.`
    : ''
  const suggestion = (errorClassification.suggestion ?? '') + stageContext

  return {
    runId: run.id,
    jiraKey: run.jira_key,
    failedAtStage,
    errorClassification,
    timeline,
    totalCostUsd,
    totalDurationMs,
    totalTokensUsed,
    stagesCompleted,
    stagesTotal: timeline.length,
    suggestion,
    generatedAt: new Date().toISOString(),
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null || ms === 0) return '-'
  return `${(ms / 1000).toFixed(1)}s`
}

function formatCost(usd: number | null): string {
  if (usd == null || usd === 0) return '-'
  return `$${usd.toFixed(4)}`
}

function formatTokens(tokens: number | null): string {
  if (tokens == null || tokens === 0) return '-'
  return tokens.toLocaleString('en-US')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function renderModelCostBreakdown(timeline: PostmortemTimelineEntry[]): string {
  const rows: string[] = []
  for (const entry of timeline) {
    if (!isRecord(entry.modelCostUsage) || !isRecord(entry.modelCostUsage.models)) {
      continue
    }
    for (const [model, rawRow] of Object.entries(entry.modelCostUsage.models)) {
      if (!isRecord(rawRow)) {
        continue
      }
      rows.push(
        `| ${entry.stage} | ${model} | ${String(rawRow.source ?? '-')} | ${formatTokens(num(rawRow.input_tokens) || null)} | ${formatTokens(num(rawRow.output_tokens) || null)} | ${formatTokens(num(rawRow.cache_read_tokens) || null)} | ${formatTokens(num(rawRow.cache_write_tokens) || null)} | ${formatCost(num(rawRow.cost_usd) || null)} | ${rawRow.exact_cost_usd === false ? 'estimated' : 'exact'} |`,
      )
    }
  }
  if (rows.length === 0) {
    return ''
  }
  return `\n## Model Cost Breakdown\n\n| Stage | Model | Source | Input | Output | Cache Read | Cache Write | Cost | Exactness |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`
}

export function renderPostmortemMarkdown(postmortem: OneShotPostmortem): string {
  const {
    runId,
    jiraKey,
    failedAtStage,
    errorClassification,
    totalCostUsd,
    totalDurationMs,
    stagesCompleted,
    stagesTotal,
    timeline,
    suggestion,
    generatedAt,
  } = postmortem

  const retryLabel = errorClassification.retryable ? 'retryable' : 'not retryable'

  const timelineRows = timeline
    .map(
      (e) =>
        `| ${e.stage} | ${e.version} | ${formatDuration(e.durationMs)} | ${formatCost(e.costUsd)} | ${formatTokens(e.tokensUsed)} | ${e.outcome} |`,
    )
    .join('\n')
  const modelCostBreakdown = renderModelCostBreakdown(timeline)

  return `# OneShot Failure Postmortem — ${jiraKey}

**Run ID:** ${runId}
**Failed at:** ${failedAtStage ?? 'unknown'}
**Error category:** ${errorClassification.category} (${retryLabel})
**Total cost:** $${totalCostUsd.toFixed(2)}
**Total duration:** ${(totalDurationMs / 1000).toFixed(1)}s
**Stages completed:** ${stagesCompleted}/${stagesTotal}

## Error

${errorClassification.message}

## Timeline

| Stage | Version | Duration | Cost | Tokens | Outcome |
|---|---|---|---|---|---|
${timelineRows}
${modelCostBreakdown}

## Suggestion

${suggestion}

---
Generated at ${generatedAt}
`
}
