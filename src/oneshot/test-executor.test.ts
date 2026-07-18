import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureTestReportSnapshot,
  executeGitDiffCheck,
  executeValidationCheck,
  executeTestCommand,
  findAndParseTestReports,
  parseJunitXml,
  resolveTestCommands,
  truncateOutput,
} from './test-executor.js'

const tempDirs: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

async function createWorkspace(files: Record<string, string>, executablePaths: string[] = []): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-test-executor-'))
  tempDirs.push(dir)

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(dir, relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, contents, 'utf8')
  }

  for (const executablePath of executablePaths) {
    await fs.chmod(path.join(dir, executablePath), 0o755)
  }

  return dir
}

async function createFakeRipgrepPath(): Promise<string> {
  return createWorkspace({
    rg: `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const separatorIndex = args.indexOf('--')
if (separatorIndex < 0 || separatorIndex + 1 >= args.length) {
  console.error('fake rg expected -- PATTERN [PATH...]')
  process.exit(2)
}

let regex
try {
  regex = new RegExp(args[separatorIndex + 1])
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

const roots = args.slice(separatorIndex + 2)
let matched = false

function scanFile(filePath, displayPath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split(/\\r?\\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (regex.test(lines[index])) {
      matched = true
      console.log(\`\${displayPath}:\${index + 1}:\${lines[index]}\`)
    }
  }
}

function scan(entry) {
  const absolute = path.resolve(process.cwd(), entry)
  const stat = fs.statSync(absolute)
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(absolute)) {
      scan(path.join(entry, child))
    }
    return
  }
  scanFile(absolute, entry)
}

try {
  for (const root of roots) {
    scan(root)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

process.exit(matched ? 0 : 1)
`,
  }, ['rg'])
}

async function withFakeRipgrep<T>(callback: () => Promise<T>): Promise<T> {
  const fakeRipgrepPath = await createFakeRipgrepPath()
  const originalPath = process.env.PATH
  process.env.PATH = `${fakeRipgrepPath}${path.delimiter}${originalPath ?? ''}`
  try {
    return await callback()
  } finally {
    process.env.PATH = originalPath
  }
}

async function withPrependedPath<T>(dir: string, callback: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH
  process.env.PATH = [dir, originalPath].filter(Boolean).join(path.delimiter)
  try {
    return await callback()
  } finally {
    process.env.PATH = originalPath
  }
}

