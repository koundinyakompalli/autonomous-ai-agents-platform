import { describe, expect, it, vi } from "vitest";
import { evaluateCandidateShaGuard } from "./stage-candidate-guard.js";
import type { OneShotQueueMessage } from "./contracts.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

function buildPayload(
  overrides: Partial<OneShotQueueMessage> = {},
): OneShotQueueMessage {
  return {
    run_id: 84,
    stage: "code_review",
    version: 2,
    expected_state: "queued_for_code_review",
    revision: false,
    emitted_at: "2026-05-05T12:00:00.000Z",
    ...overrides,
  };
}

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 84,
    workspace_mode: "v2",
    jira_key: "CPDEV-21090",
    state: "queued_for_code_review",
    current_implementation_version: 3,
    current_implementation_commit_sha:
      "2222222222222222222222222222222222222222",
    ...overrides,
  };
}

function buildCandidate(overrides: Record<string, unknown> = {}) {
  return {
    oneshotRunId: 84,
    candidateVersion: 3,
    candidateCommitSha: "2222222222222222222222222222222222222222",
    previousCandidateCommitSha: "1111111111111111111111111111111111111111",
    status: "current",
    supersededByCandidateVersion: null,
    targetFiles: [],
    metadata: null,
    finalizedAt: new Date("2026-05-05T12:00:00.000Z"),
    ...overrides,
  };
}

function buildDeps(
  artifactSha: string | null,
  candidate: Record<string, unknown> | null = buildCandidate(),
) {
  let currentCandidate = candidate;
  const oneShotDb = {
    artifacts: {
      getArtifact: vi.fn().mockResolvedValue(
        artifactSha
          ? {
              metadata_json: {
                implementationCommitSha: artifactSha,
              },
            }
          : null,
      ),
    },
    events: {
      createEvent: vi.fn().mockResolvedValue(undefined),
    },
    candidateVersions: {
      getCurrentCandidate: vi.fn().mockImplementation(() =>
        Promise.resolve(currentCandidate),
      ),
      getCandidate: vi.fn().mockImplementation(() =>
        Promise.resolve(currentCandidate),
      ),
      backfillCurrentCandidate: vi.fn().mockImplementation(
        async (input: {
          candidateVersion: number;
          candidateCommitSha: string;
          targetFiles: string[];
          metadata: Record<string, unknown>;
        }) => {
          currentCandidate = buildCandidate({
            candidateVersion: input.candidateVersion,
            candidateCommitSha: input.candidateCommitSha,
            targetFiles: input.targetFiles,
            metadata: input.metadata,
          });
          return true;
        },
      ),
    },
  };
  const publisher = {
    publishStageMessage: vi.fn().mockResolvedValue(undefined),
  };
  return { oneShotDb, publisher };
}

