import { describe, expect, it, vi, beforeEach } from 'vitest'

const { createJiraClientMock } = vi.hoisted(() => ({
  createJiraClientMock: vi.fn(),
}))

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    send = vi.fn()
  },
  InvokeModelCommand: class {
    constructor(public readonly input: unknown) {}
  },
}))

vi.mock('./JiraClient.js', async () => {
  const actual = await vi.importActual<typeof import('./JiraClient.js')>('./JiraClient.js')
  return {
    ...actual,
    createJiraClient: createJiraClientMock,
  }
})

import { TaskDescriptionGenerator } from './TaskDescriptionGenerator.js'

describe('TaskDescriptionGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to the text-only prompt when the multimodal Bedrock call fails', async () => {
    const ticketData = {
      issue: {
        key: 'CPDEV-1',
        fields: {},
      },
      descriptionMarkdown: 'description',
      comments: [],
      attachments: [],
      textAttachments: [],
      imageAttachments: [
        {
          filename: 'screenshot.png',
          mimeType: 'image/png',
          base64Data: 'ZmFrZQ==',
          originalSize: 4,
        },
      ],
    } as any

    createJiraClientMock.mockReturnValue({
      fetchTicketData: vi.fn().mockResolvedValue(ticketData),
    })

    const generator = new TaskDescriptionGenerator({
      jiraBaseUrl: 'https://mhkjira.atlassian.net',
      jiraUsername: 'devai@mhk.com',
      jiraToken: 'token',
    })

    const buildEnhancedPrompt = vi
      .spyOn(generator as any, 'buildEnhancedPrompt')
      .mockReturnValue('TEXT_ONLY_PROMPT')
    const callBedrockMultimodal = vi
      .spyOn(generator as any, 'callBedrockMultimodal')
      .mockRejectedValue(new Error('multimodal boom'))
    const callBedrock = vi
      .spyOn(generator as any, 'callBedrock')
      .mockResolvedValue('fallback description')

    await expect(generator.generateFromTicketKey('CPDEV-1')).resolves.toBe('fallback description')
    expect(callBedrockMultimodal).toHaveBeenCalledTimes(1)
    expect(buildEnhancedPrompt).toHaveBeenCalledWith(ticketData)
    expect(callBedrock).toHaveBeenCalledWith('TEXT_ONLY_PROMPT')
  })

  it('does not mark image attachments reviewed when multimodal generation falls back', async () => {
    const ticketData = {
      issue: {
        key: 'CPDEV-5',
        fields: {
          summary: 'Fallback image review',
          status: { name: 'Open' },
          issuetype: { name: 'Story' },
        },
      },
      descriptionMarkdown: 'description',
      comments: [],
      attachments: [
        {
          id: 'img-1',
          filename: 'mockup.png',
          mimeType: 'image/png',
          size: 4,
        },
      ],
      textAttachments: [],
      imageAttachments: [
        {
          id: 'img-1',
          filename: 'mockup.png',
          mimeType: 'image/png',
          base64Data: 'ZmFrZQ==',
          originalSize: 4,
        },
      ],
    } as any

    createJiraClientMock.mockReturnValue({
      fetchTicketData: vi.fn().mockResolvedValue(ticketData),
      fetchDocxAttachmentEvidence: vi.fn().mockResolvedValue([]),
    })

    const generator = new TaskDescriptionGenerator({
      jiraBaseUrl: 'https://mhkjira.atlassian.net',
      jiraUsername: 'devai@mhk.com',
      jiraToken: 'token',
    })
    vi.spyOn(generator as any, 'callBedrockMultimodal').mockRejectedValue(
      new Error('multimodal boom'),
    )
    vi.spyOn(generator as any, 'callBedrock').mockResolvedValue(
      'fallback description',
    )

    const payload = await generator.generateTaskPayloadFromTicketKey('CPDEV-5')

    expect(payload.taskDescription).toContain('## Attachment Review Reference')
    expect(payload.taskDescription).toContain('### Reviewed Attachments\n- None')
    expect(payload.taskDescription).toContain('`mockup.png`')
    expect(payload.taskDescription).toContain(
      'image was downloaded but multimodal review was unavailable; metadata only',
    )
    expect(payload.taskDescription).not.toContain(
      'image sent to multimodal task-summary pass',
    )
  })

  it('marks only images actually sent to multimodal review as reviewed', async () => {
    const images = Array.from({ length: 11 }, (_, index) => ({
      id: `img-${index}`,
      filename: `image-${index}.png`,
      mimeType: 'image/png',
      base64Data: 'ZmFrZQ==',
      originalSize: 4,
    }))
    const ticketData = {
      issue: {
        key: 'CPDEV-6',
        fields: {
          summary: 'Many images',
          status: { name: 'Open' },
          issuetype: { name: 'Story' },
        },
      },
      descriptionMarkdown: 'description',
      comments: [],
      attachments: images.map((image) => ({
        id: image.id,
        filename: image.filename,
        mimeType: image.mimeType,
        size: image.originalSize,
      })),
      textAttachments: [],
      imageAttachments: images,
    } as any

    createJiraClientMock.mockReturnValue({
      fetchTicketData: vi.fn().mockResolvedValue(ticketData),
      fetchDocxAttachmentEvidence: vi.fn().mockResolvedValue([]),
    })

    const generator = new TaskDescriptionGenerator({
      jiraBaseUrl: 'https://mhkjira.atlassian.net',
      jiraUsername: 'devai@mhk.com',
      jiraToken: 'token',
    })
    vi.spyOn(generator as any, 'callBedrockMultimodal').mockResolvedValue(
      'generated with images',
    )

    const payload = await generator.generateTaskPayloadFromTicketKey('CPDEV-6')

    expect(payload.taskDescription).toContain('`image-0.png`')
    expect(payload.taskDescription).toContain(
      'image sent to multimodal task-summary pass',
    )
    expect(payload.taskDescription).toContain('`image-10.png`')
    expect(payload.taskDescription).toContain(
      'image was downloaded but omitted from multimodal review due to image limit; metadata only',
    )
  })

  it('generates a task payload with structured ticket evidence from the same Jira fetch', async () => {
    const ticketData = {
      issue: {
        key: 'CPDEV-2',
        fields: {
          summary: 'Planner should see comments',
          issuetype: { name: 'Story' },
          status: { name: 'Open' },
          priority: { name: 'High' },
          labels: ['PFOS'],
          components: [{ name: 'core-app' }],
          fixVersions: [{ name: '2026.07' }],
          reporter: { displayName: 'Reporter One' },
          assignee: { displayName: 'Assignee One' },
          created: '2026-06-01T10:00:00.000Z',
          updated: '2026-06-02T10:00:00.000Z',
        },
      },
      descriptionMarkdown: 'Description says update the service.',
      comments: [
        {
          id: '10001',
          author: 'Reviewer',
          created: '2026-06-02T11:00:00.000Z',
          bodyMarkdown: 'The real acceptance criteria is in this comment.',
        },
      ],
      attachments: [
        {
          id: 'att-1',
          filename: 'notes.md',
          mimeType: 'text/markdown',
          size: 44,
          created: '2026-06-02T12:00:00.000Z',
          author: { displayName: 'Reporter One' },
        },
        {
          id: 'att-2',
          filename: 'workflow.png',
          mimeType: 'image/png',
          size: 128,
          created: '2026-06-02T13:00:00.000Z',
        },
        {
          id: 'att-3',
          filename: 'requirements.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 256,
          created: '2026-06-02T14:00:00.000Z',
        },
        {
          id: 'att-4',
          filename: 'AULTC Report Format.xlsx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 25058,
          created: '2026-06-02T15:00:00.000Z',
        },
      ],
      textAttachments: [
        {
          id: 'att-1',
          filename: 'notes.md',
          mimeType: 'text/markdown',
          content: '# Notes\nUse the comment acceptance criteria.',
          size: 42,
        },
      ],
      imageAttachments: [
        {
          id: 'att-2',
          filename: 'workflow.png',
          mimeType: 'image/png',
          base64Data: 'ZmFrZQ==',
          originalSize: 4,
        },
      ],
    } as any

    createJiraClientMock.mockReturnValue({
      fetchTicketData: vi.fn().mockResolvedValue(ticketData),
      fetchDocxAttachmentEvidence: vi.fn().mockResolvedValue([
        {
          id: 'att-3',
          filename: 'requirements.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          content: 'DOCX requirement text',
          size: 21,
          extractionStatus: 'included',
        },
      ]),
    })

    const generator = new TaskDescriptionGenerator({
      jiraBaseUrl: 'https://mhkjira.atlassian.net',
      jiraUsername: 'devai@mhk.com',
      jiraToken: 'token',
    })
    vi.spyOn(generator as any, 'callBedrockMultimodal').mockResolvedValue(
      'generated task description',
    )

    const payload = await generator.generateTaskPayloadFromTicketKey('CPDEV-2')

    expect(payload.taskDescription).toContain('generated task description')
    expect(payload.taskDescription).toContain('## Attachment Review Reference')
    expect(payload.taskDescription).toContain('### Reviewed Attachments')
    expect(payload.taskDescription).toContain('`requirements.docx`')
    expect(payload.taskDescription).toContain(
      'DOCX text extracted and included in ticket evidence',
    )
    expect(payload.taskDescription).toContain('### Not Reviewed / Metadata Only')
    expect(payload.taskDescription).toContain('`AULTC Report Format.xlsx`')
    expect(payload.taskDescription).toContain(
      'unsupported spreadsheet attachment; metadata only',
    )
    expect(payload.ticketEvidence).toMatchObject({
      schemaVersion: 'ticket-evidence.v1',
      jiraKey: 'CPDEV-2',
      issue: {
        summary: 'Planner should see comments',
        issueType: 'Story',
      },
      descriptionMarkdown: 'Description says update the service.',
      comments: [
        expect.objectContaining({
          id: '10001',
          bodyMarkdown: 'The real acceptance criteria is in this comment.',
        }),
      ],
      stats: {
        commentCount: 1,
        attachmentCount: 4,
        extractedAttachmentCount: 3,
        imageAttachmentCount: 1,
      },
    })
    expect(payload.ticketEvidence.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: 'notes.md',
          extractionStatus: 'included',
          extractedText: '# Notes\nUse the comment acceptance criteria.',
        }),
        expect.objectContaining({
          filename: 'workflow.png',
          extractionStatus: 'included',
          imageDigest: expect.stringContaining('workflow.png'),
        }),
        expect.objectContaining({
          filename: 'requirements.docx',
          extractionStatus: 'included',
          extractedText: 'DOCX requirement text',
        }),
        expect.objectContaining({
          filename: 'AULTC Report Format.xlsx',
          extractionStatus: 'metadata_only',
          warning: 'Unsupported or skipped attachment; metadata only.',
        }),
      ]),
    )
  })

  it('matches extracted attachment content by Jira attachment id when filenames repeat', async () => {
    const ticketData = {
      issue: {
        key: 'CPDEV-3',
        fields: {
          summary: 'Duplicate attachment names',
          status: { name: 'Open' },
          issuetype: { name: 'Story' },
        },
      },
      descriptionMarkdown: 'Two attachments share a filename.',
      comments: [],
      attachments: [
        {
          id: 'att-1',
          filename: 'requirements.md',
          mimeType: 'text/markdown',
          size: 10,
        },
        {
          id: 'att-2',
          filename: 'requirements.md',
          mimeType: 'text/markdown',
          size: 10,
        },
      ],
      textAttachments: [
        {
          id: 'att-1',
          filename: 'requirements.md',
          mimeType: 'text/markdown',
          content: 'First attachment requirement',
          size: 28,
        },
        {
          id: 'att-2',
          filename: 'requirements.md',
          mimeType: 'text/markdown',
          content: 'Second attachment requirement',
          size: 29,
        },
      ],
      imageAttachments: [],
    } as any

    createJiraClientMock.mockReturnValue({
      fetchTicketData: vi.fn().mockResolvedValue(ticketData),
      fetchDocxAttachmentEvidence: vi.fn().mockResolvedValue([]),
    })

    const generator = new TaskDescriptionGenerator({
      jiraBaseUrl: 'https://mhkjira.atlassian.net',
      jiraUsername: 'devai@mhk.com',
      jiraToken: 'token',
    })
    vi.spyOn(generator as any, 'callBedrock').mockResolvedValue(
      'generated task description',
    )

    const payload = await generator.generateTaskPayloadFromTicketKey('CPDEV-3')

    expect(payload.ticketEvidence.attachments).toEqual([
      expect.objectContaining({
        id: 'att-1',
        filename: 'requirements.md',
        extractedText: 'First attachment requirement',
      }),
      expect.objectContaining({
        id: 'att-2',
        filename: 'requirements.md',
        extractedText: 'Second attachment requirement',
      }),
    ])
  })

  it('does not match duplicate filename content to Jira attachments that have unmatched ids', async () => {
    const ticketData = {
      issue: {
        key: 'CPDEV-4',
        fields: {
          summary: 'Duplicate attachment names with missing extraction ids',
          status: { name: 'Open' },
          issuetype: { name: 'Story' },
        },
      },
      descriptionMarkdown: 'Two id-bearing attachments share a filename.',
      comments: [],
      attachments: [
        {
          id: 'att-1',
          filename: 'requirements.md',
          mimeType: 'text/markdown',
          size: 10,
        },
        {
          id: 'att-2',
          filename: 'requirements.md',
          mimeType: 'text/markdown',
          size: 10,
        },
        {
          filename: 'requirements.md',
          mimeType: 'text/markdown',
          size: 10,
        },
      ],
      textAttachments: [
        {
          filename: 'requirements.md',
          mimeType: 'text/markdown',
          content: 'Filename fallback requirement',
          size: 29,
        },
      ],
      imageAttachments: [],
    } as any

    createJiraClientMock.mockReturnValue({
      fetchTicketData: vi.fn().mockResolvedValue(ticketData),
      fetchDocxAttachmentEvidence: vi.fn().mockResolvedValue([]),
    })

    const generator = new TaskDescriptionGenerator({
      jiraBaseUrl: 'https://mhkjira.atlassian.net',
      jiraUsername: 'devai@mhk.com',
      jiraToken: 'token',
    })
    vi.spyOn(generator as any, 'callBedrock').mockResolvedValue(
      'generated task description',
    )

    const payload = await generator.generateTaskPayloadFromTicketKey('CPDEV-4')

    expect(payload.ticketEvidence.attachments).toEqual([
      expect.objectContaining({
        id: 'att-1',
        filename: 'requirements.md',
        extractionStatus: 'metadata_only',
      }),
      expect.objectContaining({
        id: 'att-2',
        filename: 'requirements.md',
        extractionStatus: 'metadata_only',
      }),
      expect.objectContaining({
        filename: 'requirements.md',
        extractionStatus: 'included',
        extractedText: 'Filename fallback requirement',
      }),
    ])
  })
})
