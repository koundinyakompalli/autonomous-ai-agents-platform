// Temporary server-side cutoff until qualifier artifacts consistently emit metadata.routerVersion.
// RepoRouter shipped in commit 60c5130; pre-cutoff repo_resolution_failed rows are legacy noise.
export const ROUTER_SHIP_ISO = "2026-04-15T00:00:00Z";
