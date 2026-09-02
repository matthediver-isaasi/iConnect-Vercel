---
name: Manual membership activation atomicity
description: Safety boundary for approving manually gated payment-plan memberships.
---

Manual membership approval must be one tenant-scoped database transaction that locks the payment plan and agreement before changing membership access, and writes the audit event in that same transaction.

**Why:** Separate pre-checks, membership updates, and best-effort audit inserts allow cancellation races, cross-tenant linkage mistakes, or unaudited access grants.

**How to apply:** For any admin approval path that grants membership access, verify the persisted activation rule and non-terminal plan/agreement state while locked; scope every linked row by tenant; commit activation and audit together.