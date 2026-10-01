---
name: Event invoice recovery authority
description: Recovery snapshots, existing-invoice evidence, payment ownership and rollout constraints.
---

Event invoice retries must use the durable operation authority, not rerun checkout or reconstruct invoices from today's catalogue.

**Why:** Historical booking rows can omit purchaser and tax provenance. Provider success can also precede failed local linkage. A missing local invoice is not proof that creation is safe. A captured Stripe intent must not acquire multiple accounting settlements through separate booking groups.

**How to apply:** Preserve immutable checkout financial evidence; use persisted provider IDs before mutable references; fence workers and claim payment ownership across groups/sources. Ambiguous historical work requires review. Never recreate after an ambiguous write merely because a remote search is empty or an idempotency retention period elapsed.

Health monitoring must read persisted completed-sweep evidence and eligibility-aware delays, never call Xero or trigger recovery. `needs_review` is not automatic recovery.

**Why:** Monitoring must not consume the quota it monitors; a successful empty sweep differs from a never-run worker, and permitted cooldowns differ from overdue work.