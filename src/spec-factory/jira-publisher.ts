import type { JiraClient } from "../orchestrator/JiraClient.js";
import { renderEpicDescription } from "./renderers.js";
import type { SpecFactoryDraftDetail } from "./types.js";
import { SPEC_FACTORY_GENERATED_LABEL, SPEC_FACTORY_LABEL } from "./types.js";

type JiraCreateIssueClient = Pick<JiraClient, "createIssue">;

export interface JiraPublisherApprovalResult {
  epicKey: string;
  children: Array<{ childId: number; jiraKey: string }>;
}

export interface JiraPublisherApprovalOptions {
  existingEpicKey?: string | null;
  onEpicCreated?: (epicKey: string) => Promise<void>;
  onChildCreated?: (child: {
    childId: number;
    jiraKey: string;
  }) => Promise<void>;
}

export interface JiraPublisherConfig {
  projectKey?: string | null;
  epicIssueType?: string | null;
  childIssueType?: string | null;
}

interface ResolvedJiraPublisherConfig {
  projectKey: string;
  epicIssueType: string;
  childIssueType: string;
}

/**
 * Optional Jira-side dedupe lookup. Used by approveDraft to detect when a
 * child story was already created in Jira on a previous publish attempt
 * but the persistence callback never landed (so the in-memory `child.jiraKey`
 * is still null on retry). Without this, a retry would create a duplicate.
 *
 * Implementations should perform a JQL search like:
 *   project = "<projectKey>" AND parent = "<parentEpicKey>" AND
 *     summary ~ "<exact summary>"
 * and return the first match by summary equality, or null when none.
 *
 * Returning null on a transient failure is acceptable: it falls through to
 * createIssue, which is the original (non-dedupe) behavior.
 */
export type FindChildIssueByParentAndSummary = (input: {
  projectKey: string;
  parentEpicKey: string;
  summary: string;
}) => Promise<{ key: string; summary: string } | null>;

export interface JiraPublisherDeps {
  findChildIssueByParentAndSummary?: FindChildIssueByParentAndSummary;
}

function configuredValue(
  value: string | null | undefined,
  fallback: string,
): string {
  return value?.trim() || fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JiraPublisher {
  private readonly config: ResolvedJiraPublisherConfig;
  private readonly findChildIssueByParentAndSummary:
    | FindChildIssueByParentAndSummary
    | null;

  constructor(
    private readonly jiraClient: JiraCreateIssueClient,
    config: JiraPublisherConfig = {},
    deps: JiraPublisherDeps = {},
  ) {
    this.config = {
      projectKey: configuredValue(config.projectKey, "CPDEV"),
      epicIssueType: configuredValue(config.epicIssueType, "Epic"),
      childIssueType: configuredValue(config.childIssueType, "Story"),
    };
    this.findChildIssueByParentAndSummary =
      deps.findChildIssueByParentAndSummary ?? null;
  }

  async approveDraft(
    draft: SpecFactoryDraftDetail,
    options: JiraPublisherApprovalOptions = {},
  ): Promise<JiraPublisherApprovalResult> {
    if (draft.draft === null) {
      throw new Error(
        "Cannot approve a Spec Factory draft with null draft content",
      );
    }

    const { projectKey, epicIssueType, childIssueType } = this.config;
    let epicKey = options.existingEpicKey?.trim() || null;
    if (!epicKey) {
      epicKey = (
        await this.jiraClient.createIssue({
          projectKey,
          summary: draft.draft.epic.summary,
          description: renderEpicDescription(draft.draft),
          issueType: epicIssueType,
          labels: [SPEC_FACTORY_LABEL, SPEC_FACTORY_GENERATED_LABEL],
        })
      ).key;
      await options.onEpicCreated?.(epicKey);
    }

    const children: Array<{ childId: number; jiraKey: string }> = [];
    const created: Array<{ childId: number; jiraKey: string }> = [];
    for (const child of draft.childTickets) {
      if (child.jiraKey) {
        continue;
      }

      // Idempotent-retry guard: Jira has no transactions, so on a
      // partial-failure retry, a child may already exist in Jira even
      // though our DB still has jiraKey=null. Probe for an existing
      // issue under the same parent Epic with the same summary before
      // creating a new one. This prevents duplicate stories.
      let resolvedKey: string | null = null;
      if (this.findChildIssueByParentAndSummary) {
        try {
          const existing = await this.findChildIssueByParentAndSummary({
            projectKey,
            parentEpicKey: epicKey,
            summary: child.summary,
          });
          if (existing?.key) {
            resolvedKey = existing.key;
          }
        } catch (error) {
          // Lookup failures are non-fatal: fall through to createIssue,
          // which preserves pre-dedupe behavior.
          console.warn(
            `[spec-factory] jira child-dedupe lookup failed for ${child.summary}: ${errorMessage(error)}`,
          );
        }
      }

      if (!resolvedKey) {
        try {
          const story = await this.jiraClient.createIssue({
            projectKey,
            summary: child.summary,
            description: child.description ?? "",
            issueType: childIssueType,
            labels: [SPEC_FACTORY_LABEL, SPEC_FACTORY_GENERATED_LABEL],
            parentKey: epicKey,
            storyPoints: child.loeHours ?? undefined,
          });
          resolvedKey = story.key;
          created.push({ childId: child.id, jiraKey: resolvedKey });
        } catch (error) {
          // Surface a clear, contextual error so the caller can attribute
          // the partial failure to a specific child + what was created.
          const message = errorMessage(error);
          const wrapped = new Error(
            `Spec Factory Jira publish failed creating child '${child.summary}' under Epic ${epicKey} (` +
              `epicCreated=${options.existingEpicKey ? "preexisting" : "this-run"}, ` +
              `childrenCreatedThisRun=${created.length}` +
              `): ${message}`,
          );
          (wrapped as Error & { cause?: unknown }).cause = error;
          throw wrapped;
        }
      }

      const createdChild = { childId: child.id, jiraKey: resolvedKey };
      await options.onChildCreated?.(createdChild);
      children.push(createdChild);
    }

    return { epicKey, children };
  }
}
