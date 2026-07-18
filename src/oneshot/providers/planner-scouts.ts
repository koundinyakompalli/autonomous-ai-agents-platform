import * as fs from 'fs/promises'
import * as path from 'path'
import {
  registerRepoFromPath,
  runAgent,
  type BedrockConfig,
  type ClaudePermissionMode,
  type ClaudeToolGuard,
  type ClaudeToolVisibility,
} from '../claude-sdk.js'
import { createLogger } from '../../utils/logger.js'
import {
  type PlannerGroundingContext,
  type PlannerGroundingSnippet,
  type PlannerScoutCoverage,
  type PlannerScoutEvidenceReport,
} from '../planner-grounding.js'
import type {
  OneShotScoutBrief,
  OneShotScoutWorkplan,
} from '../schema/scout-workplan.js'

const logger = createLogger('oneshot-planner-scouts')

export const PLANNER_SCOUT_MAX_WORK_ITEMS = 6
export const PLANNER_SCOUT_TIMEOUT_MS = 300_000
export const PLANNER_SCOUT_IDLE_TIMEOUT_MS = 60_000
const SCOUT_MAX_TURNS = 12
const SCOUT_MAX_BUDGET_USD = 1
const SCOUT_SNIPPET_TEXT_MAX = 260

export interface PlannerScoutWorkItem {
  id: string
  objective: string
  searchTerms: string[]
  backedByExistingEvidence: boolean
  specificTokenCount: number
  whyNeeded?: string
  startingPoints?: string[]
  mustAnswer?: string[]
  expectedEvidence?: string[]
  priority?: OneShotScoutBrief['priority']
  maxToolCalls?: number
  stopConditions?: string[]
  fallbackIfIncomplete?: string
}

export interface PlannerScoutRequest {
  jiraKey: string
  repoName: string
  workspacePath: string
  taskDescription: string
  qualificationSummary: {
    requirementsSummary: string[]
    nonBlockingWarnings: string[]
  }
  groundingContext?: PlannerGroundingContext | null
  workplan?: OneShotScoutWorkplan | null
  workplanSource?: 'llm' | 'fallback' | 'legacy'
  workplanWarnings?: string[]
  workplanMetrics?: {
    durationMs: number
    toolCalls: number
    tokensUsed?: {
      input: number
      output: number
      cacheRead?: number
      cacheWrite?: number
    }
    costUsd?: number
    costUsdExact?: boolean
    modelUsed?: string
    modelUsage?: Record<string, { input: number; output: number }>
  }
  scoutModelId: string
  permissionMode?: ClaudePermissionMode
  toolVisibility?: ClaudeToolVisibility
  toolGuard?: ClaudeToolGuard
}

export interface PlannerScoutRunResult {
  workItems: PlannerScoutWorkItem[]
  reports: PlannerScoutEvidenceReport[]
  coverage: PlannerScoutCoverage
  scoutInvocationFailed: boolean
  scoutReturnedNothing: boolean
  warnings: string[]
  workplan?: OneShotScoutWorkplan
  workplanSource?: 'llm' | 'fallback' | 'legacy'
  workplanWarnings?: string[]
  workplanMetrics?: PlannerScoutRequest['workplanMetrics']
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function isSafeWorkspaceRelativePath(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath)
  return Boolean(normalizedPath) &&
    !normalizedPath.split('/').some(part => part === '..')
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function verifyWorkspaceFiles(
  workspacePath: string,
  files: string[],
): Promise<string[]> {
  const verified: string[] = []
  for (const file of unique(files.map(normalizePath).filter(isSafeWorkspaceRelativePath))) {
    if (await pathExists(path.join(workspacePath, file))) {
      verified.push(file)
    }
  }
  return verified
}

function tokenize(value: string): string[] {
  return unique(
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9._/-]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 4),
  )
}

