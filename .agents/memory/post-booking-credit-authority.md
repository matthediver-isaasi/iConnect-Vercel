---
name: Post-booking credit authority
description: Local recorded credits, reversal overlap, and revenue boundaries
---
The Event Registration Report uses successful post-booking monetary credits recorded in iConnect. No local record means zero, with “No credits recorded in iConnect”; a legacy credit reference without an amount remains “Amount not recorded”. Database failures remain errors.

**Why:** The user explicitly rejected provider-wide completeness and checked-empty requirements. This supersedes the earlier requirement to prove absence at Stripe/Xero/QuickBooks. Already recovered successful amounts must remain usable without another external check.

**How to apply:** Report interactions must only read local data. Do not reintroduce historical discovery, verification coverage, or provider refresh. Preserve independent completion of known pending financial operations. Pending/failed actions neither count nor suppress unrelated successful amounts.

Provider-linked records with an unresolved outcome are not equivalent to failed or pending actions, even when a monetary amount is present.

**Why:** Cancellation capture can retain an amount alongside an unrecognized outcome. Ignoring that record would falsely establish zero and overstate revenue.

**How to apply:** Keep the local outcome explicitly unresolved and block a definitive aggregate until its recorded state establishes success or non-application; do not introduce report-driven provider lookups.

A refund and an accounting note can describe the same reversal. Matching totals alone are not proof of linkage. Preserve operation linkage, tenant/source boundaries, group allocation, and currency safeguards; unknown local allocation or overlap must not become a complete total.

**Why:** Consolidated and linked instruments otherwise double count, while historical references may not identify the applicable booking allocation.

**How to apply:** Never infer amounts from cancellation status, booking value, checkout vouchers/training funds, account settlement, or general balances. QuickBooks payment links establish memo identity, not the invoice-specific applied amount.

Event Registration Report revenue is booked value less locally recorded post-booking credits, not cash received.

**Why:** The user separates revenue from settlement. Ordinary local no-credit rows must no longer make revenue unavailable.

**How to apply:** Retain standard/complex discount semantics; deduct the group credit once. Unknown local amounts and incompatible currency still prevent a definitive revenue total.

Cancellation credit amounts are gross, including tax. Partial credits without
original invoice-line allocation must not guess between different tax,
accounting or tracking treatments; require review for those cases.

**Why:** Treating the gross cancellation amount as a tax-exclusive credit line
over-credited a VAT-bearing ticket. A single requested amount cannot establish
which tax treatment applies to a partially cancelled mixed invoice.

**How to apply:** Use the original provider invoice's tax evidence, preserve its
lines for full credits, and validate returned gross/tax totals before allocation.
Correcting future creation does not authorize editing existing credit notes.
