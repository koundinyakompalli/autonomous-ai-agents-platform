import type { JiraClient, JiraTicketData } from "../orchestrator/JiraClient.js";
import type { CodeRepository } from "../orchestrator/database.js";
import { getProfiledRepoSummariesForLlm } from "../oneshot/qualifier-repo-context.js";
import type { SpecFactorySourceWithNextDraftVersion } from "./database.js";
import {
  buildEvidenceManifest,
  type EvidenceManifest,
} from "./evidence.js";
import { buildRepoReferenceManifest } from "./repo-reference.js";
import type { SpecFactoryAttachmentArchiver } from "./attachment-archive.js";

interface EvidenceCollectorRepository {
  getSourceById(sourceId: number): Promise<SpecFactorySourceWithNextDraftVersion | null>;
  createEvidenceSnapshot(input: {
    sourceId: number;
    manifest: EvidenceManifest;
  }): Promise<number>;
  recordEvent(
    sourceId: number,
    eventType: string,
    actor: string | null,
    metadata: unknown,
  ): Promise<void>;
}

type EvidenceJiraClient = Pick<JiraClient, "fetchTicketData">;

export class SpecFactoryEvidenceCollector {
  constructor(
    private readonly jiraClient: EvidenceJiraClient,
    private readonly repository: EvidenceCollectorRepository,
    private readonly attachmentArchiver: Pick<
      SpecFactoryAttachmentArchiver,
      "archiveTicketAttachments"
    >,
    private readonly lookupRepositories: () => Promise<CodeRepository[]>,
  ) {}

  async collect(sourceId: number): Promise<EvidenceManifest> {
    const source = await this.repository.getSourceById(sourceId);
    if (!source) {
      throw new Error(`Spec Factory source ${sourceId} was not found`);
    }

    return this.collectForSource(sourceId, source.sourceJiraKey);
  }

  async collectForSource(
    sourceId: number,
    sourceJiraKey: string,
  ): Promise<EvidenceManifest> {
    const ticketData = await this.jiraClient.fetchTicketData(sourceJiraKey);
    return this.collectTicketData(sourceId, ticketData);
  }

  async collectTicketData(
    sourceId: number,
    ticketData: JiraTicketData,
  ): Promise<EvidenceManifest> {
    const archive = await this.attachmentArchiver.archiveTicketAttachments({
      sourceId,
      ticketData,
    });
    const baseManifest = buildEvidenceManifest(ticketData, {
      archivedAttachments: archive.archived,
    });
    const repositories = await this.lookupRepositories();
    const repoReferences = buildRepoReferenceManifest(
      baseManifest,
      repositories,
    );
    const profiledRepos = await getProfiledRepoSummariesForLlm(repositories);
    const manifest = buildEvidenceManifest(ticketData, {
      archivedAttachments: archive.archived,
      repoReferences,
      repoClassifierContext: { profiledRepos },
    });
    manifest.warnings.push(...archive.warnings);

    const snapshotId = await this.repository.createEvidenceSnapshot({
      sourceId,
      manifest,
    });
    manifest.snapshotId = snapshotId;

    await this.repository.recordEvent(
      sourceId,
      "evidence_snapshot_created",
      null,
      {
        snapshotId,
        attachmentCount: archive.archived.length,
        repoCount: repoReferences.matchedRepos.length,
        warningCount: manifest.warnings.length,
      },
    );

    return manifest;
  }
}
