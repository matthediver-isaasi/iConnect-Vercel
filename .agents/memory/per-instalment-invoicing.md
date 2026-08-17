---
name: Per-instalment monthly membership invoicing
description: Invariants of the opt-in invoice-per-instalment mode for monthly membership plans (GC DD + Stripe card).
---

# Per-instalment monthly membership invoicing

One tier-level invoicing mode ('annual' default | 'per_instalment') applies to BOTH GC DD and Stripe monthly card plans, and is **snapshotted at consent** into the billing-agreement terms — tier changes never affect running plans.

**Rules:**
- 'posted' means invoice created AND payment recorded at the provider. An invoice whose payment couldn't be recorded gets a recoverable "unpaid" status with the invoice linkage kept; retries only re-apply the payment, never re-create.
- Duplicate protection is three layers: (1) an atomic CAS claim to an in-flight status on the local row before any provider call — losers of the race bail; (2) deterministic provider-side idempotency keys derived from the payment identifier (Xero Idempotency-Key / QBO requestid) on BOTH the invoice-create and the separate payment-create requests — crash-after-create AND crash-after-payment replay instead of duplicating; (3) linkage-before-create — a row already linked to an invoice never creates again.
- Each rail's payments must be strict about its own bank-account setting: never fall back to another rail's account, or money is booked to the wrong account and the unpaid-recovery state never triggers.
- Crashed in-flight claims are reclaimed only by the reconcile crons, and only once stale (~15 min), and only for per-instalment rows — retrying annual-mode payment application risks double-applying.
- Per-instalment memberships must NEVER get an annual invoice: every path that invoices an existing membership row must consult the shared suppression check, which FAILS CLOSED — lookup errors/missing agreements throw and callers must withhold the invoice (skip/5xx); only an explicit pre-migration schema error preserves legacy behaviour. New-row paths are covered by (org, year) duplicate guards.
- Each payment rail names its own bank-account setting key for recording the payment; missing setting is exactly what produces the unpaid-invoice state.

**Why:** some clients require one accounting invoice per monthly collection; opt-in so the default annual-invoice + part-payments behaviour is untouched.

**How to apply:** any new annual-invoice path must run the suppression check; any new monthly settle path must route through the shared posting helpers (claim + idempotency key + payment-recorded gating), never mint invoices ad hoc.
