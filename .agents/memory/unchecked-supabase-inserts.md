---
name: Unchecked supabase inserts hide schema drift
description: Fire-and-forget supabase-js inserts fail silently when columns drift; check the error and surface it.
---

Supabase-js never throws on insert failure — it returns `{ error }`. A fire-and-forget insert whose error is never inspected will fail silently forever when the payload drifts from the real table (wrong column name, missing NOT NULL column).

**Why:** The booking-flow `program_ticket_transaction` account-charge insert used a non-existent `value` column and omitted NOT NULL `program_name`; because the error was never checked, the table sat completely empty in prod for the feature's whole life and nobody noticed until an invoice audit.

**How to apply:** For any side-effect insert in a larger flow, always capture `{ error }` and record it somewhere admin-visible (debug blob, marker column like `booking.xero_invoice_error`). When writing such an insert, verify the column list against the live table (information_schema or a probe select), not against similarly-named tables. Same class of bug as sendEmail() never throwing.
