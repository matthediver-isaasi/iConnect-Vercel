---
name: Training fund pending-vs-available balance
description: How self-serve training-fund top-ups track pending (invoice) vs available balance and stay idempotent across two credit paths.
---

Org training-fund top-ups (the "Buy Funds" flow on /Balances) split balance into two columns on `organization`: `training_fund_balance` (spendable) and `training_fund_pending_balance` (invoice purchases awaiting payment). Card purchases never touch pending — they go straight to available on Stripe confirm. Invoice purchases add to pending at creation, then move pending→available when the reconciliation cron confirms the accounting invoice is paid.

**Why:** a purchase is credited from TWO independent paths — the Stripe confirm endpoint (card) and the invoice-payment reconciliation cron (invoice) — and they can race. Double-crediting must be impossible.

**How to apply:**
- Claim + credit + ledger MUST be atomic and lock-safe. Do NOT do read-modify-write on the balance columns in JS (concurrent credits for the same org lose updates). The whole sequence lives in the Postgres function `credit_training_fund_purchase` (compare-and-set on status under a row lock, then `col = col + amount` in-place). Both paths call `creditTrainingFundForPurchase`, which just invokes that RPC — never credit inline. Pending increments at invoice-create time also go through an atomic RPC (`increment_org_training_fund_pending`), not a JS read-add-write.
- Only `payment_method='invoice'` purchases ever decrement `training_fund_pending_balance`; card purchases must not.
- Both UIs (/Balances card + /TrainingFundManagement) read pending straight off the org row; org realtime already exists — broaden its change-detection to fire on `training_fund_pending_balance` too, not just `training_fund_balance`.
- Gated on RBAC key `commerce.balances.buy-funds` (server checks role.excluded_features; client uses isFeatureExcluded).
- Ledger uses TrainingFundTransaction `type='purchase'`.
