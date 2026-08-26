---
name: Attendance snapshot finalization
description: Durable rules for safely materializing provider-neutral attendance after a provider report.
---

Replace provider attendance facts, matches, outcome revisions, and current outcomes in one tenant-scoped database transaction. Serialize replacements per attendance target, and expose the new projection only after the sync run succeeds.

**Why:** Deleting and rewriting provider facts through independent API calls can leave stale outcomes paired with missing or partial facts after a crash. Provider-only idempotency also misses outcome changes caused by late confirmations, cancellations, threshold edits, or corrected matching.

**How to apply:** Build snapshot identity from every outcome-determining input: provider and target identity, effective policy and threshold, confirmed booking identities, participant intervals, and match state. Exact repeats should reuse outcomes without duplicate revisions; any material change must re-finalize atomically.