import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import * as path from 'path'
import { createLogger } from '../utils/logger.js'
import type { OneShotValidationCheck } from './schema/implementation.js'
import {
  scratchCleanupBytesCounter,
  scratchCleanupFailureCounter,
} from './telemetry/metrics.js'
import {
  buildMavenScratchEnv,
  buildOneShotScratchPath,
} from './maven-env.js'

const execFileAsync = promisify(execFile)
const logger = createLogger('oneshot-test-executor')

const MAX_OUTPUT_BYTES = 8000
const TEST_TIMEOUT_MS = 10 * 60 * 1000
const TEST_REPORT_DIRS = [
  'target/surefire-reports',
  'build/test-results/test',
  'test-results',
  'junit-reports',
]
const DIRECT_TEST_RUNNERS = new Set([
  'vitest',
  'jest',
  'mocha',
  'ava',
  'pytest',
  'py.test',
  'unittest',
  'nose',
  'nose2',
  'tox',
  'phpunit',
  'rspec',
  'playwright',
  'cypress',
  'karma',
  'jasmine',
  'wdio',
  'nextest',
])
const DIRECT_TEST_RUNNER_REQUIRED_SUBCOMMANDS: Partial<Record<string, Set<string>>> = {
  playwright: new Set(['test']),
  cypress: new Set(['run']),
  wdio: new Set(['run']),
  nextest: new Set(['run']),
}
const TEST_KEYWORD_REGEX = /\b(?:test|tests|spec|specs|vitest|jest|mocha|ava|pytest|py\.test|unittest|nose|nose2|tox|phpunit|rspec|playwright|cypress|karma|jasmine|wdio|nextest|e2e|integration|functional|smoke|acceptance)\b/i
const TOKEN_TEST_HINT_REGEX = /(?:^|[-_.:/])(?:test|tests|spec|specs|vitest|jest|mocha|ava|pytest|unittest|nose|nose2|tox|phpunit|rspec|playwright|cypress|karma|jasmine|wdio|nextest|e2e|integration|functional|smoke|acceptance)(?:$|[-_.:/])/i

export interface TestExecResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface ValidationCheckExecResult {
  check: OneShotValidationCheck
  command: string
  exitCode: number
  passed: boolean
  stdout: string
  stderr: string
  durationMs: number
}

export interface ValidationCheckExecOptions {
  baseCommitSha?: string
}

export interface ParsedTestReport {
  passCount: number
  failCount: number
  skipCount: number
  failedTests: Array<{
    testName: string
    className?: string
    message: string
    stackTrace?: string
  }>
}

export interface ParsedCoverage {
  linePercent?: number
  branchPercent?: number
  threshold: number
  passed: boolean
}

export type TestReportSnapshot = Map<string, string>

export type TestExecutionKind =
  | 'automated_tests'
  | 'validation_only'
  | 'invalid_command'
  | 'no_runnable_command'

export type TestCommandResolution =
  | {
      kind: 'commands'
      executionKind: 'automated_tests' | 'validation_only'
      automatedCommands: string[]
      validationCommands: string[]
      validationChecks: OneShotValidationCheck[]
      skippedTestCommands: string[]
      mavenSkippedTestCommands: string[]
      mavenBuildsDisabled: boolean
      source: 'implementation' | 'planner' | 'heuristic'
      parserNotes: string[]
    }
  | {
      kind: 'none'
      executionKind: 'invalid_command' | 'no_runnable_command'
      source: 'none'
      parserNotes: string[]
      failureReason: string
      skippedTestCommands: string[]
      mavenSkippedTestCommands: string[]
      mavenBuildsDisabled: boolean
    }

const COVERAGE_THRESHOLD_PERCENT = 80
const MANUAL_VERIFICATION_PREFIX = /^(?:verify|check|confirm|inspect|review|manually|click|look|ensure|open|browse|visit)\b/i
const INTERACTIVE_COMMAND_TOKENS = new Set(['open', 'xdg-open'])
const DIRECT_VALIDATION_COMMANDS = new Set(['grep', 'rg'])
const NODE_TEST_WRAPPER_EXECUTABLES = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const UNSUPPORTED_SHELL_SYNTAX_MESSAGE = 'Unsupported shell syntax in testCommands or validationCommands; split chained checks into separate array entries.'
const UNSUPPORTED_ENV_ASSIGNMENT_MESSAGE = 'Unsupported env-assignment prefix in testCommands or validationCommands; run the command directly from the repo root.'
const NON_SIGNAL_PACKAGE_TEST_SCRIPT_PATTERNS = [
  /^\s*echo\s+["']?error:\s*no test specified["']?\s*(?:&&|;)?\s*exit\s+1\s*$/i,
  /^\s*printf\s+["']?error:\s*no test specified["']?\s*(?:&&|;)?\s*exit\s+1\s*$/i,
]
const EMPTY_OPTION_VALUE_FLAGS = new Set<string>()
const NPX_OPTION_VALUE_FLAGS = new Set(['--package', '-p', '--cache', '--userconfig'])
const TSX_OPTION_VALUE_FLAGS = new Set([
  '--tsconfig',
  '--import',
  '-i',
  '--loader',
  '--require',
  '-r',
  '--env-file',
  '--cwd',
  '-C',
])
const REPO_LOCAL_MAVEN_SETTINGS = path.join('.m2', 'settings.xml')
const GWT_SKIP_PROPERTY_NAME = 'skip.gwt.compile'
const GWT_SKIP_PROPERTY_ARG = `-D${GWT_SKIP_PROPERTY_NAME}=true`

interface ParsedExecutableCommand {
  argv: string[]
  executable: string
}

interface RunnableCommandCollection {
  accepted: string[]
  skippedTestCommands: string[]
  mavenSkippedTestCommands: string[]
  parserNotes: string[]
  failureReasons: string[]
}

interface ImplementationCommandCollection {
  automatedAccepted: string[]
  validationAccepted: string[]
  skippedTestCommands: string[]
  mavenSkippedTestCommands: string[]
  parserNotes: string[]
  failureReasons: string[]
}

interface TestCommandResolveOptions {
  mavenBuildsEnabled?: boolean
  requireModuleScopedMaven?: boolean
}

interface PackageScriptPreflight {
  runnerToken: string
  requiredTargetPath?: string
}

type NodePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

type NodeWrapperPackageRootSelector =
  | {
      type: 'relative_path'
      option: string
      value: string
    }
  | {
      type: 'unsupported_scope'
      option: string
      value?: string
    }

interface NodeWrapperInvocation {
  packageManager: NodePackageManager
  kind: 'built_in_test' | 'package_script'
  scriptName: string
  packageRootSelector?: NodeWrapperPackageRootSelector
}

const NODE_WRAPPER_FLAG_CONFIG: Record<NodePackageManager, {
  valueFlags: Set<string>
  pathSelectorFlags: Set<string>
  unsupportedScopeValueFlags: Set<string>
  unsupportedScopeBooleanFlags: Set<string>
}> = {
  npm: {
    valueFlags: new Set(['--prefix', '-C', '--workspace', '-w', '--loglevel', '--cache', '--userconfig']),
    pathSelectorFlags: new Set(['--prefix', '-C']),
    unsupportedScopeValueFlags: new Set(['--workspace', '-w']),
    unsupportedScopeBooleanFlags: new Set(['--workspaces']),
  },
  pnpm: {
    valueFlags: new Set(['--dir', '-C', '--filter', '-F']),
    pathSelectorFlags: new Set(['--dir', '-C']),
    unsupportedScopeValueFlags: new Set(['--filter', '-F']),
    unsupportedScopeBooleanFlags: new Set(['--recursive', '-r']),
  },
  yarn: {
    valueFlags: new Set(['--cwd']),
    pathSelectorFlags: new Set(['--cwd']),
    unsupportedScopeValueFlags: new Set<string>(),
    unsupportedScopeBooleanFlags: new Set<string>(),
  },
  bun: {
    valueFlags: new Set(['--cwd']),
    pathSelectorFlags: new Set(['--cwd']),
    unsupportedScopeValueFlags: new Set<string>(),
    unsupportedScopeBooleanFlags: new Set<string>(),
  },
}

type ParsedExecutableCommandResult =
  | {
      ok: true
      parsed: ParsedExecutableCommand
    }
  | {
      ok: false
      message: string
    }

function normalizeCommand(command: string): string {
  return command.trim()
}

function isMavenExecutable(cmd: string): boolean {
  const basename = path.basename(cmd).toLowerCase()
  return basename === 'mvn' || basename === 'mvnw' || basename === 'mvnw.cmd'
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value)
  }
}

