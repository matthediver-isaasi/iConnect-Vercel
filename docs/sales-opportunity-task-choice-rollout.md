# Opportunity task choice at creation — schema rollout (PENDING APPROVAL)

Migration: `supabase/migrations/202702020001_sales_opportunity_task_choice.sql`
SHA-256: `020a51419c4e364764558887dc98d934ed123e44ec90990c15009b5a8cc19d5f`
Destination: DEST (`lvmzliemqnieeoruhkik`) only. Not applied by the implementing task.

## What it changes
- Adds service-only table `sales_opportunity_board_attachment` (no FK to boards),
  backfilled from current links. It records that an opportunity has had a board,
  so deleting a linked board cannot reopen board setup.
- Adds `sales_project_attach_board` (shared create/link logic, previously inline).
- Adds `create_sales_opportunity_with_project` — opportunity + private board (or
  link to an eligible board) in one transaction; any failure leaves nothing behind.
- Replaces `change_sales_project` (same signature) so task settings are locked:
  `mode` and `unlink` are always rejected (`55000`); `create`/`link` only for a
  legacy project-mode opportunity with no linked board.
- All functions and the new table are service-role only. No existing table, row or link is modified.

## Predecessor check (read-only, 2026-11-26)
Live `change_sales_project` and `list_sales_project_boards` bodies matched
`202610090001_sales_project_tasks.sql` exactly (md5 of prosrc). Re-check before
applying; stop if they differ.

## Behaviour before the migration is applied
- Standard-task creation is unchanged (direct insert).
- The API already enforces the lock, so the Tasks tab cannot change mode, unlink
  or relink. The legacy one-time create/link is unavailable (fails closed) until
  the attachment table exists.
- "Create a new project board" / "Link to an existing project" return a clear 503
  until the new function exists.

## Apply sequence (after explicit owner approval)
1. Re-verify predecessor bodies and the file hash above.
2. Rehearse the body in a transaction ending in a forced error; confirm nothing persisted.
3. Apply once; verify signatures, grants (service_role only) and that
   `change_sales_project` rejects `mode`.
Do not replay historical migrations.

## Verification
- `node --test api/_lib/salesOpportunityTaskChoice.postgres.test.mjs` (disposable PostgreSQL)
- `node --test api/_lib/salesProjects.test.mjs api/opportunities/index.test.mjs`
- `node --test client/src/components/sales/OpportunityTaskChoice.test.mjs`
