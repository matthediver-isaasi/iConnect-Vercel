# BNMS domain recovery — 2026-09-18

## Verified cause and live correction

The active BNMS tenant (`slug=bnms`, ID `ff2df806-b321-4254-b651-3af11fccf1db`)
had `domain=60-years-of.bnms.org.uk` in the production destination database.
Neither `bnms.org.uk` nor `www.bnms.org.uk` matched another tenant.
The resolver strips the `www.` prefix, so the required canonical application
mapping is `bnms.org.uk`.

Both requested hostnames were already verified production domains on Vercel
project `vite-migrate-replit-6` (`prj_iPFlb9rOOVNVtbobMRR1vyV934lf`), under
team `isaasi`. Their aliases both pointed at production deployment
`dpl_B5jRTCDnQYJ1SAq7cMoFxrDM9G8w`. The apex already redirected to www with
HTTP 308. No transfer was needed.

Changed **one row, one application field** in the destination Supabase project
`lvmzliemqnieeoruhkik`: BNMS's `tenant.domain` from the anniversary hostname
to `bnms.org.uk`. The transaction pinned the destination REST and SQL project
identities, validated BNMS's ID/name/slug/active status and expected old value,
locked tenant writes for the uniqueness check, and used a conditional update.
TLS certificate validation was enabled for the database connection.

No schema migration was needed or applied. No source/legacy database changes.
No hosting, DNS, environment-variable, redirect, or certificate writes were
made by this recovery.

## Public verification

Before the correction, www branding and public settings returned
`404 {"error":"Tenant not found"}`. Available Vercel runtime logs also showed
the domain lookup failing with `PGRST116`.

After the correction, without tenant override parameters:

| Entry hostname | Branding | Public settings | Navigation |
| --- | --- | --- | --- |
| `bnms.org.uk` (follows existing www redirect) | 200, BNMS | 200, 16 settings | 200, 65 items |
| `www.bnms.org.uk` | 200, BNMS | 200, 16 settings | 200, 65 items |
| `bnms.iconn.app` | 200, BNMS | 200, 16 settings | 200, 65 items |

Each corresponding endpoint returned identical response hashes across all
three hosts. Read-only Chromium checks loaded all three entry addresses:
page title BNMS, BNMS logo/navigation/footer, and the configured “Our new
website is coming soon” homepage with the Annual Autumn Meeting card.
No page errors or failed public API responses were observed. The wildcard
homepage resolves to the canonical www address; its direct public APIs work.
A separate public screenshot confirmed the rendered homepage.

The requested project-domain records, including their modification timestamps,
redirects, verification flags, and production targeting, were identical before
and after. Both HTTPS certificates validated for their respective hostnames.

DNS observations before and after were unchanged:

- Apex A: `216.150.1.1`; no apex AAAA or CNAME.
- www CNAME: `d9e9af9885944d2b.vercel-dns-017.com`; observed IPv4 answers
  `216.150.16.193`, `216.150.1.193`.
- Nameservers: `ns1.ymaws.com` through `ns4.ymaws.com`.
- Existing TXT responses were unchanged; no verification records were added.

No new DNS action is required from BNMS. Administrator-facing DNS requirements
must remain unchanged.

## Registration diagnosis and limits

The source registration flow attempted POST attachment before checking the
existing target attachment, then tried automatic reclaim. Its discovery skipped
the configured project and mapped several failures to the same transfer advice.
It also swallowed provider exceptions before saving the application mapping.

The Vercel project exposes system environment variables. Environment metadata
showed an application `VERCEL_API_TOKEN` but no explicit project/team overrides.
The separate Replit Vercel connector could read the correct project with and
without an explicit team scope. This does **not** establish the application's
token permissions; no secret values were retrieved.

The available runtime-log stream did not contain the original failed
registration request. Therefore its precise provider failure branch or
application-token scope remains unverified. The confirmed public outage cause
is the incorrect application mapping, not incorrect DNS or hosting ownership.

During read-only before/after checks, the anniversary hostname's Vercel record
was independently changed to redirect to www. This recovery issued no provider
mutation requests. The requested apex/www attachments did not change.

## Rollout boundary

The database correction is live and works with the existing production
deployment. Registration safeguards are a separate source-code change; this
recovery does not promote a development deployment or publish unrelated work.

Source safeguards now read the configured project's domain before attachment,
recognize existing redirect attachments without writes, verify target
project/team identity, and never invoke automatic detach/reclaim from the admin
add flow. Provider failures and tenant-conflict lookup errors prevent saving.
Error messages distinguish access/configuration/discovery failures from actual
conflicts instead of advising a transfer for every failure.

Isolated verification:
`node scripts/run-isolated-tests.mjs node --test api/_lib/vercelDomains.test.mjs api/functions/add-tenant-domain.test.mjs`
passed all 30 tests, including existing attachments, incorrect target/access,
provider failures, attachment races, real conflicts without detachment, and
unchanged DNS instructions. These mocked tests do not mutate production.