function isModuleScopedMavenCommand(parsedCommand: ParsedExecutableCommand): boolean {
  const args = parsedCommand.argv.slice(1)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-pl' || arg === '--projects') {
      return Boolean(args[index + 1])
    }
    if (arg.startsWith('-pl') && arg.length > 3) {
      return true
    }
    if (arg.startsWith('--projects=')) {
      return true
    }
    if (arg === '-f' || arg === '--file') {
      const file = args[index + 1]?.replaceAll('\\', '/')
      return Boolean(file && file !== 'pom.xml' && file.endsWith('/pom.xml'))
    }
    if (arg.startsWith('-f') && arg.length > 2) {
      const file = arg.slice(2).replaceAll('\\', '/')
      return file !== 'pom.xml' && file.endsWith('/pom.xml')
    }
    if (arg.startsWith('--file=')) {
      const file = arg.slice('--file='.length).replaceAll('\\', '/')
      return file !== 'pom.xml' && file.endsWith('/pom.xml')
    }
  }
  return false
}

function buildScratchPath(workspacePath: string, stage: string): string {
  return buildOneShotScratchPath(workspacePath, stage)
}

async function prepareScratchPath(workspacePath: string, stage: string): Promise<string> {
  const scratchPath = buildScratchPath(workspacePath, stage)
  await fs.mkdir(scratchPath, { recursive: true })
  return scratchPath
}

async function directorySizeBytes(targetPath: string): Promise<number> {
  let total = 0
  const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name)
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath)
      continue
    }
    if (entry.isFile()) {
      total += (await fs.stat(entryPath).catch(() => ({ size: 0 }))).size
    }
  }
  return total
}

async function cleanupScratchPath(scratchPath: string, stage: string): Promise<void> {
  try {
    const bytes = await directorySizeBytes(scratchPath)
    await fs.rm(scratchPath, { recursive: true, force: true })
    scratchCleanupBytesCounter.add(bytes, { stage })
  } catch (error) {
    scratchCleanupFailureCounter.add(1, { stage })
    logger.warn(
      {
        scratchPath,
        stage,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to clean OneShot scratch path',
    )
  }
}

function hasMavenSettingsArg(args: string[]): boolean {
  return args.some((arg, index) =>
    arg === '-s'
    || arg === '--settings'
    || arg.startsWith('-s=')
    || arg.startsWith('--settings=')
    || (index > 0 && (args[index - 1] === '-s' || args[index - 1] === '--settings'))
  )
}

function hasMavenBatchArg(args: string[]): boolean {
  return args.some((arg) => arg === '-B' || arg === '--batch-mode')
}

function hasMavenPropertyArg(args: string[], propertyName: string): boolean {
  return args.some((arg) =>
    arg === `-D${propertyName}` || arg.startsWith(`-D${propertyName}=`)
  )
}

function hasMavenTestGoal(args: string[]): boolean {
  return args.some((arg) =>
    arg === 'test' || arg === 'surefire:test' || arg.endsWith(':test')
  )
}

function resolveMavenPomPath(workspacePath: string, args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if ((arg === '-f' || arg === '--file') && args[index + 1]) {
      return path.resolve(workspacePath, args[index + 1])
    }
    if (arg.startsWith('-f=') || arg.startsWith('--file=')) {
      return path.resolve(workspacePath, arg.slice(arg.indexOf('=') + 1))
    }
  }
  return path.join(workspacePath, 'pom.xml')
}

