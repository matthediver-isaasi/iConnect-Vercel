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

For the separate BNMS manual-95 cohort, general trust in the existing worker/cron is not evidence that its new recognition and exact-contact accounting integration is deployed. Local source hashes alone cannot authorize release after the October gate: an old worker could collect and fall back to generic accounting.

Require independently supplied production deployment evidence or explicit user attestation covering the exact reviewed runtime hashes, worker, webhook accounting and membership readers. Bind the whole proof into the parent-reviewed manifest and reject missing/old/unknown proof before provider reads or any apply transaction. No publishing authority is inferred. Matching is complete for all 95 (81 exact cached provider-payment-reference identities plus 14 unique current emails); no invoice retrieval was needed. Do not reacquire provider evidence merely while waiting for publishing readiness.