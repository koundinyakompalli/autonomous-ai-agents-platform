/**
 * Types for the externalized prompt and guardrail system.
 *
 * Prompts and guardrails are stored as markdown files in S3 (prod) or
 * the repo-root oneshot-prompts/ directory (local dev). A manifest pins
 * every asset to an exact S3 VersionId for reproducible deployments.
 */

export interface PromptAssetRef {
  /** S3 object key, e.g. "oneshot/prompts/plan.md" */
  key: string;
  /** S3 VersionId for exact version pinning */
  versionId: string;
}

export interface PromptManifest {
  /** Monotonically increasing version label (e.g. "2026-04-14T12:00:00Z") */
  version: string;
  /** ISO timestamp when the manifest was created */
  createdAt: string;
  /** Map of logical asset names to their S3 coordinates */
  assets: Record<string, PromptAssetRef>;
}

/**
 * Maps each OneShot pipeline stage to its prompt and guardrail
 * logical asset names. These names are used to look up assets
 * in the PromptManifest or the local filesystem.
 *
 * `systemPrompt` is optional — if present, the stage's behavioral rules
 * live in a separate asset that gets passed to the SDK's system prompt
 * slot (via `runAgent({ systemAppend })`). Stages without it compose a
 * single user-turn prompt via `PromptComposer.composePrompt`.
 */
export const STAGE_PROMPT_MAP: Record<
  string,
  { prompt: string; systemPrompt?: string; guardrail: string }
> = {
  planning: {
    prompt: "plan",
    systemPrompt: "plan-system",
    guardrail: "plan-guardrails",
  },
  review: { prompt: "review-plan", guardrail: "review-plan-guardrails" },
  implementation: { prompt: "build", guardrail: "build-guardrails" },
  code_review: { prompt: "review-code", guardrail: "review-code-guardrails" },
};
