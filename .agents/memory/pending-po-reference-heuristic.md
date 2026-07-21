---
name: Pending-PO Xero reference heuristic
description: Why descriptive Xero invoice References must be blacklisted in the pending-PO report, and PostgREST .or() failing on UPDATE
---

The Pending Purchase Orders report cross-checks Xero and treats a non-blank invoice `Reference` as an already-supplied PO number (backfilling it and hiding the row). But our own invoice-creation paths write descriptive references when there is no PO yet (e.g. `'Training Fund top-up'`, `'Membership <year>'`).

**Why:** Rows with those references were silently excluded from the report — invoiced training-fund top-ups awaiting a PO never showed.

**How to apply:** Any new invoice-creation path that sets a default/descriptive Xero Reference must add it to the `looksLikePoReference` blacklist in `api/_lib/pendingPoInvoice.js`, or use a PO-shaped reference only when a real PO exists.

Also: PostgREST rejects `.or(...)` filters on UPDATE requests with a misleading 42703 "column does not exist" error (the same `.or` works on SELECT). Use separate guarded updates (`.is(col, null)` and `.eq(col, '')`) instead.
