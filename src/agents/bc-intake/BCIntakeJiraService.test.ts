import fs from 'fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BCIntakeJiraService } from './BCIntakeJiraService.js';

describe('BCIntakeJiraService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads the first supported DOCX attachment', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: {
              attachment: [
                {
                  id: '1',
                  filename: 'upgrade-intake.doc',
                  mimeType: 'application/msword',
                  size: 10,
                  content: 'https://example.com/legacy.doc',
                },
                {
                  id: '2',
                  filename: 'upgrade-intake.docx',
                  mimeType:
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  size: 20,
                  content: 'https://example.com/intake.docx',
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const jira = new BCIntakeJiraService(
      'https://medhokapps.atlassian.net',
      'user@example.com',
      'token',
    );

    const filePath = await jira.downloadWordAttachment('BC-123');

    expect(filePath).toBeTruthy();
    expect(filePath).toMatch(/\.docx$/);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://example.com/intake.docx',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
        }),
      }),
    );

    const stats = await fs.stat(filePath!);
    expect(stats.size).toBeGreaterThan(0);

    await fs.unlink(filePath!);
  });

  it('returns null when only legacy .doc attachments are present', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fields: {
            attachment: [
              {
                id: '1',
                filename: 'upgrade-intake.doc',
                mimeType: 'application/msword',
                size: 10,
                content: 'https://example.com/legacy.doc',
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    vi.stubGlobal('fetch', fetchMock);

    const jira = new BCIntakeJiraService(
      'https://medhokapps.atlassian.net',
      'user@example.com',
      'token',
    );

    await expect(jira.downloadWordAttachment('BC-123')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
