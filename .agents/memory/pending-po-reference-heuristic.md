---
name: Pending-PO Xero reference heuristic
description: Why descriptive Xero invoice References must be blacklisted in the pending-PO report, and PostgREST .or() failing on UPDATE
---

The Pending Purchase Orders report cross-checks Xero and treats a non-blank invoice `Reference` as an already-supplied PO number (backfilling it and hiding the row). But our own invoice-creation paths write descriptive references when there is no PO yet (e.g. `'Training Fund top-up'`, `'Membership <year>'`).

**Why:** Rows with those references were silently excluded from the report — invoiced training-fund top-ups awaiting a PO never showed.

**How to apply:** Any new invoice-creation path that sets a default/descriptive Xero Reference must add it to the placeholder blacklist in `api/_lib/pendingPoInvoice.js`, or use a PO-shaped reference only when a real PO exists.

Our own membership invoicing writes `Membership <year> - PO: <po>` when a PO exists — the report must EXTRACT that embedded PO (`extractPoFromReference`) rather than reject the whole reference, else PO-bearing combined invoices never leave the report. Plain descriptive references stay rejected.

Combined invoices can be shared by a membership history row (org or member) and booking/transaction/training-fund rows: the PO captured via the membership flow lives only on the membership row, so the report must propagate it cross-record (match on both xero_* AND accounting_* invoice columns) onto siblings and hide them.

Also: PostgREST rejects `.or(...)` filters on UPDATE requests with a misleading 42703 "column does not exist" error (the same `.or` works on SELECT). Use separate guarded updates (`.is(col, null)` and `.eq(col, '')`) instead.
