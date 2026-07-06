---
name: Member-content reindex concurrency guard
description: Why the reindex self-trigger chain uses a fail-open defer-marker, NOT a hard heartbeat lock like run-import-jobs.
---

# Member-content reindex concurrency guard

The member-content reindex cron (`/api/cron/reindex-member-content`) is a
self-triggering chain of time-budgeted slices with **no hard job lock** — by
design, because re-indexing is idempotent (unchanged chunks reuse their
embedding), so a dropped chain restarts cheaply on the next 6h cron. The guard
against *overlap* (a live chain still working when the next 6h cron fires,
double-embedding changed content and burning OpenAI budget) is deliberately
softer than the CAS heartbeat lock in `run-import-jobs` / imports worker.

**The mechanism** (helpers in `api/_lib/memberContentReindexLock.js`):
- A single global marker row in `system_settings` (`setting_key =
  'member_content_reindex_run'`, `tenant_id = NULL`) holding `{ runId,
  heartbeatAt, scope, startedAt }`. `system_settings` already exists in every
  env and accepts a NULL tenant_id (no unique constraint / no migration needed).
- hop 0 (`acquireReindexRun`): if a marker is fresh (heartbeat within
  `RUN_STALE_MS = 5min`) → **defer** (return `skipped`), do NOT start a parallel
  pass. Stale marker → reclaim with a new `runId`.
- hop > 0 (`renewReindexRun`): refresh heartbeat only while the chain still
  *owns* the run (marker `runId` matches the one carried in the dispatch body).
  If a newer run took over (runId mismatch, still fresh) → the stale chain
  stands down. This is what prevents a late-reviving zombie chain from running
  alongside the reclaimer.
- The chain clears the marker (`completeReindexRun`, owner-only) when the pass
  finishes OR dead-ends (hop cap / no origin / dispatch failed / fatal error),
  so the next cron restarts immediately instead of waiting out the TTL.

**Why fail-open, not CAS:** every marker op is wrapped so any read/write error
lets indexing proceed (acquire returns `acquired:true`, renew returns
`owns:true`). The task's hard constraint was "no new hard dependency that breaks
the 'restart is free' property". A hard lock (or a lock in a table that might
not be migrated everywhere) could permanently stall indexing; a fail-open guard
that just reverts to the pre-existing (correct-but-wasteful) overlap behaviour
cannot. Do not "upgrade" this to a CAS lock or a dedicated table without
re-checking that property.

**How to apply:** if you touch this chain, keep the guard best-effort and keep
`runId` flowing through the self-trigger dispatch body; releasing the marker on
every non-handoff exit is what keeps restart free.
