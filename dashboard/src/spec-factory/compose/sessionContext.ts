import type {
  ComposeContextStatus,
  ComposeSessionSummary,
} from "./composeTypes.js";

function finiteContextVersion(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatContextStatus(
  status: ComposeContextStatus | null | undefined,
): string | null {
  if (!status) return null;
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatContextVersion(
  session: Pick<
    ComposeSessionSummary,
    "latestContextVersion" | "contextStatus"
  >,
): string | null {
  const version = finiteContextVersion(session.latestContextVersion);
  if (version !== null) return `Context v${version}`;
  const status = formatContextStatus(session.contextStatus);
  return status ? `Context ${status.toLowerCase()}` : null;
}

export function formatSessionContextDescription(
  session: Pick<
    ComposeSessionSummary,
    "latestContextVersion" | "contextStatus"
  >,
): string | null {
  const version = finiteContextVersion(session.latestContextVersion);
  const status = session.contextStatus ?? null;
  if (version !== null && status) return `context v${version} · ${status}`;
  if (version !== null) return `context v${version}`;
  return status ? `context ${status}` : null;
}
