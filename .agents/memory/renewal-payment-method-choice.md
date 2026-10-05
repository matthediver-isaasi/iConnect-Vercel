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