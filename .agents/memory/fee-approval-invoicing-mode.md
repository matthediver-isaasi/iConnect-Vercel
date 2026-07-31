---
name: Fee approval must not set invoicing_mode
description: Approving membership fees materialises invoicing rows; the mode written there gates the Create Membership workflow action.
---

The rule: any code that materialises a `member_membership_invoicing` / `organisation_membership_invoicing` row as a *side effect* (fee approval, auto-approve) must write `invoicing_mode: 'automatic'`, never `'manual'`.

**Why:** the workflow "Create Membership" action checks the invoicing-mode guard BEFORE the fee-approval guard, and resolves missing rows to 'automatic'. A side-effect 'manual' row silently blocks the action while the run still logged "success" — and with auto-approve there was no admin button to recover (Task-class deadlock, seen in prod).

**How to apply:**
- `organisation_membership_invoicing.invoicing_mode` is NOT NULL — use `'automatic'`, not null. The member table allows null (resolvers treat null as automatic; client tabs display null as automatic).
- Explicit admin choices only come from the settings PUT endpoints, which always write a validated mode.
- Heal script for historic rows: `scripts/fix-fee-approval-invoicing-mode.mjs` (tenant-scoped, dry-run by default, targets DEST).
- `workflow_log` status is now derived from action results (`partial` when any action skipped/failed); status `'skipped'` stays reserved for conditions-not-met (checkOncePerRecord depends on it).
