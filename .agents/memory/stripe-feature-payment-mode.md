---
name: Stripe feature mode for shared payments
description: How shared payment flows consistently select per-feature Stripe live/test credentials.
---

A shared payment flow that serves multiple products must derive its Stripe feature from the server-resolved payment purpose, use the same feature for provider discovery and intent creation, and persist it for later confirmation.

**Why:** Per-feature live/test toggles can point at different Stripe accounts. Re-resolving confirmation from a generic feature or current UI state can make a valid PaymentIntent invisible, especially when an administrator changes modes during checkout.

**How to apply:** Whenever another product uses a shared Stripe endpoint, validate the discovery purpose, derive the authoritative purpose again during creation, and store that feature with the pending payment. Confirmation, reconciliation, and same-key retries should use the stored feature with opposite-mode lookup. A retry must reuse the original intent and its matching publishable key, or cancel it through its original account before replacement.