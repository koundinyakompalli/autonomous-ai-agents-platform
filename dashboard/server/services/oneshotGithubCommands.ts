import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import { createLogger } from "../../../src/utils/logger.js";
import {
  fetchPullRequestForCommand,
  fetchRepositoryPermissionForUser,
  postIssueComment,
  type GitHubIssueCommentResult,
  type GitHubPullRequestForCommand,
} from "../../../src/oneshot/github.js";
import {
  OneShotDatabase,
  type OneShotQueryExecutor,
} from "../../../src/oneshot/database/index.js";
import {
  OneShotGitHubCommandsDB,
  type CreateOneShotGitHubCommandInput,
  type OneShotGitHubCommandRecord,
} from "../../../src/oneshot/database/github-commands.js";
import { OneShotPublisher } from "../../../src/oneshot/publisher.js";

const logger = createLogger("dashboard-oneshot-github-commands");

function asOneShotQueryExecutor(
  executor: mysql.Pool | mysql.PoolConnection,
): OneShotQueryExecutor {
  return executor as unknown as OneShotQueryExecutor;
}

type CommandRun = {
  id: number;
  jira_key: string;
  state: string;
  current_plan_version: number | null;
  current_pr_url: string | null;
  current_implementation_branch: string | null;
  current_implementation_commit_sha: string | null;
  current_implementation_version: number | null;
  final_disposition: string | null;
};

export type OneShotGithubCommandEnvelope = {
  deliveryId: string;
  event: string;
  payload: unknown;
};

export type OneShotGithubCommandStoreAcceptInput = CreateOneShotGitHubCommandInput & {
  pullRequest: GitHubPullRequestForCommand;
};

export type OneShotGithubCommandStoreAcceptResult = {
  command: Pick<
    OneShotGitHubCommandRecord,
    "id" | "deliveryId" | "status" | "requestedPlanVersion" | "responseCommentUrl"
  >;
  run?: CommandRun;
  requestedPlanVersion?: number | null;
  candidateVersion?: number | null;
  queued: boolean;
  responseKind: "accepted" | "coalesced" | "rejected";
  reason?: string;
};

export interface OneShotGithubCommandStore {
  getCommandByDeliveryId(deliveryId: string): Promise<OneShotGitHubCommandRecord | null>;
  rejectCommand(input: CreateOneShotGitHubCommandInput): Promise<OneShotGitHubCommandRecord>;
  acceptOrCoalesceCommand(
    input: OneShotGithubCommandStoreAcceptInput,
  ): Promise<OneShotGithubCommandStoreAcceptResult>;
  updateCommandResponse(
    id: number,
    input: {
      responseCommentUrl?: string | null;
      status?: OneShotGitHubCommandRecord["status"];
      rejectionReason?: string | null;
    },
  ): Promise<void>;
}

type ProcessDeps = {
  store?: OneShotGithubCommandStore;
  fetchPullRequest?: typeof fetchPullRequestForCommand;
  fetchRepositoryPermissionForUser?: typeof fetchRepositoryPermissionForUser;
  postIssueComment?: typeof postIssueComment;
  publisher?: Pick<OneShotPublisher, "publishStageMessage">;
};

type ParsedWebhookCommand = {
  repositoryFullName: string;
  owner: string;
  repo: string;
  pullNumber: number;
  commentId: string;
  commentUrl: string | null;
  requesterLogin: string;
  requesterType: string | null;
  authorAssociation: string | null;
  commandText: string;
};

