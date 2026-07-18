import { isIP } from "node:net";

export interface PublicHttpsUrlPolicy {
  label: string;
  allowedHosts?: string[];
  allowedHostSuffixes?: string[];
}

const YOUTUBE_HOST_SUFFIXES = [
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
];

function normalizeHost(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) {
    return lower.slice(1, -1);
  }
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

function hostMatches(hostname: string, expected: string): boolean {
  const normalized = normalizeHost(hostname);
  const suffix = normalizeHost(expected);
  return normalized === suffix || normalized.endsWith(`.${suffix}`);
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (
    nums.some(
      (num, index) =>
        !Number.isInteger(num) ||
        num < 0 ||
        num > 255 ||
        String(num) !== parts[index],
    )
  ) {
    return null;
  }
  return nums;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ipv4Parts(ip);
  if (!parts) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (/^f[cd]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;

  const maybeIpv4 = normalized.split(":").at(-1) ?? "";
  if (maybeIpv4.includes(".") && isBlockedIpv4(maybeIpv4)) {
    return true;
  }

  return false;
}

function isBlockedIp(hostname: string): boolean {
  const host = normalizeHost(hostname);
  const family = isIP(host);
  if (family === 4) return isBlockedIpv4(host);
  if (family === 6) return isBlockedIpv6(host);
  return false;
}

function configuredHostSuffixes(envValue: string | undefined): string[] {
  return (envValue ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function confluenceAllowedHostSuffixes(): string[] {
  return configuredHostSuffixes(
    process.env.COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES,
  );
}

export function normalizePublicHttpsUrl(
  raw: string,
  policy: PublicHttpsUrlPolicy,
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${policy.label} url is required`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${policy.label} url must be a valid URL`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${policy.label} url must use https`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${policy.label} url must not include credentials`);
  }

  const hostname = normalizeHost(parsed.hostname);
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error(`${policy.label} url host must be public`);
  }

  if (isBlockedIp(hostname)) {
    throw new Error(`${policy.label} url host must be public`);
  }

  const allowedHosts = policy.allowedHosts ?? [];
  const allowedSuffixes = policy.allowedHostSuffixes ?? [];
  const hasHostPolicy = allowedHosts.length > 0 || allowedSuffixes.length > 0;
  const allowed =
    allowedHosts.some((host) => normalizeHost(host) === hostname) ||
    allowedSuffixes.some((suffix) => hostMatches(hostname, suffix));
  if (hasHostPolicy && !allowed) {
    throw new Error(`${policy.label} url host is not allowed`);
  }

  parsed.hostname = hostname;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

export function normalizeYoutubeUrl(raw: string): string {
  return normalizePublicHttpsUrl(raw, {
    label: "YouTube",
    allowedHostSuffixes: YOUTUBE_HOST_SUFFIXES,
  });
}

export function normalizeConfluenceUrl(raw: string): string {
  return normalizePublicHttpsUrl(raw, {
    label: "Confluence",
    allowedHostSuffixes: confluenceAllowedHostSuffixes(),
  });
}