function specificTokenCount(value: string): number {
  const identifiers = value.match(/\b[A-Z][A-Za-z0-9_]{3,}\b/g) ?? []
  const paths = value.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+/g) ?? []
  return unique([...identifiers, ...paths]).length
}

function requirementBackedByEvidence(
  requirement: string,
  grounding?: PlannerGroundingContext | null,
): boolean {
  if (!grounding) {
    return false
  }
  const tokens = tokenize(requirement).map(normalizeForMatch).filter(token => token.length >= 4)
  if (tokens.length === 0) {
    return false
  }
  const evidenceText = [
    ...grounding.candidateFiles.flatMap(candidate => [
      candidate.path,
      ...candidate.matchedTerms,
      ...candidate.reasons,
    ]),
    ...(grounding.qualificationEvidence?.verifiedInspectedFiles ?? []),
    grounding.qualificationEvidence?.inspectionSummary ?? '',
  ].join('\n')
  const normalizedEvidence = normalizeForMatch(evidenceText)
  return tokens.some(token => normalizedEvidence.includes(token))
}

export interface PlannerScoutWorkPlan {
  requirements: string[]
  allItems: PlannerScoutWorkItem[]
  workItems: PlannerScoutWorkItem[]
  coverage: PlannerScoutCoverage
}

export function buildPlannerScoutWorkPlan(input: {
  qualificationSummary: PlannerScoutRequest['qualificationSummary']
  groundingContext?: PlannerGroundingContext | null
  workplan?: OneShotScoutWorkplan | null
}): PlannerScoutWorkPlan {
  if (input.workplan) {
    const allItems = input.workplan.scouts.map((scout, index) => ({
      id: scout.id || `scout-${index + 1}`,
      objective: scout.objective,
      searchTerms: scout.searchTerms,
      backedByExistingEvidence: input.workplan?.directPlanningAllowed === true,
      specificTokenCount: specificTokenCount([
        scout.objective,
        ...scout.searchTerms,
        ...scout.startingPoints,
      ].join(' ')),
      whyNeeded: scout.whyNeeded,
      startingPoints: scout.startingPoints,
      mustAnswer: scout.mustAnswer,
      expectedEvidence: scout.expectedEvidence,
      priority: scout.priority,
      maxToolCalls: scout.maxToolCalls,
      stopConditions: scout.stopConditions,
      fallbackIfIncomplete: scout.fallbackIfIncomplete,
    }))
    const workItems = allItems.slice(0, PLANNER_SCOUT_MAX_WORK_ITEMS)
    return {
      requirements: input.workplan.scouts.map(scout => scout.objective),
      allItems,
      workItems,
      coverage: {
        requirementCount: allItems.length,
        evidenceBackedRequirementCount: input.workplan.directPlanningAllowed && allItems.length === 0 ? 1 : 0,
        uncoveredRequirementCount: workItems.length,
      },
    }
  }

  const requirements = input.qualificationSummary.requirementsSummary
    .map(requirement => requirement.trim())
    .filter(requirement => requirement.length > 0)
  const allItems = requirements
    .map((requirement, index) => {
      const searchTerms = tokenize(requirement).slice(0, 8)
      return {
        id: `scout-${index + 1}`,
        objective: requirement.trim(),
        searchTerms,
        backedByExistingEvidence: requirementBackedByEvidence(requirement, input.groundingContext),
        specificTokenCount: specificTokenCount(requirement),
      }
    })
    .sort((left, right) => {
      if (left.backedByExistingEvidence !== right.backedByExistingEvidence) {
        return left.backedByExistingEvidence ? 1 : -1
      }
      if (left.specificTokenCount !== right.specificTokenCount) {
        return left.specificTokenCount - right.specificTokenCount
      }
      return right.objective.length - left.objective.length
    })
  const workItems = allItems
    .filter(item => !item.backedByExistingEvidence)
    .slice(0, PLANNER_SCOUT_MAX_WORK_ITEMS)
  const evidenceBackedRequirementCount = allItems.filter(item => item.backedByExistingEvidence).length

  return {
    requirements,
    allItems,
    workItems,
    coverage: {
      requirementCount: allItems.length,
      evidenceBackedRequirementCount,
      uncoveredRequirementCount: allItems.length - evidenceBackedRequirementCount,
    },
  }
}

