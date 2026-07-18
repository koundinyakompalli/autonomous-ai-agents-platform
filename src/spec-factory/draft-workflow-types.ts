export const DRAFT_WORKFLOW_EXECUTION_STAGES = [
  "evidence_snapshot",
  "qualify",
  "repository_context",
  "draft_synthesize",
  "validate",
  "persist_draft",
] as const;

export const DRAFT_WORKFLOW_STAGES = [
  ...DRAFT_WORKFLOW_EXECUTION_STAGES,
  "approval_wait",
  "jira_publish",
  "oneshot_submit",
] as const;

export type DraftWorkflowStage = (typeof DRAFT_WORKFLOW_STAGES)[number];

export interface ClaimedDraftStageRun {
  id: number;
  workflowId: number;
  sourceId: number;
  handoffSnapshotId: number | null;
  stageName: DraftWorkflowStage;
  stageOrder: number;
  attemptCount: number;
  leaseGeneration: number;
  workerId: string;
  input: unknown;
  priorOutputs: Partial<Record<DraftWorkflowStage, unknown>>;
}

export interface DraftStageExecutionOutput {
  output: unknown;
  databaseOutput?: unknown;
  outputArtifactUri?: string | null;
  outputSha256?: string | null;
  outputBytes?: number | null;
  evidenceSnapshotId?: number | null;
  draftId?: number | null;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null;
}

export interface DraftStageArtifactPointer {
  artifactUri: string;
  sha256: string;
  bytes: number;
}
