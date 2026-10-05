---
name: Renewal payment-method choice
description: Opening checkout must not permanently choose the renewal payment method.
---

Members must be able to select a different renewal payment method until they
have actually committed and paid; merely opening Stripe checkout is not a
payment-method commitment.

**Why:** The user explicitly required this after abandoning an upfront Stripe
payment to choose Direct Debit and being blocked by the unused-reservation guard.

**How to apply:** Provide provider-reconciled switching, not a timer-based
reservation reset. Preserve duplicate-payment protection, completed mandate
authority, and safety against stale checkout tabs, delayed creators and callbacks.
Do not treat elapsed time or closing a dialog as proof that payment failed.

Personal renewal ownership is independent of a payer's organisation affiliation.

**Why:** Passing a member's current organisation to a generic owner-scoped switch
can incorrectly reject their personal renewal, or select the wrong owner lock.

**How to apply:** Derive the lock and quote ownership from the persisted election;
verify current organisation membership only for organisation-owned renewals.

Renewal wording must be friendly and useful to members, not written for admins.
Keep attestation, provider-settlement provenance and unknown historical
commencement explanations out of the member-facing renewal summary.

**Why:** The user explicitly rejected these administrative messages in the
renewal element and requested clear end-user labels.

**How to apply:** Preserve the underlying audit evidence and financial safeguards;
explain the member's next action without exposing internal reservation terminology.

Display renewal dates in UK DD/MM/YYYY format.

**Why:** The user explicitly requested UK dates rather than YYYY-MM-DD in the renewal element.

**How to apply:** Format calendar dates for display only; keep stored dates and payment boundaries unchanged.