# Catalogue visibility and duplication rollout

## Database changes

Both migrations were applied to the verified destination Supabase project
`lvmzliemqnieeoruhkik` using `scripts/apply-sales-catalogue-visibility.mjs`:

- `202610130002_sales_catalogue_atomic_create.sql`
- `202610180001_sales_catalogue_visibility.sql`

Reviewed combined SHA-256:
`afc2c8f50a7f1b222277c5e44536cf300b327a56e36225617f223394bef2ea93`

The runner pins both REST and SQL destination identities, verifies TLS with the
provider CA, applies both files in one transaction, and checks the boolean
columns/defaults and service-only function grants before committing.
The legacy workspace SOURCE database was not changed. No migration remains
pending for this implementation on DEST. No production deployment was performed.

Schema must precede code: settings reads explicitly select the two new columns.
The visibility migration extends the installed settings function with guarded
anchors rather than overwriting its other settings, row locking, first-insert
serialization, version conflict handling, or audit. Independent settings work
must preserve these branches and use the shared `useSalesSettings` discovery;
do not reintroduce a separate quote-task settings cache.

The create function is restricted to the server's service role. Product/bundle
creation and audit, including ordered bundle components, commit together. Normal
edits are intentionally outside this new transaction path. The preferences are
presentation choices, not access controls or API redaction.

## Verification boundary

- Contract/API tests use injected data and deny outbound connections.
- PostgreSQL tests create and destroy disposable databases using Unix sockets;
  they do not use destination data or providers.
- Mounted UI tests use real React/QueryClient with fixture requests, including
  all flag combinations, shared settings versions, retained drafts, tenant
  switching, stale reads, duplication, cancellation and save errors.
- Browser fixtures exercise the real product dialog on desktop and mobile with
  fixture tax options and compiled application CSS.
- The production build passed.
- The application workflow restarted and serves port 5000. The unauthenticated
  workspace screenshot returned `Tenant not found` from the existing local
  tenant setup; it did not verify signed-in Sales screens. Authentication was
  not bypassed, and SOURCE was not migrated to make the preview work.
- The broader Sales hardening suite passed its foundation, catalogue, quote,
  allocation and delivery sections. Its accounting section's assertions passed,
  but the isolation guard correctly failed the file because its existing role
  overlay attempted an outbound request. Reports and navigation checks passed
  separately. This is not evidence of live accounting/provider verification.

No live tenant product, bundle, settings, quote, invoice, payment or provider
operation was performed as part of functional verification.
