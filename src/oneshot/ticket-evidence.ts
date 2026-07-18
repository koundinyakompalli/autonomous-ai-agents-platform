import type { WorkspaceArtifactFile } from './workspace-artifacts.js'

export const TICKET_EVIDENCE_SCHEMA_VERSION = 'ticket-evidence.v1' as const

export interface TicketEvidenceStats {
  commentCount: number
  attachmentCount: number
  extractedAttachmentCount: number
  imageAttachmentCount: number
  warningCount: number
}

export interface TicketEvidenceRef {
  schemaVersion: typeof TICKET_EVIDENCE_SCHEMA_VERSION
  bucket: string
  key: string
  stats?: TicketEvidenceStats
}

export type TicketEvidenceExtractionStatus =
  | 'included'
  | 'metadata_only'
  | 'failed'

export interface TicketEvidenceIssue {
  summary?: string
  issueType?: string
  status?: string
  priority?: string
  resolution?: string
  labels?: string[]
  components?: string[]
  fixVersions?: string[]
  reporter?: string
  assignee?: string
  created?: string
  updated?: string
  parent?: { key?: string; summary?: string }
  subtasks?: Array<{ key?: string; summary?: string; status?: string }>
  links?: string[]
}

export interface TicketEvidenceComment {
  id: string
  author?: string
  created: string
  bodyMarkdown: string
}

export interface TicketEvidenceAttachment {
  id?: string
  filename: string
  mimeType?: string
  size?: number
  created?: string
  author?: string
  extractionStatus: TicketEvidenceExtractionStatus
  extractedText?: string
  imageDigest?: string
  warning?: string
}

export interface TicketEvidenceV1 {
  schemaVersion: typeof TICKET_EVIDENCE_SCHEMA_VERSION
  jiraKey: string
  capturedAt: string
  issue: TicketEvidenceIssue
  descriptionMarkdown: string
  comments: TicketEvidenceComment[]
  attachments: TicketEvidenceAttachment[]
  warnings: string[]
  stats: TicketEvidenceStats
}

export function deriveTicketEvidenceKey(taskDescriptionKey: string): string {
  if (taskDescriptionKey.endsWith('.md')) {
    return taskDescriptionKey.replace(/\.md$/, '.ticket-evidence.v1.json')
  }
  return `${taskDescriptionKey}.ticket-evidence.v1.json`
}

export function buildTicketEvidenceStats(
  evidence: Pick<TicketEvidenceV1, 'comments' | 'attachments' | 'warnings'>,
): TicketEvidenceStats {
  return {
    commentCount: evidence.comments.length,
    attachmentCount: evidence.attachments.length,
    extractedAttachmentCount: evidence.attachments.filter(
      (attachment) => attachment.extractionStatus === 'included',
    ).length,
    imageAttachmentCount: evidence.attachments.filter((attachment) =>
      (attachment.mimeType ?? '').toLowerCase().startsWith('image/'),
    ).length,
    warningCount: evidence.warnings.length,
  }
}

export function isTicketEvidenceStats(value: unknown): value is TicketEvidenceStats {
  if (!value || typeof value !== 'object') {
    return false
  }
  const stats = value as Record<string, unknown>
  const isNonNegativeInteger = (count: unknown): count is number =>
    typeof count === 'number' && Number.isInteger(count) && count >= 0
  return [
    stats.commentCount,
    stats.attachmentCount,
    stats.extractedAttachmentCount,
    stats.imageAttachmentCount,
    stats.warningCount,
  ].every(isNonNegativeInteger)
}

export function publicTicketEvidenceRef(
  ref: TicketEvidenceRef | null | undefined,
): Omit<TicketEvidenceRef, 'stats'> | null {
  if (!ref?.bucket || !ref.key || !isTicketEvidenceStats(ref.stats)) {
    return null
  }
  return {
    schemaVersion: TICKET_EVIDENCE_SCHEMA_VERSION,
    bucket: ref.bucket,
    key: ref.key,
  }
}

