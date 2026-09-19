---
name: Membership summary evidence
description: Why settled membership terms must not be described as a successfully configured recurring payment arrangement.
---

Keep membership access, invoice settlement and recurring-payment setup as separate claims. A paid or partially paid retained term can establish membership evidence, but does not by itself establish a current collection arrangement.

**Why:** Reusable member-facing cards use affirmative setup wording. Applying that wording to an annual invoice, or to a monthly history row whose matching plan is missing, would make an unsupported claim even though the term itself is genuine. Conversely, a confirmed upfront payment legitimately has no recurring plan; calling its payment details unavailable falsely suggests the complete membership record is missing.

**How to apply:** Use distinct “paid in full” wording for confirmed upfront settlement, never recurring-setup wording. Missing or partial settlement evidence and a paid monthly instalment do not establish upfront settlement. Require commitment-matched plan evidence for setup-success wording and next planned collection dates. Show a known renewal anniversary explicitly as renewal, never as an automatic collection date. Do not borrow unrelated plans or infer organisation billing from an employee's personal agreement.

For migrated Direct Debits, distinguish verified existing mandate readiness, imported historical payments, source-system current entitlement, and the new collection term.

**Why:** A pilot retained paid historical collections separately from an unpaid future term. Its internal pending setup status was misleading on screen despite an active legacy mandate; relabelling the term active would instead falsely grant financial entitlement.

**How to apply:** Derive truthful presentation from tenant/environment-scoped mandate evidence without changing payment or activation state. Future imports must evidence current-term dates separately; historical paid collections alone do not establish those dates. Preserve collection holds, reviewed release, and cutover guards.

Variable monthly prices and annual financial commitments are separate evidence.

**Why:** Imported dynamic terms deliberately retain null annual totals while preserving an initial monthly quote. Neither that quote nor a saved reservation proves today's applicable price, and multiplying a current monthly amount by twelve invents a commitment.

**How to apply:** Resolve display estimates read-only for an evidenced date and purchased scope; use provider evidence alone for scheduled-charge wording. Keep annual nulls uncommitted and preserve existing financial totals. Do not let a UI fallback turn an old reservation into a fresh price estimate.

Provider-only historical evidence can coexist with a held future adoption before accounting reconciliation.

**Why:** BNMS beta candidates had verified settled provider payments but expired accounting access and no evidenced source entitlement dates. Blocking collection and keeping evidence separate allowed safe held adoption without inventing invoice links or current membership access.

**How to apply:** Label provider-only history as accounting-unreconciled, leave nominal coverage periods and invoice links absent, and preserve the historical mutable-ledger barrier. Do not inherit the original pilot's accounting approval, disabled-legacy-scheduler claim or entitlement from similar mandates. Member/admin projections using real DEST data and injected auth collaborators are service evidence only—not deployed login or visual proof.