/**
 * Harvey File Processor
 *
 * Downloads and extracts readable content from file attachments sent via Teams.
 *
 * Supported formats:
 *   Text    — .sql .txt .log .csv .json .yaml .xml .md .java .ts .js .py etc.
 *   PDF     — text extracted via pdf-parse
 *   Word    — .docx text extracted via mammoth
 *   Excel   — .xlsx/.xls converted to plain text via xlsx
 *   Images  — .png/.jpg described via Bedrock Claude vision
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('harvey-files');

const TEXT_EXTENSIONS = new Set([
  'sql', 'txt', 'log', 'csv', 'json', 'yaml', 'yml', 'xml',
  'md', 'properties', 'conf', 'sh', 'java', 'ts', 'js', 'py',
  'html', 'css', 'jsx', 'tsx', 'go', 'rb', 'php', 'tf', 'toml',
]);
const BINARY_EXTENSIONS: Record<string, 'pdf' | 'word' | 'excel' | 'image' | 'unsupported'> = {
  pdf:  'pdf',
  docx: 'word', doc: 'word',
  xlsx: 'excel', xls: 'excel',
  png:  'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};

export type FileProcessResult =
  | { ok: true;  content: string; name: string }
  | { ok: false; reason: string;  name: string };

export class FileProcessor {
  private bedrock: BedrockRuntimeClient;
  private modelId: string;

  constructor(region?: string, modelId?: string) {
    this.bedrock = new BedrockRuntimeClient({
      region: region || process.env.AWS_REGION || 'us-east-2',
    });
    this.modelId = modelId || process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
  }

  /**
   * Process a single Teams file attachment.
   * Downloads the file and extracts readable content based on format.
   */
  async process(attachment: any, taskHint?: string): Promise<FileProcessResult> {
    const name: string = attachment.name ?? 'attachment';
    const ext = name.split('.').pop()?.toLowerCase() ?? '';

    logger.info({ fileName: name, ext }, '[FILE_PROCESS] Processing attachment');

    // Get download URL
    const downloadUrl: string | undefined =
      (attachment.content as any)?.downloadUrl ?? attachment.contentUrl;

    if (!downloadUrl) {
      return { ok: false, reason: 'No download URL available', name };
    }

    // Fetch the raw bytes
    let buffer: Buffer;
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        return { ok: false, reason: `Download failed (HTTP ${response.status})`, name };
      }
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (err: any) {
      return { ok: false, reason: `Download error: ${err.message}`, name };
    }

    // Route based on extension
    if (TEXT_EXTENSIONS.has(ext)) {
      return this.processText(buffer, name);
    }

    const binaryType = BINARY_EXTENSIONS[ext];
    switch (binaryType) {
      case 'pdf':   return this.processPdf(buffer, name);
      case 'word':  return this.processWord(buffer, name);
      case 'excel': return this.processExcel(buffer, name);
      case 'image': return this.processImage(buffer, name, ext, taskHint);
      default:
        return {
          ok: false,
          reason: `Unsupported format (.${ext}). Supported: text files, PDF, Word, Excel, PNG, JPG.`,
          name,
        };
    }
  }

  // =========================================================================
  // Format handlers
  // =========================================================================

  private processText(buffer: Buffer, name: string): FileProcessResult {
    const content = buffer.toString('utf-8');
    const truncated = this.truncate(content, 50000);
    return { ok: true, content: truncated, name };
  }

  private async processPdf(buffer: Buffer, name: string): Promise<FileProcessResult> {
    try {
      // Dynamic import — pdf-parse is CJS and may need this pattern in ESM
      const pdfParse = (await import('pdf-parse')) as any;
      const parseFn = pdfParse.default ?? pdfParse;
      const data = await parseFn(buffer);
      const text = data.text?.trim() ?? '';
      if (!text) return { ok: false, reason: 'PDF appears to be image-only (no extractable text)', name };
      return { ok: true, content: this.truncate(text, 50000), name };
    } catch (err: any) {
      return { ok: false, reason: `PDF extraction failed: ${err.message}`, name };
    }
  }

  private async processWord(buffer: Buffer, name: string): Promise<FileProcessResult> {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value?.trim() ?? '';
      if (!text) return { ok: false, reason: 'Word document appears to be empty', name };
      return { ok: true, content: this.truncate(text, 50000), name };
    } catch (err: any) {
      return { ok: false, reason: `Word extraction failed: ${err.message}`, name };
    }
  }

  private async processExcel(buffer: Buffer, name: string): Promise<FileProcessResult> {
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const parts: string[] = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (csv.trim()) {
          parts.push(`## Sheet: ${sheetName}\n${csv}`);
        }
      }

      const content = parts.join('\n\n');
      if (!content.trim()) return { ok: false, reason: 'Excel file appears to be empty', name };
      return { ok: true, content: this.truncate(content, 50000), name };
    } catch (err: any) {
      return { ok: false, reason: `Excel extraction failed: ${err.message}`, name };
    }
  }

  private async processImage(
    buffer: Buffer,
    name: string,
    ext: string,
    taskHint?: string,
  ): Promise<FileProcessResult> {
    try {
      const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'png' ? 'image/png'
        : ext === 'gif' ? 'image/gif'
        : 'image/webp';

      const base64 = buffer.toString('base64');

      const prompt = taskHint
        ? `The user uploaded this image in the context of: "${taskHint}". Describe all relevant content — text, data, diagrams, error messages, code snippets, UI elements — that would help an AI agent understand and act on this image.`
        : `Describe all content in this image that would be useful for a software engineering task — include any visible text, code, error messages, data, diagrams, or UI elements verbatim.`;

      const response = await this.bedrock.send(
        new ConverseCommand({
          modelId: this.modelId,
          messages: [{
            role: 'user',
            content: [
              { image: { format: mediaType.split('/')[1] as any, source: { bytes: buffer } } },
              { text: prompt },
            ],
          }],
          inferenceConfig: { maxTokens: 1024, temperature: 0 },
        }),
      );

      const description = (response.output?.message?.content ?? [])
        .filter((b: any) => b.text !== undefined)
        .map((b: any) => b.text!)
        .join('');

      if (!description) return { ok: false, reason: 'Could not extract content from image', name };
      return { ok: true, content: `[Image: ${name}]\n${description}`, name };
    } catch (err: any) {
      return { ok: false, reason: `Image processing failed: ${err.message}`, name };
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars) + `\n...(truncated — original is ${text.length.toLocaleString()} chars)`;
  }
}