export function buildPlannerScoutWorkItems(input: {
  qualificationSummary: PlannerScoutRequest['qualificationSummary']
  taskDescription: string
  groundingContext?: PlannerGroundingContext | null
}): PlannerScoutWorkItem[] {
  return buildPlannerScoutWorkPlan({
    qualificationSummary: input.qualificationSummary,
    groundingContext: input.groundingContext,
  }).workItems
}

function buildScoutPrompt(request: PlannerScoutRequest, workItem: PlannerScoutWorkItem): string {
  const candidateFiles = request.groundingContext?.candidateFiles
    .slice(0, 8)
    .map(candidate => `- ${candidate.path} (${candidate.reasons.join(', ')})`)
    .join('\n') || '- none'
  const maxToolCalls = workItem.maxToolCalls ?? 8
  const startingPoints = (workItem.startingPoints ?? []).length > 0
    ? workItem.startingPoints?.map(point => `- ${point}`).join('\n')
    : '- none'
  const mustAnswer = (workItem.mustAnswer ?? []).length > 0
    ? workItem.mustAnswer?.map(question => `- ${question}`).join('\n')
    : '- Identify exact files, symbols, tests, risks, and gaps relevant to this objective.'
  const expectedEvidence = (workItem.expectedEvidence ?? []).length > 0
    ? workItem.expectedEvidence?.map(item => `- ${item}`).join('\n')
    : '- verified file paths and concise snippets'
  const stopConditions = (workItem.stopConditions ?? []).length > 0
    ? workItem.stopConditions?.map(item => `- ${item}`).join('\n')
    : '- Stop when you have concrete files/snippets/tests or can state an explicit evidence gap.'
  return [
    'You are a read-only OneShot planner scout.',
    '',
    'Your job is to find concrete repository evidence for one focused planner workplan brief. Do not write files.',
    '',
    'Hard requirements:',
    '- Your first action MUST be a Glob or Grep tool call.',
    '- You MUST make at least 2 total repository tool calls before answering.',
    '- A response without repository tool calls is invalid and will be rejected.',
    '- Return plain markdown, not JSON.',
    '- Answer every question in the Must Answer section.',
    '',
    'Hard limits:',
    `- Use at most ${maxToolCalls} repository tool calls total.`,
    '- Use Glob/Grep before Read.',
    '- Do not read files larger than roughly 2000 lines; narrow with Grep first.',
    '- Return as soon as you have concrete files/snippets/tests.',
    '',
    'Return exactly these markdown sections:',
    '## FILES',
    '- path/to/file.ext - one-line reason',
    '## SNIPPETS',
    '- path/to/file.ext:123 - matching text, at most 260 chars',
    '## SYMBOLS',
    '- SymbolName or config.key - one-line reason',
    '## TESTS',
    '- path/to/test.ext - scenario or - none with reason',
    '## COMMANDS',
    '- command to validate or - none with reason',
    '## TEMPLATE MAPPINGS',
    '- target-pattern <- existing/template/file.ext - rationale, or - none',
    '## RISKS',
    '- risk or evidence gap, or - none',
    '## SUMMARY',
    'One short paragraph.',
    '',
    `Jira: ${request.jiraKey}`,
    `Repo: ${request.repoName}`,
    `Work item: ${workItem.id}`,
    `Objective: ${workItem.objective}`,
    `Why needed: ${workItem.whyNeeded ?? 'Planner needs more repository evidence before final plan compilation.'}`,
    `Priority: ${workItem.priority ?? 'medium'}`,
    `Search terms: ${workItem.searchTerms.join(', ') || 'none'}`,
    '',
    'Starting points:',
    startingPoints ?? '- none',
    '',
    'Must Answer:',
    mustAnswer ?? '- Identify exact files, symbols, tests, risks, and gaps relevant to this objective.',
    '',
    'Expected Evidence:',
    expectedEvidence ?? '- verified file paths and concise snippets',
    '',
    'Stop Conditions:',
    stopConditions ?? '- Stop when you have concrete files/snippets/tests or can state an explicit evidence gap.',
    '',
    `Fallback if incomplete: ${workItem.fallbackIfIncomplete ?? 'Return the best verified evidence and explicit gaps; do not invent files.'}`,
    '',
    'Existing deterministic candidates:',
    candidateFiles,
    '',
    'Task description:',
    request.taskDescription,
    '',
    'Non-blocking qualification warnings:',
    request.qualificationSummary.nonBlockingWarnings.join('; ') || 'none',
  ].join('\n')
}

