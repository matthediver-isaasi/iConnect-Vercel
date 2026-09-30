---
name: Voucher monthly rollup recognition rules
description: How monthly voucher snapshots attribute allocations/usage/refunds/expiry to months, and why re-runs must be deterministic.
---

Monthly voucher snapshots (per tenant+org+month) follow deterministic recognition rules so a recompute always reproduces a closed month:

- **Allocations have NO real ledger row** — "voucher_awarded" is synthetic. Allocated amount is reconstructed as remaining value + debits − credits from the ledger; allocation month = voucher `valid_from ?? issued_at ?? created_at`.
- **Usage is recognised in the EVENT start month**, not the booking/txn month. Value booked for a future event stays in the closing balance but is reported as `reserved_future` (available = closing − reserved).
- **Cancellation refunds branch on timing**: refund month ≤ event month → nets against `used` in the event month (never reported as used); refund AFTER the event month → `reinstated` correcting adjustment in the refund month, so closed months are never rewritten.
- **Expiry** → the voucher's `expires_at` month (mirrors the usage rule), falling back to the txn month when `expires_at` is missing or the expiry-date month was already closed BEFORE the ledger entry was written. Closed-month awareness = `closedMonthCutoffs` ('YYYY-MM' → earliest snapshot `generated_at`), loaded by `loadClosedMonthCutoffs` and threaded through all call paths. Crucially, a recompute of a closed month PRESERVES the original `generated_at` — it doubles as the stable close-instant cutoff; refreshing it would flip expiry attribution and make stored vs recompute drift.
- **Adjustments** → transaction month.

**Why:** finance wants event-date attribution and immutable closed months; any rule depending on "when the snapshot ran" would make reconciliation (stored vs recompute) permanently dirty.

**How to apply:** engine is pure functions (buildMovements/rollupMonth) in `api/_lib/voucherMonthlyRollup.js` with DB wiring alongside; new voucher_transaction types must be added to buildMovements or they fall into a signed-adjustment fallback bucket. Carry-forward: opening = prior snapshot closing when present, else full-ledger replay — both must agree (reconcile endpoint checks continuity).
