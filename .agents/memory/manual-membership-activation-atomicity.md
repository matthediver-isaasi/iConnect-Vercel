---
name: Manual membership activation atomicity
description: Safety boundary for approving manually gated payment-plan memberships.
---

Manual membership approval must be one tenant-scoped database transaction that locks the payment plan and agreement before changing membership access, and writes the audit event in that same transaction.

**Why:** Separate pre-checks, membership updates, and best-effort audit inserts allow cancellation races, cross-tenant linkage mistakes, or unaudited access grants.

**How to apply:** For any admin approval path that grants membership access, verify the persisted activation rule and non-terminal plan/agreement state while locked; scope every linked row by tenant; commit activation and audit together.

BNMS wants automatic activation on first successful payment across its
membership schedules, not mandate-only activation or manual approval.

**Why:** The owner explicitly requested first-payment approval on all BNMS
schedules after reviewing a paid monthly-card membership awaiting activation.

**How to apply:** Preserve that policy for new BNMS schedule configurations.
Existing agreements retain their saved activation rules; resolve exceptions
through explicit, audited approval rather than silently rewriting consent
snapshots or initiating collections. Do not impose this tenant policy on others.