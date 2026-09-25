---
name: Financial exception approvals
description: Keep manual reconciliation exceptions separate from payment settlement and release authority.
---

An instruction to proceed despite known unpaid invoices or failed attempts authorizes only those reviewed exceptions, not settlement, retry, write-off, or a general bypass.

**Why:** Manual follow-up can coexist with scheduled processing, but broad exclusions would also hide newly scheduled collections or changed liabilities.

**How to apply:** Bind exact resource identities, owners and financial evidence to the approval and review hash; revalidate fresh evidence before release and retain unpaid/failed statuses. Deliver a private member-level follow-up report. Independently enforce deployment and provider freshness.

For a timed provider release, budget credential lifetime across the warm-up, user evidence handoff, cached dry-run and forced-fresh apply—not just one invocation.

**Why:** A token can pass the dry-run's minimum remaining lifetime but fail the identical threshold at apply, wasting a short-lived user deployment attestation. Normal refresh may only become available later.

**How to apply:** Check credential lifetime before the final cycle and never extend timestamps to compensate. Avoid repeatedly warming the full provider cache merely to obtain another review hash; repeated contact scans can exhaust the provider's daily limit.

An old zero-blocker report can support a clearly labelled, non-authorizing economic preview if the canonical apply independently reacquires every mutable resource and compares the resulting complete economic/state commitment before writing.

**Why:** The deployment evidence and financial preview need not require two consecutive full provider scans inside one short freshness window. Old observations must never be represented as current evidence.

**How to apply:** Retain original report timestamps, verify the new deployment proof, independently review the pure economic commitment, and use only the canonical forced-fresh apply. Keep all schema, current-state, exact-hash, handover and pre-commit freshness checks. Any mismatch requires review, not automatic acceptance of a new hash.

Financial release approval must distinguish reviewed source code from evidence that the same safeguards are deployed.

Run long reviewed financial transactions in a durable background task with
private progress/exit artifacts, transaction-local application naming and
bounded SQL/lock timeouts. Measure database round-trip latency when estimating
completion time, not just local test duration.

**Why:** Thousands of sequential remote queries can take several minutes even
when each query is fast and local rehearsal completes in seconds. Foreground
tool termination does not identify the SQL stage or prove transaction outcome;
verify the persisted journal and live records before considering any retry.

An explicitly accepted operator deployment-evidence exception may waive only missing deployment timestamps and scoped runtime attestation for one pinned cohort/runtime/deployment. Record unknown metadata as unknown, preserve the supplied report, and never label it independently verified.

Capture full-row financial CAS evidence with the same database JSON codec and
explicit transaction-local timezone used during application.

**Why:** Driver-decoded `SELECT *` rows convert dates and numerics differently
from PostgreSQL `to_jsonb`, producing false drift and losing sub-millisecond
timestamp precision. Preserve every field; test real mutations rather than
dropping timestamp or price guards.

**Why:** Operator risk acceptance about deployment provenance does not establish financial identity or authorize bypassing current-state safeguards. Mandatory mandate/accounting identity, collision, freshness, exact economics, date gates, atomic rollback and replay checks remain enforced; any compare-and-swap failure stops release.

**Why:** Existing scheduled processing may still run older accounting behavior after local source changes.

**How to apply:** Bind independent deployment evidence to the reviewed release approval and fail closed when it is absent or stale. Release approval does not itself authorize publishing; avoid reacquiring short-lived provider evidence while deployment readiness is unresolved.