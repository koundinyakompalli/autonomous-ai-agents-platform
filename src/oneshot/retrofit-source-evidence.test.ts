import { describe, expect, it } from 'vitest'
import {
  deriveRetrofitAllowedFiles,
  findUnaccountedRetrofitCommits,
  hasRetrofitAdaptationCoverage,
  parseRetrofitAdaptationCoverage,
  parseRetrofitSourceEvidence,
  type RetrofitCommitManifest,
  type RetrofitCommitManifestEntry,
  type RetrofitCommitStatus,
} from './retrofit-source-evidence.js'

function makeEntry(
  sha: string,
  status: RetrofitCommitStatus,
  overrides: Partial<RetrofitCommitManifestEntry> = {},
): RetrofitCommitManifestEntry {
  return {
    sha,
    subject: `Commit ${sha}`,
    files: [`src/file-${sha}.ts`],
    status,
    ...overrides,
  }
}

describe('findUnaccountedRetrofitCommits', () => {
  it('returns empty array when all commits are already_applied', () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        makeEntry('abc1', 'already_applied'),
        makeEntry('abc2', 'already_applied'),
      ],
    }
    expect(findUnaccountedRetrofitCommits(manifest)).toEqual([])
  })

  it('returns empty array when all commits are clean_applied', () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        makeEntry('abc1', 'clean_applied'),
        makeEntry('abc2', 'clean_applied'),
      ],
    }
    expect(findUnaccountedRetrofitCommits(manifest)).toEqual([])
  })

  it('returns empty array when all commits are adapted', () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        makeEntry('abc1', 'adapted'),
        makeEntry('abc2', 'adapted'),
      ],
    }
    expect(findUnaccountedRetrofitCommits(manifest)).toEqual([])
  })

  it('returns empty array when failed commits have an excludedRationale', () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        makeEntry('abc1', 'failed', {
          excludedRationale: 'This test-only commit is not needed on target branch',
        }),
      ],
    }
    expect(findUnaccountedRetrofitCommits(manifest)).toEqual([])
  })

  it('returns empty array when not_attempted commits have an excludedRationale', () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        makeEntry('abc1', 'not_attempted', {
          excludedRationale: 'Intentionally skipped — doc-only change',
        }),
      ],
    }
    expect(findUnaccountedRetrofitCommits(manifest)).toEqual([])
  })

  it('flags failed commits without a rationale', () => {
    const failedEntry = makeEntry('abc1', 'failed')
    const manifest: RetrofitCommitManifest = {
      entries: [failedEntry],
    }
    const result = findUnaccountedRetrofitCommits(manifest)
    expect(result).toHaveLength(1)
    expect(result[0].sha).toBe('abc1')
  })

  it('flags not_attempted commits without a rationale', () => {
    const notAttemptedEntry = makeEntry('abc1', 'not_attempted')
    const manifest: RetrofitCommitManifest = {
      entries: [notAttemptedEntry],
    }
    const result = findUnaccountedRetrofitCommits(manifest)
    expect(result).toHaveLength(1)
    expect(result[0].sha).toBe('abc1')
  })

  it('returns only unaccounted entries from a mixed manifest', () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        makeEntry('sha-1', 'already_applied'),
        makeEntry('sha-2', 'clean_applied'),
        makeEntry('sha-3', 'adapted'),
        makeEntry('sha-4', 'failed'),
        makeEntry('sha-5', 'not_attempted'),
        makeEntry('sha-6', 'failed', { excludedRationale: 'Safe to skip' }),
        makeEntry('sha-7', 'not_attempted', { excludedRationale: 'Doc-only' }),
      ],
    }
    const result = findUnaccountedRetrofitCommits(manifest)
    expect(result.map((e) => e.sha)).toEqual(['sha-4', 'sha-5'])
  })

  it('handles an empty manifest', () => {
    const manifest: RetrofitCommitManifest = { entries: [] }
    expect(findUnaccountedRetrofitCommits(manifest)).toEqual([])
  })
})

