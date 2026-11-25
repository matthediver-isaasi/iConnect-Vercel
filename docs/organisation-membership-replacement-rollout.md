# Organisation membership year replacement — schema rollout

## Installation
- Source: `supabase/migrations/202701300001_organisation_membership_replacement.sql`,
  SHA-256 `c4b1767f3ff0d557f79a8a33db51472ea09e8246c1bd52bb9a86423951f6c7b8`.
- Owner-approved and installed once on verified DEST (`lvmzliemqnieeoruhkik`) on
  2026-11-25 through the managed migration path. Deployment version `20261125140602`.
- The install ran in a guard block. It took an advisory lock and refused to run if the
  journal table or RPC already existed, so the file could not be replayed. **Do not replay
  the source file.**

## Pre-install evidence (read-only)
- 376 organisation history rows, 0 with status `replaced`. Lineage columns, the journal
  table and the functions were absent.
- The live uniqueness indexes and the `rolling_no_overlap` exclusion also carried
  `cancelled_for_switch_at IS NULL`. The migration keeps that condition and only appends
  `status IS DISTINCT FROM 'replaced'`.
- `btree_gist` and `pgcrypto` were present.
- A rollback-only rehearsal against DEST, which ended in a deliberate RAISE, completed every
  step. Afterwards no objects or migration-history rows remained.

## Post-install verification
- The five lineage columns exist. All four index/constraint predicates exclude `replaced`
  rows. The guard trigger is enabled. RLS is on for `organisation_membership_replacement`.
- service_role can only SELECT from the journal table, plus the column-limited UPDATE. The
  RPC is executable only by service_role; anon and authenticated have no access.
- Row count is unchanged at 376. No row is replaced or linked, and the journal is empty.
- PostgREST: a journal read returned 200 and an empty list. An invalid RPC call reached the
  function and returned its own `22023` validation error, so nothing was written.

## Not verified
- End-to-end Replace preview/execute against a Xero/QuickBooks **sandbox** tenant was not run,
  because no sandbox tenant was provided. Execute creates real credit notes and invoices.
  Preview reads live provider invoices and can refresh provider tokens, so it was not run
  against customer tenants either.
- Known limitation: 19 existing annual (`term_key IS NULL`) organisation rows use a
  structure with `start_mode = 'immediate'`. The existing `rolling_commitment_guard`
  rejects an INSERT for such a config without a dated commitment, so Replace fails for them
  inside the RPC before any provider call.
- Matching API/UI code must still be merged and released. Nothing was deployed, and no
  membership, invoice, email or provider action occurred.

## Rollback
See the header of the migration file. Rollback is only possible while no `replaced` rows exist.
