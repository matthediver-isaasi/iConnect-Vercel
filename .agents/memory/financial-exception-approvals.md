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

**Why:** Existing scheduled processing may still run older accounting behavior after local source changes.

**How to apply:** Bind independent deployment evidence to the reviewed release approval and fail closed when it is absent or stale. Release approval does not itself authorize publishing; avoid reacquiring short-lived provider evidence while deployment readiness is unresolved.