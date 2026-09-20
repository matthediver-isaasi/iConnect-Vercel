---
name: Payment report evidence
description: Why saved payment rows alone cannot establish all upcoming membership collection dates.
---

Do not relax provider-environment checks to make legacy GoCardless payment rows appear in a report.

**Why:** Some existing writers omit the payment environment (leaving a sandbox default even for live plans), and ordinary pending mirrors may lack charge dates. A persisted-only report therefore cannot reliably cover fixed GoCardless or Stripe schedules. Missing evidence must remain unavailable rather than borrowing renewal dates.

**How to apply:** Use verified, tenant-owned provider reads where persisted evidence is incomplete, with bounded caching and explicit unavailable results. Repair upstream mirror provenance separately; do not infer a payment's environment solely from its parent.