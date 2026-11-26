---
name: Xero invoice readback projections
description: Compare the same invoice endpoint projection when verifying tracking-only updates.
---

Verify before/after invoice changes using the same Xero endpoint shape.

**Why:** The invoice-list endpoint can return empty Payments/CreditNotes and zero AmountCredited while by-ID omits them; by-ID also adds line ValidationErrors. Raw comparisons across these endpoints can falsely report financial changes.

**How to apply:** Compare matching endpoint projections or normalize known optional metadata explicitly. Preserve and verify line amounts, tax, accounts, references and payment evidence when changing tracking only.