async function hasRepoLocalMavenSettings(workspacePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(workspacePath, REPO_LOCAL_MAVEN_SETTINGS), fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

async function pomSupportsGwtCompileSkip(workspacePath: string, args: string[]): Promise<boolean> {
  try {
    const pomXml = await fs.readFile(resolveMavenPomPath(workspacePath, args), 'utf8')
    return pomXml.includes(`<${GWT_SKIP_PROPERTY_NAME}>`)
      || pomXml.includes(GWT_SKIP_PROPERTY_NAME)
  } catch {
    return false
  }
}

async function shouldInjectGwtCompileSkip(
  workspacePath: string,
  args: string[],
): Promise<boolean> {
  return hasMavenTestGoal(args)
    && !hasMavenPropertyArg(args, GWT_SKIP_PROPERTY_NAME)
    && await pomSupportsGwtCompileSkip(workspacePath, args)
}

async function buildMavenAwareArgs(
  workspacePath: string,
  cmd: string,
  args: string[],
): Promise<{ args: string[]; parserNotes: string[] }> {
  if (!isMavenExecutable(cmd) || !(await hasRepoLocalMavenSettings(workspacePath))) {
    return { args, parserNotes: [] }
  }

  const injectedArgs: string[] = []
  const parserNotes: string[] = []
  if (!hasMavenSettingsArg(args)) {
    injectedArgs.push('-s', REPO_LOCAL_MAVEN_SETTINGS)
    parserNotes.push(`Using repo-local Maven settings from ${REPO_LOCAL_MAVEN_SETTINGS}.`)
  }

  if (!hasMavenBatchArg(args)) {
    injectedArgs.push('--batch-mode')
    parserNotes.push('Running Maven in batch mode.')
  }

  if (await shouldInjectGwtCompileSkip(workspacePath, args)) {
    injectedArgs.push(GWT_SKIP_PROPERTY_ARG)
    parserNotes.push(`Skipping GWT compilation for Maven test goal via ${GWT_SKIP_PROPERTY_ARG}.`)
  }

  return {
    args: [...injectedArgs, ...args],
    parserNotes,
  }
}

function buildMavenAwareEnv(
  cmd: string,
  baseEnv: NodeJS.ProcessEnv,
  scratchPath?: string,
): NodeJS.ProcessEnv {
  if (!isMavenExecutable(cmd)) {
    return baseEnv
  }

  return scratchPath ? buildMavenScratchEnv(baseEnv, scratchPath) : baseEnv
}

function extractFirstToken(command: string): string | undefined {
  const [token] = normalizeCommand(command).split(/\s+/)
  return token || undefined
}

function isCommandSubstitutionStart(command: string, index: number): boolean {
  return command[index] === '$' && command[index + 1] === '('
}

function parseExecutableCommand(command: string): ParsedExecutableCommandResult {
  const normalized = normalizeCommand(command)
  if (!normalized) {
    return {
      ok: false,
      message: 'command is empty after normalization.',
    }
  }

  const argv: string[] = []
  let current = ''
  let tokenStarted = false
  let quote: 'single' | 'double' | null = null
  let escaping = false

  const pushToken = () => {
    if (!tokenStarted) {
      return
    }
    argv.push(current)
    current = ''
    tokenStarted = false
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]

    if (quote === 'single') {
      if (char === '\'') {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (quote === 'double') {
      if (escaping) {
        current += char
        escaping = false
        tokenStarted = true
        continue
      }

      if (char === '\\') {
        const nextChar = normalized[index + 1]
        if (nextChar === '"' || nextChar === '\\') {
          escaping = true
        } else {
          current += '\\'
        }
        tokenStarted = true
        continue
      }

      if (char === '"') {
        quote = null
        continue
      }

      if (char === '`' || isCommandSubstitutionStart(normalized, index)) {
        return {
          ok: false,
          message: UNSUPPORTED_SHELL_SYNTAX_MESSAGE,
        }
      }

      current += char
      tokenStarted = true
      continue
    }

    if (escaping) {
      current += char
      escaping = false
      tokenStarted = true
      continue
    }

    if (char === '\\') {
      escaping = true
      tokenStarted = true
      continue
    }

    if (char === '\'') {
      quote = 'single'
      tokenStarted = true
      continue
    }

    if (char === '"') {
      quote = 'double'
      tokenStarted = true
      continue
    }

    if (/\s/.test(char)) {
      pushToken()
      continue
    }

    if (
      char === ';'
      || char === '|'
      || char === '<'
      || char === '>'
      || char === '`'
      || isCommandSubstitutionStart(normalized, index)
      || (char === '&' && normalized[index + 1] === '&')
      || (char === '|' && normalized[index + 1] === '|')
    ) {
      return {
        ok: false,
        message: UNSUPPORTED_SHELL_SYNTAX_MESSAGE,
      }
    }

    current += char
    tokenStarted = true
  }

  if (escaping) {
    return {
      ok: false,
      message: 'command ends with an unfinished escape sequence.',
    }
  }

  if (quote !== null) {
    return {
      ok: false,
      message: 'command contains an unterminated quoted argument.',
    }
  }

  pushToken()

  if (argv.length === 0 || !argv[0]) {
    return {
      ok: false,
      message: 'command is empty after parsing.',
    }
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(argv[0])) {
    return {
      ok: false,
      message: UNSUPPORTED_ENV_ASSIGNMENT_MESSAGE,
    }
  }

  return {
    ok: true,
    parsed: {
      argv,
      executable: argv[0],
    },
  }
}

function looksLikeTestHint(part: string): boolean {
  const normalized = part.trim()
  if (!normalized) {
    return false
  }

  const lower = normalized.toLowerCase()
  return TEST_KEYWORD_REGEX.test(normalized)
    || TOKEN_TEST_HINT_REGEX.test(lower)
    || /(test|tests|spec|specs|e2e|integration|functional|smoke|acceptance|unittest|nose|nose2|nextest)$/i.test(normalized)
}

function hasTestSignal(parts: string[]): boolean {
  return parts.some((part) => looksLikeTestHint(part))
}

function getRepoLocalBinPath(workspacePath: string, token: string): string {
  return path.join(workspacePath, 'node_modules', '.bin', token)
}

function isPathLikeToken(token: string): boolean {
  return token.startsWith('./') || token.startsWith('../') || path.isAbsolute(token)
}

function looksLikeRepoRelativeFileToken(token: string): boolean {
  return isPathLikeToken(token)
    || token.includes('/')
    || path.extname(token).length > 0
}

function looksLikeManualVerification(command: string): boolean {
  const normalized = normalizeCommand(command)
  if (!normalized) {
    return false
  }

  const firstToken = extractFirstToken(normalized)?.toLowerCase()
  if (firstToken && INTERACTIVE_COMMAND_TOKENS.has(firstToken)) {
    return true
  }

  return MANUAL_VERIFICATION_PREFIX.test(normalized)
    || /\b(?:in (?:the )?browser|visually|manual(?:ly)?|ui(?:\s|-)?check|visual(?:\s|-)?check|browser(?:\s|-)?check)\b/i.test(normalized)
}

function looksLikeMeaningfulPackageTestScript(script: string): boolean {
  const normalized = normalizeCommand(script)
  if (!normalized) {
    return false
  }

  if (NON_SIGNAL_PACKAGE_TEST_SCRIPT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false
  }

  return TEST_KEYWORD_REGEX.test(normalized)
    || TOKEN_TEST_HINT_REGEX.test(normalized.toLowerCase())
}

function getAttachedOptionValue(token: string, option: string): string | null | undefined {
  if (token === option) {
    return null
  }

  if (token.startsWith(`${option}=`)) {
    return token.slice(option.length + 1)
  }

  if (option.startsWith('-') && !option.startsWith('--') && token.startsWith(option) && token.length > option.length) {
    return token.slice(option.length)
  }

  return undefined
}

function consumeLeadingOption(
  argv: string[],
  index: number,
  options: Set<string>,
): { matched: true; option: string; value?: string; nextIndex: number } | { matched: false } {
  const token = argv[index]
  for (const option of options) {
    const attachedValue = getAttachedOptionValue(token, option)
    if (attachedValue === undefined) {
      continue
    }

    if (attachedValue !== null) {
      return {
        matched: true,
        option,
        value: attachedValue,
        nextIndex: index + 1,
      }
    }

    return {
      matched: true,
      option,
      value: argv[index + 1],
      nextIndex: Math.min(argv.length, index + 2),
    }
  }

  return { matched: false }
}

function findFirstPositionalTokenIndex(
  argv: string[],
  startIndex: number,
  valueFlags: Set<string>,
): number {
  let index = startIndex
  while (index < argv.length) {
    const token = argv[index]
    if (token === '--') {
      return index + 1 < argv.length ? index + 1 : -1
    }
    if (!token.startsWith('-')) {
      return index
    }
    const consumedOption = consumeLeadingOption(argv, index, valueFlags)
    index = consumedOption.matched ? consumedOption.nextIndex : index + 1
  }
  return -1
}

function resolveNodeWrapperLeadingContext(
  parsedCommand: ParsedExecutableCommand,
): { commandIndex: number; packageRootSelector?: NodeWrapperPackageRootSelector } | null {
  const packageManager = parsedCommand.executable.toLowerCase() as NodePackageManager
  const config = NODE_WRAPPER_FLAG_CONFIG[packageManager]
  if (!config) {
    return null
  }

  let index = 1
  let packageRootSelector: NodeWrapperPackageRootSelector | undefined
  while (index < parsedCommand.argv.length) {
    const token = parsedCommand.argv[index]
    if (token === '--') {
      return index + 1 < parsedCommand.argv.length
        ? { commandIndex: index + 1, packageRootSelector }
        : null
    }
    if (!token.startsWith('-')) {
      return { commandIndex: index, packageRootSelector }
    }

    const pathSelector = consumeLeadingOption(parsedCommand.argv, index, config.pathSelectorFlags)
    if (pathSelector.matched) {
      if (pathSelector.value) {
        packageRootSelector = {
          type: 'relative_path',
          option: pathSelector.option,
          value: pathSelector.value,
        }
      }
      index = pathSelector.nextIndex
      continue
    }

    const unsupportedScope = consumeLeadingOption(parsedCommand.argv, index, config.unsupportedScopeValueFlags)
    if (unsupportedScope.matched) {
      packageRootSelector = {
        type: 'unsupported_scope',
        option: unsupportedScope.option,
        value: unsupportedScope.value,
      }
      index = unsupportedScope.nextIndex
      continue
    }

    if (config.unsupportedScopeBooleanFlags.has(token)) {
      packageRootSelector = {
        type: 'unsupported_scope',
        option: token,
      }
      index += 1
      continue
    }

    const valueOption = consumeLeadingOption(parsedCommand.argv, index, config.valueFlags)
    index = valueOption.matched ? valueOption.nextIndex : index + 1
  }

  return null
}

function supportsBarePackageScriptInvocation(packageManager: NodePackageManager): boolean {
  return packageManager === 'pnpm' || packageManager === 'yarn'
}

function classifyNodeWrapperInvocation(
  parsedCommand: ParsedExecutableCommand,
): NodeWrapperInvocation | null {
  const packageManager = parsedCommand.executable.toLowerCase() as NodePackageManager
  if (!NODE_TEST_WRAPPER_EXECUTABLES.has(packageManager)) {
    return null
  }

  const leadingContext = resolveNodeWrapperLeadingContext(parsedCommand)
  if (!leadingContext) {
    return null
  }

  const subcommand = parsedCommand.argv[leadingContext.commandIndex]?.toLowerCase()
  if (!subcommand) {
    return null
  }

  if (packageManager === 'bun' && subcommand === 'test') {
    return {
      packageManager,
      kind: 'built_in_test',
      scriptName: 'test',
      packageRootSelector: leadingContext.packageRootSelector,
    }
  }

  if (subcommand === 'workspace') {
    const workspaceNameIndex = findFirstPositionalTokenIndex(
      parsedCommand.argv,
      leadingContext.commandIndex + 1,
      EMPTY_OPTION_VALUE_FLAGS,
    )
    if (workspaceNameIndex < 0) {
      return null
    }

    const workspaceName = parsedCommand.argv[workspaceNameIndex]
    const nestedCommandIndex = findFirstPositionalTokenIndex(
      parsedCommand.argv,
      workspaceNameIndex + 1,
      EMPTY_OPTION_VALUE_FLAGS,
    )
    if (nestedCommandIndex < 0) {
      return null
    }

    const nestedCommand = parsedCommand.argv[nestedCommandIndex].toLowerCase()
    if (nestedCommand === 'run') {
      const scriptIndex = findFirstPositionalTokenIndex(
        parsedCommand.argv,
        nestedCommandIndex + 1,
        EMPTY_OPTION_VALUE_FLAGS,
      )
      if (scriptIndex < 0) {
        return null
      }

      const scriptName = parsedCommand.argv[scriptIndex]
      if (!looksLikeTestHint(scriptName)) {
        return null
      }

      return {
        packageManager,
        kind: 'package_script',
        scriptName,
        packageRootSelector: {
          type: 'unsupported_scope',
          option: 'workspace',
          value: workspaceName,
        },
      }
    }

    if (!looksLikeTestHint(nestedCommand)) {
      return null
    }

    return {
      packageManager,
      kind: 'package_script',
      scriptName: parsedCommand.argv[nestedCommandIndex],
      packageRootSelector: {
        type: 'unsupported_scope',
        option: 'workspace',
        value: workspaceName,
      },
    }
  }

  if (subcommand === 'test') {
    return {
      packageManager,
      kind: 'package_script',
      scriptName: 'test',
      packageRootSelector: leadingContext.packageRootSelector,
    }
  }

  if (subcommand === 'run') {
    const scriptIndex = findFirstPositionalTokenIndex(
      parsedCommand.argv,
      leadingContext.commandIndex + 1,
      EMPTY_OPTION_VALUE_FLAGS,
    )
    if (scriptIndex < 0) {
      return null
    }

    const scriptName = parsedCommand.argv[scriptIndex]
    if (!looksLikeTestHint(scriptName)) {
      return null
    }

    return {
      packageManager,
      kind: 'package_script',
      scriptName,
      packageRootSelector: leadingContext.packageRootSelector,
    }
  }

  if (!supportsBarePackageScriptInvocation(packageManager) || !looksLikeTestHint(subcommand)) {
    return null
  }

  return {
    packageManager,
    kind: 'package_script',
    scriptName: parsedCommand.argv[leadingContext.commandIndex],
    packageRootSelector: leadingContext.packageRootSelector,
  }
}

function resolveNodeWrapperPackageRootPath(
  workspacePath: string,
  invocation: NodeWrapperInvocation,
): string | null {
  const selector = invocation.packageRootSelector
  if (!selector) {
    return workspacePath
  }

  if (selector.type === 'relative_path') {
    return path.resolve(workspacePath, selector.value)
  }

  return null
}

function buildNodeWrapperUnsupportedScopeMessage(
  sourceLabel: string,
  command: string,
  selector: NodeWrapperPackageRootSelector,
): string {
  const suffix = selector.value ? ` ${selector.value}` : ''
  return `Ignoring ${sourceLabel} test command "${command}" because ${selector.option}${suffix} selects a package scope that cannot be validated preflight.`
}

function isConcreteExecutableToken(token: string): boolean {
  return !token.startsWith('@') && !token.includes('/') && path.extname(token) === ''
}

function isSupportedDirectTestRunnerInvocation(
  parsedCommand: ParsedExecutableCommand,
): boolean {
  const executable = parsedCommand.executable.toLowerCase()
  if (!DIRECT_TEST_RUNNERS.has(executable)) {
    return false
  }

  const requiredSubcommands = DIRECT_TEST_RUNNER_REQUIRED_SUBCOMMANDS[executable]
  if (!requiredSubcommands) {
    return true
  }

  return parsedCommand.argv
    .slice(1)
    .some((token) => requiredSubcommands.has(token.toLowerCase()))
}

function resolvePackageScriptPreflight(
  parsedCommand: ParsedExecutableCommand,
  packageRootPath: string,
): PackageScriptPreflight | null {
  const executable = parsedCommand.executable.toLowerCase()

  if (executable === 'npx') {
    const runnerIndex = findFirstPositionalTokenIndex(
      parsedCommand.argv,
      1,
      NPX_OPTION_VALUE_FLAGS,
    )
    if (runnerIndex < 0) {
      return null
    }

    const runnerToken = parsedCommand.argv[runnerIndex]
    const normalizedRunner = runnerToken.toLowerCase()
    if (
      !isConcreteExecutableToken(runnerToken)
      || (
        !DIRECT_TEST_RUNNERS.has(normalizedRunner)
        && normalizedRunner !== 'tsx'
      )
    ) {
      return null
    }

    const preflight: PackageScriptPreflight = {
      runnerToken,
    }

    if (
      DIRECT_TEST_RUNNERS.has(normalizedRunner)
      && !isSupportedDirectTestRunnerInvocation({
        executable: runnerToken,
        argv: [runnerToken, ...parsedCommand.argv.slice(runnerIndex + 1)],
      })
    ) {
      return null
    }

    if (normalizedRunner === 'tsx') {
      const targetArgIndex = findFirstPositionalTokenIndex(
        parsedCommand.argv,
        runnerIndex + 1,
        TSX_OPTION_VALUE_FLAGS,
      )
      const targetArg = targetArgIndex >= 0 ? parsedCommand.argv[targetArgIndex] : undefined
      if (!targetArg || !looksLikeRepoRelativeFileToken(targetArg)) {
        return null
      }
      preflight.requiredTargetPath = path.resolve(packageRootPath, targetArg)
    }

    return preflight
  }

  if (isSupportedDirectTestRunnerInvocation(parsedCommand)) {
    return {
      runnerToken: parsedCommand.executable,
    }
  }

  if (executable === 'tsx') {
    const targetArgIndex = findFirstPositionalTokenIndex(
      parsedCommand.argv,
      1,
      TSX_OPTION_VALUE_FLAGS,
    )
    const targetArg = targetArgIndex >= 0 ? parsedCommand.argv[targetArgIndex] : undefined
    if (!targetArg || !looksLikeRepoRelativeFileToken(targetArg)) {
      return null
    }
    return {
      runnerToken: parsedCommand.executable,
      requiredTargetPath: path.resolve(packageRootPath, targetArg),
    }
  }

  return null
}

async function getNodeWrapperCommandValidationFailure(
  workspacePath: string,
  command: string,
  parsedCommand: ParsedExecutableCommand,
  sourceLabel: string,
): Promise<string | null> {
  const invocation = classifyNodeWrapperInvocation(parsedCommand)
  if (!invocation || invocation.kind !== 'package_script') {
    return null
  }

  const packageRootPath = resolveNodeWrapperPackageRootPath(workspacePath, invocation)
  if (!packageRootPath) {
    return invocation.packageRootSelector
      ? buildNodeWrapperUnsupportedScopeMessage(sourceLabel, command, invocation.packageRootSelector)
      : `Ignoring ${sourceLabel} test command "${command}" because the package root could not be resolved for preflight validation.`
  }

  const packageJsonPath = path.join(packageRootPath, 'package.json')
  let pkg: { scripts?: Record<string, unknown> }
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8')
    pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> }
  } catch {
    const relativePackageJsonPath = path.relative(workspacePath, packageJsonPath) || 'package.json'
    return `Ignoring ${sourceLabel} test command "${command}" because ${relativePackageJsonPath} could not be read from the repo root.`
  }

  const script = pkg.scripts?.[invocation.scriptName]
  if (typeof script !== 'string') {
    return `Ignoring ${sourceLabel} test command "${command}" because package.json scripts.${invocation.scriptName} is missing.`
  }

  if (!looksLikeMeaningfulPackageTestScript(script)) {
    return `Ignoring ${sourceLabel} test command "${command}" because package.json scripts.${invocation.scriptName}="${script}" does not appear to be a meaningful automated test entrypoint.`
  }

  const parsedScript = parseExecutableCommand(script)
  if (parsedScript.ok === false) {
    return `Ignoring ${sourceLabel} test command "${command}" because package.json scripts.${invocation.scriptName}="${script}" cannot be validated preflight: ${parsedScript.message}`
  }

  if (!looksLikeAutomatedTestCommand(script, parsedScript.parsed)) {
    return `Ignoring ${sourceLabel} test command "${command}" because package.json scripts.${invocation.scriptName}="${script}" does not appear to be a real automated test command.`
  }

  const preflight = resolvePackageScriptPreflight(parsedScript.parsed, packageRootPath)
  if (!preflight) {
    return `Ignoring ${sourceLabel} test command "${command}" because package.json scripts.${invocation.scriptName}="${script}" uses a wrapper that cannot be validated preflight.`
  }

  const runnerExists = await commandTokenExists(packageRootPath, preflight.runnerToken)
  if (!runnerExists) {
    return `Ignoring ${sourceLabel} test command "${command}" because package.json scripts.${invocation.scriptName} resolves to "${script}" but underlying runner "${preflight.runnerToken}" is not available from the repo root.`
  }

  if (preflight.requiredTargetPath) {
    try {
      await fs.access(preflight.requiredTargetPath, fsConstants.R_OK)
    } catch {
      const relativeTarget = path.relative(packageRootPath, preflight.requiredTargetPath)
      return `Ignoring ${sourceLabel} test command "${command}" because package.json scripts.${invocation.scriptName} resolves to "${script}" but target "${relativeTarget}" is missing from the selected package root.`
    }
  }

  return null
}

