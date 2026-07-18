/**
 * Shared server-side error-summary parser — currently used by
 * `oneshotAnalytics.ts` to cluster 24h failures by reason on the Failures tab.
 *
 * The Detail modal still mirrors this logic on the client because the browser
 * bundle cannot import server-only modules directly. Keep the implementations
 * aligned so the cluster headline and modal error title do not drift apart.
 */

export interface ParsedErrorSummary {
  /** HTTP-ish status code if the summary begins with `NNN `, else `null`. */
  code: string | null;
  /**
   * Short headline suitable for a title — first sentence of the text after
   * the code, or the whole thing if there's no full-stop.
   */
  heading: string;
  /** Full (post-code) body for the subtitle / paragraph slot. */
  body: string;
}

export function parseErrorSummary(summary: string): ParsedErrorSummary {
  const match = summary.match(/^(\d{3})\s+(.+)$/s);
  if (!match) {
    const firstSentence = summary.split(/(?<=\.)\s+/, 1)[0]?.replace(/\.$/, "");
    return {
      code: null,
      heading: firstSentence || "Error",
      body: summary,
    };
  }
  const [, code, rest] = match;
  const firstSentence = rest.split(/(?<=\.)\s+/, 1)[0]?.replace(/\.$/, "");
  return {
    code,
    heading: firstSentence || rest,
    body: rest,
  };
}

/**
 * Stable cluster signature derived from a parsed headline. Strips trailing
 * punctuation and lowercases so `"Too Many Requests."` and
 * `"too many requests"` hash identically.
 */
export function clusterSignature(parsed: ParsedErrorSummary): string {
  const key = `${parsed.code ?? "—"}|${parsed.heading.toLowerCase().replace(/[\s\p{P}]+$/u, "")}`;
  return key;
}