export function compactTicketEvidenceMetadata(
  ref: TicketEvidenceRef | null | undefined,
): Record<string, unknown> {
  const stats = isTicketEvidenceStats(ref?.stats) ? ref.stats : undefined
  return {
    present: Boolean(ref?.bucket && ref.key && stats),
    comment_count: stats?.commentCount ?? 0,
    attachment_count: stats?.attachmentCount ?? 0,
    extracted_attachment_count: stats?.extractedAttachmentCount ?? 0,
    image_attachment_count: stats?.imageAttachmentCount ?? 0,
    warning_count: stats?.warningCount ?? 0,
  }
}

function safeEvidenceFilename(filename: string): string {
  const safe = filename
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${safe || 'attachment'}.md`
}

function safeEvidenceToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'attachment'
}

function attachmentSidecarFilename(attachment: TicketEvidenceAttachment): string {
  const filename = safeEvidenceFilename(attachment.filename)
  return attachment.id
    ? `${safeEvidenceToken(attachment.id)}-${filename}`
    : filename
}

function renderIssueMarkdown(evidence: TicketEvidenceV1): string {
  const issue = evidence.issue
  return [
    `# ${evidence.jiraKey}: ${issue.summary ?? '(No summary)'}`,
    '',
    `- Type: ${issue.issueType ?? 'unknown'}`,
    `- Status: ${issue.status ?? 'unknown'}`,
    `- Priority: ${issue.priority ?? 'unknown'}`,
    `- Resolution: ${issue.resolution ?? 'unresolved'}`,
    `- Labels: ${(issue.labels ?? []).join(', ') || 'none'}`,
    `- Components: ${(issue.components ?? []).join(', ') || 'none'}`,
    `- Fix versions: ${(issue.fixVersions ?? []).join(', ') || 'none'}`,
    `- Reporter: ${issue.reporter ?? 'unknown'}`,
    `- Assignee: ${issue.assignee ?? 'unassigned'}`,
    `- Created: ${issue.created ?? 'unknown'}`,
    `- Updated: ${issue.updated ?? 'unknown'}`,
    issue.parent
      ? `- Parent: ${issue.parent.key ?? 'unknown'} ${issue.parent.summary ?? ''}`.trim()
      : '',
    '',
    '## Description',
    '',
    evidence.descriptionMarkdown || '(No description provided)',
    '',
    '## Related Issues',
    '',
    ...(issue.links?.length ? issue.links.map((link) => `- ${link}`) : ['(No linked issues)']),
    '',
    '## Subtasks',
    '',
    ...(issue.subtasks?.length
      ? issue.subtasks.map(
          (subtask) =>
            `- [${subtask.status ?? 'unknown'}] ${subtask.key ?? 'unknown'}: ${subtask.summary ?? ''}`,
        )
      : ['(No subtasks)']),
  ]
    .filter((line) => line !== null)
    .join('\n')
}

function renderCommentsMarkdown(evidence: TicketEvidenceV1): string {
  if (evidence.comments.length === 0) {
    return '# Ticket Comments\n\n(No comments)'
  }
  return [
    '# Ticket Comments',
    '',
    ...evidence.comments.map((comment, index) =>
      [
        `## Comment ${index + 1}: ${comment.id}`,
        '',
        `- Author: ${comment.author ?? 'unknown'}`,
        `- Created: ${comment.created}`,
        '',
        comment.bodyMarkdown || '(Empty comment)',
      ].join('\n'),
    ),
  ].join('\n\n---\n\n')
}

function renderAttachmentsIndex(evidence: TicketEvidenceV1): string {
  if (evidence.attachments.length === 0) {
    return '# Ticket Attachments\n\n(No attachments)'
  }
  return [
    '# Ticket Attachments',
    '',
    ...evidence.attachments.map((attachment) => {
      const lines = [
        `## ${attachment.filename}`,
        '',
        `- Status: ${attachment.extractionStatus}`,
        `- MIME type: ${attachment.mimeType ?? 'unknown'}`,
        `- Size: ${attachment.size ?? 'unknown'}`,
        `- Created: ${attachment.created ?? 'unknown'}`,
        `- Author: ${attachment.author ?? 'unknown'}`,
      ]
      if (attachment.extractedText) {
        lines.push(`- Extracted sidecar: attachments/${attachmentSidecarFilename(attachment)}`)
      }
      if (attachment.imageDigest) {
        lines.push('', attachment.imageDigest)
      }
      if (attachment.warning) {
        lines.push('', `Warning: ${attachment.warning}`)
      }
      return lines.join('\n')
    }),
  ].join('\n\n---\n\n')
}