async function commandTokenExists(workspacePath: string, token: string): Promise<boolean> {
  if (!token) {
    return false
  }

  if (isPathLikeToken(token)) {
    const absolutePath = path.isAbsolute(token)
      ? token
      : path.resolve(workspacePath, token)

    try {
      await fs.access(absolutePath, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }

  try {
    await fs.access(getRepoLocalBinPath(workspacePath, token), fsConstants.X_OK)
    return true
  } catch {
    // fall through to PATH lookup
  }

  try {
    await execFileAsync('which', [token], {
      env: process.env,
    })
    return true
  } catch {
    return false
  }
}

function looksLikeAutomatedTestCommand(
  command: string,
  parsedCommand: ParsedExecutableCommand,
): boolean {
  const normalized = normalizeCommand(command)
  if (!normalized) {
    return false
  }

  const tokens = parsedCommand.argv
  const token = parsedCommand.executable
  if (isPathLikeToken(token)) {
    return hasTestSignal([path.basename(token), ...tokens.slice(1)])
  }

  const lowerTokens = tokens.map((part) => part.toLowerCase())
  const tokenLower = token.toLowerCase()

  if (DIRECT_TEST_RUNNERS.has(tokenLower)) {
    return isSupportedDirectTestRunnerInvocation(parsedCommand)
  }

  if (TOKEN_TEST_HINT_REGEX.test(tokenLower)) {
    return true
  }

  const wrapperInvocation = classifyNodeWrapperInvocation(parsedCommand)
  if (wrapperInvocation) {
    return true
  }

  if (tokenLower === 'npx') {
    const runnerIndex = findFirstPositionalTokenIndex(tokens, 1, NPX_OPTION_VALUE_FLAGS)
    const nextToken = runnerIndex >= 0 ? lowerTokens[runnerIndex] : undefined
    return nextToken !== undefined
      && (
        isConcreteExecutableToken(tokens[runnerIndex] ?? '')
        && (
          (
            DIRECT_TEST_RUNNERS.has(nextToken)
            && isSupportedDirectTestRunnerInvocation({
              executable: tokens[runnerIndex] ?? '',
              argv: [tokens[runnerIndex] ?? '', ...tokens.slice(runnerIndex + 1)],
            })
          )
          || nextToken === 'tsx'
        )
        || (nextToken === 'tsx' && hasTestSignal(tokens.slice(runnerIndex + 1)))
      )
  }

  if (tokenLower === 'mvn' || tokenLower === 'mvnw') {
    return /\b(?:test|verify)\b/i.test(normalized)
  }

  if (tokenLower === 'gradle' || tokenLower === 'gradlew') {
    return /\b(?:test|check)\b/i.test(normalized)
  }

  if (tokenLower === 'go' || tokenLower === 'dotnet' || tokenLower === 'mix') {
    return lowerTokens[1] === 'test'
  }

  if (tokenLower === 'cargo') {
    return lowerTokens[1] === 'test'
      || (lowerTokens[1] === 'nextest' && lowerTokens[2] === 'run')
  }

  if (tokenLower === 'make' || tokenLower === 'just') {
    return hasTestSignal(tokens.slice(1))
  }

  if (
    tokenLower === 'node'
    || tokenLower === 'tsx'
    || tokenLower === 'python'
    || tokenLower === 'python3'
    || tokenLower === 'ruby'
    || tokenLower === 'bash'
    || tokenLower === 'sh'
    || tokenLower === 'bundle'
    || tokenLower === 'poetry'
    || tokenLower === 'uv'
  ) {
    return hasTestSignal(tokens.slice(1))
  }

  return false
}

function looksLikeValidationCommand(
  parsedCommand: ParsedExecutableCommand,
): boolean {
  const executable = parsedCommand.executable.toLowerCase()
  if (!DIRECT_VALIDATION_COMMANDS.has(executable)) {
    return false
  }

  return parsedCommand.argv.slice(1).some((part) => !part.startsWith('-'))
}

async function scanTestReportFiles(workspacePath: string): Promise<TestReportSnapshot> {
  const snapshot: TestReportSnapshot = new Map()

  for (const dir of TEST_REPORT_DIRS) {
    const fullDir = path.join(workspacePath, dir)
    try {
      const entries = await fs.readdir(fullDir)
      const xmlFiles = entries.filter((file) => file.endsWith('.xml'))

      for (const xmlFile of xmlFiles) {
        const absolutePath = path.join(fullDir, xmlFile)
        const stats = await fs.stat(absolutePath)
        snapshot.set(
          absolutePath,
          `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
        )
      }
    } catch {
      // directory doesn't exist
    }
  }

  return snapshot
}

export async function captureTestReportSnapshot(workspacePath: string): Promise<TestReportSnapshot> {
  return scanTestReportFiles(workspacePath)
}

async function collectRunnableCommands(
  workspacePath: string,
  commands: string[],
  sourceLabel: string,
  mode: 'automated' | 'validation',
  options: TestCommandResolveOptions = {},
): Promise<RunnableCommandCollection> {
  const accepted: string[] = []
  const skippedTestCommands: string[] = []
  const mavenSkippedTestCommands: string[] = []
  const parserNotes: string[] = []
  const failureReasons: string[] = []
  const mavenBuildsEnabled = options.mavenBuildsEnabled ?? true

  for (const rawCommand of commands) {
    const command = normalizeCommand(rawCommand)
    if (!command) {
      continue
    }

    if (looksLikeManualVerification(command)) {
      parserNotes.push(
        `Ignoring ${sourceLabel} test command "${command}" because it appears to be manual or interactive verification.`,
      )
      continue
    }

    const parsedCommand = parseExecutableCommand(command)
    if (parsedCommand.ok === false) {
      parserNotes.push(
        `Ignoring ${sourceLabel} test command "${command}" because ${parsedCommand.message}`,
      )
      failureReasons.push(parsedCommand.message)
      continue
    }

    const acceptedByMode = mode === 'automated'
      ? looksLikeAutomatedTestCommand(command, parsedCommand.parsed)
      : looksLikeValidationCommand(parsedCommand.parsed)

    if (!acceptedByMode) {
      parserNotes.push(
        `Ignoring ${sourceLabel} test command "${command}" because it does not appear to be a ${mode === 'automated' ? 'real automated test command' : 'supported validation command'}.`,
      )
      continue
    }

    if (!mavenBuildsEnabled && isMavenExecutable(parsedCommand.parsed.executable)) {
      parserNotes.push(
        `Skipping ${sourceLabel} test command "${command}" because ONESHOT_MAVEN_BUILDS_ENABLED=false.`,
      )
      addUnique(skippedTestCommands, command)
      addUnique(mavenSkippedTestCommands, command)
      continue
    }

    if (
      options.requireModuleScopedMaven &&
      mode === 'automated' &&
      isMavenExecutable(parsedCommand.parsed.executable) &&
      !isModuleScopedMavenCommand(parsedCommand.parsed)
    ) {
      const message =
        `Skipping ${sourceLabel} test command "${command}" because SonarQube remediation ` +
        `requires module-scoped Maven validation (-pl/--projects or -f <module>/pom.xml).`
      parserNotes.push(message)
      failureReasons.push(message)
      addUnique(skippedTestCommands, command)
      addUnique(mavenSkippedTestCommands, command)
      continue
    }

    if (mode === 'automated') {
      const wrapperValidationFailure = await getNodeWrapperCommandValidationFailure(
        workspacePath,
        command,
        parsedCommand.parsed,
        sourceLabel,
      )
      if (wrapperValidationFailure) {
        parserNotes.push(wrapperValidationFailure)
        continue
      }
    }

    if (!(await commandTokenExists(workspacePath, parsedCommand.parsed.executable))) {
      parserNotes.push(
        `Ignoring ${sourceLabel} test command "${command}" because executable "${parsedCommand.parsed.executable}" is not available from the repo root.`,
      )
      continue
    }

    accepted.push(command)
  }

  return {
    accepted,
    skippedTestCommands,
    mavenSkippedTestCommands,
    parserNotes,
    failureReasons,
  }
}

async function collectImplementationCommands(
  workspacePath: string,
  implementationTestCommands: string[],
  implementationValidationCommands: string[],
  options: TestCommandResolveOptions = {},
): Promise<ImplementationCommandCollection> {
  const automatedAccepted: string[] = []
  const validationAccepted: string[] = []
  const skippedTestCommands: string[] = []
  const mavenSkippedTestCommands: string[] = []
  const parserNotes: string[] = []
  const failureReasons: string[] = []
  const seenValidationCommands = new Set<string>()
  const mavenBuildsEnabled = options.mavenBuildsEnabled ?? true

  const addValidationCommand = (command: string, note?: string) => {
    if (seenValidationCommands.has(command)) {
      return
    }
    seenValidationCommands.add(command)
    validationAccepted.push(command)
    if (note) {
      parserNotes.push(note)
    }
  }

  for (const rawCommand of implementationTestCommands) {
    const command = normalizeCommand(rawCommand)
    if (!command) {
      continue
    }

    if (looksLikeManualVerification(command)) {
      parserNotes.push(
        `Ignoring implementation-provided test command "${command}" because it appears to be manual or interactive verification.`,
      )
      continue
    }

    const parsedCommand = parseExecutableCommand(command)
    if (parsedCommand.ok === false) {
      parserNotes.push(
        `Ignoring implementation-provided test command "${command}" because ${parsedCommand.message}`,
      )
      failureReasons.push(parsedCommand.message)
      continue
    }

    const automatedTestCommand = looksLikeAutomatedTestCommand(command, parsedCommand.parsed)

    if (
      !mavenBuildsEnabled &&
      isMavenExecutable(parsedCommand.parsed.executable) &&
      automatedTestCommand
    ) {
      parserNotes.push(
        `Skipping implementation-provided test command "${command}" because ONESHOT_MAVEN_BUILDS_ENABLED=false.`,
      )
      addUnique(skippedTestCommands, command)
      addUnique(mavenSkippedTestCommands, command)
      continue
    }

    if (
      options.requireModuleScopedMaven &&
      automatedTestCommand &&
      isMavenExecutable(parsedCommand.parsed.executable) &&
      !isModuleScopedMavenCommand(parsedCommand.parsed)
    ) {
      const message =
        `Skipping implementation-provided test command "${command}" because SonarQube remediation ` +
        `requires module-scoped Maven validation (-pl/--projects or -f <module>/pom.xml).`
      parserNotes.push(message)
      failureReasons.push(message)
      addUnique(skippedTestCommands, command)
      addUnique(mavenSkippedTestCommands, command)
      continue
    }

    const wrapperValidationFailure = await getNodeWrapperCommandValidationFailure(
      workspacePath,
      command,
      parsedCommand.parsed,
      'implementation-provided',
    )
    if (wrapperValidationFailure) {
      parserNotes.push(wrapperValidationFailure)
      if (automatedTestCommand) {
        addUnique(skippedTestCommands, command)
      }
      continue
    }

    if (!(await commandTokenExists(workspacePath, parsedCommand.parsed.executable))) {
      parserNotes.push(
        `Ignoring implementation-provided test command "${command}" because executable "${parsedCommand.parsed.executable}" is not available from the repo root.`,
      )
      if (automatedTestCommand) {
        addUnique(skippedTestCommands, command)
      }
      continue
    }

    if (automatedTestCommand) {
      automatedAccepted.push(command)
      continue
    }

    if (looksLikeValidationCommand(parsedCommand.parsed)) {
      addValidationCommand(
        command,
        `Treating implementation-provided test command "${command}" as a structural validation command for backward compatibility; move it to \`validationCommands\`.`,
      )
      continue
    }

    parserNotes.push(
      `Ignoring implementation-provided test command "${command}" because it does not appear to be a real automated test command.`,
    )
  }

  const explicitValidationResolution = await collectRunnableCommands(
    workspacePath,
    implementationValidationCommands,
    'implementation-provided validation',
    'validation',
    options,
  )

  parserNotes.push(...explicitValidationResolution.parserNotes)
  failureReasons.push(...explicitValidationResolution.failureReasons)
  for (const command of explicitValidationResolution.skippedTestCommands) {
    addUnique(skippedTestCommands, command)
  }
  for (const command of explicitValidationResolution.mavenSkippedTestCommands) {
    addUnique(mavenSkippedTestCommands, command)
  }
  for (const command of explicitValidationResolution.accepted) {
    addValidationCommand(command)
  }

  return {
    automatedAccepted,
    validationAccepted,
    skippedTestCommands,
    mavenSkippedTestCommands,
    parserNotes,
    failureReasons,
  }
}

export async function resolveTestCommands(
  workspacePath: string,
  implementationTestCommands: string[],
  implementationValidationCommands: string[],
  plannerDiscoveredCommand?: string,
  implementationValidationChecks: OneShotValidationCheck[] = [],
  options: TestCommandResolveOptions = {},
): Promise<TestCommandResolution> {
  const mavenBuildsEnabled = options.mavenBuildsEnabled ?? true
  const implementationResolution = await collectImplementationCommands(
    workspacePath,
    implementationTestCommands,
    implementationValidationCommands,
    options,
  )
  let specificFailureReason = implementationResolution.failureReasons[0]

  const parserNotes = [...implementationResolution.parserNotes]
  const skippedTestCommands = [...implementationResolution.skippedTestCommands]
  const mavenSkippedTestCommands = [
    ...implementationResolution.mavenSkippedTestCommands,
  ]
  const addSkippedFrom = (resolution: RunnableCommandCollection) => {
    for (const command of resolution.skippedTestCommands) {
      addUnique(skippedTestCommands, command)
    }
    for (const command of resolution.mavenSkippedTestCommands) {
      addUnique(mavenSkippedTestCommands, command)
    }
  }
  const buildCommandsResolution = (
    executionKind: 'automated_tests' | 'validation_only',
    automatedCommands: string[],
    source: 'implementation' | 'planner' | 'heuristic',
  ): TestCommandResolution => ({
    kind: 'commands',
    executionKind,
    automatedCommands,
    validationCommands: implementationResolution.validationAccepted,
    validationChecks: implementationValidationChecks,
    skippedTestCommands,
    mavenSkippedTestCommands,
    mavenBuildsDisabled: !mavenBuildsEnabled,
    source,
    parserNotes,
  })

  if (plannerDiscoveredCommand) {
    const plannerResolution = await collectRunnableCommands(
      workspacePath,
      [plannerDiscoveredCommand],
      'planner-discovered',
      'automated',
      options,
    )
    parserNotes.push(...plannerResolution.parserNotes)
    addSkippedFrom(plannerResolution)
    specificFailureReason ??= plannerResolution.failureReasons[0]
    if (plannerResolution.accepted.length > 0) {
      return buildCommandsResolution(
        'automated_tests',
        plannerResolution.accepted,
        'planner',
      )
    }
  }

  const packageJsonPath = path.join(workspacePath, 'package.json')
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8')
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
    if (pkg.scripts?.test && looksLikeMeaningfulPackageTestScript(pkg.scripts.test)) {
      const npmResolution = await collectRunnableCommands(
        workspacePath,
        ['npm test'],
        'heuristic',
        'automated',
        options,
      )
      parserNotes.push(...npmResolution.parserNotes)
      addSkippedFrom(npmResolution)
      specificFailureReason ??= npmResolution.failureReasons[0]
      if (npmResolution.accepted.length > 0) {
        return buildCommandsResolution(
          'automated_tests',
          npmResolution.accepted,
          'heuristic',
        )
      }
    } else if (pkg.scripts?.test) {
      parserNotes.push(
        `Ignoring package.json test script "${pkg.scripts.test}" because it does not appear to be a meaningful automated test entrypoint.`,
      )
    }
  } catch {
    // not a Node project
  }

  const pomPath = path.join(workspacePath, 'pom.xml')
  try {
    await fs.access(pomPath)
    const mvnResolution = await collectRunnableCommands(
      workspacePath,
      ['mvn test -B'],
      'heuristic',
      'automated',
      options,
    )
    parserNotes.push(...mvnResolution.parserNotes)
    addSkippedFrom(mvnResolution)
    specificFailureReason ??= mvnResolution.failureReasons[0]
    if (mvnResolution.accepted.length > 0) {
      return buildCommandsResolution(
        'automated_tests',
        mvnResolution.accepted,
        'heuristic',
      )
    }
  } catch {
    // not a Maven project
  }

  const gradlePath = path.join(workspacePath, 'build.gradle')
  const gradleKtsPath = path.join(workspacePath, 'build.gradle.kts')
  try {
    await fs.access(gradlePath)
      const gradleResolution = await collectRunnableCommands(
        workspacePath,
        ['./gradlew test'],
        'heuristic',
        'automated',
        options,
      )
      parserNotes.push(...gradleResolution.parserNotes)
      addSkippedFrom(gradleResolution)
      specificFailureReason ??= gradleResolution.failureReasons[0]
      if (gradleResolution.accepted.length > 0) {
        return buildCommandsResolution(
          'automated_tests',
          gradleResolution.accepted,
          'heuristic',
        )
    }
  } catch {
    try {
      await fs.access(gradleKtsPath)
      const gradleKtsResolution = await collectRunnableCommands(
        workspacePath,
        ['./gradlew test'],
        'heuristic',
        'automated',
        options,
      )
      parserNotes.push(...gradleKtsResolution.parserNotes)
      addSkippedFrom(gradleKtsResolution)
      specificFailureReason ??= gradleKtsResolution.failureReasons[0]
      if (gradleKtsResolution.accepted.length > 0) {
        return buildCommandsResolution(
          'automated_tests',
          gradleKtsResolution.accepted,
          'heuristic',
        )
      }
    } catch {
      // not a Gradle project
    }
  }

  if (implementationResolution.automatedAccepted.length > 0) {
    return buildCommandsResolution(
      'automated_tests',
      implementationResolution.automatedAccepted,
      'implementation',
    )
  }

  if (implementationResolution.validationAccepted.length > 0 || implementationValidationChecks.length > 0) {
    return buildCommandsResolution('validation_only', [], 'implementation')
  }

  return {
    kind: 'none',
    executionKind: specificFailureReason ? 'invalid_command' : 'no_runnable_command',
    source: 'none',
    parserNotes,
    failureReason: specificFailureReason
      ?? 'No runnable automated test command found from implementation output, planner discoveries, or project heuristics.',
    skippedTestCommands,
    mavenSkippedTestCommands,
    mavenBuildsDisabled: !mavenBuildsEnabled,
  }
}

export async function executeTestCommand(
  workspacePath: string,
  command: string,
): Promise<TestExecResult> {
  const startTime = Date.now()
  const parsedCommand = parseExecutableCommand(command)
  if (parsedCommand.ok === false) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: parsedCommand.message,
      durationMs: Date.now() - startTime,
    }
  }

  const cmd = parsedCommand.parsed.executable
  const mavenAware = await buildMavenAwareArgs(
    workspacePath,
    cmd,
    parsedCommand.parsed.argv.slice(1),
  )
  const args = mavenAware.args
  const scratchPath = isMavenExecutable(cmd)
    ? await prepareScratchPath(workspacePath, 'tester')
    : undefined
  const repoLocalBinPath = path.join(workspacePath, 'node_modules', '.bin')
  const currentPath = process.env.PATH ?? ''
  const pathEntries = currentPath
    ? currentPath.split(path.delimiter)
    : []
  const executionPath = [repoLocalBinPath, ...pathEntries]
    .filter((entry, index, entries) => entry && entries.indexOf(entry) === index)
    .join(path.delimiter)

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: workspacePath,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: buildMavenAwareEnv(cmd, {
        ...process.env,
        CI: 'true',
        PATH: executionPath,
      }, scratchPath),
    })

    return {
      exitCode: 0,
      stdout: [mavenAware.parserNotes.join('\n'), stdout]
        .filter(Boolean)
        .join('\n')
        .slice(-MAX_OUTPUT_BYTES),
      stderr: stderr.slice(-MAX_OUTPUT_BYTES),
      durationMs: Date.now() - startTime,
    }
  } catch (error) {
    const execError = error as {
      code?: number | string
      stdout?: string
      stderr?: string
      killed?: boolean
    }

    const exitCode = typeof execError.code === 'number' ? execError.code : 127
    const stdout = typeof execError.stdout === 'string' ? execError.stdout : ''
    const stderr = typeof execError.stderr === 'string' ? execError.stderr : ''

    if (execError.killed) {
      logger.warn( { command, workspacePath },'Test command killed (timeout)')
    }

    return {
      exitCode,
      stdout: [mavenAware.parserNotes.join('\n'), stdout]
        .filter(Boolean)
        .join('\n')
        .slice(-MAX_OUTPUT_BYTES),
      stderr: stderr.slice(-MAX_OUTPUT_BYTES),
      durationMs: Date.now() - startTime,
    }
  } finally {
    if (scratchPath) {
      await cleanupScratchPath(scratchPath, 'tester')
    }
  }
}

