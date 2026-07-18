import {
  registerRepoFromPath,
  runAgent,
  type AgentResult,
  type ClaudePermissionMode,
  type ClaudeToolGuard,
  type ClaudeToolVisibility,
} from '../claude-sdk.js'
import { createLogger } from '../../utils/logger.js'
import {
  ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA,
  createFallbackScoutWorkplan,
  sanitizeScoutWorkplan,
  type OneShotScoutWorkplan,
  type OneShotScoutWorkplanSource,
} from '../schema/scout-workplan.js'

const logger = createLogger('oneshot-scout-workplan')

const WORKPLAN_TIMEOUT_MS = 180_000
const WORKPLAN_MAX_TURNS = 4
const WORKPLAN_MAX_BUDGET_USD = 2
const SECTION_MAX_CHARS = 12_000

export interface PlannerPriorDiagnosticInput {
  key: string
  kind: string
  body: unknown
}

export interface ScoutWorkplanRequest {
  jiraKey: string
  repoName: string
  workspacePath: string
  taskDescription: string
  ticketEvidenceSummary?: string
  qualificationSummary: {
    requirementsSummary: string[]
    acceptanceCriteriaPresent?: boolean
    nonBlockingWarnings: string[]
  }
  repoScanSummary?: string
  routeCardContext?: string
  groundingSummary?: string
  revisionSummary?: string
  priorDiagnostics?: PlannerPriorDiagnosticInput[]
  scoutModelId: string
  permissionMode?: ClaudePermissionMode
  toolVisibility?: ClaudeToolVisibility
  toolGuard?: ClaudeToolGuard
}

export interface ScoutWorkplanResult {
  workplan: OneShotScoutWorkplan
  source: OneShotScoutWorkplanSource
  warnings: string[]
  metrics?: AgentResult['metrics']
  rawOutput?: string
}

function compact(value: string | undefined, maxChars = SECTION_MAX_CHARS): string {
  const text = value?.trim() ?? ''
  if (!text) {
    return 'None.'
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`
}

function compactJson(value: unknown, maxChars = 8_000): string {
  const text = JSON.stringify(value ?? null, null, 2)
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`
}

function buildPriorDiagnosticsSection(diagnostics: PlannerPriorDiagnosticInput[] = []): string {
  if (diagnostics.length === 0) {
    return 'None.'
  }
  return diagnostics
    .slice(0, 3)
    .map((diagnostic) => {
      return [
        `### ${diagnostic.kind}`,
        `Artifact: ${diagnostic.key}`,
        '```json',
        compactJson(diagnostic.body),
        '```',
      ].join('\n')
    })
    .join('\n\n')
}

export function buildScoutWorkplanPrompt(request: ScoutWorkplanRequest): string {
  const requirements = request.qualificationSummary.requirementsSummary.length > 0
    ? request.qualificationSummary.requirementsSummary.map(item => `- ${item}`).join('\n')
    : '- None.'
  const warnings = request.qualificationSummary.nonBlockingWarnings.length > 0
    ? request.qualificationSummary.nonBlockingWarnings.map(item => `- ${item}`).join('\n')
    : '- None.'

  return [
    'You are creating a OneShot planner scout workplan.',
    '',
    'Your job is to decide what focused read-only scout investigations should run before the final implementation planner.',
    'Do not create an implementation plan. Do not propose code changes. Do not emit OneShot plan JSON.',
    '',
    'Rules:',
    '- Decompose only into independent exploration questions that can run in parallel.',
    '- Prefer fewer scouts. Use zero scouts only when evidence is already strong, localized, and direct planning is safe.',
    '- Each scout must gather evidence useful for fileChangeContract, plannedCodeChanges, guardrailReport, testingStrategy, or implementerGuardrails.',
    '- Do not assume technology or domain from labels alone; use ticket evidence, qualification evidence, repo summaries, and inspected-file hints.',
    '- Scouts are read-only and may use only Read, Glob, and Grep. Never ask scouts to edit files, use Bash, use Agent/Task/Skill, post to Jira, or produce final plan JSON.',
    '- Keep each scout brief specific and bounded. Give starting files or directories when evidence supports them, otherwise give targeted search terms.',
    '',
    'Return only the structured scout workplan JSON that matches the schema.',
    '',
    `Jira: ${request.jiraKey}`,
    `Repo: ${request.repoName}`,
    '',
    '## Task Description',
    compact(request.taskDescription),
    '',
    '## Ticket Evidence And Attachment Review',
    compact(request.ticketEvidenceSummary),
    '',
    '## Qualification Requirements',
    requirements,
    '',
    `Acceptance criteria present: ${request.qualificationSummary.acceptanceCriteriaPresent === false ? 'no' : 'yes_or_unknown'}`,
    '',
    '## Qualification Warnings',
    warnings,
    '',
    '## Repo Scan Summary',
    compact(request.repoScanSummary),
    '',
    '## Route Card Context',
    compact(request.routeCardContext),
    '',
    '## Deterministic Grounding Summary',
    compact(request.groundingSummary),
    '',
    '## Revision Context',
    compact(request.revisionSummary),
    '',
    '## Prior Planner Diagnostics',
    buildPriorDiagnosticsSection(request.priorDiagnostics),
  ].join('\n')
}

function parseJsonObjectFromOutput(output: string): unknown {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] ?? output
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('Scout workplan output did not contain a JSON object.')
  }
  return JSON.parse(candidate.slice(start, end + 1))
}

export class ScoutWorkplanProvider {
  async generateWorkplan(request: ScoutWorkplanRequest): Promise<ScoutWorkplanResult> {
    try {
      const repoId = registerRepoFromPath(
        request.workspacePath,
        `oneshot-run-${request.jiraKey}-scout-workplan`,
      )
      const result = await runAgent({
        taskId: `oneshot-scout-workplan-${request.jiraKey}-${Date.now()}`,
        sdkStage: 'planning_scout_workplan',
        taskPrompt: buildScoutWorkplanPrompt(request),
        repoIds: [repoId],
        allowedTools: [],
        disableTools: true,
        outputSchema: ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA,
        timeoutMs: WORKPLAN_TIMEOUT_MS,
        maxTurns: WORKPLAN_MAX_TURNS,
        maxBudgetUsd: WORKPLAN_MAX_BUDGET_USD,
        bedrockConfig: { model: request.scoutModelId },
        permissionMode: request.permissionMode,
        toolVisibility: request.toolVisibility ?? 'restricted',
        toolGuard: request.toolGuard,
        settingSources: [],
      })

      if (!result.success) {
        return {
          workplan: createFallbackScoutWorkplan(result.error || 'Scout workplan provider failed.'),
          source: 'fallback',
          warnings: [result.error || 'Scout workplan provider failed.'],
          metrics: result.metrics,
          rawOutput: result.output,
        }
      }

      const raw = result.structuredOutput ?? parseJsonObjectFromOutput(result.output)
      const sanitized = sanitizeScoutWorkplan(raw)
      return {
        ...sanitized,
        metrics: result.metrics,
        rawOutput: result.output,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(
        {
          jiraKey: request.jiraKey,
          repoName: request.repoName,
          error: message,
        },
        'Scout workplan generation failed; using fallback scout workplan',
      )
      return {
        workplan: createFallbackScoutWorkplan(message),
        source: 'fallback',
        warnings: [message],
      }
    }
  }
}
