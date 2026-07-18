import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { JiraClient } from "../orchestrator/JiraClient.js";
import { createLogger } from "../utils/logger.js";
import {
  buildOneShotArtifactKey,
  type OneShotConsumerConfig,
} from "./config.js";
import type { OneShotDatabase } from "./database/index.js";
import { eventEmitFailureLogger } from "./event-emit.js";
import {
  resolveOneShotJiraCredentials,
  type OneShotJiraCredentials,
} from "./jira-credentials.js";
import {
  buildOneShotTraceArtifact,
  buildTraceJiraComment,
  renderTraceCsv,
  sectionCTestCases,
  verifyOneShotTraceArtifact,
  type OneShotTraceArtifact,
  type OneShotVerifyReport,
} from "./schema/trace-verify.js";
import type { OneShotPlan } from "./schema/plan.js";
import type { OneShotRun, OneShotState } from "./types.js";

const logger = createLogger("oneshot-trace-verify-runner");

interface RunTraceVerifyDeps {
  config: OneShotConsumerConfig;
  oneShotDb: OneShotDatabase;
  s3Client: S3Client;
  visibilityTimeoutSeconds: number;
  jiraCredentials?: OneShotJiraCredentials | null;
}

interface RunTraceVerifyInput {
  run: OneShotRun;
  plan: OneShotPlan;
  planVersion: number;
  ticketSummary?: string;
  stageStartedMs: number;
  eventStage: string;
  eventState: OneShotState;
  assertWorkspaceLease?: () => Promise<void>;
}

function observeVisibilityBudget(
  deps: RunTraceVerifyDeps,
  input: RunTraceVerifyInput,
  phase: "TRACE" | "VERIFY" | "JIRA_POST",
): void {
  const visibilityMs = deps.visibilityTimeoutSeconds * 1000;
  const elapsedMs = Date.now() - input.stageStartedMs;
  const remainingMs = visibilityMs - elapsedMs;
  const minimumRemainingMs = 60_000;
  if (remainingMs >= minimumRemainingMs) {
    return;
  }

  logger.warn(
    {
      runId: input.run.id,
      jiraKey: input.run.jira_key,
      stage: input.eventStage,
      phase,
      elapsedMs,
      remainingMs,
      visibilityMs,
      minimumRemainingMs,
    },
    "Stage static visibility budget is below threshold; continuing because the queue consumer heartbeat extends message visibility",
  );
}

