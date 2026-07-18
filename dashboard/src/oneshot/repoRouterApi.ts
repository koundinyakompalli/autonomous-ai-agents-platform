export interface RepoRouterEvidence {
  id?: string;
  signal?: string;
  score?: number;
  detail?: string;
}

export interface RepoRouterConfirmationCandidate {
  repoId: number;
  repoName: string;
  score?: number;
  evidence?: RepoRouterEvidence[];
}

export interface RepoRouterConfirmationSummary {
  id: number;
  ticketId: string;
  taskManagementId: number | null;
  routerDecisionId: number | null;
  candidates: RepoRouterConfirmationCandidate[];
  evidence: RepoRouterEvidence[];
  jiraCommentId: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedRepo: { repoId: number; repoName: string | null } | null;
  resolutionSource: string | null;
  timeoutState: string;
  snapshotHash: string;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  return typeof payload.error === "string" ? payload.error : fallback;
}

export async function listRepoRouterConfirmations(): Promise<
  RepoRouterConfirmationSummary[]
> {
  const response = await fetch("/api/oneshot/repo-router/confirmations", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to load repo confirmations: ${response.status}`,
      ),
    );
  }
  const payload = (await response.json()) as {
    confirmations?: RepoRouterConfirmationSummary[];
  };
  return payload.confirmations ?? [];
}

export async function resolveRepoRouterConfirmation(
  confirmationId: number,
  repoId: number,
): Promise<void> {
  const response = await fetch(
    `/api/oneshot/repo-router/confirmations/${confirmationId}/resolve`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repoId }),
    },
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to resolve repo confirmation: ${response.status}`,
      ),
    );
  }
}
