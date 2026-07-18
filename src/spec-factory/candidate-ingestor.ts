import type { JiraClient } from "../orchestrator/JiraClient.js";
import type { SpecFactoryRepository } from "./database.js";
import {
  SPEC_FACTORY_LOUISE_JQL,
  SPEC_FACTORY_STARTED_LABEL,
} from "./types.js";

type CandidateJiraClient = Pick<
  JiraClient,
  "searchIssues" | "updateIssueLabels"
>;
type CandidateRepository = Pick<SpecFactoryRepository, "upsertSource">;

export interface CandidateIngestorNewSource {
  id: number;
  key: string;
}

export interface CandidateIngestorRefreshResult {
  scanned: number;
  upserted: number;
  matched: number;
  truncated: boolean;
  claimed: number;
  claimFailures: number;
  newSources: CandidateIngestorNewSource[];
}

export class CandidateIngestor {
  constructor(
    private readonly jiraClient: CandidateJiraClient,
    private readonly repository: CandidateRepository,
    private readonly jql = SPEC_FACTORY_LOUISE_JQL,
    private readonly claimLabel = SPEC_FACTORY_STARTED_LABEL,
  ) {}

  async refresh(): Promise<CandidateIngestorRefreshResult> {
    // 50 is the Jira API PAGE size, not a cap: JiraClient.searchIssues exhausts
    // nextPageToken internally and returns every match (total === issues.length).
    // So no Louise candidate is dropped, and `truncated` below is structurally
    // always false — retained only for result-shape stability.
    const searchResult = await this.jiraClient.searchIssues(
      this.jql,
      "key,summary,status,labels,updated",
      50,
    );
    let upserted = 0;
    let claimed = 0;
    let claimFailures = 0;
    const newSources: CandidateIngestorNewSource[] = [];

    for (const issue of searchResult.issues) {
      const upsert = await this.repository.upsertSource({
        sourceJiraKey: issue.key,
        sourceSummary: issue.fields?.summary ?? issue.key,
        sourceStatus: issue.fields?.status?.name ?? null,
        sourceLabels: issue.fields?.labels ?? [],
        loeHours: null,
      });

      if (!this.claimLabel || issue.fields?.labels?.includes(this.claimLabel)) {
        if (upsert.inserted) {
          upserted += 1;
          newSources.push({ id: upsert.id, key: issue.key });
        }
        continue;
      }

      try {
        await this.jiraClient.updateIssueLabels(issue.key, {
          add: [this.claimLabel],
        });
        claimed += 1;
      } catch (error) {
        claimFailures += 1;
        console.warn(
          `[spec-factory] failed to add ${this.claimLabel} to ${issue.key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (upsert.inserted) {
        upserted += 1;
        newSources.push({ id: upsert.id, key: issue.key });
      }
    }

    return {
      scanned: searchResult.issues.length,
      upserted,
      matched: searchResult.total,
      truncated: searchResult.total > searchResult.issues.length,
      claimed,
      claimFailures,
      newSources,
    };
  }
}
