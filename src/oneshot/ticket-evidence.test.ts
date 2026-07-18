import { describe, expect, it } from 'vitest'
import {
  buildTicketEvidenceStats,
  compactTicketEvidenceMetadata,
  deriveTicketEvidenceKey,
  publicTicketEvidenceRef,
  renderTicketEvidencePromptSection,
  renderTicketEvidenceSidecars,
  type TicketEvidenceV1,
} from './ticket-evidence.js'

function buildEvidence(): TicketEvidenceV1 {
  return {
    schemaVersion: 'ticket-evidence.v1',
    jiraKey: 'CPDEV-42',
    capturedAt: '2026-06-17T12:00:00.000Z',
    issue: {
      summary: 'Use all ticket evidence',
      issueType: 'Story',
      status: 'Open',
      priority: 'High',
      labels: ['PFOS'],
      components: ['core-app'],
      fixVersions: ['2026.07'],
      reporter: 'Reporter',
      assignee: 'Assignee',
      created: '2026-06-01T12:00:00.000Z',
      updated: '2026-06-02T12:00:00.000Z',
    },
    descriptionMarkdown: 'Ticket description.',
    comments: [
      {
        id: '10001',
        author: 'Reviewer',
        created: '2026-06-02T12:30:00.000Z',
        bodyMarkdown: 'Comment-only requirement.',
      },
    ],
    attachments: [
      {
        id: 'att-1',
        filename: 'requirements.md',
        mimeType: 'text/markdown',
        size: 128,
        created: '2026-06-02T13:00:00.000Z',
        author: 'Reporter',
        extractionStatus: 'included',
        extractedText: '# Requirements\nDo the thing.',
      },
      {
        id: 'att-2',
        filename: 'diagram.png',
        mimeType: 'image/png',
        size: 512,
        created: '2026-06-02T14:00:00.000Z',
        extractionStatus: 'included',
        imageDigest: 'Image diagram.png was included in ticket evidence.',
      },
      {
        id: 'att-3',
        filename: 'archive.zip',
        mimeType: 'application/zip',
        size: 1024,
        extractionStatus: 'metadata_only',
        warning: 'Unsupported attachment type.',
      },
    ],
    warnings: ['archive.zip: unsupported attachment type'],
    stats: {
      commentCount: 1,
      attachmentCount: 3,
      extractedAttachmentCount: 2,
      imageAttachmentCount: 1,
      warningCount: 1,
    },
  }
}

describe('ticket evidence helpers', () => {
  it('derives a sibling evidence key from the task description key', () => {
    expect(deriveTicketEvidenceKey('tasks/CPDEV-42/2026-06-17.md')).toBe(
      'tasks/CPDEV-42/2026-06-17.ticket-evidence.v1.json',
    )
  })

  it('computes compact stats without exposing raw evidence', () => {
    expect(buildTicketEvidenceStats(buildEvidence())).toEqual({
      commentCount: 1,
      attachmentCount: 3,
      extractedAttachmentCount: 2,
      imageAttachmentCount: 1,
      warningCount: 1,
    })
  })

  it('does not report evidence present until a ref has verified stats', () => {
    expect(
      compactTicketEvidenceMetadata({
        schemaVersion: 'ticket-evidence.v1',
        bucket: 'specter-tasks',
        key: 'tasks/CPDEV-42/missing.ticket-evidence.v1.json',
      }),
    ).toMatchObject({
      present: false,
      comment_count: 0,
      attachment_count: 0,
    })
  })

  it('does not report evidence present when ref stats are malformed', () => {
    const ref = {
      schemaVersion: 'ticket-evidence.v1',
      bucket: 'specter-tasks',
      key: 'tasks/CPDEV-42/2026-06-17.ticket-evidence.v1.json',
      jiraKey: 'CPDEV-42',
      stats: {
        commentCount: 1,
      },
    } as any

    expect(publicTicketEvidenceRef(ref)).toBeNull()
    expect(compactTicketEvidenceMetadata(ref)).toMatchObject({
      present: false,
      comment_count: 0,
      attachment_count: 0,
    })
  })

  it('renders planner sidecars and a compact prompt index', () => {
    const evidence = buildEvidence()

    const sidecars = renderTicketEvidenceSidecars(evidence)
    expect(sidecars.map((artifact) => artifact.fileName)).toEqual([
      'ticket-evidence/index.md',
      'ticket-evidence/ticket.md',
      'ticket-evidence/comments.md',
      'ticket-evidence/attachments.md',
      'ticket-evidence/attachments/att-1-requirements.md.md',
      'ticket-evidence/ticket-evidence.v1.json',
    ])
    expect(sidecars[0].body).toContain('CPDEV-42')
    expect(sidecars[2].body).toContain('Comment-only requirement.')

    const promptSection = renderTicketEvidencePromptSection({
      evidence,
      evidenceRootRelativePath: 'planner/ticket-evidence',
    })
    expect(promptSection).toContain('## Ticket Evidence')
    expect(promptSection).toContain('planner/ticket-evidence/index.md')
    expect(promptSection).toContain('Read the ticket evidence sidecars')
    expect(promptSection).not.toContain('Comment-only requirement.')
    expect(promptSection).not.toContain('# Requirements')
  })

  it('uses attachment ids to keep duplicate filenames in distinct sidecars', () => {
    const evidence = buildEvidence()
    evidence.attachments = [
      {
        id: 'att-1',
        filename: 'requirements.md',
        mimeType: 'text/markdown',
        extractionStatus: 'included',
        extractedText: 'First copy',
      },
      {
        id: 'att-2',
        filename: 'requirements.md',
        mimeType: 'text/markdown',
        extractionStatus: 'included',
        extractedText: 'Second copy',
      },
    ]
    evidence.stats = buildTicketEvidenceStats(evidence)

    const sidecars = renderTicketEvidenceSidecars(evidence)

    expect(sidecars.map((artifact) => artifact.fileName)).toEqual(
      expect.arrayContaining([
        'ticket-evidence/attachments/att-1-requirements.md.md',
        'ticket-evidence/attachments/att-2-requirements.md.md',
      ]),
    )
    expect(sidecars.find((artifact) =>
      artifact.fileName.endsWith('att-1-requirements.md.md'),
    )?.body).toContain('First copy')
    expect(sidecars.find((artifact) =>
      artifact.fileName.endsWith('att-2-requirements.md.md'),
    )?.body).toContain('Second copy')
    expect(String(sidecars[3].body)).toContain(
      'attachments/att-1-requirements.md.md',
    )
    expect(String(sidecars[3].body)).toContain(
      'attachments/att-2-requirements.md.md',
    )
  })
})
