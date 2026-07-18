import { describe, expect, it } from 'vitest'
import { parseOneShotTestResult } from './test-result.js'

describe('parseOneShotTestResult', () => {
  const validResult = {
    resolvedCommand: 'mvn test -B',
    commandSource: 'implementation' as const,
    executionKind: 'automated_tests' as const,
    executedCommands: ['mvn test -B'],
    exitCode: 0,
    passed: true,
    passCount: 42,
    failCount: 0,
    skipCount: 3,
    failedTests: [],
    truncatedOutput: '',
    parserNotes: [],
    implementationVersion: 1,
  }

  it('accepts a valid passing test result', () => {
    const result = parseOneShotTestResult(validResult)
    expect(result.passed).toBe(true)
    expect(result.passCount).toBe(42)
  })

  it('accepts a failed test result with details', () => {
    const result = parseOneShotTestResult({
      ...validResult,
      exitCode: 1,
      passed: false,
      passCount: 40,
      failCount: 2,
      failedTests: [
        { testName: 'should handle null input', message: 'Expected null but got undefined' },
        { testName: 'should validate email', className: 'UserTest', message: 'Assertion failed', stackTrace: 'at UserTest.java:42' },
      ],
    })
    expect(result.passed).toBe(false)
    expect(result.failedTests).toHaveLength(2)
    expect(result.failedTests[1].className).toBe('UserTest')
  })

  it('accepts optional coverage data', () => {
    const result = parseOneShotTestResult({
      ...validResult,
      coverage: {
        linePercent: 85.4,
        branchPercent: 72.1,
        passed: true,
      },
    })
    expect(result.coverage?.linePercent).toBe(85.4)
    expect(result.coverage?.passed).toBe(true)
  })

  it('rejects invalid commandSource', () => {
    expect(() => parseOneShotTestResult({
      ...validResult,
      commandSource: 'magic',
    })).toThrow()
  })

  it('accepts a fail-fast result with no runnable automated command', () => {
    const result = parseOneShotTestResult({
      ...validResult,
      resolvedCommand: '(no automated test command available)',
      commandSource: 'none',
      executionKind: 'no_runnable_command',
      executedCommands: [],
      exitCode: 1,
      passed: false,
      passCount: 0,
      failCount: 1,
      failedTests: [
        {
          testName: 'automated-test-command',
          message: 'No runnable automated test command available.',
        },
      ],
    })

    expect(result.commandSource).toBe('none')
    expect(result.failedTests[0].message).toContain('No runnable automated test command')
  })

  it('rejects invalid or no-runnable results that claim commands executed', () => {
    expect(() => parseOneShotTestResult({
      ...validResult,
      commandSource: 'none',
      executionKind: 'invalid_command',
      executedCommands: ['grep foo file'],
      exitCode: 1,
      passed: false,
      passCount: 0,
      failCount: 1,
      failedTests: [
        {
          testName: 'automated-test-command',
          message: 'Unsupported shell syntax in testCommands or validationCommands.',
        },
      ],
    })).toThrow(/executedCommands/i)
  })

  it('rejects negative counts', () => {
    expect(() => parseOneShotTestResult({
      ...validResult,
      passCount: -1,
    })).toThrow()
  })

  it('requires implementationVersion to be positive', () => {
    expect(() => parseOneShotTestResult({
      ...validResult,
      implementationVersion: 0,
    })).toThrow()
  })

  it('rejects passed=true when failCount > 0', () => {
    expect(() => parseOneShotTestResult({
      ...validResult,
      passed: true,
      failCount: 3,
    })).toThrow(/invariant/i)
  })

  it('rejects passed=true when exitCode is non-zero', () => {
    expect(() => parseOneShotTestResult({
      ...validResult,
      passed: true,
      exitCode: 1,
    })).toThrow(/invariant/i)
  })

  it('rejects passed=true when coverage is failing', () => {
    expect(() => parseOneShotTestResult({
      ...validResult,
      passed: true,
      coverage: {
        linePercent: 50,
        branchPercent: 40,
        threshold: 80,
        passed: false,
      },
    })).toThrow(/invariant/i)
  })

  it('rejects passed=true when no tests ran', () => {
    expect(() => parseOneShotTestResult({
      ...validResult,
      passed: true,
      passCount: 0,
      failCount: 0,
      skipCount: 0,
    })).toThrow(/no tests ran/i)
  })

  it('accepts explicit Maven-disabled no-proof results as unverified but not failed', () => {
    const result = parseOneShotTestResult({
      ...validResult,
      resolvedCommand: '(no automated test command available)',
      commandSource: 'none',
      executionKind: 'no_runnable_command',
      executedCommands: [],
      skippedTestCommands: ['mvn test -B'],
      mavenSkippedTestCommands: ['mvn test -B'],
      mavenBuildsDisabled: true,
      unverified: true,
      exitCode: 0,
      passed: true,
      passCount: 0,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    })

    expect(result.unverified).toBe(true)
    expect(result.passed).toBe(true)
    expect(result.failCount).toBe(0)
  })

  it('rejects coverage.passed=true when below threshold', () => {
    expect(() => parseOneShotTestResult({
      ...validResult,
      coverage: {
        linePercent: 50,
        branchPercent: 40,
        threshold: 80,
        passed: true,
      },
    })).toThrow(/threshold/i)
  })

  it('accepts coverage.passed=false when below threshold', () => {
    const result = parseOneShotTestResult({
      ...validResult,
      passed: false,
      exitCode: 1,
      failCount: 1,
      failedTests: [{ testName: 'coverage gate', message: 'coverage below threshold' }],
      coverage: {
        linePercent: 50,
        branchPercent: 40,
        threshold: 80,
        passed: false,
      },
    })
    expect(result.coverage?.passed).toBe(false)
  })
})
