---
name: Commercial sale invoice conversion
description: Integrity rules for converting confirmed Sales quotes into external accounting invoices.
---

Convert a confirmed commercial sale from its accepted quote-version snapshot only. Never recalculate from live catalogue, organisation, event, or contact data. Preserve accepted quantities and exact net/tax/gross minor-unit arithmetic; reject provider representations that would round differently.

**Why:** Provider-native discount and rounding semantics can silently produce ledger totals that differ from the immutable accepted quote. External timeouts and provider switches also make a local read-then-create check insufficient to prevent duplicate or inaccessible invoices.

**How to apply:** Atomically claim one durable conversion command per sale/provider, reuse a bounded collision-resistant provider idempotency key, and keep immutable invoice links per provider. Customer mapping claims need owned cleanup on failure. For providers that calculate tax themselves, read the created invoice back and compare provider net/tax/gross to the snapshot before linking it. Treat prior-provider links as stored history after a switch, not as the active invoice or a reason to suppress a new active-provider conversion.