interface ParsedScoutMarkdown {
  files: string[]
  snippets: PlannerGroundingSnippet[]
  symbols: string[]
  testFiles: string[]
  commands: string[]
  templateMappings: NonNullable<PlannerScoutEvidenceReport['templateMappings']>
  blockers: string[]
  summary?: string
}

function stripBullet(value: string): string {
  return value
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^`([^`]+)`/, '$1')
    .trim()
}

function extractPathCandidate(value: string): string | undefined {
  const codeSpan = value.match(/`([^`]+)`/)
  if (codeSpan?.[1]) {
    return normalizePath(codeSpan[1].split(':')[0].trim())
  }
  const fileMatch = value.match(/(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+/)
  if (fileMatch?.[0]) {
    return normalizePath(fileMatch[0])
  }
  const firstSegment = stripBullet(value)
    .split(/\s[-:]\s|\s+—\s+/u)[0]
    .trim()
  return firstSegment.includes('/') ? normalizePath(firstSegment.split(':')[0]) : undefined
}

function extractSnippet(line: string): PlannerGroundingSnippet | undefined {
  const cleaned = stripBullet(line)
  const match = cleaned.match(/((?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+):(\d+)\s*(?:[-:—]\s*)?(.*)$/u)
  if (!match) {
    const file = extractPathCandidate(cleaned)
    return file
      ? {
          file,
          line: 1,
          term: 'scout',
          text: cleaned.slice(0, SCOUT_SNIPPET_TEXT_MAX),
        }
      : undefined
  }
  return {
    file: normalizePath(match[1]),
    line: Number(match[2]),
    term: 'scout',
    text: (match[3] || cleaned).slice(0, SCOUT_SNIPPET_TEXT_MAX),
  }
}

export function parseScoutMarkdown(markdown: string): ParsedScoutMarkdown {
  let section:
    | 'files'
    | 'snippets'
    | 'symbols'
    | 'tests'
    | 'commands'
    | 'templates'
    | 'risks'
    | 'summary'
    | undefined
  const files: string[] = []
  const snippets: PlannerGroundingSnippet[] = []
  const symbols: string[] = []
  const testFiles: string[] = []
  const commands: string[] = []
  const templateMappings: NonNullable<PlannerScoutEvidenceReport['templateMappings']> = []
  const blockers: string[] = []
  const summaryLines: string[] = []

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    const header = line
      .replace(/^#+\s*/, '')
      .replace(/^\*\*/, '')
      .replace(/\*\*:?$/, '')
      .trim()
      .toLowerCase()
    if (header === 'files') {
      section = 'files'
      continue
    }
    if (header === 'snippets') {
      section = 'snippets'
      continue
    }
    if (header === 'summary') {
      section = 'summary'
      continue
    }
    if (header === 'symbols') {
      section = 'symbols'
      continue
    }
    if (header === 'tests') {
      section = 'tests'
      continue
    }
    if (header === 'commands') {
      section = 'commands'
      continue
    }
    if (header === 'template mappings') {
      section = 'templates'
      continue
    }
    if (header === 'risks') {
      section = 'risks'
      continue
    }

    if (section === 'files') {
      const file = extractPathCandidate(line)
      if (file) {
        files.push(file)
      }
      continue
    }
    if (section === 'snippets') {
      const snippet = extractSnippet(line)
      if (snippet) {
        snippets.push(snippet)
      }
      continue
    }
    if (section === 'summary') {
      summaryLines.push(line)
      continue
    }
    if (section === 'symbols') {
      const symbol = stripBullet(line)
      if (symbol && symbol.toLowerCase() !== 'none') {
        symbols.push(symbol.slice(0, 200))
      }
      continue
    }
    if (section === 'tests') {
      const file = extractPathCandidate(line)
      if (file) {
        testFiles.push(file)
      } else {
        const gap = stripBullet(line)
        if (gap && gap.toLowerCase() !== 'none') {
          blockers.push(`test-surface: ${gap.slice(0, 240)}`)
        }
      }
      continue
    }
    if (section === 'commands') {
      const command = stripBullet(line)
      if (command && command.toLowerCase() !== 'none') {
        commands.push(command.slice(0, 500))
      }
      continue
    }
    if (section === 'templates') {
      const cleaned = stripBullet(line)
      const mapping = cleaned.match(/^(.+?)\s*(?:<-|from)\s*((?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9_.-]+)\s*(?:[-:—]\s*)?(.*)$/u)
      if (mapping) {
        templateMappings.push({
          targetPattern: mapping[1].trim().slice(0, 300),
          templateFile: normalizePath(mapping[2]),
          rationale: (mapping[3] || cleaned).slice(0, 500),
        })
      }
      continue
    }
    if (section === 'risks') {
      const risk = stripBullet(line)
      if (risk && risk.toLowerCase() !== 'none') {
        blockers.push(risk.slice(0, 500))
      }
    }
  }

  return {
    files: unique(files),
    snippets,
    symbols: unique(symbols),
    testFiles: unique(testFiles),
    commands: unique(commands),
    templateMappings,
    blockers: unique(blockers),
    summary: summaryLines.join(' ').trim() || undefined,
  }
}

function emptyMetrics(): Pick<PlannerScoutEvidenceReport, 'durationMs' | 'toolCalls'> {
  return {
    durationMs: 0,
    toolCalls: 0,
  }
}

export class PlannerScoutProvider {
  async runScouts(request: PlannerScoutRequest): Promise<PlannerScoutRunResult> {
    const workPlan = buildPlannerScoutWorkPlan({
      qualificationSummary: request.qualificationSummary,
      groundingContext: request.groundingContext,
      workplan: request.workplan,
    })
    const { workItems, coverage } = workPlan

    if (coverage.requirementCount === 0) {
      return {
        workItems,
        reports: [],
        coverage,
        scoutInvocationFailed: false,
        scoutReturnedNothing: false,
        warnings: [
          ...(request.workplanWarnings ?? []),
          request.workplan
            ? 'Scout workplan selected no scout investigations.'
            : 'No qualification requirements were available for scout fallback.',
        ],
        workplan: request.workplan ?? undefined,
        workplanSource: request.workplanSource ?? (request.workplan ? 'llm' : 'legacy'),
        workplanWarnings: request.workplanWarnings,
        workplanMetrics: request.workplanMetrics,
      }
    }

    if (workItems.length === 0) {
      return {
        workItems,
        reports: [],
        coverage,
        scoutInvocationFailed: false,
        scoutReturnedNothing: false,
        warnings: [
          ...(request.workplanWarnings ?? []),
          'No uncovered requirements were available for scout fallback.',
        ],
        workplan: request.workplan ?? undefined,
        workplanSource: request.workplanSource ?? (request.workplan ? 'llm' : 'legacy'),
        workplanWarnings: request.workplanWarnings,
        workplanMetrics: request.workplanMetrics,
      }
    }

    let reports: PlannerScoutEvidenceReport[]
    try {
      const repoId = registerRepoFromPath(
        request.workspacePath,
        `oneshot-run-${request.jiraKey}-planner-scouts`,
      )

      reports = await Promise.all(
        workItems.map(workItem => this.runSingleScout(request, workItem, repoId)),
      )
    } catch (error) {
      return {
        workItems,
        reports: [],
        coverage,
        scoutInvocationFailed: true,
        scoutReturnedNothing: false,
        warnings: [
          ...(request.workplanWarnings ?? []),
          `Planner scout fallback failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
        workplan: request.workplan ?? undefined,
        workplanSource: request.workplanSource ?? (request.workplan ? 'llm' : 'legacy'),
        workplanWarnings: request.workplanWarnings,
        workplanMetrics: request.workplanMetrics,
      }
    }
    const validScoutCount = reports.filter(
      report => report.status === 'valid' && report.verifiedInspectedFiles.length > 0,
    ).length
    const scoutInvocationFailed = reports.some(report => report.invocationFailed === true)

    return {
      workItems,
      reports,
      coverage,
      scoutInvocationFailed,
      scoutReturnedNothing: reports.length > 0 && validScoutCount === 0 && !scoutInvocationFailed,
      warnings: [
        ...(request.workplanWarnings ?? []),
        ...reports
          .filter(report => report.status !== 'valid')
          .map(report => `${report.workItemId}: ${report.failureReason ?? 'scout did not return usable evidence'}`),
      ],
      workplan: request.workplan ?? undefined,
      workplanSource: request.workplanSource ?? (request.workplan ? 'llm' : 'legacy'),
      workplanWarnings: request.workplanWarnings,
      workplanMetrics: request.workplanMetrics,
    }
  }

  private async runSingleScout(
    request: PlannerScoutRequest,
    workItem: PlannerScoutWorkItem,
    repoId: string,
  ): Promise<PlannerScoutEvidenceReport> {
    try {
      const result = await runAgent({
        taskId: `oneshot-planner-scout-${request.jiraKey}-${workItem.id}-${Date.now()}`,
        sdkStage: 'planning_scout',
        taskPrompt: buildScoutPrompt(request, workItem),
        repoIds: [repoId],
        permissionLevel: 'read_only',
        allowedTools: ['Read', 'Glob', 'Grep'],
        toolBudgetGuard: {
          enabled: true,
          tools: ['Read', 'Glob', 'Grep'],
          maxCalls: workItem.maxToolCalls ?? 8,
          message:
            'Scout tool budget exhausted. Return the best verified evidence, risks, and gaps now.',
        },
        timeoutMs: PLANNER_SCOUT_TIMEOUT_MS,
        maxTurns: SCOUT_MAX_TURNS,
        maxBudgetUsd: SCOUT_MAX_BUDGET_USD,
        bedrockConfig: { model: request.scoutModelId } satisfies Partial<BedrockConfig>,
        permissionMode: request.permissionMode,
        toolVisibility: request.toolVisibility,
        toolGuard: request.toolGuard,
        settingSources: [],
        includePartialMessages: true,
        idleTimeoutMs: PLANNER_SCOUT_IDLE_TIMEOUT_MS,
        compactionGraceMs: 30_000,
      })

      if (!result.success) {
        return {
          workItemId: workItem.id,
          objective: workItem.objective,
          status: 'failed',
          inspectedFiles: [],
          verifiedInspectedFiles: [],
          snippets: [],
          symbols: [],
          testFiles: [],
          commands: [],
          confidence: 'weak',
          blockers: [],
          failureReason: result.error || 'scout provider failed',
          invocationFailed: true,
          ...emptyMetrics(),
          ...result.metrics,
        }
      }

      const parsed = parseScoutMarkdown(result.output)
      const toolCalls = result.metrics.toolCalls ?? 0
      if (toolCalls === 0) {
        return {
          workItemId: workItem.id,
          objective: workItem.objective,
          status: 'ignored',
          inspectedFiles: parsed.files.map(normalizePath),
          verifiedInspectedFiles: [],
          snippets: [],
          symbols: parsed.symbols,
          testFiles: [],
          commands: parsed.commands,
          templateMappings: [],
          confidence: 'weak',
          summary: parsed.summary,
          blockers: parsed.blockers,
          failureReason: 'scout returned without repository tool calls',
          ...result.metrics,
        }
      }

      const parsedFiles = unique([
        ...parsed.files,
        ...parsed.snippets.map(snippet => snippet.file),
        ...parsed.testFiles,
        ...parsed.templateMappings.map(mapping => mapping.templateFile),
      ])
      const verifiedInspectedFiles = await verifyWorkspaceFiles(
        request.workspacePath,
        parsedFiles,
      )
      const verifiedSnippets: PlannerGroundingSnippet[] = parsed.snippets
        .filter(snippet => verifiedInspectedFiles.includes(normalizePath(snippet.file)))
        .map(snippet => ({
          file: normalizePath(snippet.file),
          line: snippet.line,
          term: snippet.term,
          text: snippet.text.slice(0, SCOUT_SNIPPET_TEXT_MAX),
        }))
      const verifiedTestFiles = parsed.testFiles
        .map(normalizePath)
        .filter(file => verifiedInspectedFiles.includes(file))
      const verifiedTemplateMappings = parsed.templateMappings
        .map(mapping => ({
          ...mapping,
          templateFile: normalizePath(mapping.templateFile),
        }))
        .filter(mapping => verifiedInspectedFiles.includes(mapping.templateFile))

      if (parsedFiles.length === 0) {
        return {
          workItemId: workItem.id,
          objective: workItem.objective,
          status: 'ignored',
          inspectedFiles: [],
          verifiedInspectedFiles,
          snippets: verifiedSnippets,
          symbols: parsed.symbols,
          testFiles: verifiedTestFiles,
          commands: parsed.commands,
          templateMappings: verifiedTemplateMappings,
          confidence: 'weak',
          summary: parsed.summary,
          blockers: parsed.blockers,
          failureReason: 'scout returned no parseable files',
          ...result.metrics,
        }
      }

      if (verifiedInspectedFiles.length === 0) {
        return {
          workItemId: workItem.id,
          objective: workItem.objective,
          status: 'ignored',
          inspectedFiles: parsedFiles.map(normalizePath),
          verifiedInspectedFiles,
          snippets: verifiedSnippets,
          symbols: parsed.symbols,
          testFiles: verifiedTestFiles,
          commands: parsed.commands,
          templateMappings: verifiedTemplateMappings,
          confidence: 'weak',
          summary: parsed.summary,
          blockers: parsed.blockers,
          failureReason: 'no inspected files were found in the workspace',
          ...result.metrics,
        }
      }

      return {
        workItemId: workItem.id,
        objective: workItem.objective,
        status: 'valid',
        inspectedFiles: parsedFiles.map(normalizePath),
        verifiedInspectedFiles,
        snippets: verifiedSnippets,
        symbols: parsed.symbols,
        testFiles: verifiedTestFiles,
        commands: parsed.commands,
        templateMappings: verifiedTemplateMappings,
        confidence: verifiedSnippets.length > 0 ? 'strong' : 'medium',
        summary: parsed.summary,
        blockers: parsed.blockers,
        ...result.metrics,
      }
    } catch (error) {
      logger.warn(
        {
          jiraKey: request.jiraKey,
          workItemId: workItem.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Planner scout failed',
      )
      return {
        workItemId: workItem.id,
        objective: workItem.objective,
        status: 'failed',
        inspectedFiles: [],
        verifiedInspectedFiles: [],
        snippets: [],
        symbols: [],
        testFiles: [],
        commands: [],
        confidence: 'weak',
        blockers: [],
        failureReason: error instanceof Error ? error.message : String(error),
        invocationFailed: true,
        ...emptyMetrics(),
      }
    }
  }
}
