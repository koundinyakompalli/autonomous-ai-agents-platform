import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCodeReviewContext } from './code-review-context.js'

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()
}

async function createTempRepo(): Promise<string> {
  const repoPath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'oneshot-code-review-context-test-'),
  )
  runGit(repoPath, ['init', '-q'])
  runGit(repoPath, ['config', 'user.name', 'OneShot Code Review Test'])
  runGit(repoPath, [
    'config',
    'user.email',
    'oneshot-code-review-test@example.com',
  ])
  return repoPath
}

describe('buildCodeReviewContext', () => {
  const tempRepos: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempRepos.splice(0).map(async (repoPath) => {
        await fs.rm(repoPath, { recursive: true, force: true })
      }),
    )
  })

  it('truncates large diffs before child-process stdout buffering can fail', async () => {
    const repoPath = await createTempRepo()
    tempRepos.push(repoPath)

    await fs.writeFile(path.join(repoPath, 'large.txt'), 'initial\n')
    runGit(repoPath, ['add', 'large.txt'])
    runGit(repoPath, ['commit', '-qm', 'init'])
    const baseCommitSha = runGit(repoPath, ['rev-parse', 'HEAD'])

    const largeContent = Array.from(
      { length: 80_000 },
      (_value, index) => `line-${index} ${'x'.repeat(32)}`,
    ).join('\n')
    await fs.writeFile(path.join(repoPath, 'large.txt'), `${largeContent}\n`)
    runGit(repoPath, ['add', 'large.txt'])
    runGit(repoPath, ['commit', '-qm', 'large change'])

    const context = await buildCodeReviewContext(repoPath, baseCommitSha, [
      'large.txt',
    ])

    expect(context.diffTruncated).toBe(true)
    expect(Buffer.byteLength(context.diff, 'utf8')).toBeLessThanOrEqual(
      100 * 1024,
    )
    expect(context.truncated).toBe(true)
    expect(context.truncationNote).toContain('Diff was truncated')
    expect(context.changedFiles[0]).toMatchObject({
      path: 'large.txt',
      included: true,
      truncated: true,
    })
  })
})
