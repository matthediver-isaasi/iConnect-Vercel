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