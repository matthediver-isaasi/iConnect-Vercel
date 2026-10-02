---
name: Event invoice recovery authority
description: Recovery snapshots, existing-invoice evidence, payment ownership and rollout constraints.
---

Event invoice retries must use the durable operation authority, not rerun checkout or reconstruct invoices from today's catalogue.

**Why:** Historical booking rows can omit purchaser and tax provenance. Provider success can also precede failed local linkage. A missing local invoice is not proof that creation is safe. A captured Stripe intent must not acquire multiple accounting settlements through separate booking groups.

**How to apply:** Preserve immutable checkout financial evidence; use persisted provider IDs before mutable references; fence workers and claim payment ownership across groups/sources. Ambiguous historical work requires review. Never recreate after an ambiguous write merely because a remote search is empty or an idempotency retention period elapsed.

Health monitoring must read persisted completed-sweep evidence and eligibility-aware delays, never call Xero or trigger recovery. `needs_review` is not automatic recovery.

**Why:** Monitoring must not consume the quota it monitors; a successful empty sweep differs from a never-run worker, and permitted cooldowns differ from overdue work.

The user clarified that the sweep's purpose includes creating missing historical invoices, not merely identifying them. A missing checkout snapshot alone must not be treated as permanently unrepairable when original booking/provider evidence can support recovery.

**Why:** A discovery-only historical sweep did not meet the intended product requirement.

**How to apply:** Reconcile existing provider invoices first, reconstruct from verified evidence under an explicit accounting policy where necessary, then use the same fenced writer. Keep genuinely ambiguous tax, purchaser, payment and duplicate cases distinct from recoverable failures.

Historical Stripe lookup may find a payment in test mode while the tenant currently uses live mode.

**Why:** The fallback between Stripe modes can successfully retrieve test payments from real booking rows; a successful capture alone does not prove live settlement.

**How to apply:** Verify provider livemode before posting live accounting settlement; never reinterpret test payments as live receipts.

Use Xero's normal invoice numbering, not the internal recovery identifier.

**Why:** The user explicitly requested correcting recovery invoices whose internal event hashes appeared as customer-facing invoice numbers. Existing paid invoices must be renamed in place, never recreated or repaid.

**How to apply:** Keep duplicate-prevention identity separate from numbering and retain provider invoice/payment IDs. Xero auto-numbering on creation does not establish that omitting the number on an update regenerates it; do not experiment on paid invoices.