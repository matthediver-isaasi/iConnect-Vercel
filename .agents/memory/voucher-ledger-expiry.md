---
name: Voucher ledger expiry & new-column fallbacks
description: Adding a voucher_transaction type or voucher column touches several sign/label/select surfaces; env drift needs 42703 fallbacks.
---

- A new `voucher_transaction.type` (e.g. `expiry`) must be added in FOUR sign/label places or amounts render wrong: export-csv NEGATIVE_TYPES/POSITIVE_TYPES + formatTransactionTypeLabel, export-csv net-by-voucher loops, admin ledger buildUsageDescription (api/admin/voucher-transactions/index.js), and client formatTransactionType in VoucherManagement.jsx.
- New voucher/voucher_transaction columns must be threaded through the export's flag-driven selects (`voucherColFlags`/`voucherSelectCols`, txn select) with 42703 drop-and-retry — the dev workspace runtime DB is the stale legacy SOURCE and lacks new columns even after DEST is migrated.
- FEFU redemption ordering (expires_at asc, then issued_at asc) is duplicated in api/functions/[functionName].js and api/public/complex-event-booking.js; keep both in lockstep. FEFU is the DEFAULT only — an explicit manual-order flag in the booking payload preserves client order and records the override in txn `notes`.
- Finance-mutating crons must fail CLOSED when CRON_SECRET is unset (500), unlike older crons that fail open.
- **Why:** signs/labels are switch-based with silent defaults, so a missed surface shows a wrong-signed or unlabeled amount without erroring.