export async function executeGitDiffCheck(
  workspacePath: string,
  baseCommitSha: string,
): Promise<TestExecResult> {
  const startTime = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      [
        'diff',
        '--check',
        '--no-ext-diff',
        '--no-color',
        baseCommitSha,
        'HEAD',
        '--',
      ],
      {
        cwd: workspacePath,
        timeout: TEST_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
    )

    return {
      exitCode: 0,
      stdout,
      stderr,
      durationMs: Date.now() - startTime,
    }
  } catch (error) {
    const err = error as {
      code?: number
      stdout?: string | Buffer
      stderr?: string | Buffer
    }
    return {
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
      durationMs: Date.now() - startTime,
    }
  }
}

function normalizeValidationPath(workspacePath: string, rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) {
    throw new Error('validationChecks path is empty.')
  }
  if (trimmed.includes('\0')) {
    throw new Error(`validationChecks path "${rawPath}" contains a NUL byte.`)
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error(`validationChecks path "${rawPath}" must be relative to the repo root.`)
  }
  const normalized = path.normalize(trimmed).replace(/\\/g, '/')
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`validationChecks path "${rawPath}" cannot escape the repo root.`)
  }
  const absolutePath = path.resolve(workspacePath, normalized)
  const workspaceRoot = path.resolve(workspacePath)
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`validationChecks path "${rawPath}" cannot escape the repo root.`)
  }
  return normalized
}

