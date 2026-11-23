# Staging database for Vercel previews

Vercel **Preview** deployments use a separate Supabase project, `iconnect-staging`
(`skaszwscycbfvfofnifx`, eu-central-1), that holds a point-in-time copy of
production (`iconn-multi-tenant`, `lvmzliemqnieeoruhkik`). Production
deployments and production environment variables are unchanged.

| | Production | Staging |
|---|---|---|
| Supabase project | `lvmzliemqnieeoruhkik` | `skaszwscycbfvfofnifx` |
| API URL | `https://vault.iconn.app` / `https://lvmzliemqnieeoruhkik.supabase.co` | `https://skaszwscycbfvfofnifx.supabase.co` |
| Used by | Vercel Production | Vercel Preview (all branches) |
| Migrations | feature runner pinned to DEST (`scripts/apply-*.mjs`) | `scripts/staging/apply-migration-to-staging.mjs` |

## Refreshing staging from production (any time)

Use this when a bug only reproduces on live data. It replaces **all** staging
data, so tell anyone testing on previews first: staging is shared.

```bash
export PROD_DATABASE_URL=...      # session pooler, postgres.lvmzliemqnieeoruhkik
export STAGING_DATABASE_URL=...   # session pooler, postgres.skaszwscycbfvfofnifx
ICONNECT_STAGING_REFRESH_CONFIRM=skaszwscycbfvfofnifx \
  scripts/staging/refresh-staging-from-production.sh
```

Requirements: `pg_dump`/`pg_restore` 17 or newer, about 1 GB of local disk, and
a staging disk of at least 32 GB (a bulk load writes several times the 3.5 GB
data size in WAL; the default 8 GB disk fills and the database stops).

What it does:

1. Refuses unless both URLs name the expected projects, the confirm variable
   names staging, and the two databases are different clusters.
2. Dumps production read only, from one consistent snapshot: the `public`
   schema (tables, data, functions, triggers, RLS policies, grants), `auth.users`
   and `auth.identities`, `storage.buckets`, and `storage.objects` policies.
3. Empties the staging `public` schema (keeping its default grants), restores,
   and re-adds realtime publication membership.
4. Runs `scripts/staging/staging-safety.sql` (below).
5. Compares exact row counts for every public table; it never prints row contents.
   Differences can only come from rows written after the snapshot.
6. Deletes the local dump; keeps only the count reports.

Takes roughly 15–25 minutes.

### Not copied

- **Storage files** (≈13k objects, 16 GB). Bucket definitions and policies are
  copied; files are not. Records point at production file URLs, so previews
  *display* production images, but uploads go to staging and files deleted
  from a preview are rejected by `fileRepositoryDelete` (it trusts only the
  configured storage origin).
- **Auth sessions/refresh tokens, MFA, audit log.** Users and identities are
  copied, so the same logins work; everyone must sign in again on previews.
- **Edge functions, cron jobs, Auth/SMTP settings, secrets.** Configure on the
  staging project in the dashboard if a test needs them.
- **Migration history** (`supabase_migrations`) — not used by this repo's runners.

## Live side effects: staging safety controls

A raw production copy contains live integration credentials. Previews also
share some Vercel variables with production (Mailgun, `STRIPE_SECRET_KEY`).
`staging-safety.sql` runs after every refresh and:

| Integration | Staging state after refresh | Why |
|---|---|---|
| Xero, QuickBooks, Outlook OAuth tokens | **deleted** | Refresh tokens rotate; a preview refreshing a copied token disconnects production |
| Zoho Campaigns tokens | access/refresh token removed, integration disabled | same |
| Stripe (per tenant) | all features switched to `test` where test keys exist, else disabled | no live charges |
| GoCardless, Xero, QuickBooks, Zoho, Zoom | `is_enabled = false` | no live mandates, invoices, CRM or meeting writes |
| WordPress webhook, floater webhooks | cleared | no outbound calls to live sites |
| `xero_invoice_enabled` setting | `false` | |

Original values are kept in the private `staging_safety` schema (no API access).

**Email** is controlled by Vercel environment variables, not the database.
While the preview Mailgun key is unset, preview email sends fail closed.

### Restoring integrations for development testing

Integrations remain fully available on previews; they are only switched off
after each refresh. To use one again on staging:

- **Preferred:** connect a sandbox/demo account through the app's normal
  integration settings on a preview (Xero demo company, QuickBooks sandbox,
  GoCardless sandbox, Stripe test mode, Zoho test org).
- **Re-enable copied settings** (acts on the real provider account):
  `psql "$STAGING_DATABASE_URL" -v integration=<type> -f scripts/staging/staging-restore-integrations.sql`
  where `<type>` is a `tenant_integrations.integration_type` (for example
  `zoom`, `gocardless`) or `webhooks`. OAuth tokens are not restorable; reconnect.
- **Email:** set a preview-scoped `MAILGUN_API_KEY` in Vercel
  (Project → Settings → Environment Variables → Preview). Use a Mailgun
  sandbox domain or test-mode key while testing with copied customer addresses.

A refresh re-applies the safety controls, so repeat these steps after refreshing.

## Migration workflow

All migrations are tested on staging first, then promoted to production.

1. Write the migration in `supabase/migrations/` and its feature runner as usual.
2. Agree in the team channel who is migrating staging (it is shared).
3. Dry run, then apply to staging:
   ```bash
   node scripts/staging/apply-migration-to-staging.mjs supabase/migrations/<file>.sql
   node scripts/staging/apply-migration-to-staging.mjs supabase/migrations/<file>.sql --apply --review-sha256=<sha>
   ```
   The runner refuses any URL or cluster that is not `skaszwscycbfvfofnifx`.
4. Push the branch; the Vercel preview runs against staging. Test there.
5. **Promotion to production** (separate approval): run the feature's pinned
   DEST runner (`scripts/apply-<feature>.mjs --apply --review-sha256=<sha>`),
   which only accepts `lvmzliemqnieeoruhkik`, then merge and deploy.
6. Record in `replit.md`: which migrations were applied to staging, which to
   production, and which remain pending.

If a staging migration goes wrong, refresh staging from production.

## Preview environment variables (Vercel)

These variables have separate **Preview** values pointing at staging; their
**Production** values are unchanged.

| Variable | Preview value |
|---|---|
| `SUPABASE_URL`, `VITE_SUPABASE_URL` | `https://skaszwscycbfvfofnifx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | staging anon key |
| `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | staging service_role key |
| `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `DEST_DATABASE_URL` | staging pooler URL |
| `GOCARDLESS_ENVIRONMENT` | `sandbox` |
| `MAILGUN_API_KEY` | unset while testing (see Email above) |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | Stripe test keys, or unset |

The stale `conf5` branch-only variables (an old project, `iixnxbicvckncdclfaph`)
were removed.

Who can read the copy: the staging project is in the same Supabase
organisation, so organisation members can see it. Treat it like production data.
