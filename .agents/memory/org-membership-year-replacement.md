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
**How to apply:** the schema is installed on DEST (2026-11-25); never replay the source file.

Annual rows whose structure has start_mode 'immediate' cannot be replaced: the existing rolling_commitment_guard rejects the replacement INSERT without a dated commitment.
**Why:** the guard treats any new immediate-config history row as needing an authoritative commitment, even for annual years.
**How to apply:** fixing this needs a narrow guard exemption tied to the replacement journal, not a weaker guard.

An original invoice already credited outside the app (e.g. a manual Xero credit note) may be adopted only by explicit admin confirmation of that exact credit note, and only when it is unambiguous: the single credit on the invoice, fully crediting the gross, not applied elsewhere, no cash paid, not linked to another record. Partial or shared credits stay blocked for accounting review. Owner asked for this on 2026-11-25.
**Why:** finance sometimes raises the credit note manually before the admin replaces the year; creating a second one would double-credit.
**How to apply:** the adopted note is carried in the operation's invoice snapshot and re-verified at sync; never create a new credit note when the invoice already shows credit.
