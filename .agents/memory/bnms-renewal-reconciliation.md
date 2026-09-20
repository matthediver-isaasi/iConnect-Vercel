# Alpha live configuration comparison

An unchanged membership configuration may receive a new top-level `updated_at` during unrelated maintenance. Compare every economic, eligibility, identity and effective-date field, excluding only that audit timestamp; preserve the original immutable manifest/evidence hash. Never generalize this exception to nested timestamps or other fields. Test actual pricing/eligibility drift still blocks adoption.

---
name: BNMS renewal reconciliation scope
description: Agreed scope and evidence boundaries for BNMS migration review spreadsheets.
---

**Historical invoice identity lesson:** Live Xero can contain two distinct invoice IDs with the same invoice number, even both marked paid. For existing GoCardless history, resolve with the exact Xero payment Reference matching the provider payment ID plus verified contact, amount/currency and period; invoice number or paid status alone is not ownership proof. Reject multiple exact matches rather than guessing. Future BNMS alpha tooling must enforce full historical-invoice identity coverage and explicitly block missing matches (see the brief near the top of replit.md).

Reconcile one exact `member_class` at a time, beginning with invoices dated within the last twelve months. Deliver one Excel workbook with exactly two sheets: ready-to-set-up members and members needing completion. Use the same columns on both, with editable business fields, fixed-choice dropdowns, in-cell guidance and concise missing-information checklists, not separate evidence tabs.

**Why:** The user chose class-by-class review because structures have different nominal codes and billing patterns, then requested a simpler completion template that can be returned for a controlled import. Broad historical candidate lists obscured recurring invoice series and counted copies from multiple sources separately.

**How to apply:** Inspect the selected structure's actual nominal code, including dated versions and band overrides, and compare it with invoice-line AccountCode evidence. Never substitute a generic sales fallback as proof of membership. Deduplicate invoice identities across live and exported evidence, and distinguish monthly invoice sequences from competing annual invoices. Preserve missing-code and unavailable-provider evidence explicitly; descriptions alone are provisional. Reporting does not authorise membership or provider mutations.

Budget Xero evidence gathering: a large migration review plus repeated per-invoice revalidation can exhaust the provider quota. Respect Xero's `Retry-After`, preserve pinned staged progress, and never bypass a fresh required check merely because rate limits interrupt the review.