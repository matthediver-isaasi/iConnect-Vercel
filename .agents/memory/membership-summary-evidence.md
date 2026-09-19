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