describe('parseRetrofitSourceEvidence', () => {
  it('parses valid evidence', () => {
    const raw = {
      sourceJiraKey: 'CPDEV-18876',
      sourceBranch: 'medhok-monorepo-4.1',
      targetBranch: 'medhok-monorepo-3.17',
      sourceRepoName: 'core-app',
      sourceRepoUrl: 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
      selectedCommits: [
        {
          sha: 'abc1234',
          subject: 'CPDEV-18876 Fix dropdown sort',
          files: ['MedicalMgmt/src/main/java/View.java'],
        },
      ],
      touchedFiles: ['MedicalMgmt/src/main/java/View.java'],
      evidenceSummary: 'Single commit fixing dropdown sort.',
    }
    const result = parseRetrofitSourceEvidence(raw)
    expect(result).not.toBeNull()
    expect(result?.sourceJiraKey).toBe('CPDEV-18876')
    expect(result?.selectedCommits).toHaveLength(1)
    expect(result?.selectedCommits[0].sha).toBe('abc1234')
  })

  it('returns null for invalid evidence', () => {
    expect(parseRetrofitSourceEvidence(null)).toBeNull()
    expect(parseRetrofitSourceEvidence(undefined)).toBeNull()
    expect(parseRetrofitSourceEvidence({ invalid: 'object' })).toBeNull()
    expect(parseRetrofitSourceEvidence('string')).toBeNull()
  })
})

describe('deriveRetrofitAllowedFiles', () => {
  it('combines touched files with editable adaptation files that have rationale', () => {
    const result = deriveRetrofitAllowedFiles(
      {
        touchedFiles: ['src/Source.ts', ' src/Source.ts ', ''],
      },
      [
        {
          path: 'src/AdaptedTarget.ts',
          editable: true,
          role: 'runtime_required',
          rationale: 'Target branch renamed the source component.',
        },
        {
          path: 'src/MissingRationale.ts',
          editable: true,
          role: 'runtime_required',
          rationale: '   ',
        },
        {
          path: 'src/ReadOnly.ts',
          editable: true,
          role: 'read_only_evidence',
          rationale: 'Read-only evidence cannot be edited.',
        },
        {
          path: 'src/Forbidden.ts',
          editable: true,
          role: 'forbidden',
          rationale: 'Forbidden entries cannot be edited.',
        },
        {
          path: 'src/NotEditable.ts',
          editable: false,
          role: 'runtime_required',
          rationale: 'Not editable.',
        },
      ],
    )

    expect(result).toEqual(['src/Source.ts', 'src/AdaptedTarget.ts'])
  })

  it('returns an empty allowlist when no retrofit evidence is available', () => {
    expect(
      deriveRetrofitAllowedFiles(null, [
        {
          path: 'src/AdaptedTarget.ts',
          editable: true,
          role: 'runtime_required',
          rationale: 'Would be allowed only with retrofit source evidence.',
        },
      ]),
    ).toEqual([])
  })
})

describe('hasRetrofitAdaptationCoverage', () => {
  it('accepts coverage only when source SHA, files, and hunk evidence are present', () => {
    expect(
      hasRetrofitAdaptationCoverage(
        [
          {
            sourceSha: 'abc1234',
            filesCovered: ['src/AuthClient.ts'],
            hunkEvidence: ['Mapped response header capture into target branch API.'],
          },
        ],
        'abc1234',
      ),
    ).toBe(true)
  })

  it('rejects missing or incomplete coverage entries', () => {
    expect(hasRetrofitAdaptationCoverage(undefined, 'abc1234')).toBe(false)
    expect(
      hasRetrofitAdaptationCoverage(
        [
          {
            sourceSha: 'abc1234',
            filesCovered: [],
            hunkEvidence: ['No files means no durable proof.'],
          },
          {
            sourceSha: 'def5678',
            filesCovered: ['src/AuthClient.ts'],
            hunkEvidence: [],
          },
        ],
        'abc1234',
      ),
    ).toBe(false)
  })
})

describe('parseRetrofitAdaptationCoverage', () => {
  it('returns parsed coverage entries when the payload is valid', () => {
    expect(
      parseRetrofitAdaptationCoverage([
        {
          sourceSha: 'abc1234',
          filesCovered: ['src/AuthClient.ts'],
          hunkEvidence: ['Mapped source header capture into target branch API.'],
          rationale: 'Target branch method names differ.',
        },
      ]),
    ).toEqual([
      {
        sourceSha: 'abc1234',
        filesCovered: ['src/AuthClient.ts'],
        hunkEvidence: ['Mapped source header capture into target branch API.'],
        rationale: 'Target branch method names differ.',
      },
    ])
  })

  it('returns an empty array when the payload is missing or invalid', () => {
    expect(parseRetrofitAdaptationCoverage(undefined)).toEqual([])
    expect(parseRetrofitAdaptationCoverage([{ sourceSha: 'abc1234' }])).toEqual([])
  })
})