function parseDiffPath(line: string): string | null {
  if (!line.startsWith('+++ ')) return null
  const rawPath = line.slice(4).trim()
  if (rawPath === '/dev/null') return null
  if (rawPath.startsWith('b/')) return rawPath.slice(2)
  return rawPath
}

function parseNewHunkRange(line: string): { start: number; end: number } | null {
  const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
  if (!match) return null
  const start = Number(match[1])
  const count = match[2] === undefined ? 1 : Number(match[2])
  if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) {
    return null
  }
  return { start, end: start + count - 1 }
}

function parseChangedLineRanges(diffOutput: string): Map<string, Array<{ start: number; end: number }>> {
  const rangesByPath = new Map<string, Array<{ start: number; end: number }>>()
  let currentPath: string | null = null

  for (const line of diffOutput.split(/\r?\n/)) {
    const diffPath = parseDiffPath(line)
    if (diffPath !== null || line.startsWith('+++ ')) {
      currentPath = diffPath
      if (currentPath && !rangesByPath.has(currentPath)) {
        rangesByPath.set(currentPath, [])
      }
      continue
    }

    if (!currentPath) continue
    const range = parseNewHunkRange(line)
    if (range) {
      rangesByPath.get(currentPath)?.push(range)
    }
  }

  return rangesByPath
}

