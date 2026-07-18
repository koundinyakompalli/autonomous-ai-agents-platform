import { beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyBaseDrift } from './branch-drift.js'

const { listChangedFilesMock, runGitCommandMock } = vi.hoisted(() => ({
  listChangedFilesMock: vi.fn(),
  runGitCommandMock: vi.fn(),
}))

vi.mock('./git.js', () => ({
  listChangedFiles: listChangedFilesMock,
  runGitCommand: runGitCommandMock,
}))

describe('classifyBaseDrift', () => {
  beforeEach(() => {
    listChangedFilesMock.mockReset()
    runGitCommandMock.mockReset()
  })

  it('returns no_drift when the base still matches current head', async () => {
    const result = await classifyBaseDrift('/tmp/repo', 'abc1234', 'abc1234', [
      'src/member/MemberSearchForm.java',
    ])

    expect(result.status).toBe('no_drift')
    expect(listChangedFilesMock).not.toHaveBeenCalled()
  })

  it('auto-refreshes safe fast-forward drift with unrelated files', async () => {
    runGitCommandMock.mockResolvedValue({ stdout: '', stderr: '' })
    listChangedFilesMock.mockResolvedValue(['docs/release-notes.md'])

    const result = await classifyBaseDrift('/tmp/repo', 'oldbase', 'newhead', [
      'src/member/MemberSearchForm.java',
    ])

    expect(result.status).toBe('safe_fast_forward')
    expect(result.changedFiles).toEqual(['docs/release-notes.md'])
    expect(result.overlappingFiles).toEqual([])
    expect(result.riskyFiles).toEqual([])
  })

  it('requires replan on exact planned-file overlap', async () => {
    runGitCommandMock.mockResolvedValue({ stdout: '', stderr: '' })
    listChangedFilesMock.mockResolvedValue([
      'src/member/MemberSearchForm.java',
      'docs/release-notes.md',
    ])

    const result = await classifyBaseDrift('/tmp/repo', 'oldbase', 'newhead', [
      './src/member/MemberSearchForm.java',
    ])

    expect(result.status).toBe('conflicting_fast_forward')
    expect(result.overlappingFiles).toEqual(['src/member/MemberSearchForm.java'])
    expect(result.evidence.join(' ')).toContain('overlap planned files')
  })

  it('requires replan on risky shared build files', async () => {
    runGitCommandMock.mockResolvedValue({ stdout: '', stderr: '' })
    listChangedFilesMock.mockResolvedValue(['pom.xml'])

    const result = await classifyBaseDrift('/tmp/repo', 'oldbase', 'newhead', [
      'src/member/MemberSearchForm.java',
    ])

    expect(result.status).toBe('conflicting_fast_forward')
    expect(result.riskyFiles).toEqual(['pom.xml'])
  })

  it('requires replan for non-fast-forward movement', async () => {
    runGitCommandMock.mockRejectedValue(new Error('not ancestor'))

    const result = await classifyBaseDrift('/tmp/repo', 'oldbase', 'newhead', [
      'src/member/MemberSearchForm.java',
    ])

    expect(result.status).toBe('non_fast_forward')
    expect(listChangedFilesMock).not.toHaveBeenCalled()
  })
})
