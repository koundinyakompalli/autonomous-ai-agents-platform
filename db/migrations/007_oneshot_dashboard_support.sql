-- Migration 007: add dashboard-facing implementation identity to oneshot_runs.

ALTER TABLE oneshot_runs
  ADD COLUMN IF NOT EXISTS current_implementation_branch VARCHAR(255) NULL
    AFTER current_implementation_version,
  ADD COLUMN IF NOT EXISTS current_implementation_commit_sha VARCHAR(40) NULL
    AFTER current_implementation_branch,
  ADD INDEX idx_oneshot_current_impl_branch (current_implementation_branch);