function isLineInRanges(lineNumber: number, ranges: Array<{ start: number; end: number }> | undefined): boolean {
  if (!ranges) return false
  return ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end)
}

function parseRipgrepMatchLine(
  line: string,
  changedPaths: string[],
): { filePath: string; lineNumber: number } | null {
  for (const filePath of changedPaths) {
    const prefix = `${filePath}:`
    if (!line.startsWith(prefix)) continue
    const rest = line.slice(prefix.length)
    const separator = rest.indexOf(':')
    if (separator < 0) return null
    const lineNumber = Number(rest.slice(0, separator))
    if (!Number.isFinite(lineNumber)) return null
    return { filePath, lineNumber }
  }
  return null
}

export async function executeValidationCheck(
  workspacePath: string,
  check: OneShotValidationCheck,
  options: ValidationCheckExecOptions = {},
): Promise<ValidationCheckExecResult> {
  const startTime = Date.now()
  let paths: string[]
  const scope = check.scope ?? 'file'
  try {
    paths = check.paths.map((entry) => normalizeValidationPath(workspacePath, entry))
  } catch (error) {
    return {
      check,
      command: `rg --line-number --color never -- ${check.pattern} ${check.paths.join(' ')}`,
      exitCode: 2,
      passed: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    }
  }

  const args = ['--line-number', '--color', 'never', '--', check.pattern, ...paths]
  const command = `rg --line-number --color never -- ${JSON.stringify(check.pattern)} ${paths.join(' ')}${scope === 'changed_lines' ? ' [scope=changed_lines]' : ''}`

  let changedLineRanges: Map<string, Array<{ start: number; end: number }>> | null = null
  if (scope === 'changed_lines') {
    if (!options.baseCommitSha) {
      return {
        check,
        command,
        exitCode: 2,
        passed: false,
        stdout: '',
        stderr: 'validationChecks scope=changed_lines requires a base commit SHA.',
        durationMs: Date.now() - startTime,
      }
    }

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--unified=0', '--no-ext-diff', '--no-color', options.baseCommitSha, '--', ...paths],
        {
          cwd: workspacePath,
          timeout: TEST_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          env: process.env,
        },
      )
      changedLineRanges = parseChangedLineRanges(stdout)
    } catch (error) {
      const execError = error as {
        code?: number | string
        stdout?: string
        stderr?: string
      }
      const exitCode = typeof execError.code === 'number' ? execError.code : 2
      const stderr = typeof execError.stderr === 'string' && execError.stderr.length > 0
        ? execError.stderr
        : error instanceof Error
          ? error.message
          : String(error)
      return {
        check,
        command,
        exitCode,
        passed: false,
        stdout: typeof execError.stdout === 'string' ? execError.stdout.slice(-MAX_OUTPUT_BYTES) : '',
        stderr: stderr.slice(-MAX_OUTPUT_BYTES),
        durationMs: Date.now() - startTime,
      }
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync('rg', args, {
      cwd: workspacePath,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    })
    if (scope === 'changed_lines' && changedLineRanges) {
      const changedPaths = [...changedLineRanges.keys()].sort((a, b) => b.length - a.length)
      const scopedLines: string[] = []
      let ignoredMatches = 0
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const parsedLine = parseRipgrepMatchLine(line, changedPaths)
        if (
          parsedLine &&
          isLineInRanges(parsedLine.lineNumber, changedLineRanges.get(parsedLine.filePath))
        ) {
          scopedLines.push(line)
        } else {
          ignoredMatches += 1
        }
      }
      const scopedStdout = scopedLines.join('\n') + (scopedLines.length > 0 ? '\n' : '')
      const scopedMatched = scopedLines.length > 0
      const notes = [
        stderr,
        ignoredMatches > 0
          ? `${ignoredMatches} match(es) ignored outside changed_lines scope.`
          : '',
      ].filter(Boolean).join('\n')
      return {
        check,
        command,
        exitCode: scopedMatched ? 0 : 1,
        passed: check.kind === 'must_match' ? scopedMatched : !scopedMatched,
        stdout: scopedStdout.slice(-MAX_OUTPUT_BYTES),
        stderr: notes.slice(-MAX_OUTPUT_BYTES),
        durationMs: Date.now() - startTime,
      }
    }
    return {
      check,
      command,
      exitCode: 0,
      passed: check.kind === 'must_match',
      stdout: stdout.slice(-MAX_OUTPUT_BYTES),
      stderr: stderr.slice(-MAX_OUTPUT_BYTES),
      durationMs: Date.now() - startTime,
    }
  } catch (error) {
    const execError = error as {
      code?: number | string
      stdout?: string
      stderr?: string
      killed?: boolean
    }
    const exitCode = typeof execError.code === 'number' ? execError.code : 127
    const stdout = typeof execError.stdout === 'string' ? execError.stdout : ''
    const stderr = typeof execError.stderr === 'string' && execError.stderr.length > 0
      ? execError.stderr
      : error instanceof Error
        ? error.message
        : ''
    if (scope === 'changed_lines' && changedLineRanges && exitCode === 1) {
      return {
        check,
        command,
        exitCode,
        passed: check.kind === 'must_not_match',
        stdout: '',
        stderr: stderr.slice(-MAX_OUTPUT_BYTES),
        durationMs: Date.now() - startTime,
      }
    }
    return {
      check,
      command,
      exitCode,
      passed: check.kind === 'must_not_match' && exitCode === 1,
      stdout: stdout.slice(-MAX_OUTPUT_BYTES),
      stderr: stderr.slice(-MAX_OUTPUT_BYTES),
      durationMs: Date.now() - startTime,
    }
  }
}

