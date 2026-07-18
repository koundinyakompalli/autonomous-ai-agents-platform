import { z } from 'zod'

export const TestFailureDetailSchema = z.object({
  testName: z.string().min(1),
  className: z.string().min(1).optional(),
  message: z.string().min(1),
  stackTrace: z.string().optional(),
})

export const TestCoverageSchema = z.object({
  linePercent: z.number().min(0).max(100).optional(),
  branchPercent: z.number().min(0).max(100).optional(),
  threshold: z.number().min(0).max(100).optional(),
  passed: z.boolean(),
}).superRefine((value, ctx) => {
  // coverage.passed must reflect meeting the threshold when both are known.
  if (value.threshold === undefined) {
    return
  }
  const lineMeetsThreshold = value.linePercent === undefined || value.linePercent >= value.threshold
  const branchMeetsThreshold = value.branchPercent === undefined || value.branchPercent >= value.threshold
  const shouldPass = lineMeetsThreshold && branchMeetsThreshold
  if (shouldPass !== value.passed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Coverage.passed=${value.passed} but line=${value.linePercent ?? 'n/a'}%/branch=${value.branchPercent ?? 'n/a'}% vs threshold=${value.threshold}% implies shouldPass=${shouldPass}`,
      path: ['passed'],
    })
  }
})

export const OneShotTestResultSchema = z.object({
  resolvedCommand: z.string().min(1),
  commandSource: z.enum(['implementation', 'planner', 'heuristic', 'none']),
  executionKind: z.enum(['automated_tests', 'validation_only', 'invalid_command', 'no_runnable_command']),
  executedCommands: z.array(z.string().min(1)).default([]),
  executedValidationChecks: z.array(z.object({
    kind: z.enum(['must_match', 'must_not_match']),
    pattern: z.string().min(1),
    paths: z.array(z.string().min(1)),
    scope: z.enum(['file', 'changed_lines']).default('file'),
    passed: z.boolean(),
    exitCode: z.number().int(),
    outputPreview: z.string().default(''),
  })).default([]),
  skippedTestCommands: z.array(z.string().min(1)).default([]),
  mavenSkippedTestCommands: z.array(z.string().min(1)).default([]),
  mavenBuildsDisabled: z.boolean().default(false),
  unverified: z.boolean().default(false),
  exitCode: z.number().int(),
  passed: z.boolean(),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  skipCount: z.number().int().nonnegative(),
  coverage: TestCoverageSchema.optional(),
  failedTests: z.array(TestFailureDetailSchema).default([]),
  truncatedOutput: z.string().default(''),
  parserNotes: z.array(z.string().min(1)).default([]),
  implementationVersion: z.number().int().positive(),
  codeReviewVersion: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).superRefine((value, ctx) => {
  // `passed=true` must agree with failCount===0, a non-zero exitCode cannot pass,
  // and coverage (when present) must also be passing.
  const coverageOk = value.coverage === undefined || value.coverage.passed
  const shouldPass = value.failCount === 0 && value.exitCode === 0 && coverageOk
  if (value.passed !== shouldPass) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Test result invariant violated: passed=${value.passed} but failCount=${value.failCount}, exitCode=${value.exitCode}, coverage.passed=${value.coverage?.passed ?? 'n/a'}`,
      path: ['passed'],
    })
  }
  const noTestCounts =
    value.passCount === 0 && value.failCount === 0 && value.skipCount === 0
  const explicitMavenDisabledNoProof =
    value.unverified &&
    value.mavenBuildsDisabled &&
    value.mavenSkippedTestCommands.length > 0 &&
    value.skippedTestCommands.length === value.mavenSkippedTestCommands.length
  if (value.passed && noTestCounts && !explicitMavenDisabledNoProof) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Test result cannot claim passed=true when no tests ran (passCount=failCount=skipCount=0)',
      path: ['passed'],
    })
  }
  if ((value.executionKind === 'invalid_command' || value.executionKind === 'no_runnable_command') && value.executedCommands.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.executionKind} results cannot record executedCommands because no command should have run.`,
      path: ['executedCommands'],
    })
  }
})

export type OneShotTestResult = z.infer<typeof OneShotTestResultSchema>
export type TestFailureDetail = z.infer<typeof TestFailureDetailSchema>
export type TestCoverage = z.infer<typeof TestCoverageSchema>

export function parseOneShotTestResult(value: unknown): OneShotTestResult {
  return OneShotTestResultSchema.parse(value)
}
