---
name: Advance/scheduled membership invoicing invariants
description: Rules any "pre-create a future membership year" feature must follow so the renewal cron neither double-invoices nor activates an unbilled year.
---

# Advance / scheduled membership invoicing invariants

"Invoice Now" (advance org invoicing) pre-creates a future-year `organisation_membership_history` row (`status='scheduled'` + `scheduled_activation_date`) and the renewal cron later flips it to `active` without re-invoicing. Three invariants keep this safe:

1. **One history row per `(org, membership_year)` is the duplicate guard.** The renewal cron decides whether to invoice based on whether a record for that year exists — the existence check is status-agnostic, so a `scheduled` (or `active`) row already blocks a second invoice. Never create more than one row per org/year (a unique index enforces it; handle `23505`).

2. **A pre-created row must NEVER be left behind without a linked invoice.** If invoice creation fails, the advance handler must roll the row back (delete) and return an error — otherwise the cron would later activate a membership year that was never billed. Defense in depth: cron activation also skips any `scheduled` row with no linked invoice.
   **Why:** a non-fatal "invoice failed but row stays" path produces a silent billing gap (active, unbilled membership) — flagged in code review and explicitly designed against.

3. **Invoice-linkage checks must be provider-agnostic.** Check both `xero_invoice_id` AND `accounting_invoice_id` (QuickBooks sets only the latter). Checking only `xero_invoice_id` causes QBO advance rows to be re-invoiced by the cron. The same applies to UI "invoice sent" gating — gate on actual linkage, not `status==='scheduled'`.
