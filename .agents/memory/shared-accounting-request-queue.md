---
name: Shared accounting request queue
description: Agreed direction for central invoice recovery across Xero and QuickBooks.
---

The user approved a central durable accounting-request queue for both Xero and QuickBooks invoices, rather than feature-by-feature sweeps reconstructing failed invoices.

**Why:** Same-day GoCardless collection notifications can produce accounting bursts. Saving original invoice details and iConnect source links gives recovery one authoritative source.

**How to apply:** Persist requests before provider calls; retain original financial details and intended provider/company binding. Track invoice creation, local linkage and payment posting independently, with provider-specific cooldown and ambiguous-outcome reconciliation. Include QuickBooks from the outset, not as a later Xero-only extension. This is an agreed design direction, not authorization by itself to implement or migrate.