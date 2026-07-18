import { normalizePublicHttpsUrl } from "./compose-url-policy.js";
import { bufferToBlobPart } from "../utils/blob.js";

type FetchFn = typeof fetch;

export class MarkitdownClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async convertFile(input: {
    bytes: Buffer;
    filename: string;
    mimeType: string | null;
  }): Promise<string> {
    const form = new FormData();
    const blob = new Blob([bufferToBlobPart(input.bytes)], {
      type: input.mimeType ?? "application/octet-stream",
    });
    form.append("file", blob, input.filename);
    form.append("filename", input.filename);
    return this.post(form);
  }

  async convertUrl(url: string): Promise<string> {
    const safeUrl = normalizePublicHttpsUrl(url, { label: "Conversion" });
    const form = new FormData();
    form.append("url", safeUrl);
    return this.post(form);
  }

  private async post(form: FormData): Promise<string> {
    const response = await this.fetchFn(`${this.baseUrl}/convert`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { detail?: string };
        detail = body?.detail ? `: ${body.detail}` : "";
      } catch {
        detail = "";
      }
      throw new Error(
        `markitdown convert failed (${response.status})${detail}`,
      );
    }
    const body = (await response.json()) as { markdown?: string };
    return body.markdown ?? "";
  }
}
