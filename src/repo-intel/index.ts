// Shared, provider-agnostic repo-analysis surface ("repo intelligence").
//
// Both OneShot and Spec Factory need the same repo scanner, route-card
// navigation hints, and repo-identify helpers. The implementations currently
// live under `src/oneshot/` and have many in-tree importers (OneShot +
// orchestrator), so rather than physically relocate them (and churn ~17
// import sites), this barrel RE-EXPORTS the provider-agnostic functions from
// their current home. New consumers (e.g. Spec Factory Compose repo grounding)
// import from `repo-intel` so there is one canonical surface and no
// cross-subsystem coupling into `src/oneshot/*` internals.
//
// A future cleanup may physically move the underlying modules behind this
// same barrel without touching consumers.

// --- Repo scanner: tech stack / structure / key files + prompt formatting ---
export {
  scanRepo,
  formatScanForPrompt,
} from "../oneshot/repo-scanner.js";
export type {
  RepoScanResult,
  TechStack,
  ProjectStructure,
  KeyFile,
  ProjectGuidanceFile,
  ProjectGuidanceKind,
} from "../oneshot/repo-scanner.js";

// --- Route cards: curated per-repo navigation hints ---
export {
  buildRepoRouteCardContext,
  getRepoRouteCardMatches,
} from "../oneshot/repo-route-cards.js";
export type { RepoRouteCard } from "../oneshot/repo-route-cards.js";

// --- Repo identify: slug + mention tokens for inferring a repo from text ---
export {
  getRepositorySlug,
  getRepoMentionTokens,
} from "../oneshot/repo-metadata.js";
