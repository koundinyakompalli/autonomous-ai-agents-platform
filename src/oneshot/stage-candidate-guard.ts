import type { Logger } from "pino";
import type { OneShotQueueMessage } from "./contracts.js";
import type { OneShotCandidateVersionRecord } from "./database/candidate-versions.js";
import type { OneShotDatabase } from "./database/index.js";
import type { OneShotPublisher } from "./publisher.js";
import { candidateShaMismatchCounter } from "./telemetry/metrics.js";
import type { OneShotArtifact, OneShotRun, OneShotState } from "./types.js";

type CandidateRunFields = Pick<
  OneShotRun,
  | "id"
  | "workspace_mode"
  | "jira_key"
  | "state"
  | "current_implementation_version"
  | "current_implementation_commit_sha"
>;

export type CandidateShaGuardResult =
  | {
      action: "continue";
      candidateSha: string | null;
      legacyUnpinned: boolean;
    }
  | {
      action: "drop_republished";
    }
  | {
      action: "fail";
      reason: "candidate_sha_integrity_error";
      message: string;
      metadata: Record<string, unknown>;
    };

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function implementationArtifactSha(artifact: OneShotArtifact | null): string | null {
  return stringValue(artifact?.metadata_json?.implementationCommitSha);
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function candidateMetadata(input: {
  payload: OneShotQueueMessage;
  run: CandidateRunFields;
  artifactSha: string | null;
  currentCandidate?: OneShotCandidateVersionRecord | null;
  messageId?: string;
  receiveCount: number;
}): Record<string, unknown> {
  return {
    reason: "candidate_sha_contract",
    messageId: input.messageId ?? null,
    receiveCount: input.receiveCount,
    stage: input.payload.stage,
    version: input.payload.version,
    payloadImplementationCommitSha:
      input.payload.expected_implementation_commit_sha ?? null,
    payloadImplementationVersion:
      input.payload.expected_implementation_version ?? null,
    currentImplementationVersion: input.run.current_implementation_version,
    currentImplementationCommitSha: input.run.current_implementation_commit_sha,
    artifactImplementationCommitSha: input.artifactSha,
    candidateTableVersion: input.currentCandidate?.candidateVersion ?? null,
    candidateTableCommitSha: input.currentCandidate?.candidateCommitSha ?? null,
    candidateTableStatus: input.currentCandidate?.status ?? null,
  };
}

async function loadCurrentCandidateContext(input: {
  run: CandidateRunFields;
  payload: OneShotQueueMessage;
  oneShotDb: OneShotDatabase;
  messageId?: string;
  receiveCount: number;
}): Promise<{
  artifactSha: string | null;
  currentCandidate: OneShotCandidateVersionRecord | null;
  targetFiles: string[];
  metadata: Record<string, unknown>;
}> {
  const implementationVersion = input.run.current_implementation_version;
  const implementationArtifact = implementationVersion
    ? await input.oneShotDb.artifacts.getArtifact(
        input.run.id,
        "implementation",
        implementationVersion,
      )
    : null;
  const artifactSha = implementationArtifactSha(implementationArtifact);
  const targetFiles = stringArrayValue(
    implementationArtifact?.metadata_json?.changedFiles,
  );
  const currentCandidate =
    await input.oneShotDb.candidateVersions.getCurrentCandidate(input.run.id);
  const metadata = candidateMetadata({
    payload: input.payload,
    run: input.run,
    artifactSha,
    currentCandidate,
    messageId: input.messageId,
    receiveCount: input.receiveCount,
  });
  return { artifactSha, currentCandidate, targetFiles, metadata };
}

function v2CandidateIntegrityFailure(input: {
  metadata: Record<string, unknown>;
  detail: string;
}): CandidateShaGuardResult {
  return {
    action: "fail",
    reason: "candidate_sha_integrity_error",
    message: `Candidate SHA integrity check failed: ${input.detail}`,
    metadata: {
      ...input.metadata,
      reason: "candidate_sha_integrity_error",
      integrityFailureDetail: input.detail,
    },
  };
}

function v2CandidateTableAgrees(input: {
  run: CandidateRunFields;
  artifactSha: string | null;
  currentCandidate: OneShotCandidateVersionRecord | null;
}): boolean {
  return Boolean(
    input.currentCandidate &&
      input.currentCandidate.status === "current" &&
      input.currentCandidate.candidateVersion === input.run.current_implementation_version &&
      input.currentCandidate.candidateCommitSha === input.run.current_implementation_commit_sha &&
      input.artifactSha === input.currentCandidate.candidateCommitSha,
  );
}

export async function evaluateCandidateShaGuard(input: {
  run: CandidateRunFields;
  payload: OneShotQueueMessage;
  oneShotDb: OneShotDatabase;
  publisher: OneShotPublisher;
  logger: Logger;
  messageId?: string;
  receiveCount: number;
}): Promise<CandidateShaGuardResult> {
  const payloadSha = input.payload.expected_implementation_commit_sha ?? null;
  const payloadVersion = input.payload.expected_implementation_version ?? null;

  let { artifactSha, currentCandidate, targetFiles, metadata } =
    await loadCurrentCandidateContext(input);

  if (!currentCandidate) {
    const currentVersion = input.run.current_implementation_version;
    const currentSha = input.run.current_implementation_commit_sha;
    if (currentVersion && currentSha && artifactSha === currentSha) {
      const backfilled =
        await input.oneShotDb.candidateVersions.backfillCurrentCandidate({
          oneshotRunId: input.run.id,
          candidateVersion: currentVersion,
          candidateCommitSha: currentSha,
          targetFiles,
          metadata: {
            source: "stage_candidate_guard_backfill",
            stage: input.payload.stage,
            messageId: input.messageId ?? null,
          },
        });
      if (backfilled) {
        input.logger.info(
          {
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            stage: input.payload.stage,
            candidateVersion: currentVersion,
            candidateCommitSha: currentSha,
          },
          "Backfilled missing v2 current candidate row from implementation artifact",
        );
        ({ artifactSha, currentCandidate, metadata } =
          await loadCurrentCandidateContext(input));
      }
    }
  }

  if (!currentCandidate) {
    return v2CandidateIntegrityFailure({
      metadata,
      detail: "v2 run has no current candidate-version row.",
    });
  }

  if (!v2CandidateTableAgrees({ run: input.run, artifactSha, currentCandidate })) {
    return v2CandidateIntegrityFailure({
      metadata,
      detail:
        "v2 candidate-version table, run state, and implementation artifact do not agree.",
    });
  }

  const payloadMatchesCurrentCandidate =
    payloadSha === currentCandidate.candidateCommitSha &&
    payloadVersion === currentCandidate.candidateVersion;

  if (!payloadMatchesCurrentCandidate) {
    candidateShaMismatchCounter.add(1, {
      stage: input.payload.stage,
      reason: !payloadSha
        ? "missing_payload_sha"
        : payloadSha !== currentCandidate.candidateCommitSha
          ? "sha_mismatch"
          : "version_mismatch",
    });
    const dedupeToken = `candidate-mismatch-republish:${payloadSha ?? "missing"}:${currentCandidate.candidateCommitSha}:${payloadVersion ?? "legacy"}:${currentCandidate.candidateVersion}:${input.messageId ?? Date.now()}`;
    input.logger.info(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        stage: input.payload.stage,
        version: input.payload.version,
        payloadImplementationCommitSha: payloadSha,
        payloadImplementationVersion: payloadVersion,
        candidateTableCommitSha: currentCandidate.candidateCommitSha,
        candidateTableVersion: currentCandidate.candidateVersion,
        dedupeToken,
      },
      "Dropping stale v2 downstream message and republishing with current candidate table row",
    );
    await input.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "candidate_sha_mismatch_dropped",
        from_state: input.payload.expected_state,
        to_state: input.run.state,
        stage: input.payload.stage,
        metadata_json: {
          ...metadata,
          reason: !payloadSha
            ? "candidate_sha_missing_v2"
            : "candidate_sha_mismatch",
          requestedRepublish: true,
          dedupeToken,
        },
      })
      .catch((error: unknown) => {
        input.logger.warn(
          {
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            stage: input.payload.stage,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to persist v2 candidate-SHA audit event; continuing",
        );
      });

    await input.publisher.publishStageMessage(
      input.run.id,
      input.payload.stage,
      input.payload.version,
      input.payload.expected_state,
      input.payload.revision,
      {
        dedupeToken,
        expectedImplementationCommitSha: currentCandidate.candidateCommitSha,
        expectedImplementationVersion: currentCandidate.candidateVersion,
      },
    );

    return { action: "drop_republished" };
  }

  return {
    action: "continue",
    candidateSha: currentCandidate.candidateCommitSha,
    legacyUnpinned: false,
  };
}

export async function recordCandidateShaIntegrityFailure(input: {
  runId: number;
  fromState: OneShotState;
  toState: "failed";
  stage: OneShotQueueMessage["stage"];
  metadata: Record<string, unknown>;
  oneShotDb: OneShotDatabase;
  logger: Logger;
}): Promise<void> {
  await input.oneShotDb.events
    .createEvent({
      oneshot_run_id: input.runId,
      event_type: "state_transition",
      from_state: input.fromState,
      to_state: input.toState,
      stage: input.stage,
      metadata_json: input.metadata,
    })
    .catch((error: unknown) => {
      input.logger.warn(
        {
          runId: input.runId,
          stage: input.stage,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to persist candidate-SHA integrity failure event",
      );
    });
}
