import { describe, expect, it, vi } from 'vitest'
import { detectExternalSpecEvidence } from './readiness.js'
import { resolveExternalSpecEvidence } from './external-spec-evidence.js'

function createFakeS3(initialObjects: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initialObjects))
  return {
    objects,
    client: {
      async send(command: { input?: { Key?: string; Body?: string } }) {
        const key = command.input?.Key
        if (!key) {
          throw new Error('missing key')
        }
        if (command.constructor.name === 'GetObjectCommand') {
          const body = objects.get(key)
          if (!body) {
            const error = new Error('NoSuchKey') as Error & { name: string; $metadata: { httpStatusCode: number } }
            error.name = 'NoSuchKey'
            error.$metadata = { httpStatusCode: 404 }
            throw error
          }
          return {
            Body: {
              async transformToString() {
                return body
              },
            },
          }
        }
        if (command.constructor.name === 'PutObjectCommand') {
          objects.set(key, String(command.input?.Body ?? ''))
          return {}
        }
        throw new Error(`unexpected command ${command.constructor.name}`)
      },
    },
  }
}

describe('external spec evidence', () => {
  const plan = {
    jiraKey: 'CPDEV-20626',
    repoName: 'cp-interoperability-monorepo',
    branchName: 'master',
    baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    summary: 'Implement Da Vinci DTR questionnaire-package using https://build.fhir.org/ig/HL7/davinci-dtr/OperationDefinition-questionnaire-package.html',
    specs: [{
      id: 'spec-1',
      objective: 'Return PackageBundle response.',
      acceptanceCriteria: ['Bundle.meta.profile is set.'],
      targetFiles: ['DtrClient.java'],
      targetFileRationales: [],
      implementationNotes: ['Follow DTR PackageBundle profile.'],
      validationSteps: ['mvn test'],
    }],
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    risks: [],
  }

  it('fetches exact allowlisted URLs and caches a strict evidence summary', async () => {
    const detected = detectExternalSpecEvidence({ plan })
    const fakeS3 = createFakeS3()
    const resolved = await resolveExternalSpecEvidence({
      detected,
      s3Client: fakeS3.client as never,
      bucket: 'specter-results',
      now: new Date('2026-05-01T00:00:00.000Z'),
      fetchActive: true,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return [
            `FHIR profile for ${url}`,
            'The response SHALL be a Bundle with Bundle.meta.profile.',
            'The PackageBundle entry MUST include QuestionnaireResponse.',
            'Input parameter coverage is required.',
          ].join('\n')
        },
      }),
    })

    expect(resolved.unavailable).toBe(false)
    expect(resolved.urls[0]?.url).toBe('https://build.fhir.org/ig/HL7/davinci-dtr/OperationDefinition-questionnaire-package.html')
    expect(resolved.urls[0]?.status).toBe('fetched')
    expect(resolved.urls[0]?.evidence?.profileRequirements.join(' ')).toContain('meta.profile')
    expect(fakeS3.objects.size).toBe(1)
  })

  it('keeps detected URLs observe-only when external spec readiness is inactive', async () => {
    const detected = detectExternalSpecEvidence({ plan })
    const fakeS3 = createFakeS3()
    const fetchImpl = vi.fn()

    const resolved = await resolveExternalSpecEvidence({
      detected,
      s3Client: fakeS3.client as never,
      bucket: 'specter-results',
      now: new Date('2026-05-01T00:00:00.000Z'),
      fetchImpl,
    })

    expect(resolved.unavailable).toBe(false)
    expect(resolved.urls[0]?.status).toBe('not_fetched_observe_mode')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(fakeS3.objects.size).toBe(0)
  })

  it('uses fresh cached evidence without fetching the network', async () => {
    const detected = detectExternalSpecEvidence({ plan })
    const key = detected.urls[0]!.cacheKey
    const fakeS3 = createFakeS3({
      [key]: JSON.stringify({
        schemaVersion: 1,
        url: detected.urls[0]!.url,
        cachedAt: '2026-05-01T00:00:00.000Z',
        expiresAt: '2026-05-08T00:00:00.000Z',
        evidence: {
          schemaVersion: 1,
          url: detected.urls[0]!.url,
          fetchedAt: '2026-05-01T00:00:00.000Z',
          sourceBytes: 12,
          contentHash: 'abc',
          profileRequirements: ['Bundle.meta.profile'],
          bundleStructure: ['PackageBundle entry'],
          parameterContracts: [],
          questionnaireRequirements: [],
          operationContracts: [],
          notes: [],
        },
      }),
    })

    const resolved = await resolveExternalSpecEvidence({
      detected,
      s3Client: fakeS3.client as never,
      bucket: 'specter-results',
      now: new Date('2026-05-02T00:00:00.000Z'),
      fetchActive: true,
      fetchImpl: async () => {
        throw new Error('fetch should not run')
      },
    })

    expect(resolved.urls[0]?.status).toBe('cached')
    expect(resolved.urls[0]?.evidence?.profileRequirements).toEqual(['Bundle.meta.profile'])
  })

  it('marks fetched specs unavailable when extraction is not meaningful', async () => {
    const detected = detectExternalSpecEvidence({ plan })
    const fakeS3 = createFakeS3()

    const resolved = await resolveExternalSpecEvidence({
      detected,
      s3Client: fakeS3.client as never,
      bucket: 'specter-results',
      now: new Date('2026-05-01T00:00:00.000Z'),
      fetchActive: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return 'Welcome to a generic landing page.'
        },
      }),
    })

    expect(resolved.unavailable).toBe(true)
    expect(resolved.urls[0]?.status).toBe('unavailable')
    expect(resolved.urls[0]?.error).toBe('insufficient_external_spec_evidence')
    expect(fakeS3.objects.size).toBe(0)
  })

  it('refetches cached evidence that no longer satisfies the evidence threshold', async () => {
    const detected = detectExternalSpecEvidence({ plan })
    const key = detected.urls[0]!.cacheKey
    const fakeS3 = createFakeS3({
      [key]: JSON.stringify({
        schemaVersion: 1,
        url: detected.urls[0]!.url,
        cachedAt: '2026-05-01T00:00:00.000Z',
        expiresAt: '2026-05-08T00:00:00.000Z',
        evidence: {
          schemaVersion: 1,
          url: detected.urls[0]!.url,
          fetchedAt: '2026-05-01T00:00:00.000Z',
          sourceBytes: 12,
          contentHash: 'abc',
          profileRequirements: ['Bundle.meta.profile'],
          bundleStructure: [],
          parameterContracts: [],
          questionnaireRequirements: [],
          operationContracts: [],
          notes: [],
        },
      }),
    })

    const resolved = await resolveExternalSpecEvidence({
      detected,
      s3Client: fakeS3.client as never,
      bucket: 'specter-results',
      now: new Date('2026-05-02T00:00:00.000Z'),
      fetchActive: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return [
            'FHIR profile requires Bundle.meta.profile.',
            'The PackageBundle entry MUST include QuestionnaireResponse.',
          ].join('\n')
        },
      }),
    })

    expect(resolved.urls[0]?.status).toBe('fetched')
    expect(resolved.urls[0]?.evidence?.bundleStructure.join(' ')).toContain('PackageBundle')
  })
})
