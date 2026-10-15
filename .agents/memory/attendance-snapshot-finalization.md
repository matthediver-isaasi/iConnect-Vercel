---
name: Attendance snapshot finalization
description: Durable rules for safely materializing provider-neutral attendance after a provider report.
---

Replace provider attendance facts, matches, outcome revisions, and current outcomes in one tenant-scoped database transaction. Serialize replacements per attendance target, and expose the new projection only after the sync run succeeds.

**Why:** Deleting and rewriting provider facts through independent API calls can leave stale outcomes paired with missing or partial facts after a crash. Provider-only idempotency also misses outcome changes caused by late confirmations, cancellations, threshold edits, or corrected matching.

**How to apply:** Build snapshot identity from every outcome-determining input: provider and target identity, effective policy and threshold, confirmed booking identities, participant intervals, and match state. Exact repeats should reuse outcomes without duplicate revisions; any material change must re-finalize atomically.

For workflow publication, compare a new fingerprint only with the current outcome. Do not make historical fingerprints unique: a correction can legitimately return to a result seen before and must still create a new auditable revision and transition.

**Why:** A global fingerprint uniqueness rule silently loses transitions such as attended → absent → attended. Workflow side effects also cannot always be replayed safely after a crash.

**How to apply:** Publish revisions through a transactional outbox. Key once-per-record delivery claims by workflow + booking, not member or transition. Never auto-replay an ambiguous claimed action; leave the outbox blocked until an admin acknowledges the attempt without replay, then resume still-unclaimed workflows.

When a provider meeting is detached, replaced, or its policy changes, keep the materialized target hidden through pending and failed syncs. Only a successful fresh snapshot may reactivate it; retry state must not expose facts from the previous meeting identity.

Administrator-approved attendance-only reconciliations are an explicit exception to normal transition publication: retain the evidence, matching, revisions and current outcomes atomically, with a durable explanation that award/workflow publication was deliberately withheld.

**Why:** Attendance approval is not necessarily approval to issue CPD points or certificates. Publishing the normal transition can enqueue awards even without calling an application-level award function.

**How to apply:** Verify live database side effects and existing pending jobs before the repair; compare award/notification queues before and after. Do not later replay intentionally withheld transitions as routine recovery without separate approval.

Audience attendance must recognise approved provider outcomes without converting
them into QR/check-in records. Keep preview and background preparation aligned,
including the inverse “Not attended” selection and inactive-target exclusions.

**Why:** The approved Zoom reconciliation deliberately recorded attendance without
publishing award transitions; checking only booking check-in timestamps excluded
all of those attendees from an attendance-filtered audience.

**How to apply:** Use current attended outcomes for active targets alongside
existing check-in evidence, scoped by tenant and booking source. Do not manufacture
check-ins or replay CPD/certificate actions to make recipients appear.
