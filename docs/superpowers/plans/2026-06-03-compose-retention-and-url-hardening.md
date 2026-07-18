# Compose Retention and URL Hardening Follow-Up

**Goal:** Implement the cleanup and URL-ingestion safeguards intentionally deferred from the Spec Factory gap-fix pass.

## Retention Policy

- Treat Compose EFS workspaces as a working cache, not the durable source of record.
- Keep raw uploads in S3 and converted source bodies / chat / context in the database-backed evidence path.
- Archive should mark a session eligible for cleanup; it should not synchronously delete workspace files.
- Default retention target: delete archived Compose workspaces after 30 days unless a later product decision requires longer retention.

## Cleanup Implementation Checklist

- [x] Add `archived_at` or equivalent cleanup eligibility metadata for Compose sessions if current timestamps are insufficient.
- [x] Add a periodic cleanup worker or admin command that deletes EFS `compose/<sessionId>` workspaces for archived sessions older than the retention window.
- [x] Record cleanup events with session id, workspace path, bytes/files deleted when available, and failures.
- [x] Keep cleanup idempotent: missing workspace paths should be treated as already cleaned.
- [x] Add tests for eligible, too-new, active, and already-missing workspaces.

## URL Ingestion Hardening Checklist

- [x] Restrict accepted schemes to `https:` unless a specific exception is approved.
- [x] Block private, loopback, link-local, and metadata-service IP ranges after DNS resolution and redirects.
- [x] Add redirect count limits.
- [x] Add fetch timeout and response size limits.
- [x] Preserve YouTube-specific transcript ingestion while avoiding a general SSRF-capable fetcher.
- [x] Add tests for rejected schemes, private-network targets, redirect loops, timeout, and oversized responses.
