import type {
  InvestigationEvidenceArtifact,
  InvestigationFinding,
} from "../types/investigation.js";

const LABELED_KEY_VALUE =
  /\b([A-Za-z][A-Za-z0-9_. -]{0,63})\s*[:=]\s*['"]?([^,'"\n)]{1,512}?)(?=\s+[A-Za-z][A-Za-z0-9_.-]{0,63}\s*[:=]|[,)'"\n]|$)/g;
const SECRET_KEY_NAME =
  /(?:password|passwd|pwd|secret|token|credential|privatekey|accesskey|sessiontoken|apikey|authkey|clientsecret|keystorepass|keystorepassword|truststorepass|truststorepassword)/i;
const PHI_KEY_NAME =
  /(?:memberid|memberno|subscriberid|personid|patientid|medicareno|medicareid|medicaidno|medicaidid|mbi|hicn|policynumber|mrn|firstname|lastname|fullname|dob|dateofbirth|ssn|email|phone|fax|address|city|zip)/i;
const SECURE_QUERY_PARAM =
  /([?&](?:password|passwd|pwd|secret|token|access[_.-]?key|session[_.-]?token|api[_.-]?key|auth[_.-]?key)=)[^&\s,'")]+/gi;
const LONG_IDENTIFIER = /\b\d{8,}\b/g;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE_NUMBER = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

const SENSITIVE_TERM =
  /(?:password|passwd|pwd|secret|token|credential|privatekey|accesskey|sessiontoken|apikey|authkey|clientsecret|ssn|dob|memberid|subscriberid|patientid|personid|mbi|hicn)/i;

export function redactInvestigationText(value: unknown): string {
  return String(value ?? "")
    .replace(LABELED_KEY_VALUE, (match, key: string) => {
      const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
      if (SECRET_KEY_NAME.test(normalizedKey)) return `${key}=[REDACTED_SECRET]`;
      if (PHI_KEY_NAME.test(normalizedKey)) return `${key}=[REDACTED_PHI]`;
      return match;
    })
    .replace(SECURE_QUERY_PARAM, "$1[REDACTED_SECRET]")
    .replace(EMAIL_ADDRESS, "[REDACTED_EMAIL]")
    .replace(SSN, "[REDACTED_SSN]")
    .replace(PHONE_NUMBER, "[REDACTED_PHONE]")
    .replace(LONG_IDENTIFIER, "[REDACTED_ID]");
}

export function extractPersistenceFailureColumns(text: string, limit = 16): string[] {
  const columns = new Set<string>();
  const source = redactInvestigationText(text);
  const patterns = [
    /\bdata too long for column\s+['"`]?([A-Za-z_][A-Za-z0-9_]*)/gi,
    /\bvalue too long[^\n]{0,160}\bcolumn\s+['"`]?([A-Za-z_][A-Za-z0-9_]*)/gi,
    /\bcolumn\s+['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?[^\n]{0,160}\b(?:truncat|too long|overflow)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const column = match[1]?.trim().toLowerCase();
      if (!column) continue;
      columns.add(column);
      if (columns.size >= limit) return Array.from(columns);
    }
  }
  return Array.from(columns);
}

export function extractInvestigationSignals(
  text: string,
  limit = 16,
): string[] {
  const signals = new Set<string>();
  const source = redactInvestigationText(text);
  for (const column of extractPersistenceFailureColumns(source, limit)) {
    signals.add(column);
  }
  const patterns = [
    /\b(?:data too long for column|value too long|string data right truncation|data truncation)\b/gi,
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?:Exception|Error)\b/g,
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?:Controller|Service|Processor|Batch|Job|Scheduler|Task|Command|Handler|Repository|Dao|DAO|Client|Utility|Util)\b/g,
    /\b[A-Za-z0-9][A-Za-z0-9.-]*(?:batch|job|skybot|runtime|app|web|host|server|node|instance)[A-Za-z0-9.-]*\.[A-Za-z0-9.-]+\b/gi,
    /\b[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]*\b/g,
    /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]{3,}\b/g,
    /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g,
    /\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+){2,}\b/g,
    /['"]([A-Z][A-Z0-9_]{3,})['"]/g,
    /\b[A-Za-z0-9_./-]+\.(?:jar|war|ear|sh|ksh|bat|cmd|properties|xml|yml|yaml|log)\b/g,
    /\b[A-Za-z0-9_./-]+\.(?:py|java|kt|js|mjs|cjs|ts|tsx|go|rb|cs)\b/g,
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]{4,120}/g,
    /\b(?:skybot|autosys|cron|batch|job)\s*(?:job|name|command|schedule|chain)?\s*[:=#-]?\s*[A-Za-z0-9_.-]{4,120}\b/gi,
    /\b[A-Za-z0-9_.-]+\.(?:url|uri|endpoint|host|path|enabled|allowed|timeout|baseUrl|serviceUrl|server|port)\b/gi,
    /\b(?:HTTP\s*)?[45]\d{2}\b/gi,
    /\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]{4,120}/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = normalizeSignal(match[1] || match[0]);
      if (!value || SENSITIVE_TERM.test(value)) {
        continue;
      }
      signals.add(value);
      if (signals.size >= limit) {
        return Array.from(signals);
      }
    }
  }

  return Array.from(signals);
}

export function extractEvidenceSearchTerms(
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
  limit = 32,
): string[] {
  const terms = new Set<string>();
  const add = (value: unknown) => {
    for (const signal of extractInvestigationSignals(String(value ?? ""), 8)) {
      terms.add(signal);
      if (terms.size >= limit) {
        return;
      }
    }
  };

  for (const finding of findings) {
    add(finding.title);
    add(finding.summary);
    add(boundedMetadataText(finding.metadata));
    if (terms.size >= limit) return Array.from(terms);
  }

  for (const artifact of evidence) {
    add(artifact.title);
    add(artifact.summary);
    add(boundedMetadataText(artifact.metadata));
    if (terms.size >= limit) return Array.from(terms);
  }

  return Array.from(terms);
}

function boundedMetadataText(value: unknown, maxChars = 100_000): string {
  const serialized = JSON.stringify(value ?? {});
  return serialized.length > maxChars ? serialized.slice(0, maxChars) : serialized;
}

export function hasRuntimeFailureEvidence(
  findings: InvestigationFinding[],
): boolean {
  return findings.some(
    (finding) =>
      finding.type === "runtime_log_error_evidence" ||
      /(?:exception|error|4\d\d|5\d\d|runtime|endpoint|config)/i.test(
        `${finding.title} ${finding.summary}`,
      ),
  );
}

function normalizeSignal(value: string): string {
  return value
    .trim()
    .replace(/^HTTP\s*/i, "")
    .replace(/[),.;\]]+$/, "")
    .slice(0, 140);
}
