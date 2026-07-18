import { promises as fs } from "fs";
import path from "path";
import type { ComposeRepository } from "./compose-database.js";
import type { SpecFactoryRepository } from "./database.js";
import {
  buildComposeEvidenceManifest,
  type ComposeEvidenceSourceInput,
  type EvidenceManifest,
} from "./evidence.js";

type ComposeProviderComposeRepo = Pick<
  ComposeRepository,
  "findSessionBySourceId" | "listSessionSourceContents"
>;
type ComposeProviderSpecRepo = Pick<SpecFactoryRepository, "getSourceById">;

const WORKSPACE_EVIDENCE_FILES = ["context.md", "sources-index.md", "chat.md"];

async function readWorkspaceEvidence(
  workspacePath: string | null | undefined,
): Promise<ComposeEvidenceSourceInput[]> {
  if (!workspacePath) return [];
  const artifacts: ComposeEvidenceSourceInput[] = [];
  for (const filename of WORKSPACE_EVIDENCE_FILES) {
    try {
      const content = await fs.readFile(path.join(workspacePath, filename), "utf8");
      artifacts.push({ sourceId: 0, filename, content });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
  return artifacts;
}

export class ComposeEvidenceProvider {
  constructor(
    private readonly composeRepository: ComposeProviderComposeRepo,
    private readonly specRepository: ComposeProviderSpecRepo,
  ) {}

  async collect(sourceId: number): Promise<EvidenceManifest> {
    const session =
      await this.composeRepository.findSessionBySourceId(sourceId);
    if (!session) {
      throw new Error(`No compose session is linked to source ${sourceId}`);
    }

    const source = await this.specRepository.getSourceById(sourceId);
    if (!source) {
      throw new Error(`Spec Factory source ${sourceId} was not found`);
    }

    const workspaceSources = await readWorkspaceEvidence(session.workspacePath);
    const sources = [
      ...workspaceSources,
      ...(await this.composeRepository.listSessionSourceContents(session.id)),
    ];

    return buildComposeEvidenceManifest({
      sourceJiraKey: source.sourceJiraKey,
      sourceSummary: source.sourceSummary,
      sources,
      composeStories: session.readiness?.stories,
    });
  }
}