function extractSuiteAttr(tag: string, attr: string): number {
  const match = tag.match(new RegExp(`\\b${attr}="(\\d+)"`))
  return match ? parseInt(match[1], 10) : 0
}

export function parseJunitXml(xmlContent: string): ParsedTestReport {
  const failedTests: ParsedTestReport['failedTests'] = []
  let passCount = 0
  let failCount = 0
  let skipCount = 0

  const suiteTagMatches = xmlContent.matchAll(/<testsuite\b[^>]*>/g)

  for (const [tag] of suiteTagMatches) {
    const total = extractSuiteAttr(tag, 'tests')
    const failures = extractSuiteAttr(tag, 'failures')
    const errors = extractSuiteAttr(tag, 'errors')
    const skipped = extractSuiteAttr(tag, 'skipped')
    failCount += failures + errors
    skipCount += skipped
    passCount += total - failures - errors - skipped
  }

  const testcaseMatches = xmlContent.matchAll(
    /<testcase\s([^>]*)>([\s\S]*?)<\/testcase>/g,
  )

  for (const tc of testcaseMatches) {
    const attrs = tc[1]
    const inner = tc[2]
    const nameMatch = attrs.match(/\bname="([^"]*)"/)
    const classMatch = attrs.match(/\bclassname="([^"]*)"/)
    const testName = nameMatch?.[1] ?? 'unknown'
    const className = classMatch?.[1] || undefined

    const failureMatch = inner.match(/<failure[^>]*message="([^"]*)"[^>]*>([\s\S]*?)<\/failure>/)
    const errorMatch = inner.match(/<error[^>]*message="([^"]*)"[^>]*>([\s\S]*?)<\/error>/)

    const match = failureMatch ?? errorMatch
    if (match) {
      failedTests.push({
        testName,
        className,
        message: match[1] || 'Unknown failure',
        stackTrace: match[2]?.trim() || undefined,
      })
    }
  }

  return { passCount, failCount, skipCount, failedTests }
}

export async function findAndParseTestReports(
  workspacePath: string,
  baseline?: TestReportSnapshot,
): Promise<ParsedTestReport> {
  const combined: ParsedTestReport = { passCount: 0, failCount: 0, skipCount: 0, failedTests: [] }

  for (const dir of TEST_REPORT_DIRS) {
    const fullDir = path.join(workspacePath, dir)
    try {
      const entries = await fs.readdir(fullDir)
      const xmlFiles = entries.filter(f => f.endsWith('.xml'))

      for (const xmlFile of xmlFiles) {
        try {
          const absolutePath = path.join(fullDir, xmlFile)
          const stats = await fs.stat(absolutePath)
          const fingerprint = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
          if (baseline?.get(absolutePath) === fingerprint) {
            continue
          }

          const content = await fs.readFile(absolutePath, 'utf8')
          const report = parseJunitXml(content)
          combined.passCount += report.passCount
          combined.failCount += report.failCount
          combined.skipCount += report.skipCount
          combined.failedTests.push(...report.failedTests)
        } catch {
          // skip unparseable files
        }
      }
    } catch {
      // directory doesn't exist
    }
  }

  return combined
}

export async function findAndParseCoverage(workspacePath: string): Promise<ParsedCoverage | undefined> {
  const jacocoPath = path.join(workspacePath, 'target/site/jacoco/jacoco.csv')
  try {
    const csv = await fs.readFile(jacocoPath, 'utf8')
    const lines = csv.split('\n').filter(Boolean)
    if (lines.length < 2) {
      return undefined
    }

    let totalBranchMissed = 0
    let totalBranchCovered = 0
    let totalLineMissed = 0
    let totalLineCovered = 0

    for (const line of lines.slice(1)) {
      const cols = line.split(',')
      if (cols.length < 8) continue
      totalBranchMissed += parseInt(cols[5], 10) || 0
      totalBranchCovered += parseInt(cols[6], 10) || 0
      totalLineMissed += parseInt(cols[7], 10) || 0
      totalLineCovered += parseInt(cols[8], 10) || 0
    }

    const totalBranch = totalBranchMissed + totalBranchCovered
    const totalLine = totalLineMissed + totalLineCovered
    const branchPercent = totalBranch > 0 ? (totalBranchCovered / totalBranch) * 100 : undefined
    const linePercent = totalLine > 0 ? (totalLineCovered / totalLine) * 100 : undefined

    const roundedLine = linePercent !== undefined ? Math.round(linePercent * 100) / 100 : undefined
    const roundedBranch = branchPercent !== undefined ? Math.round(branchPercent * 100) / 100 : undefined
    return {
      linePercent: roundedLine,
      branchPercent: roundedBranch,
      threshold: COVERAGE_THRESHOLD_PERCENT,
      passed: (roundedLine ?? 100) >= COVERAGE_THRESHOLD_PERCENT
        && (roundedBranch ?? 100) >= COVERAGE_THRESHOLD_PERCENT,
    }
  } catch {
    // no Jacoco report
  }

  const istanbulPath = path.join(workspacePath, 'coverage/coverage-summary.json')
  try {
    const raw = await fs.readFile(istanbulPath, 'utf8')
    const summary = JSON.parse(raw) as {
      total?: {
        lines?: { pct?: number }
        branches?: { pct?: number }
      }
    }

    const linePercent = summary.total?.lines?.pct
    const branchPercent = summary.total?.branches?.pct

    return {
      linePercent,
      branchPercent,
      threshold: COVERAGE_THRESHOLD_PERCENT,
      passed: (linePercent ?? 100) >= COVERAGE_THRESHOLD_PERCENT
        && (branchPercent ?? 100) >= COVERAGE_THRESHOLD_PERCENT,
    }
  } catch {
    // no Istanbul report
  }

  return undefined
}

export function truncateOutput(stdout: string, stderr: string, maxBytes: number): string {
  const combined = `=== STDOUT ===\n${stdout}\n=== STDERR ===\n${stderr}`
  if (combined.length <= maxBytes) {
    return combined
  }
  return combined.slice(-maxBytes)
}
