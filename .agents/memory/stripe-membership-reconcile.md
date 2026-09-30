---
name: Stripe membership payment settlement invariants
description: Exactly-once rules and pitfalls for membership card payment recording (fee-token and form flows)
---

Membership card paid-marking has multiple concurrent settlers (client confirm, per-tenant Stripe webhook, cron retry, admin reconcile). Durable invariants:

**Exactly-once rule:** every unpaid→paid transition must be a CONDITIONAL update (guard on current status, and on PI stamp being null-or-same), and the paid workflow may fire only when that guarded update actually changed a row. In-memory row snapshots are stale by design — never fire side effects from a snapshot's before-status alone.
**Why:** confirm flows stamp the PI on the history row before marking it paid and reconcile later from a stale snapshot; a webhook landing in that window otherwise double-fires member communications.
**How to apply:** any new path that settles a membership payment must route through the shared reconciliation helpers (guarded transitions + shared workflow firer), not hand-rolled updates.

Other durable lessons:
- A PI-stamped-but-unpaid row means "confirm crashed mid-flight" — it must be repairable, not treated as already recorded; only settled (paid/voided) rows are terminal. A row stamped with a *different* PI is a conflict — never overwrite.
- A webhook can arrive before the confirm flow has created any history row. Recoverable outcomes must stay pending (non-2xx so the provider redelivers) with a cron sweep as final backstop; never invent a history row from webhook metadata.
- Mode-flip pitfall: admins can flip the membership Stripe test/live mode while payers are mid-checkout; the open page keeps the old mode's client secret and single-key PI retrieval fails `resource_missing` on a charged intent. Verify PIs via the cross-mode retrieve helper in the Stripe credentials lib.
- Messaging rule: once a PI is verified succeeded, every rejection path must log a distinct confirm-failure marker and tell the payer the charge succeeded and will be reconciled ("do NOT pay again") — never a generic failure. Fee-token confirm validates via the PI's own metadata token binding, not the last PI stamped on the token (page re-init stamps newer PIs).
- Per-tenant webhook signing secrets live in the Stripe tenant_integrations credentials; the endpoint refuses (503) until the tenant registers it in their Stripe dashboard.