async function getTraceJiraPostCompletion(
  deps: RunTraceVerifyDeps,
  runId: number,
  traceCsvKey: string,
): Promise<{
  attachmentCompleted: boolean;
  commentQueued: boolean;
  notificationId?: number;
}> {
  try {
    const events = await deps.oneShotDb.events.getEventsForRun(runId);
    const matchingEvents = events.filter(
      (event) =>
        event.event_type === "trace_jira_post_completed" &&
        event.metadata_json?.traceCsvS3Key === traceCsvKey,
    );

    let notificationId: number | undefined;
    for (const event of matchingEvents) {
      const recordedId = event.metadata_json?.notificationId;
      if (typeof recordedId === "number") notificationId = recordedId;
    }

    return {
      attachmentCompleted: matchingEvents.some(
        (event) => event.metadata_json?.attachmentStatus === "attached",
      ),
      commentQueued: matchingEvents.some(
        (event) => event.metadata_json?.commentStatus === "enqueued",
      ),
      notificationId,
    };
  } catch (error) {
    logger.warn(
      {
        runId,
        traceCsvKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Unable to check TRACE Jira post idempotency marker; proceeding with post attempt",
    );
    return { attachmentCompleted: false, commentQueued: false };
  }
}

async function recordTraceJiraPostCompleted(
  deps: RunTraceVerifyDeps,
  input: {
    runId: number;
    filename: string;
    traceCsvKey: string;
    eventStage: string;
    eventState: OneShotState;
    attachmentStatus: "attached" | "skipped" | "failed";
    commentStatus: "enqueued" | "failed";
    notificationId?: number;
    attachmentAlreadyCompleted?: boolean;
    commentAlreadyQueued?: boolean;
    attachmentError?: string;
    commentError?: string;
  },
): Promise<void> {
  try {
    await deps.oneShotDb.events.createEvent({
      oneshot_run_id: input.runId,
      event_type: "trace_jira_post_completed",
      from_state: input.eventState,
      to_state: input.eventState,
      stage: input.eventStage,
      metadata_json: {
        filename: input.filename,
        traceCsvS3Key: input.traceCsvKey,
        attachmentStatus: input.attachmentStatus,
        commentStatus: input.commentStatus,
        notificationId: input.notificationId,
        attachmentAlreadyCompleted: input.attachmentAlreadyCompleted,
        commentAlreadyQueued: input.commentAlreadyQueued,
        attachmentError: input.attachmentError,
        commentError: input.commentError,
      },
    });
  } catch (error) {
    logger.warn(
      {
        runId: input.runId,
        traceCsvKey: input.traceCsvKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to record TRACE Jira post idempotency marker",
    );
  }
}

async function postTraceToJira(
  deps: RunTraceVerifyDeps,
  input: {
    run: OneShotRun;
    trace: OneShotTraceArtifact;
    verify?: OneShotVerifyReport;
    csv: string;
    traceCsvKey: string;
    eventStage: string;
    eventState: OneShotState;
    skipAttachment?: boolean;
    skipComment?: boolean;
    existingNotificationId?: number;
  },
): Promise<void> {
  const filename = `test-cases-${input.run.jira_key}.csv`;
  const attachmentAlreadyCompleted = Boolean(input.skipAttachment);
  const commentAlreadyQueued = Boolean(input.skipComment);
  let attachmentStatus: "attached" | "skipped" | "failed" =
    attachmentAlreadyCompleted ? "attached" : "skipped";
  let attachmentError: string | undefined;
  let commentStatus: "enqueued" | "failed" = commentAlreadyQueued
    ? "enqueued"
    : "failed";
  let commentError: string | undefined;
  let notificationId: number | undefined = input.existingNotificationId;

  const jiraBaseUrl = process.env.JIRA_BASE_URL?.trim();
  const jiraCredentials =
    deps.jiraCredentials ??
    (await resolveOneShotJiraCredentials({
      fallbackUsername: process.env.JIRA_USERNAME,
      fallbackToken: process.env.JIRA_TOKEN,
    }));
  if (attachmentAlreadyCompleted) {
    logger.info(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        traceCsvKey: input.traceCsvKey,
      },
      "Skipping TRACE Jira attachment because it already completed",
    );
  } else if (jiraBaseUrl && jiraCredentials?.username && jiraCredentials.token) {
    try {
      const attachmentResult = await new JiraClient({
        baseUrl: jiraBaseUrl,
        username: jiraCredentials.username,
        token: jiraCredentials.token,
      }).attachFileToIssue(input.run.jira_key, filename, input.csv, "text/csv");
      if (attachmentResult.status === "attached") {
        attachmentStatus = "attached";
      } else {
        attachmentStatus = "skipped";
        attachmentError = attachmentResult.reason;
        deps.oneShotDb.events
          .createEvent({
            oneshot_run_id: input.run.id,
            event_type: "trace_jira_attachment_skipped",
            from_state: input.eventState,
            to_state: input.eventState,
            stage: input.eventStage,
            metadata_json: {
              filename,
              reason: attachmentResult.reason,
              traceCsvS3Key: input.traceCsvKey,
              credentialSource: jiraCredentials.source,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: input.run.id,
              eventType: "trace_jira_attachment_skipped",
              stage: input.eventStage,
            }),
          );
      }
    } catch (error) {
      attachmentStatus = "failed";
      attachmentError = error instanceof Error ? error.message : String(error);
      deps.oneShotDb.events
        .createEvent({
          oneshot_run_id: input.run.id,
          event_type: "trace_jira_attachment_failed",
          from_state: input.eventState,
          to_state: input.eventState,
          stage: input.eventStage,
          metadata_json: {
            filename,
            error: attachmentError,
            traceCsvS3Key: input.traceCsvKey,
            credentialSource: jiraCredentials.source,
          },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: input.run.id,
            eventType: "trace_jira_attachment_failed",
            stage: input.eventStage,
          }),
        );
    }
  } else {
    attachmentError =
      "Jira attachment skipped because Jira base URL or usable Jira credentials are not configured in the reviewer environment.";
    deps.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "trace_jira_attachment_skipped",
        from_state: input.eventState,
        to_state: input.eventState,
        stage: input.eventStage,
        metadata_json: {
          filename,
          reason: "missing_jira_credentials",
          traceCsvS3Key: input.traceCsvKey,
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: input.run.id,
          eventType: "trace_jira_attachment_skipped",
          stage: input.eventStage,
        }),
      );
  }

  if (commentAlreadyQueued) {
    logger.info(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        traceCsvKey: input.traceCsvKey,
        notificationId,
      },
      "Skipping TRACE Jira comment because it was already queued",
    );
  } else {
    try {
      notificationId = await deps.oneShotDb.notifications.createNotification({
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "progress_update",
        body_markdown: buildTraceJiraComment({
          trace: input.trace,
          verify: input.verify,
          csvS3Key: input.traceCsvKey,
          filename,
          attachmentStatus,
          attachmentError,
        }),
      });
      commentStatus = "enqueued";
    } catch (error) {
      commentError = error instanceof Error ? error.message : String(error);
      deps.oneShotDb.events
        .createEvent({
          oneshot_run_id: input.run.id,
          event_type: "trace_jira_comment_failed",
          from_state: input.eventState,
          to_state: input.eventState,
          stage: input.eventStage,
          metadata_json: {
            filename,
            error: commentError,
            traceCsvS3Key: input.traceCsvKey,
          },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: input.run.id,
            eventType: "trace_jira_comment_failed",
            stage: input.eventStage,
          }),
        );
    }
  }

  await recordTraceJiraPostCompleted(deps, {
    runId: input.run.id,
    filename,
    traceCsvKey: input.traceCsvKey,
    eventStage: input.eventStage,
    eventState: input.eventState,
    attachmentStatus,
    commentStatus,
    notificationId,
    attachmentAlreadyCompleted,
    commentAlreadyQueued,
    attachmentError,
    commentError,
  });
}