async function withPathValue<T>(pathValue: string, callback: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH
  process.env.PATH = pathValue
  try {
    return await callback()
  } finally {
    process.env.PATH = originalPath
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function commitWorkspace(workspace: string): Promise<string> {
  await git(workspace, ['init'])
  await git(workspace, ['config', 'user.email', 'oneshot@example.com'])
  await git(workspace, ['config', 'user.name', 'OneShot Test'])
  await git(workspace, ['add', '.'])
  await git(workspace, ['commit', '-m', 'base'])
  return git(workspace, ['rev-parse', 'HEAD'])
}

describe('parseJunitXml', () => {
  it('parses a simple Surefire XML report', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.UserTest" tests="3" failures="1" errors="0" skipped="1" time="0.123">
  <testcase name="testLogin" classname="com.example.UserTest" time="0.05">
  </testcase>
  <testcase name="testLogout" classname="com.example.UserTest" time="0.02">
    <failure message="Expected true but was false">
      at com.example.UserTest.testLogout(UserTest.java:42)
    </failure>
  </testcase>
  <testcase name="testRegistration" classname="com.example.UserTest" time="0.01">
    <skipped/>
  </testcase>
</testsuite>`

    const report = parseJunitXml(xml)
    expect(report.passCount).toBe(1)
    expect(report.failCount).toBe(1)
    expect(report.skipCount).toBe(1)
    expect(report.failedTests).toHaveLength(1)
    expect(report.failedTests[0].testName).toBe('testLogout')
    expect(report.failedTests[0].className).toBe('com.example.UserTest')
    expect(report.failedTests[0].message).toBe('Expected true but was false')
    expect(report.failedTests[0].stackTrace).toContain('UserTest.java:42')
  })

  it('handles an empty test suite', () => {
    const xml = '<testsuite name="empty" tests="0" failures="0" skipped="0"></testsuite>'
    const report = parseJunitXml(xml)
    expect(report.passCount).toBe(0)
    expect(report.failCount).toBe(0)
    expect(report.failedTests).toHaveLength(0)
  })

  it('handles errors in addition to failures', () => {
    const xml = `<testsuite tests="2" failures="0" errors="1" skipped="0">
  <testcase name="testA" classname="Test">
  </testcase>
  <testcase name="testB" classname="Test">
    <error message="NullPointerException">java.lang.NullPointerException</error>
  </testcase>
</testsuite>`

    const report = parseJunitXml(xml)
    expect(report.failCount).toBe(1)
    expect(report.passCount).toBe(1)
    expect(report.failedTests).toHaveLength(1)
    expect(report.failedTests[0].message).toBe('NullPointerException')
  })

  it('returns zeros for non-XML content', () => {
    const report = parseJunitXml('not xml at all')
    expect(report.passCount).toBe(0)
    expect(report.failCount).toBe(0)
    expect(report.skipCount).toBe(0)
  })
})

describe('truncateOutput', () => {
  it('combines stdout and stderr', () => {
    const result = truncateOutput('out', 'err', 1000)
    expect(result).toContain('STDOUT')
    expect(result).toContain('out')
    expect(result).toContain('STDERR')
    expect(result).toContain('err')
  })

  it('truncates to maxBytes from the end', () => {
    const long = 'a'.repeat(500)
    const result = truncateOutput(long, 'err', 100)
    expect(result.length).toBe(100)
  })
})

describe('executeValidationCheck', () => {
  it('passes must_match when rg finds a match', async () => {
    const workspace = await createWorkspace({
      'src/Foo.java': 'logger.debug("safe");\n',
    })

    const result = await withFakeRipgrep(() => executeValidationCheck(workspace, {
      kind: 'must_match',
      pattern: 'logger\\.debug',
      paths: ['src/Foo.java'],
    }))

    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('logger.debug')
  })

  it('passes must_not_match when rg finds no match', async () => {
    const workspace = await createWorkspace({
      'src/Foo.java': 'logger.debug("safe");\n',
    })

    const result = await withFakeRipgrep(() => executeValidationCheck(workspace, {
      kind: 'must_not_match',
      pattern: 'logger\\.info.*answer',
      paths: ['src'],
    }))

    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(1)
  })

  it('fails must_not_match and includes matched lines', async () => {
    const workspace = await createWorkspace({
      'src/Foo.java': 'logger.info("Setting answer value {}", value);\n',
    })

    const result = await withFakeRipgrep(() => executeValidationCheck(workspace, {
      kind: 'must_not_match',
      pattern: 'logger\\.info.*answer',
      paths: ['src'],
    }))

    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Setting answer')
  })

  it('fails must_not_match when rg itself is unavailable', async () => {
    const workspace = await createWorkspace({
      'src/Foo.java': 'logger.debug("safe");\n',
    })
    const originalPath = process.env.PATH
    process.env.PATH = workspace

    try {
      const result = await executeValidationCheck(workspace, {
        kind: 'must_not_match',
        pattern: 'logger\\.info.*answer',
        paths: ['src'],
      })

      expect(result.passed).toBe(false)
      expect(result.exitCode).toBe(127)
      expect(result.stderr).toContain('rg')
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('passes must_not_match changed_lines when matches only exist on unchanged legacy lines', async () => {
    const workspace = await createWorkspace({
      'src/ManagerActionView.java': [
        'class ManagerActionView {',
        '  void releaseTask() {',
        '    lgrid.updateData(r);',
        '  }',
        '  void activateProvider() {',
        '    lgrid.updateData(r);',
        '  }',
        '}',
        '',
      ].join('\n'),
    })
    const baseCommitSha = await commitWorkspace(workspace)
    await fs.writeFile(path.join(workspace, 'src/ManagerActionView.java'), [
      'class ManagerActionView {',
      '  void releaseTask() {',
      '    assignOrReleaseTask();',
      '  }',
      '  void activateProvider() {',
      '    lgrid.updateData(r);',
      '  }',
      '}',
      '',
    ].join('\n'))

    const result = await withFakeRipgrep(() => executeValidationCheck(workspace, {
      kind: 'must_not_match',
      pattern: 'lgrid\\.updateData\\(r\\)',
      paths: ['src/ManagerActionView.java'],
      scope: 'changed_lines',
    }, { baseCommitSha }))

    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('ignored outside changed_lines scope')
  })

  it('fails must_not_match changed_lines when the changed lines still contain the pattern', async () => {
    const workspace = await createWorkspace({
      'src/ManagerActionView.java': [
        'class ManagerActionView {',
        '  void releaseTask() {',
        '    assignOrReleaseTask();',
        '  }',
        '}',
        '',
      ].join('\n'),
    })
    const baseCommitSha = await commitWorkspace(workspace)
    await fs.writeFile(path.join(workspace, 'src/ManagerActionView.java'), [
      'class ManagerActionView {',
      '  void releaseTask() {',
      '    lgrid.updateData(r);',
      '  }',
      '}',
      '',
    ].join('\n'))

    const result = await withFakeRipgrep(() => executeValidationCheck(workspace, {
      kind: 'must_not_match',
      pattern: 'lgrid\\.updateData\\(r\\)',
      paths: ['src/ManagerActionView.java'],
      scope: 'changed_lines',
    }, { baseCommitSha }))

    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('lgrid.updateData')
  })

  it('fails changed_lines checks when the base commit is missing', async () => {
    const workspace = await createWorkspace({
      'src/Foo.java': 'logger.debug("safe");\n',
    })

    const result = await withFakeRipgrep(() => executeValidationCheck(workspace, {
      kind: 'must_match',
      pattern: 'logger\\.debug',
      paths: ['src/Foo.java'],
      scope: 'changed_lines',
    }))

    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('requires a base commit SHA')
  })
})

describe('resolveTestCommands', () => {
  it('keeps structured validation checks separate from Unix validation command semantics', async () => {
    const workspace = await createWorkspace({
      'src/Foo.java': 'logger.debug("safe");\n',
    })

    const resolution = await resolveTestCommands(
      workspace,
      [],
      [],
      undefined,
      [{
        kind: 'must_not_match',
        pattern: 'logger\\.info.*answer',
        paths: ['src'],
      }],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'validation_only',
      automatedCommands: [],
      validationCommands: [],
      validationChecks: [{
        kind: 'must_not_match',
        pattern: 'logger\\.info.*answer',
        paths: ['src'],
      }],
      source: 'implementation',
    })
  })

  it('records declared automated test commands skipped due missing executables', async () => {
    const workspace = await createWorkspace({
      'src/Foo.java': 'class Foo {}\n',
    })

    const resolution = await resolveTestCommands(
      workspace,
      ['missing-test-runner --suite FooTest'],
      [],
    )

    expect(resolution.skippedTestCommands).toEqual(['missing-test-runner --suite FooTest'])
    expect(resolution.parserNotes.join('\n')).toContain('executable "missing-test-runner" is not available')
  })

  it('skips Maven implementation commands when Maven builds are disabled', async () => {
    const workspace = await createWorkspace({
      'src/Foo.java': 'class Foo {}\n',
    })

    const resolution = await resolveTestCommands(
      workspace,
      ['mvn test -B'],
      [],
      undefined,
      [],
      { mavenBuildsEnabled: false },
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      skippedTestCommands: ['mvn test -B'],
      mavenSkippedTestCommands: ['mvn test -B'],
      mavenBuildsDisabled: true,
    })
    expect(resolution.parserNotes.join('\n')).toContain(
      'ONESHOT_MAVEN_BUILDS_ENABLED=false',
    )
  })

  it('runs non-Maven implementation tests while retaining skipped Maven metadata', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['mvn test -B', 'vitest src/foo.test.ts'],
      [],
      undefined,
      [],
      { mavenBuildsEnabled: false },
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['vitest src/foo.test.ts'],
      skippedTestCommands: ['mvn test -B'],
      mavenSkippedTestCommands: ['mvn test -B'],
      mavenBuildsDisabled: true,
      source: 'implementation',
    })
  })

  it('skips heuristic Maven tests when Maven builds are disabled', async () => {
    const workspace = await createWorkspace({
      'pom.xml': '<project></project>',
    })

    const resolution = await resolveTestCommands(
      workspace,
      [],
      [],
      undefined,
      [],
      { mavenBuildsEnabled: false },
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      skippedTestCommands: ['mvn test -B'],
      mavenSkippedTestCommands: ['mvn test -B'],
      mavenBuildsDisabled: true,
    })
  })

  it('rejects bare Maven commands when Sonar remediation requires module scope', async () => {
    const workspace = await createWorkspace({
      'src/Foo.java': 'class Foo {}\n',
    })

    const resolution = await resolveTestCommands(
      workspace,
      ['mvn test -B'],
      [],
      undefined,
      [],
      { requireModuleScopedMaven: true },
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'invalid_command',
      skippedTestCommands: ['mvn test -B'],
      mavenSkippedTestCommands: ['mvn test -B'],
    })
    expect(resolution.parserNotes.join('\n')).toContain(
      'requires module-scoped Maven validation',
    )
  })

  it('accepts module-scoped Maven commands when Sonar remediation requires module scope', async () => {
    const workspace = await createWorkspace(
      {
        mvn: '#!/bin/sh\nexit 0\n',
        'MedicalMgmt/pom.xml': '<project></project>',
      },
      ['mvn'],
    )

    const resolution = await withPrependedPath(workspace, () =>
      resolveTestCommands(
        workspace,
        ['mvn -pl MedicalMgmt -am -B test'],
        [],
        undefined,
        [],
        { requireModuleScopedMaven: true },
      ),
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['mvn -pl MedicalMgmt -am -B test'],
    })
  })

  it('rejects a non-test planner command and falls back to repo heuristics', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'vitest',
          },
        }),
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      [],
      [],
      'node --version',
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npm test'],
      validationCommands: [],
      source: 'heuristic',
    })
    if (resolution.kind === 'commands') {
      expect(resolution.parserNotes.join('\n')).toContain('does not appear to be a real automated test command')
    }
  })

  it('rejects manual implementation prose and falls back to repo heuristics', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'vitest',
          },
        }),
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['Verify the cancel button is red in the browser'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npm test'],
      validationCommands: [],
      source: 'heuristic',
    })
    if (resolution.kind === 'commands') {
      expect(resolution.parserNotes.join('\n')).toContain('manual or interactive verification')
    }
  })

  it('prefers planner-discovered real tests over implementation-provided validation commands', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['grep -n "cancelButtonRed" MedicalMgmt/src/main/webapp/Medhok3.css'],
      [],
      'vitest src/foo.test.ts',
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['vitest src/foo.test.ts'],
      validationCommands: ['grep -n "cancelButtonRed" MedicalMgmt/src/main/webapp/Medhok3.css'],
      source: 'planner',
    })
  })

  it('prefers repo heuristics over implementation-provided validation commands when planner is absent', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'vitest',
          },
        }),
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['grep -n "cancelButtonRed" MedicalMgmt/src/main/webapp/Medhok3.css'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npm test'],
      validationCommands: ['grep -n "cancelButtonRed" MedicalMgmt/src/main/webapp/Medhok3.css'],
      source: 'heuristic',
    })
  })

  it('rejects heuristic npm test when package.json test runner is missing', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'vitest',
          },
        }),
        npm: '#!/bin/sh\necho npm "$@"\n',
      },
      ['npm'],
    )

    const resolution = await withPathValue([workspace, '/usr/bin', '/bin'].join(path.delimiter), () => resolveTestCommands(
      workspace,
      [],
      [],
      undefined,
      [],
      { mavenBuildsEnabled: false },
    ))

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      source: 'none',
      mavenBuildsDisabled: true,
    })
    expect(resolution.parserNotes.join('\n')).toContain(
      'underlying runner "vitest" is not available from the repo root',
    )
  })

  it('rejects planner-discovered npm test when package.json test runner is missing', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'vitest',
          },
        }),
        npm: '#!/bin/sh\necho npm "$@"\n',
      },
      ['npm'],
    )

    const resolution = await withPathValue([workspace, '/usr/bin', '/bin'].join(path.delimiter), () => resolveTestCommands(
      workspace,
      [],
      [],
      'npm test',
    ))

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      source: 'none',
    })
    expect(resolution.parserNotes.join('\n')).toContain(
      'package.json scripts.test resolves to "vitest" but underlying runner "vitest" is not available from the repo root',
    )
  })

  it('rejects flagged npm wrapper forms when package.json test runner is missing', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'vitest',
          },
        }),
        npm: '#!/bin/sh\necho npm "$@"\n',
      },
      ['npm'],
    )

    for (const command of ['npm --silent test', 'npm -s run test']) {
      const resolution = await withPathValue([workspace, '/usr/bin', '/bin'].join(path.delimiter), () => resolveTestCommands(
        workspace,
        [command],
        [],
      ))

      expect(resolution).toMatchObject({
        kind: 'none',
        executionKind: 'no_runnable_command',
        source: 'none',
      })
      expect(resolution.parserNotes.join('\n')).toContain(
        'underlying runner "vitest" is not available from the repo root',
      )
    }
  })

  it('rejects heuristic npm test when package.json uses an unsupported interpreter wrapper', async () => {
    const workspace = await createWorkspace({
      'package.json': JSON.stringify({
        scripts: {
          test: 'node scripts/test.js',
        },
      }),
    })

    const resolution = await resolveTestCommands(
      workspace,
      [],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      source: 'none',
    })
    expect(resolution.parserNotes.join('\n')).toContain(
      'uses a wrapper that cannot be validated preflight',
    )
  })

  it('accepts heuristic npm test when package.json uses a tsx entrypoint with a real target file', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'tsx --tsconfig tsconfig.json scripts/test.ts',
          },
        }),
        'node_modules/.bin/tsx': '#!/bin/sh\necho tsx "$@"\n',
        'tsconfig.json': '{"compilerOptions":{}}',
        'scripts/test.ts': 'console.log("test")\n',
      },
      ['node_modules/.bin/tsx'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      [],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npm test'],
      validationCommands: [],
      source: 'heuristic',
    })
  })

  it('rejects heuristic npm test when the tsx entry file is missing', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'tsx --tsconfig tsconfig.json scripts/test.ts',
          },
        }),
        'node_modules/.bin/tsx': '#!/bin/sh\necho tsx "$@"\n',
        'tsconfig.json': '{"compilerOptions":{}}',
      },
      ['node_modules/.bin/tsx'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      [],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      source: 'none',
    })
    expect(resolution.parserNotes.join('\n')).toContain(
      'target "scripts/test.ts" is missing from the selected package root',
    )
  })

  it('accepts heuristic npm test when package.json test runner exists only on PATH', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'vitest',
          },
        }),
        vitest: '#!/bin/sh\necho vitest "$@"\n',
      },
      ['vitest'],
    )

    const resolution = await withPrependedPath(workspace, () => resolveTestCommands(
      workspace,
      [],
      [],
    ))

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npm test'],
      validationCommands: [],
      source: 'heuristic',
    })
  })

  it('accepts heuristic npm test when package.json uses a PATH-backed playwright runner', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'playwright test',
          },
        }),
        playwright: '#!/bin/sh\necho playwright "$@"\n',
      },
      ['playwright'],
    )

    const resolution = await withPrependedPath(workspace, () => resolveTestCommands(
      workspace,
      [],
      [],
    ))

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npm test'],
      validationCommands: [],
      source: 'heuristic',
    })
  })

  it('rejects heuristic npm test when package.json uses a non-test playwright subcommand', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'playwright codegen',
          },
        }),
        playwright: '#!/bin/sh\necho playwright "$@"\n',
      },
      ['playwright'],
    )

    const resolution = await withPrependedPath(workspace, () => resolveTestCommands(
      workspace,
      [],
      [],
    ))

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      source: 'none',
    })
    expect(resolution.parserNotes.join('\n')).toContain(
      'does not appear to be a real automated test command',
    )
  })

  it('accepts heuristic npm test when package.json uses npx with a supported executable token', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'npx --yes vitest run src/foo.test.ts',
          },
        }),
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      [],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npm test'],
      validationCommands: [],
      source: 'heuristic',
    })
  })

  it('ignores placeholder package.json test scripts and falls back to a valid implementation test command', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            test: 'echo "Error: no test specified" && exit 1',
          },
        }),
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['vitest src/foo.test.ts'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['vitest src/foo.test.ts'],
      validationCommands: [],
      source: 'implementation',
    })
    if (resolution.kind === 'commands') {
      expect(resolution.parserNotes.join('\n')).toContain('does not appear to be a meaningful automated test entrypoint')
    }
  })

  it('returns kind=none when no runnable automated command exists anywhere', async () => {
    const workspace = await createWorkspace({})

    const resolution = await resolveTestCommands(
      workspace,
      ['Verify the cancel button is red in the browser'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      source: 'none',
    })
    if (resolution.kind === 'none') {
      expect(resolution.failureReason).toContain('No runnable automated test command')
    }
  })

  it('returns an explicit failure reason for unsupported shell syntax', async () => {
    const workspace = await createWorkspace({})

    const resolution = await resolveTestCommands(
      workspace,
      ["grep foo file && grep bar file"],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'invalid_command',
      source: 'none',
    })
    if (resolution.kind === 'none') {
      expect(resolution.failureReason).toContain('Unsupported shell syntax')
      expect(resolution.parserNotes.join('\n')).toContain('split chained checks into separate array entries')
    }
  })

  it('rejects other unsupported shell syntax forms', async () => {
    const workspace = await createWorkspace({})
    const commands = [
      'FOO=bar npm test',
      'grep foo file | cat',
      'grep foo file > out.txt',
      'echo $(pwd)',
      'echo `pwd`',
    ]

    for (const command of commands) {
      const resolution = await resolveTestCommands(workspace, [command], [])

      expect(resolution).toMatchObject({
        kind: 'none',
        executionKind: 'invalid_command',
        source: 'none',
      })
      if (resolution.kind === 'none') {
        expect(resolution.failureReason).toMatch(/Unsupported (shell syntax|env-assignment prefix)/)
      }
    }
  })

  it('returns kind=none for arbitrary executables that are not test commands', async () => {
    const workspace = await createWorkspace({})

    const resolution = await resolveTestCommands(
      workspace,
      [],
      [],
      'node --version',
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      source: 'none',
    })
    if (resolution.kind === 'none') {
      expect(resolution.parserNotes.join('\n')).toContain('does not appear to be a real automated test command')
    }
  })

  it('accepts quoted single-command grep validations without shell operators', async () => {
    const workspace = await createWorkspace({})

    const resolution = await resolveTestCommands(
      workspace,
      [],
      ["grep -n 'cancel button' MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java"],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'validation_only',
      automatedCommands: [],
      validationCommands: ["grep -n 'cancel button' MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java"],
      source: 'implementation',
    })
  })

  it('keeps valid commands when mixed with unsupported shell-style commands', async () => {
    const workspace = await createWorkspace({})

    const resolution = await resolveTestCommands(
      workspace,
      [
        "grep foo file && grep bar file",
        "grep -n 'cancel button' MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
      ],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'validation_only',
      automatedCommands: [],
      validationCommands: ["grep -n 'cancel button' MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java"],
      source: 'implementation',
    })
    if (resolution.kind === 'commands') {
      expect(resolution.parserNotes.join('\n')).toContain('Unsupported shell syntax')
    }
  })

  it('accepts automated commands whose test path contains a ui segment', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['vitest src/ui/button.test.ts'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['vitest src/ui/button.test.ts'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts npx vitest commands when the repo-local runner exists', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['npx vitest src/foo.test.ts'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npx vitest src/foo.test.ts'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts bun test without requiring package.json scripts.test', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/bun': '#!/bin/sh\necho bun "$@"\n',
      },
      ['node_modules/.bin/bun'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['bun test'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['bun test'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('rejects direct runner commands that use non-test subcommands', async () => {
    const workspace = await createWorkspace(
      {
        playwright: '#!/bin/sh\necho playwright "$@"\n',
        npx: '#!/bin/sh\necho npx "$@"\n',
        cypress: '#!/bin/sh\necho cypress "$@"\n',
        wdio: '#!/bin/sh\necho wdio "$@"\n',
      },
      ['playwright', 'npx', 'cypress', 'wdio'],
    )

    await withPrependedPath(workspace, async () => {
      for (const command of ['playwright codegen', 'npx playwright codegen', 'cypress open', 'wdio repl']) {
        const resolution = await resolveTestCommands(
          workspace,
          [command],
          [],
        )

        expect(resolution).toMatchObject({
          kind: 'none',
          executionKind: 'no_runnable_command',
          source: 'none',
        })
        expect(resolution.parserNotes.join('\n')).toContain(
          'does not appear to be a real automated test command',
        )
      }
    })
  })

  it('accepts direct runner commands that use the correct explicit test subcommand', async () => {
    const workspace = await createWorkspace(
      {
        playwright: '#!/bin/sh\necho playwright "$@"\n',
        cypress: '#!/bin/sh\necho cypress "$@"\n',
        wdio: '#!/bin/sh\necho wdio "$@"\n',
      },
      ['playwright', 'cypress', 'wdio'],
    )

    await withPrependedPath(workspace, async () => {
      for (const command of ['playwright test', 'cypress run', 'wdio run ./wdio.conf.ts']) {
        const resolution = await resolveTestCommands(
          workspace,
          [command],
          [],
        )

        expect(resolution).toMatchObject({
          kind: 'commands',
          executionKind: 'automated_tests',
          automatedCommands: [command],
          validationCommands: [],
          source: 'implementation',
        })
      }
    })
  })

  it('treats bun run test as a package-script wrapper', async () => {
    const workspace = await createWorkspace(
      {
        'app/package.json': JSON.stringify({
          scripts: {
            test: 'vitest',
          },
        }),
        'node_modules/.bin/bun': '#!/bin/sh\necho bun "$@"\n',
        'app/node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/bun', 'app/node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['bun --cwd app run test'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['bun --cwd app run test'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts flagged yarn test commands from a selected package root', async () => {
    const workspace = await createWorkspace(
      {
        'app/package.json': JSON.stringify({
          scripts: {
            test: 'vitest',
          },
        }),
        'node_modules/.bin/yarn': '#!/bin/sh\necho yarn "$@"\n',
        'app/node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/yarn', 'app/node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['yarn --cwd app test'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['yarn --cwd app test'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('rejects wrapper commands that select an unsupported package scope', async () => {
    const workspace = await createWorkspace({})

    const resolution = await resolveTestCommands(
      workspace,
      ['yarn workspace app test'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      source: 'none',
    })
    expect(resolution.parserNotes.join('\n')).toContain(
      'workspace app selects a package scope that cannot be validated preflight',
    )
  })

  it('accepts repo-local executable scripts as automated commands', async () => {
    const workspace = await createWorkspace(
      {
        'scripts/run-tests.sh': '#!/bin/sh\nexit 0\n',
      },
      ['scripts/run-tests.sh'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['./scripts/run-tests.sh'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['./scripts/run-tests.sh'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('rejects path-like scripts that do not look like tests', async () => {
    const workspace = await createWorkspace(
      {
        'scripts/build.sh': '#!/bin/sh\nexit 0\n',
      },
      ['scripts/build.sh'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['./scripts/build.sh'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'none',
      executionKind: 'no_runnable_command',
      source: 'none',
    })
    if (resolution.kind === 'none') {
      expect(resolution.parserNotes.join('\n')).toContain('does not appear to be a real automated test command')
    }
  })

  it('accepts path-like commands when their task arguments clearly indicate tests', async () => {
    const workspace = await createWorkspace(
      {
        'gradlew': '#!/bin/sh\nexit 0\n',
      },
      ['gradlew'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['./gradlew integrationTest'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['./gradlew integrationTest'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts repo-local vitest binaries from node_modules/.bin', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['vitest src/foo.test.ts'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['vitest src/foo.test.ts'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts repo-local jest binaries from node_modules/.bin', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/jest': '#!/bin/sh\necho jest "$@"\n',
      },
      ['node_modules/.bin/jest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['jest src/foo.test.ts'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['jest src/foo.test.ts'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts npx test commands even when npx flags come first', async () => {
    const workspace = await createWorkspace({})

    const resolution = await resolveTestCommands(
      workspace,
      ['npx --yes vitest run src/foo.test.ts'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npx --yes vitest run src/foo.test.ts'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts playwright test commands invoked through npx', async () => {
    const workspace = await createWorkspace({})

    const resolution = await resolveTestCommands(
      workspace,
      ['npx playwright test'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npx playwright test'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts npm script names that are clearly test-like even without the word test', async () => {
    const workspace = await createWorkspace(
      {
        'package.json': JSON.stringify({
          scripts: {
            e2e: 'vitest src/e2e/foo.test.ts',
          },
        }),
        'node_modules/.bin/vitest': '#!/bin/sh\necho vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['npm run e2e'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['npm run e2e'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts python unittest module invocations', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/python': '#!/bin/sh\nexit 0\n',
      },
      ['node_modules/.bin/python'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['python -m unittest discover'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['python -m unittest discover'],
      validationCommands: [],
      source: 'implementation',
    })
  })

  it('accepts cargo nextest invocations', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/cargo': '#!/bin/sh\nexit 0\n',
      },
      ['node_modules/.bin/cargo'],
    )

    const resolution = await resolveTestCommands(
      workspace,
      ['cargo nextest run'],
      [],
    )

    expect(resolution).toMatchObject({
      kind: 'commands',
      executionKind: 'automated_tests',
      automatedCommands: ['cargo nextest run'],
      validationCommands: [],
      source: 'implementation',
    })
  })
})

describe('executeTestCommand', () => {
  it('runs repo-local binaries from node_modules/.bin', async () => {
    const workspace = await createWorkspace(
      {
        'node_modules/.bin/vitest': '#!/bin/sh\necho local-vitest "$@"\n',
      },
      ['node_modules/.bin/vitest'],
    )

    const result = await executeTestCommand(
      workspace,
      'vitest src/foo.test.ts',
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local-vitest src/foo.test.ts')
  })

  it('preserves quoted arguments for single-command grep validations', async () => {
    const workspace = await createWorkspace({
      'notes.txt': 'cancel button\ncancel button red\n',
    })

    const result = await executeTestCommand(
      workspace,
      "grep -n 'cancel button red' notes.txt",
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('2:cancel button red')
  })

  it('preserves escaped regex arguments inside double quotes', async () => {
    const workspace = await createWorkspace({
      'notes.txt': 'foo\nbar\n',
    })

    const result = await executeTestCommand(
      workspace,
      'grep -n "foo\\|bar" notes.txt',
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('1:foo')
    expect(result.stdout).toContain('2:bar')
  })

  it('uses repo-local Maven settings and isolated Maven repo when present', async () => {
    const workspace = await createWorkspace(
      {
        '.m2/settings.xml': '<settings></settings>',
        'MedicalMgmt/pom.xml': '<project><properties><skip.gwt.compile>false</skip.gwt.compile></properties></project>',
        'mvn': '#!/bin/sh\necho args:"$@"\necho maven_opts:"$MAVEN_OPTS"\n',
      },
      ['mvn'],
    )
    const priorPath = process.env.PATH
    const priorMavenOpts = process.env.MAVEN_OPTS
    process.env.PATH = [workspace, priorPath].filter(Boolean).join(path.delimiter)
    process.env.MAVEN_OPTS = '-Dmaven.repo.local=.m2/repository -Dkeep=true'

    try {
      const result = await executeTestCommand(
        workspace,
        'mvn -f MedicalMgmt/pom.xml test -Dtest=SomeTest',
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Using repo-local Maven settings from .m2/settings.xml.')
      expect(result.stdout).toContain('Skipping GWT compilation for Maven test goal via -Dskip.gwt.compile=true.')
      expect(result.stdout).toContain('args:-s .m2/settings.xml --batch-mode -Dskip.gwt.compile=true -f MedicalMgmt/pom.xml test -Dtest=SomeTest')
      expect(result.stdout).toContain('-Dmaven.repo.local=')
      expect(result.stdout).toContain('/tester/.m2/repository')
      expect(result.stdout).toContain('-Dkeep=true')
      expect(result.stdout).not.toContain('-Dmaven.repo.local=.m2/repository')
      expect(result.stdout).toContain('-Daether.connector.https.securityMode=insecure')
      await expect(fs.access(path.join(workspace, '.m2', 'repository'))).rejects.toThrow()
    } finally {
      process.env.PATH = priorPath
      process.env.MAVEN_OPTS = priorMavenOpts
    }
  })

  it('does not override an explicit GWT compile choice', async () => {
    const workspace = await createWorkspace(
      {
        '.m2/settings.xml': '<settings></settings>',
        'MedicalMgmt/pom.xml': '<project><properties><skip.gwt.compile>false</skip.gwt.compile></properties></project>',
        'mvn': '#!/bin/sh\necho args:"$@"\n',
      },
      ['mvn'],
    )
    const priorPath = process.env.PATH
    process.env.PATH = [workspace, priorPath].filter(Boolean).join(path.delimiter)

    try {
      const result = await executeTestCommand(
        workspace,
        'mvn -f MedicalMgmt/pom.xml test -Dskip.gwt.compile=false -Dtest=SomeTest',
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('args:-s .m2/settings.xml --batch-mode -f MedicalMgmt/pom.xml test -Dskip.gwt.compile=false -Dtest=SomeTest')
      expect(result.stdout).not.toContain('-Dskip.gwt.compile=true')
    } finally {
      process.env.PATH = priorPath
    }
  })

  it('does not duplicate Maven settings or batch flags when already supplied', async () => {
    const workspace = await createWorkspace(
      {
        '.m2/settings.xml': '<settings></settings>',
        'mvn': '#!/bin/sh\necho args:"$@"\n',
      },
      ['mvn'],
    )
    const priorPath = process.env.PATH
    process.env.PATH = [workspace, priorPath].filter(Boolean).join(path.delimiter)

    try {
      const result = await executeTestCommand(
        workspace,
        'mvn --settings custom-settings.xml -B test',
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('args:--settings custom-settings.xml -B test')
      expect(result.stdout).not.toContain('args:-s .m2/settings.xml')
    } finally {
      process.env.PATH = priorPath
    }
  })
})

describe('executeGitDiffCheck', () => {
  async function createGitWorkspace(): Promise<{ workspace: string; baseSha: string }> {
    const workspace = await createWorkspace({
      'src/Foo.java': 'class Foo {}\n',
    })
    await execFileAsync('git', ['init'], { cwd: workspace })
    await execFileAsync('git', ['config', 'user.email', 'oneshot@example.com'], {
      cwd: workspace,
    })
    await execFileAsync('git', ['config', 'user.name', 'OneShot Test'], {
      cwd: workspace,
    })
    await execFileAsync('git', ['add', '.'], { cwd: workspace })
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: workspace })
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
    })
    return { workspace, baseSha: stdout.trim() }
  }

  it('passes when candidate diff has no whitespace issues', async () => {
    const { workspace, baseSha } = await createGitWorkspace()
    await fs.writeFile(
      path.join(workspace, 'src/Foo.java'),
      'class Foo { int value = 1; }\n',
      'utf8',
    )

    const result = await executeGitDiffCheck(workspace, baseSha)

    expect(result.exitCode).toBe(0)
  })

  it('fails when candidate diff has trailing whitespace', async () => {
    const { workspace, baseSha } = await createGitWorkspace()
    await fs.writeFile(
      path.join(workspace, 'src/Foo.java'),
      'class Foo { int value = 1; }   \n',
      'utf8',
    )
    await execFileAsync('git', ['add', '.'], { cwd: workspace })
    await execFileAsync('git', ['commit', '-m', 'candidate'], {
      cwd: workspace,
    })

    const result = await executeGitDiffCheck(workspace, baseSha)

    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'trailing whitespace',
    )
  })
})

describe('findAndParseTestReports', () => {
  it('ignores unchanged XML reports when a baseline snapshot is provided', async () => {
    const workspace = await createWorkspace({
      'target/surefire-reports/TEST-old.xml': '<testsuite tests="1" failures="0" skipped="0"></testsuite>',
    })

    const snapshot = await captureTestReportSnapshot(workspace)
    const report = await findAndParseTestReports(workspace, snapshot)

    expect(report.passCount).toBe(0)
    expect(report.failCount).toBe(0)
    expect(report.skipCount).toBe(0)
  })

  it('only parses reports that are new or changed after the baseline snapshot', async () => {
    const workspace = await createWorkspace({
      'target/surefire-reports/TEST-old.xml': '<testsuite tests="1" failures="0" skipped="0"></testsuite>',
    })

    const snapshot = await captureTestReportSnapshot(workspace)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await fs.writeFile(
      path.join(workspace, 'target/surefire-reports/TEST-new.xml'),
      '<testsuite tests="1" failures="1" skipped="0"><testcase name="failure"><failure message="boom">boom</failure></testcase></testsuite>',
      'utf8',
    )

    const report = await findAndParseTestReports(workspace, snapshot)

    expect(report.passCount).toBe(0)
    expect(report.failCount).toBe(1)
    expect(report.failedTests).toHaveLength(1)
    expect(report.failedTests[0].message).toBe('boom')
  })
})