describe("evaluateCandidateShaGuard", () => {
  it("republishes unpinned v2 downstream messages with the current candidate", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun() as never,
      payload: buildPayload(),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      messageId: "message-v2",
      receiveCount: 1,
    });

    expect(result).toEqual({ action: "drop_republished" });
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      2,
      "queued_for_code_review",
      false,
      {
        dedupeToken:
          "candidate-mismatch-republish:missing:2222222222222222222222222222222222222222:legacy:3:message-v2",
        expectedImplementationCommitSha:
          "2222222222222222222222222222222222222222",
        expectedImplementationVersion: 3,
      },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "candidate_sha_mismatch_dropped",
        metadata_json: expect.objectContaining({
          reason: "candidate_sha_missing_v2",
          candidateTableCommitSha:
            "2222222222222222222222222222222222222222",
          candidateTableVersion: 3,
        }),
      }),
    );
  });

  it("drops stale candidate messages and republishes with a unique FIFO token", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun() as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "1111111111111111111111111111111111111111",
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      messageId: "message-2",
      receiveCount: 2,
    });

    expect(result).toEqual({ action: "drop_republished" });
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      2,
      "queued_for_code_review",
      false,
      {
        dedupeToken:
          "candidate-mismatch-republish:1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:legacy:3:message-2",
        expectedImplementationCommitSha:
          "2222222222222222222222222222222222222222",
        expectedImplementationVersion: 3,
      },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "candidate_sha_mismatch_dropped",
      }),
    );
  });

  it("allows matching payload, run, and implementation artifact SHAs", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun() as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
        expected_implementation_version: 3,
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      receiveCount: 1,
    });

    expect(result).toEqual({
      action: "continue",
      candidateSha: "2222222222222222222222222222222222222222",
      legacyUnpinned: false,
    });
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("allows v2 only when payload, run, artifact, and candidate table all agree", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun() as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
        expected_implementation_version: 3,
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      receiveCount: 1,
    });

    expect(result).toEqual({
      action: "continue",
      candidateSha: "2222222222222222222222222222222222222222",
      legacyUnpinned: false,
    });
    expect(oneShotDb.candidateVersions.getCurrentCandidate).toHaveBeenCalledWith(84);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("drops stale candidate-version messages and republishes the current candidate", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun() as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
        expected_implementation_version: 2,
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      messageId: "message-3",
      receiveCount: 2,
    });

    expect(result).toEqual({ action: "drop_republished" });
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      2,
      "queued_for_code_review",
      false,
      {
        dedupeToken:
          "candidate-mismatch-republish:2222222222222222222222222222222222222222:2222222222222222222222222222222222222222:2:3:message-3",
        expectedImplementationCommitSha:
          "2222222222222222222222222222222222222222",
        expectedImplementationVersion: 3,
      },
    );
  });

  it("republishes v2 downstream messages that have a SHA but no candidate version", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun() as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      messageId: "message-v2-sha-only",
      receiveCount: 1,
    });

    expect(result).toEqual({ action: "drop_republished" });
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      2,
      "queued_for_code_review",
      false,
      {
        dedupeToken:
          "candidate-mismatch-republish:2222222222222222222222222222222222222222:2222222222222222222222222222222222222222:legacy:3:message-v2-sha-only",
        expectedImplementationCommitSha:
          "2222222222222222222222222222222222222222",
        expectedImplementationVersion: 3,
      },
    );
  });

  it("fails v2 messages when run state has a current SHA but no candidate version", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun({
        current_implementation_version: null,
      }) as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      messageId: "message-v2-missing-version",
      receiveCount: 1,
    });

    expect(result).toMatchObject({
      action: "fail",
      reason: "candidate_sha_integrity_error",
    });
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("backfills and allows v2 messages when the current candidate row is missing but run and artifact agree", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
      null,
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun() as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
        expected_implementation_version: 3,
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      receiveCount: 1,
    });

    expect(result).toEqual({
      action: "continue",
      candidateSha: "2222222222222222222222222222222222222222",
      legacyUnpinned: false,
    });
    expect(oneShotDb.candidateVersions.backfillCurrentCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        oneshotRunId: 84,
        candidateVersion: 3,
        candidateCommitSha: "2222222222222222222222222222222222222222",
        metadata: expect.objectContaining({
          source: "stage_candidate_guard_backfill",
          stage: "code_review",
        }),
      }),
    );
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("backfills and allows messages when a dirty run row has a blank workspace mode", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
      null,
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun({ workspace_mode: "" }) as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
        expected_implementation_version: 3,
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      receiveCount: 1,
    });

    expect(result).toEqual({
      action: "continue",
      candidateSha: "2222222222222222222222222222222222222222",
      legacyUnpinned: false,
    });
    expect(oneShotDb.candidateVersions.getCurrentCandidate).toHaveBeenCalledWith(
      84,
    );
    expect(
      oneShotDb.candidateVersions.backfillCurrentCandidate,
    ).toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("fails v2 messages when candidate table disagrees with run state", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "2222222222222222222222222222222222222222",
      buildCandidate({
        candidateCommitSha: "3333333333333333333333333333333333333333",
      }),
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun() as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
        expected_implementation_version: 3,
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      receiveCount: 1,
    });

    expect(result).toMatchObject({
      action: "fail",
      reason: "candidate_sha_integrity_error",
      metadata: expect.objectContaining({
        candidateTableCommitSha:
          "3333333333333333333333333333333333333333",
      }),
    });
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("fails when the implementation artifact disagrees with run state", async () => {
    const { oneShotDb, publisher } = buildDeps(
      "3333333333333333333333333333333333333333",
    );

    const result = await evaluateCandidateShaGuard({
      run: buildRun() as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      receiveCount: 1,
    });

    expect(result).toMatchObject({
      action: "fail",
      reason: "candidate_sha_integrity_error",
    });
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("explains integrity failures when the run no longer has a candidate SHA", async () => {
    const { oneShotDb, publisher } = buildDeps(null);

    const result = await evaluateCandidateShaGuard({
      run: buildRun({
        current_implementation_commit_sha: null,
      }) as never,
      payload: buildPayload({
        expected_implementation_commit_sha:
          "2222222222222222222222222222222222222222",
      }),
      oneShotDb: oneShotDb as never,
      publisher: publisher as never,
      logger: logger as never,
      receiveCount: 1,
    });

    expect(result).toMatchObject({
      action: "fail",
      reason: "candidate_sha_integrity_error",
      message:
        "Candidate SHA integrity check failed: v2 candidate-version table, run state, and implementation artifact do not agree.",
      metadata: expect.objectContaining({
        payloadImplementationCommitSha:
          "2222222222222222222222222222222222222222",
        currentImplementationCommitSha: null,
        integrityFailureDetail:
          "v2 candidate-version table, run state, and implementation artifact do not agree.",
      }),
    });
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });
});