export async function runOneShotTraceVerify(
  deps: RunTraceVerifyDeps,
  input: RunTraceVerifyInput,
): Promise<{ trace?: OneShotTraceArtifact; verify?: OneShotVerifyReport }> {
  if (!deps.config.traceEnabled) {
    return {};
  }

  observeVisibilityBudget(deps, input, "TRACE");

  await input.assertWorkspaceLease?.();
  const trace = buildOneShotTraceArtifact({
    jiraKey: input.run.jira_key,
    planVersion: input.planVersion,
    plan: input.plan,
    ticketSummary: input.ticketSummary,
  });
  const csv = renderTraceCsv(trace);
  const traceKey = buildOneShotArtifactKey(
    deps.config,
    input.run.jira_key,
    input.run.id,
    "trace",
    input.planVersion,
  );
  const traceCsvKey = traceKey.replace(/test-cases\.json$/i, "test-cases.csv");
  const startedAt = new Date();

  await input.assertWorkspaceLease?.();
  await deps.s3Client.send(
    new PutObjectCommand({
      Bucket: deps.config.artifactBucket,
      Key: traceKey,
      Body: JSON.stringify(trace, null, 2),
      ContentType: "application/json",
    }),
  );
  await deps.s3Client.send(
    new PutObjectCommand({
      Bucket: deps.config.artifactBucket,
      Key: traceCsvKey,
      Body: csv,
      ContentType: "text/csv",
    }),
  );
  await deps.oneShotDb.artifacts.upsertArtifact({
    oneshot_run_id: input.run.id,
    stage: "trace",
    version: input.planVersion,
    status: trace.traceGuardrailResult.passed ? "completed" : "failed",
    s3_bucket: deps.config.artifactBucket,
    s3_key: traceKey,
    provider: "deterministic",
    model: "trace-port",
    metadata_json: {
      traceGuardrailResult: trace.traceGuardrailResult,
      acceptanceCriteriaCoverage: trace.acceptanceCriteriaCoverage,
      sectionCounts: {
        A: trace.sections.A.length,
        B: trace.sections.B.length,
        C: trace.sections.C.length,
      },
      csvS3Key: traceCsvKey,
      sectionCTestCaseIds: sectionCTestCases(trace).map(
        (testCase) => testCase.id,
      ),
    },
    started_at: startedAt,
    completed_at: new Date(),
  });

  deps.oneShotDb.events
    .createEvent({
      oneshot_run_id: input.run.id,
      event_type: "trace_generated",
      from_state: input.eventState,
      to_state: input.eventState,
      stage: input.eventStage,
      metadata_json: {
        version: input.planVersion,
        traceS3Key: traceKey,
        traceCsvS3Key: traceCsvKey,
        traceGuardrailResult: trace.traceGuardrailResult,
        acceptanceCriteriaCoverage: trace.acceptanceCriteriaCoverage,
      },
    })
    .catch(
      eventEmitFailureLogger({
        logger,
        runId: input.run.id,
        eventType: "trace_generated",
        stage: input.eventStage,
      }),
    );

  let verify: OneShotVerifyReport | undefined;
  let verifyKey: string | undefined;
  if (deps.config.verifyEnabled) {
    observeVisibilityBudget(deps, input, "VERIFY");
    verify = verifyOneShotTraceArtifact({
      trace,
      csv,
      mode: deps.config.verifyMode,
    });
    verifyKey = buildOneShotArtifactKey(
      deps.config,
      input.run.jira_key,
      input.run.id,
      "verify",
      input.planVersion,
    );
    await input.assertWorkspaceLease?.();
    await deps.s3Client.send(
      new PutObjectCommand({
        Bucket: deps.config.artifactBucket,
        Key: verifyKey,
        Body: JSON.stringify(verify, null, 2),
        ContentType: "application/json",
      }),
    );
    await deps.oneShotDb.artifacts.upsertArtifact({
      oneshot_run_id: input.run.id,
      stage: "verify",
      version: input.planVersion,
      status: "completed",
      s3_bucket: deps.config.artifactBucket,
      s3_key: verifyKey,
      provider: "deterministic",
      model: `verify-port:${verify.mode}`,
      metadata_json: {
        verifyGuardrailResult: verify.verifyGuardrailResult,
        recommendation: verify.recommendation,
        riskLevel: verify.riskLevel,
        acceptanceCriteriaCoverage: verify.acceptanceCriteriaCoverage,
        unverifiedClaims: verify.unverifiedClaims,
        degradedModeDisclaimers: verify.degradedModeDisclaimers,
        gapCount: verify.gaps.length,
        criticalGapCount: verify.gaps.filter(
          (gap) => gap.severity === "critical",
        ).length,
        highGapCount: verify.gaps.filter((gap) => gap.severity === "high")
          .length,
      },
      started_at: new Date(),
      completed_at: new Date(),
    });

    deps.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "verify_completed",
        from_state: input.eventState,
        to_state: input.eventState,
        stage: input.eventStage,
        metadata_json: {
          version: input.planVersion,
          verifyS3Key: verifyKey,
          recommendation: verify.recommendation,
          riskLevel: verify.riskLevel,
          verifyGuardrailResult: verify.verifyGuardrailResult,
          acceptanceCriteriaCoverage: verify.acceptanceCriteriaCoverage,
          unverifiedClaims: verify.unverifiedClaims,
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: input.run.id,
          eventType: "verify_completed",
          stage: input.eventStage,
        }),
      );
  }

  if (deps.config.tracePostToJira) {
    observeVisibilityBudget(deps, input, "JIRA_POST");
    const postCompletion = await getTraceJiraPostCompletion(
      deps,
      input.run.id,
      traceCsvKey,
    );
    if (postCompletion.attachmentCompleted && postCompletion.commentQueued) {
      logger.info(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          planVersion: input.planVersion,
          traceCsvKey,
        },
        "Skipping duplicate TRACE Jira post for previously completed plan version",
      );
    } else {
      await postTraceToJira(deps, {
        run: input.run,
        trace,
        verify,
        csv,
        traceCsvKey,
        eventStage: input.eventStage,
        eventState: input.eventState,
        skipAttachment: postCompletion.attachmentCompleted,
        skipComment: postCompletion.commentQueued,
        existingNotificationId: postCompletion.notificationId,
      });
    }
  }

  logger.info(
    {
      runId: input.run.id,
      jiraKey: input.run.jira_key,
      planVersion: input.planVersion,
      eventStage: input.eventStage,
      traceKey,
      traceCsvKey,
      verifyKey,
      verifyRecommendation: verify?.recommendation ?? "disabled",
    },
    "Completed TRACE and VERIFY artifacts",
  );

  return { trace, verify };
}
