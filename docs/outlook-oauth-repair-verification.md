# Outlook OAuth repair verification

## Destination evidence — 2026-09-23

Read-only PostgreSQL inspection used the existing destination pin and verified
Supabase TLS CA, targeting DEST project `lvmzliemqnieeoruhkik`, not SOURCE.
The table had none of `health_state`, `health_error`, or `health_checked_at`.
A separate REST projection returned SQLSTATE `42703` for `health_state`.
The callback writes these fields on both insert and update, so the deployed
destination schema is incompatible with those writes.

The table has a primary key and unique `(tenant_id, identity_id)` constraint.
No identity foreign key was present. No connection credentials or profile data
were selected. The repair preflight counted six connections.

This establishes a concrete persistence defect, but does not identify which
branch the original GSF request reached. Vercel connector requests returned
403, so historical callback logs and the live deployment's environment target
could not independently be inspected. DEST is the production target documented
by this project; it must not be confused with the workspace's legacy SOURCE.

## Migration status

Prepared: `supabase/migrations/20261121_outlook_health_columns_repair.sql`.
It repairs the missing authorization-health model from
`20260830_outlook_graph_authorization_health.sql` with repeatable constraint
creation and preservation of existing health metadata.

SHA-256: `ebcdd0ef8ea24a88def01b379a4a12f2b756045a28af1693b011c0356ca94d5e`.

- Applied to DEST: **approved and applied on 2026-09-23** using the exact
  reviewed hash above. Transactional verification found three columns, one
  health constraint and zero invalid health states. Post-commit read-only
  verification found all six existing connections retained, with six health
  states initialized.
- Applied to SOURCE: **none**.
- Pending migrations for this repair: **none**. Normal application deployment
  and authenticated live OAuth verification remain outstanding.

Read-only preflight:

```sh
node scripts/apply-outlook-health-columns-repair-migration.mjs --preflight
```

Approved apply command used:

```sh
node scripts/apply-outlook-health-columns-repair-migration.mjs --apply --review-sha256=ebcdd0ef8ea24a88def01b379a4a12f2b756045a28af1693b011c0356ca94d5e
```

## Verification boundaries

- Isolated handler tests cover first connection, both reconnect lookup paths,
  all four persistence failures, cancellation, invalid/expired state, nonce
  mismatch, unsafe paths/hosts, and `gsf.dev.iconn.app`.
- Mounted UI tests cover success/status loading, retry, callback messages,
  retained query/hash values and failed status reloads.
- Disposable PostgreSQL tests cover migration replay, metadata preservation,
  connection/token preservation, and original scope-based backfill.
- Public HTTP checks: GSF `/admin/settings` returned 200; `/settings` returned
  404. HTTP 200 alone does not establish authenticated settings functionality.
- Local preview starts and renders the tenant-admin login screen. It cannot
  establish a real Outlook connection; the local legacy tenant lookup also
  reports a missing tenant.
- No Microsoft account was connected and no messages were sent. The only live
  connection changes were the approved migration's health metadata backfill;
  its SQL does not modify credentials, account identity or sync settings.

Still required: deployed code verification and the user's interactive
Microsoft authorization followed by authenticated status
reload on GSF `/admin/settings`. Do not describe fixtures as live OAuth proof.