function renderEvidenceIndex(evidence: TicketEvidenceV1): string {
  return [
    `# Ticket Evidence Index: ${evidence.jiraKey}`,
    '',
    `Captured: ${evidence.capturedAt}`,
    '',
    '## Sidecars',
    '',
    '- `ticket.md`: Jira metadata, description, parent/subtasks, and related issue metadata.',
    `- \`comments.md\`: ${evidence.stats.commentCount} ticket comment(s).`,
    `- \`attachments.md\`: ${evidence.stats.attachmentCount} attachment metadata row(s).`,
    '- `attachments/*.md`: extracted text for supported attachments.',
    '- `ticket-evidence.v1.json`: structured evidence packet.',
    '',
    '## Counts',
    '',
    `- Comments: ${evidence.stats.commentCount}`,
    `- Attachments: ${evidence.stats.attachmentCount}`,
    `- Extracted attachments: ${evidence.stats.extractedAttachmentCount}`,
    `- Images: ${evidence.stats.imageAttachmentCount}`,
    `- Warnings: ${evidence.stats.warningCount}`,
    '',
    evidence.warnings.length ? '## Evidence Gaps' : '',
    ...evidence.warnings.map((warning) => `- ${warning}`),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function renderTicketEvidenceSidecars(
  evidence: TicketEvidenceV1,
): WorkspaceArtifactFile[] {
  const sidecars: WorkspaceArtifactFile[] = [
    {
      fileName: 'ticket-evidence/index.md',
      body: renderEvidenceIndex(evidence),
      format: 'md',
    },
    {
      fileName: 'ticket-evidence/ticket.md',
      body: renderIssueMarkdown(evidence),
      format: 'md',
    },
    {
      fileName: 'ticket-evidence/comments.md',
      body: renderCommentsMarkdown(evidence),
      format: 'md',
    },
    {
      fileName: 'ticket-evidence/attachments.md',
      body: renderAttachmentsIndex(evidence),
      format: 'md',
    },
  ]

  for (const attachment of evidence.attachments) {
    if (!attachment.extractedText) {
      continue
    }
    sidecars.push({
      fileName: `ticket-evidence/attachments/${attachmentSidecarFilename(attachment)}`,
      body: [
        `# Attachment: ${attachment.filename}`,
        '',
        `- MIME type: ${attachment.mimeType ?? 'unknown'}`,
        `- Size: ${attachment.size ?? 'unknown'}`,
        '',
        '## Extracted Text',
        '',
        attachment.extractedText,
      ].join('\n'),
      format: 'md',
    })
  }

  sidecars.push({
    fileName: 'ticket-evidence/ticket-evidence.v1.json',
    body: evidence,
    format: 'json',
  })
  return sidecars
}

export function renderTicketEvidencePromptSection(input: {
  evidence: TicketEvidenceV1
  evidenceRootRelativePath: string
}): string {
  const { evidence, evidenceRootRelativePath } = input
  return [
    '## Ticket Evidence',
    '',
    `Full target-ticket evidence was materialized under \`${evidenceRootRelativePath}\`.`,
    `- Index: \`${evidenceRootRelativePath}/index.md\``,
    `- Ticket: \`${evidenceRootRelativePath}/ticket.md\``,
    `- Comments: \`${evidenceRootRelativePath}/comments.md\` (${evidence.stats.commentCount})`,
    `- Attachments: \`${evidenceRootRelativePath}/attachments.md\` (${evidence.stats.attachmentCount}, extracted ${evidence.stats.extractedAttachmentCount})`,
    `- Structured JSON: \`${evidenceRootRelativePath}/ticket-evidence.v1.json\``,
    '',
    'Read the ticket evidence sidecars before relying on ticket requirements, comments, or attachments. Treat warnings as evidence gaps and keep producing the structured OneShot plan.',
  ].join('\n')
}
