---
name: Organisation membership year replacement
description: Financial rules and pitfalls for replacing a recorded organisation membership year (credit note + new invoice for the same period).
---
- The replaced original keeps its dates and invoice; the replacement covers the identical period. Every reader that picks "the" year row must ignore `replaced` rows.
- Approved financial rules: credit the full original gross; unpaid part clears the original, paid part moves to the new invoice; surplus stays unallocated credit (no automatic refunds).
- Credit notes must equal the approved gross exactly before any allocation. QuickBooks credit memos carry one tax code, so mixed-VAT QBO invoices are blocked; QBO has no AmountCredited, so prior credits need explicit discovery and unknown evidence blocks.
- Re-pricing must ignore the row being replaced, or year-one pro-rata/incentives silently disappear.
- Blocked by design: rolling terms, proposal/quote/funnel years, Training Fund add-ons, drafts, already-credited invoices, provider mismatch, active DD/card plans.
**Why:** duplicate or wrong-value documents in Xero/QuickBooks are costly to unwind; owner rule is never refund automatically.
**How to apply:** applying the schema change to the destination database needs owner approval.