export type OneShotGithubCommandProcessResult = {
  ignored?: boolean;
  status:
    | "accepted"
    | "coalesced"
    | "duplicate"
    | "rejected"
    | "ignored";
  reason?: string;
  oneshotRunId?: number;
  requestedPlanVersion?: number | null;
  responseCommentUrl?: string | null;
  commentError?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function parseOneShotCommandText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const match = trimmed.match(/^\/oneshot(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  return (match[1] ?? "").trim();
}

function parseWebhookCommand(payload: unknown): ParsedWebhookCommand | null {
  const root = asRecord(payload);
  if (root.action !== "created") {
    return null;
  }
  const issue = asRecord(root.issue);
  if (!issue.pull_request || typeof issue.number !== "number") {
    return null;
  }
  const comment = asRecord(root.comment);
  const commandText = parseOneShotCommandText(comment.body);
  if (commandText === null) {
    return null;
  }
  const repository = asRecord(root.repository);
  const repositoryFullName = typeof repository.full_name === "string"
    ? repository.full_name
    : "";
  const [owner, repo] = repositoryFullName.split("/");
  const user = asRecord(comment.user);
  const requesterLogin = typeof user.login === "string" ? user.login : "";
  if (!owner || !repo || !requesterLogin) {
    return null;
  }
  return {
    repositoryFullName,
    owner,
    repo,
    pullNumber: Number(issue.number),
    commentId: String(comment.id ?? ""),
    commentUrl:
      typeof comment.html_url === "string"
        ? comment.html_url
        : typeof comment.url === "string"
          ? comment.url
          : null,
    requesterLogin,
    requesterType: typeof user.type === "string" ? user.type : null,
    authorAssociation:
      typeof comment.author_association === "string"
        ? comment.author_association
        : null,
    commandText,
  };
}

function writerPermission(permission: string): boolean {
  return permission === "write" || permission === "maintain" || permission === "admin";
}

function buildBaseCommandInput(
  parsed: ParsedWebhookCommand,
  deliveryId: string,
  status: CreateOneShotGitHubCommandInput["status"],
  extra: Partial<CreateOneShotGitHubCommandInput> = {},
): CreateOneShotGitHubCommandInput {
  return {
    deliveryId,
    repositoryFullName: parsed.repositoryFullName,
    pullNumber: parsed.pullNumber,
    commentId: parsed.commentId,
    commentUrl: parsed.commentUrl,
    requesterLogin: parsed.requesterLogin,
    authorAssociation: parsed.authorAssociation,
    commandText: parsed.commandText,
    status,
    ...extra,
  };
}

function rejectionBody(reason: string): string {
  switch (reason) {
    case "unauthorized":
      return "I can only run `/oneshot` commands from users with write access to this repository.";
    case "closed_pr":
      return "I can only replan open OneShot pull requests.";
    case "bot_comment":
      return "Ignoring `/oneshot` from bot accounts to avoid command loops.";
    case "missing_run":
      return "I could not find an open OneShot run mapped to this pull request.";
    case "unsupported_state":
      return "I can only replan a OneShot PR while the run is `pr_open`, or add feedback while it is still `queued_for_planning`.";
    default:
      return `I could not queue this /oneshot request: ${reason}.`;
  }
}

function acknowledgementBody(input: {
  kind: "accepted" | "coalesced";
  runId?: number;
  requestedPlanVersion?: number | null;
}): string {
  const runLabel = input.runId ? `run-${input.runId}` : "this OneShot run";
  if (input.kind === "coalesced") {
    return `added this /oneshot request to the queued planning revision for ${runLabel}.`;
  }
  const versionText = input.requestedPlanVersion
    ? ` (plan v${input.requestedPlanVersion})`
    : "";
  return `queued a OneShot planning revision for ${runLabel}${versionText}.`;
}

async function postBestEffortComment(input: {
  parsed: ParsedWebhookCommand;
  body: string;
  postIssueCommentFn: typeof postIssueComment;
}): Promise<{ result?: GitHubIssueCommentResult; error?: string }> {
  try {
    const result = await input.postIssueCommentFn({
      owner: input.parsed.owner,
      repo: input.parsed.repo,
      issueNumber: input.parsed.pullNumber,
      body: input.body,
    });
    return { result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      {
        repository: input.parsed.repositoryFullName,
        pullNumber: input.parsed.pullNumber,
        error: message,
      },
      "Failed to post GitHub /oneshot acknowledgement",
    );
    return { error: message };
  }
}

function duplicateAcknowledgementBody(
  existing: OneShotGitHubCommandRecord,
): string | null {
  if (existing.status === "accepted" || existing.status === "coalesced") {
    return acknowledgementBody({
      kind: existing.status,
      runId: existing.oneshotRunId ?? undefined,
      requestedPlanVersion: existing.requestedPlanVersion,
    });
  }
  if (existing.status === "rejected") {
    return rejectionBody(existing.rejectionReason ?? "duplicate_delivery");
  }
  return null;
}

async function recoverDuplicateDelivery(input: {
  existing: OneShotGitHubCommandRecord;
  parsed: ParsedWebhookCommand;
  deliveryId: string;
  store: OneShotGithubCommandStore;
  postIssueCommentFn: typeof postIssueComment;
  publisher?: Pick<OneShotPublisher, "publishStageMessage">;
}): Promise<OneShotGithubCommandProcessResult> {
  let responseCommentUrl = input.existing.responseCommentUrl;
  let commentError: string | undefined;

  if (!responseCommentUrl) {
    if (
      input.existing.status === "accepted" &&
      input.existing.oneshotRunId &&
      input.existing.requestedPlanVersion
    ) {
      const publisher = input.publisher ?? new OneShotPublisher();
      await publisher.publishStageMessage(
        input.existing.oneshotRunId,
        "planning",
        input.existing.requestedPlanVersion,
        "queued_for_planning",
        true,
        {
          dedupeToken: `github-command-${input.deliveryId}`,
        },
      );
    }

    const body = duplicateAcknowledgementBody(input.existing);
    if (body) {
      const posted = await postBestEffortComment({
        parsed: input.parsed,
        body,
        postIssueCommentFn: input.postIssueCommentFn,
      });
      responseCommentUrl = posted.result?.htmlUrl ?? null;
      commentError = posted.error;
      if (responseCommentUrl) {
        await input.store.updateCommandResponse(input.existing.id, {
          responseCommentUrl,
        });
      }
    }
  }

  return {
    status: "duplicate",
    reason: "duplicate_delivery",
    oneshotRunId: input.existing.oneshotRunId ?? undefined,
    requestedPlanVersion: input.existing.requestedPlanVersion,
    responseCommentUrl,
    commentError,
  };
}

export async function processOneShotGithubCommand(
  envelope: OneShotGithubCommandEnvelope,
  deps: ProcessDeps = {},
): Promise<OneShotGithubCommandProcessResult> {
  if (envelope.event !== "issue_comment") {
    return { ignored: true, status: "ignored", reason: "unsupported_event" };
  }

  const parsed = parseWebhookCommand(envelope.payload);
  if (!parsed) {
    return { ignored: true, status: "ignored" };
  }

  const store = deps.store ?? new MysqlOneShotGithubCommandStore();
  const existing = await store.getCommandByDeliveryId(envelope.deliveryId);
  if (existing) {
    return recoverDuplicateDelivery({
      existing,
      parsed,
      deliveryId: envelope.deliveryId,
      store,
      postIssueCommentFn: deps.postIssueComment ?? postIssueComment,
      publisher: deps.publisher,
    });
  }

  const postIssueCommentFn = deps.postIssueComment ?? postIssueComment;

  if (parsed.requesterType === "Bot" || parsed.requesterLogin.endsWith("[bot]")) {
    const command = await store.rejectCommand(buildBaseCommandInput(
      parsed,
      envelope.deliveryId,
      "rejected",
      { rejectionReason: "bot_comment" },
    ));
    const posted = await postBestEffortComment({
      parsed,
      body: rejectionBody("bot_comment"),
      postIssueCommentFn,
    });
    if (posted.result?.htmlUrl) {
      await store.updateCommandResponse(command.id, {
        responseCommentUrl: posted.result.htmlUrl,
      });
    }
    return {
      status: "rejected",
      reason: "bot_comment",
      responseCommentUrl: posted.result?.htmlUrl,
      commentError: posted.error,
    };
  }

  const fetchPullRequest = deps.fetchPullRequest ?? fetchPullRequestForCommand;
  const pullRequest = await fetchPullRequest({
    owner: parsed.owner,
    repo: parsed.repo,
    pullNumber: parsed.pullNumber,
  });
  if (pullRequest.state !== "open") {
    const command = await store.rejectCommand(buildBaseCommandInput(
      parsed,
      envelope.deliveryId,
      "rejected",
      { rejectionReason: "closed_pr" },
    ));
    const posted = await postBestEffortComment({
      parsed,
      body: rejectionBody("closed_pr"),
      postIssueCommentFn,
    });
    if (posted.result?.htmlUrl) {
      await store.updateCommandResponse(command.id, {
        responseCommentUrl: posted.result.htmlUrl,
      });
    }
    return {
      status: "rejected",
      reason: "closed_pr",
      responseCommentUrl: posted.result?.htmlUrl,
      commentError: posted.error,
    };
  }

  const fetchPermission = deps.fetchRepositoryPermissionForUser ?? fetchRepositoryPermissionForUser;
  const permission = await fetchPermission({
    owner: parsed.owner,
    repo: parsed.repo,
    username: parsed.requesterLogin,
  });
  if (!writerPermission(permission)) {
    const command = await store.rejectCommand(buildBaseCommandInput(
      parsed,
      envelope.deliveryId,
      "rejected",
      { rejectionReason: "unauthorized" },
    ));
    const posted = await postBestEffortComment({
      parsed,
      body: rejectionBody("unauthorized"),
      postIssueCommentFn,
    });
    if (posted.result?.htmlUrl) {
      await store.updateCommandResponse(command.id, {
        responseCommentUrl: posted.result.htmlUrl,
      });
    }
    return {
      status: "rejected",
      reason: "unauthorized",
      responseCommentUrl: posted.result?.htmlUrl,
      commentError: posted.error,
    };
  }

  const accepted = await store.acceptOrCoalesceCommand({
    ...buildBaseCommandInput(parsed, envelope.deliveryId, "accepted"),
    pullRequest,
  });

  if (accepted.responseKind === "rejected") {
    const posted = await postBestEffortComment({
      parsed,
      body: rejectionBody(accepted.reason ?? "unsupported_state"),
      postIssueCommentFn,
    });
    if (posted.result?.htmlUrl) {
      await store.updateCommandResponse(accepted.command.id, {
        responseCommentUrl: posted.result.htmlUrl,
      });
    }
    return {
      status: "rejected",
      reason: accepted.reason,
      oneshotRunId: accepted.run?.id,
      requestedPlanVersion: accepted.requestedPlanVersion,
      responseCommentUrl: posted.result?.htmlUrl,
      commentError: posted.error,
    };
  }

  if (accepted.queued && accepted.run?.id && accepted.requestedPlanVersion) {
    const publisher = deps.publisher ?? new OneShotPublisher();
    await publisher.publishStageMessage(
      accepted.run.id,
      "planning",
      accepted.requestedPlanVersion,
      "queued_for_planning",
      true,
      {
        dedupeToken: `github-command-${envelope.deliveryId}`,
      },
    );
  }

  const posted = await postBestEffortComment({
    parsed,
    body: acknowledgementBody({
      kind: accepted.responseKind,
      runId: accepted.run?.id,
      requestedPlanVersion: accepted.requestedPlanVersion,
    }),
    postIssueCommentFn,
  });
  if (posted.result?.htmlUrl) {
    await store.updateCommandResponse(accepted.command.id, {
      responseCommentUrl: posted.result.htmlUrl,
    });
  }

  return {
    status: accepted.responseKind,
    oneshotRunId: accepted.run?.id,
    requestedPlanVersion: accepted.requestedPlanVersion,
    responseCommentUrl: posted.result?.htmlUrl,
    commentError: posted.error,
  };
}

class MysqlOneShotGithubCommandStore implements OneShotGithubCommandStore {
  constructor(private readonly pool = getPool()) {}

  async getCommandByDeliveryId(deliveryId: string): Promise<OneShotGitHubCommandRecord | null> {
    return new OneShotGitHubCommandsDB(
      asOneShotQueryExecutor(this.pool),
    ).getByDeliveryId(deliveryId);
  }

  async rejectCommand(input: CreateOneShotGitHubCommandInput): Promise<OneShotGitHubCommandRecord> {
    return new OneShotGitHubCommandsDB(
      asOneShotQueryExecutor(this.pool),
    ).createCommand(input);
  }

  async updateCommandResponse(
    id: number,
    input: {
      responseCommentUrl?: string | null;
      status?: OneShotGitHubCommandRecord["status"];
      rejectionReason?: string | null;
    },
  ): Promise<void> {
    await new OneShotGitHubCommandsDB(asOneShotQueryExecutor(this.pool)).updateResponse({
      id,
      ...input,
    });
  }

  async acceptOrCoalesceCommand(
    input: OneShotGithubCommandStoreAcceptInput,
  ): Promise<OneShotGithubCommandStoreAcceptResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await this.acceptOrCoalesceCommandInTransaction(connection, input);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async acceptOrCoalesceCommandInTransaction(
    connection: mysql.PoolConnection,
    input: OneShotGithubCommandStoreAcceptInput,
  ): Promise<OneShotGithubCommandStoreAcceptResult> {
    const oneShotExecutor = asOneShotQueryExecutor(connection);
    const commandsDb = new OneShotGitHubCommandsDB(oneShotExecutor);
    const existing = await commandsDb.getByDeliveryId(input.deliveryId);
    if (existing) {
      return {
        command: existing,
        requestedPlanVersion: existing.requestedPlanVersion,
        queued: false,
        responseKind: "rejected",
        reason: "duplicate_delivery",
      };
    }

    const prUrls = [
      input.pullRequest.htmlUrl,
      `https://github.com/${input.pullRequest.owner}/${input.pullRequest.repo}/pull/${input.pullRequest.pullNumber}`,
    ];
    const [runRows] = await connection.query<Array<mysql.RowDataPacket & CommandRun>>(
      `SELECT id,
              jira_key,
              state,
              current_plan_version,
              current_pr_url,
              current_implementation_branch,
              current_implementation_commit_sha,
              current_implementation_version,
              final_disposition
       FROM oneshot_runs
       WHERE current_pr_url IN (?, ?)
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [prUrls[0], prUrls[1]],
    );
    const run = runRows[0] ?? null;
    if (!run) {
      const command = await commandsDb.createCommand({
        ...input,
        oneshotRunId: null,
        status: "rejected",
        rejectionReason: "missing_run",
      });
      return {
        command,
        queued: false,
        responseKind: "rejected",
        reason: "missing_run",
      };
    }
    if (run.state !== "pr_open" && run.state !== "queued_for_planning") {
      const command = await commandsDb.createCommand({
        ...input,
        oneshotRunId: run.id,
        status: "rejected",
        rejectionReason: "unsupported_state",
      });
      return {
        command,
        run,
        queued: false,
        responseKind: "rejected",
        reason: "unsupported_state",
      };
    }

    const requestedPlanVersion = Number(run.current_plan_version ?? 0) + 1;
    const oneShotDb = new OneShotDatabase(oneShotExecutor);
    const candidate = input.pullRequest.headSha
      ? await oneShotDb.candidateVersions.adoptCurrentCandidate({
          oneshotRunId: run.id,
          candidateCommitSha: input.pullRequest.headSha,
          metadata: {
            source: "github_slash_command_replan",
            deliveryId: input.deliveryId,
            pullNumber: input.pullRequest.pullNumber,
            requesterLogin: input.requesterLogin,
          },
        })
      : null;
    const implementationVersion =
      candidate?.candidateVersion ?? run.current_implementation_version;
    const implementationSha =
      input.pullRequest.headSha ?? run.current_implementation_commit_sha;
    const implementationBranch =
      input.pullRequest.headRef ?? run.current_implementation_branch;

    const responseKind = run.state === "queued_for_planning" ? "coalesced" : "accepted";
    const command = await commandsDb.createCommand({
      ...input,
      oneshotRunId: run.id,
      requestedPlanVersion,
      status: responseKind,
      rejectionReason: null,
    });

    if (run.state === "pr_open") {
      const [updateResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE oneshot_runs
         SET state = 'queued_for_planning',
             last_error = NULL,
             final_disposition = NULL,
             planning_attempt_count = 0,
             current_implementation_branch = ?,
             current_implementation_commit_sha = ?,
             current_implementation_version = ?,
             updated_at = NOW()
         WHERE id = ?
           AND state = 'pr_open'`,
        [
          implementationBranch,
          implementationSha,
          implementationVersion,
          run.id,
        ],
      );
      if (updateResult.affectedRows !== 1) {
        throw new Error(`Failed to queue OneShot run ${run.id} for planning revision`);
      }
      await connection.query(
        `INSERT INTO oneshot_run_events (
           oneshot_run_id,
           event_type,
           from_state,
           to_state,
           stage,
           metadata_json,
           occurred_at
         ) VALUES (?, 'state_transition', 'pr_open', 'queued_for_planning', 'planning', ?, NOW(6))`,
        [
          run.id,
          JSON.stringify({
            reason: "github_slash_command_replan",
            deliveryId: input.deliveryId,
            requestedPlanVersion,
            candidateVersion: candidate?.candidateVersion ?? null,
            pullRequestHeadSha: input.pullRequest.headSha ?? null,
          }),
        ],
      );
    } else {
      await connection.query(
        `UPDATE oneshot_runs
         SET current_implementation_branch = ?,
             current_implementation_commit_sha = ?,
             current_implementation_version = ?,
             updated_at = NOW()
         WHERE id = ?
           AND state = 'queued_for_planning'`,
        [
          implementationBranch,
          implementationSha,
          implementationVersion,
          run.id,
        ],
      );
      await connection.query(
        `INSERT INTO oneshot_run_events (
           oneshot_run_id,
           event_type,
           from_state,
           to_state,
           stage,
           metadata_json,
           occurred_at
         ) VALUES (?, 'github_command_coalesced', 'queued_for_planning', 'queued_for_planning', 'planning', ?, NOW(6))`,
        [
          run.id,
          JSON.stringify({
            reason: "github_slash_command_replan",
            deliveryId: input.deliveryId,
            requestedPlanVersion,
            candidateVersion: candidate?.candidateVersion ?? null,
          }),
        ],
      );
    }

    return {
      command,
      run: {
        ...run,
        state: run.state === "pr_open" ? "queued_for_planning" : run.state,
        current_implementation_branch: implementationBranch,
        current_implementation_commit_sha: implementationSha,
        current_implementation_version: implementationVersion,
      },
      requestedPlanVersion,
      candidateVersion: candidate?.candidateVersion ?? null,
      queued: run.state === "pr_open",
      responseKind,
    };
  }
}
