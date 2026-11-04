# BNMS Xero connection — read-only investigation

**Evidence collected:** 4 November 2026. Production connection inventory snapshot: **07:07:30 UTC**. No application code, credentials, connections or database records were changed by this investigation.

## Conclusion

BNMS is configured with OAuth Client ID **`6216B6041EB8428CA3719086BB4A108F`**, for the stored Xero organisation **British Nuclear Medicine Society**, Xero Tenant ID **`3d57dce6-2205-462f-abf6-9c7cbf00be23`**.

It **does not share its currently configured Client ID** with the other configured iConnect tenant, Graduate Futures Institute. Credentials are stored separately per iConnect tenant; this architecture permits reuse of an application but the two current IDs differ.

**Core would increase BNMS’s entitlement from 1,000 to 5,000 calls per 24-hour tenant/app connection if the application actually authorising BNMS is on Starter and that same application is upgraded to Core.** Upgrading the Graduate Futures Institute application would not increase the allowance of a BNMS grant belonging to the different application above.

The developer application's **display name, owner, current tier, migration/exemption status and original token-grant Client ID are not verified**. The database does not retain grant-time Client ID provenance. Today's configured Client ID is not conclusive proof of the application that originally issued the saved tokens. A read-only developer-console check matching BNMS's organisation and Client ID is the remaining evidence needed before an upgrade decision—not a reconnection.

## Complete production inventory

| iConnect tenant | Stored Xero organisation | Xero Tenant ID | Configured OAuth Client ID | Stored status |
|---|---|---|---|---|
| BNMS | British Nuclear Medicine Society | `3d57dce6-2205-462f-abf6-9c7cbf00be23` | `6216B6041EB8428CA3719086BB4A108F` | Configured; enabled; access and refresh tokens present; organisation selected |
| Graduate Futures Institute | The Association of Graduate Careers Advisory Services | `608971fe-5a0d-4031-80bb-3d9d438e90fb` | `053FD3632DA24A6596703EFC698D9E49` | Configured; enabled; access and refresh tokens present; organisation selected |
| Unassigned legacy token row (`app_tenant_id` is NULL) | The Association of Graduate Careers Advisory Services | `608971fe-5a0d-4031-80bb-3d9d438e90fb` | Unknown; no owning integration can be joined | Token-present only; enablement/configuration cannot be attributed |

**Live-verified status: not checked for every row.** No Xero API request, refresh, status endpoint, reconnection or grant revocation was performed. Token presence does not prove a usable connection.

- BNMS iConnect tenant ID: `ff2df806-b321-4254-b651-3af11fccf1db`; integration created 17 August 2026 15:22:05 UTC, last updated 15:23:35 UTC.
- Graduate Futures Institute iConnect tenant ID: `fd82da65-aab7-4a5c-85b8-b2febeb2003d`; integration created 31 January 2026 18:01:46 UTC, last updated 18:01:56 UTC.
- Stored access-token expiry: BNMS 4 November 2026 07:10:34 UTC; Graduate Futures Institute 06:30:27 UTC; unassigned row 23 January 2026 16:45:23 UTC. At the snapshot BNMS was already inside the application's five-minute refresh window. Expiry is not a refresh-success timestamp or proof of revocation.

**Completeness and safety:** destination `lvmzliemqnieeoruhkik`, pinned against current project documentation and the destination-only connection runner. Verified TLS; PostgreSQL repeatable-read, read-only transaction; explicit projections; stable `ORDER BY id LIMIT 100 OFFSET ...` pagination until a short page. Independent counts and enumerated totals matched: **2 Xero integration rows, 3 token rows**. The union includes token-only records rather than silently dropping them. Only `credentials->>'client_id'` was retrieved/decrypted in process; Client Secret and access/refresh-token presence were calculated as database booleans. No secret values or raw credential objects were output or saved.

## Configuration and OAuth process

| Location | Finding and evidence boundary |
|---|---|
| Production Supabase `tenant_integrations` | Verified two `integration_type='xero'` rows. Client ID and Client Secret are stored in credential JSON; the application encrypts string fields using AES-256-CBC and a scrypt-derived key. Only Client IDs were decrypted for this report. Both secret-presence booleans are true; validity was not tested. |
| Production Supabase `xero_token` | Stores `app_tenant_id` (iConnect owner), `tenant_id` (Xero organisation), organisation name, access/refresh tokens, expiry and token type. No Client ID, application name, tier, grant timestamp or credential-version history columns. Code writes tokens without application-layer encryption. |
| Vercel project `vite-migrate-replit-6` | Read-only API metadata verified production entries for `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `SESSION_SECRET`. No `XERO_*` or `INTEGRATION_ENCRYPTION_KEY` entries appeared in the returned environment inventory. This verifies project-level metadata, not decrypted values or the environment snapshot of every deployment. |
| Encryption dependency | Code uses `INTEGRATION_ENCRYPTION_KEY || SESSION_SECRET`. Production metadata supports the fallback configuration; the existing workspace key successfully decrypted the two destination Client IDs. No encryption key was printed or exported. |
| Queue configuration | Production metadata contains `ACCOUNTING_REQUEST_QUEUE_ENABLED`, `ACCOUNTING_REQUEST_QUEUE_SOURCES`, and `CRON_SECRET`; their values were not inspected. `vercel.json:91` schedules queue reconciliation every minute. A production Xero binding exists for BNMS; its observed cooldown timestamp was 4 November 2026 07:06:52 UTC. This is not a historical rate-limit log or proof of all routes using the queue. |
| Supabase secrets/runtime | Vault extension exists; a names-only query found no Vault secrets matching Xero, integration-encryption or session-secret names. No Xero references were found in repository `supabase/functions`. Supabase management access denied the SQL request, so deployed Edge Function secrets/configuration were not independently inventoried. Vault absence is not proof of absence in Edge secrets. |

The production destination was verified through project documentation and destination SQL/REST identity pins, **not by revealing Vercel environment values**. The workspace's ordinary Supabase configuration is documented as a stale source and was not used for the inventory. Vercel reported a READY production deployment; deployed code equivalence to this working tree was not established. Pre-existing working-tree changes were left untouched.

### Flow

1. An integration administrator saves tenant-scoped credentials through `api/admin/integrations.js:150–156,290–345`. Encryption is at lines 11–27 and 62–72.
2. `api/xero/auth-url.js:18–62` loads the signed-in tenant user's credentials, requires enablement, constructs the callback URI from request headers, and requests offline access plus identity, invoice, payment, contact and settings scopes.
3. `api/xero/callback.js:9–19,91–166,244–295` decodes the iConnect tenant from state, exchanges the authorisation code using that tenant's configured application, and calls `/connections`. A single organisation is saved directly and sets the active accounting provider; multiple organisations first produce a `PENDING_SELECTION` token row.
4. `api/xero/select-tenant.js:9–32` replaces that pending marker with the submitted Xero organisation ID/name. This branch does not call the single-organisation branch's active-provider setter.
5. `api/_lib/xero.js:128–224` retrieves tokens by **iConnect** tenant ID, returns the selected **Xero** ID for request headers, and refreshes within five minutes of expiry using the currently configured Client ID/Secret. It checks token persistence errors.
6. Additional refresh implementations exist in `api/functions/[functionName].js:115–203,6134–6205` and `api/_lib/eventInvoiceRecoveryXero.js:105–146`. The legacy function versions do not check the token-update result. Event recovery uses a conditional update matching the previous refresh token; the general/legacy implementations do not share that protection. No refresh implementation was executed.

The admin “connected” summary is stored-record evidence: `api/_lib/accountingProvider.js:176–185` tests for a non-pending organisation row, not a live Xero grant.

## Rate-limit handling

**Correct organisation binding in inspected paths:** direct accounting calls in `api/_lib/xero.js` pass the saved Xero ID in `xero-tenant-id`; queued calls in `api/_lib/accountingRequestProviders.js:233–280` validate the connection/company binding and set `Xero-tenant-id` to `companyId`. `/connections` and OAuth token exchange are different APIs and do not require an organisation header. Correct header construction does not prove that a saved selection was authorised.

**Durable queue:** `accountingRequestQueue.js:27–35,69–107,181–216` and migration `supabase/migrations/202612050001_accounting_request_queue.sql:1–8,101–140,169–190` implement database leases, serialisation and shared cooldown keyed by **provider + company/organisation ID**, not iConnect tenant or OAuth Client ID. Queue guards run before provider requests; one row has a 40-request budget, an immediate invocation has a 45-second cap, and cron processes up to 10 rows within a shared 40-second work budget. These budgets are not Xero quota accounting.

429 responses retain `Retry-After`; numeric/date values are supported, with 60 seconds for missing/unparseable values. Cooldown is not shortened by retry scheduling. Retries use bounded exponential backoff; uncertain writes require discovery rather than blind replay. The provider adapter distinguishes a rejected Xero 429 from an uncertain post-write/readback outcome.

**Partial coverage:** queue feature flags/source filters control adoption. Direct contact/tax reads and sales invoice methods (`xero.js:341–365,468–499`), legacy function paths and separate recovery flows are not all governed by queue leases. The common JSON error helper preserves HTTP status/Retry-After but does not itself wait, queue or reserve allowance. Cancellation recovery reads/extends the organisation cooldown but does not acquire the same queue lease (`xeroCancellationRecovery.js:5–32`).

Membership invoice reconciliation has a **1,200 ms per-iConnect-tenant gap** and stops processing that tenant after a 429 until a later run (`api/cron/reconcile-membership-invoice-payments.js:19–26,154–165`). This is invocation-local pacing, not a cross-worker organisation-wide throttle.

**No remaining-quota tracking found** for `X-DayLimit-Remaining`, `X-MinLimit-Remaining`, `X-AppMinLimit-Remaining` or `X-Rate-Limit-Problem` in the inspected API/Edge source. There is no evidenced universal 60/minute or five-concurrent limiter or application-wide 10,000/minute budget. Sharing an organisation cooldown across different Client IDs can over-throttle independent app grants; application-wide exhaustion would conversely need coordination across organisations. Neither scenario was demonstrated in production.

## Prioritised findings

### Confirmed production configuration / source defects

1. **High priority — token-table access boundary:** production `public.xero_token` has RLS disabled, no policies, and `anon`/`authenticated` grants including SELECT, INSERT, UPDATE and DELETE. This is a verified database permission weakness around directly stored token fields. Public API exposure/access was not exercised; exploitation or token disclosure is **not claimed**. Remediation needs separate approval.
2. **High priority — OAuth request binding and selection:** state is plain base64 tenant JSON, with no nonce/session/signature verification in the callback. Organisation selection has no session/admin check, accepts caller-supplied organisation details, does not require `appTenantId`, and does not verify the selection against authorised connections. Root `middleware.js:27–39` excludes `/api/`, so it does not supply these missing checks. These are confirmed source defects, not a live exploitation test.
3. **Persistence and provenance gaps:** the selection update and multi-organisation temporary-token save do not check database errors; legacy refresh updates also ignore errors. Callback logs the full query, which can contain a short-lived authorisation code (`callback.js:5`). No grant-time application identity is stored. One unassigned legacy token row remains in production.

### Suspected operational risks, not proven incidents

- Concurrent refreshes can race across general, legacy and recovery paths; a conditional save in one implementation is not a shared refresh lock.
- Direct callers can consume quota during queue cooldowns or alongside leased work. Local pacing cannot enforce global provider quotas.
- Updating per-tenant application credentials can leave an older grant paired with a different Client ID. Recent token expiry timestamps do not prove this happened—or prove it did not.

## Official Xero entitlement evidence

Retrieved **4 November 2026**:

- [Developer pricing](https://developer.xero.com/pricing): Starter **1,000/day/org**, Core and higher **5,000/day/org**; Core supports up to 50 connections and requires a payment method. Plans belong to applications; separate applications do not share connection counts or usage.
- [Rate limits](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits): allowance is per **tenant/app connection** over a 24-hour fixed window; five concurrent requests and 60/minute per connection; 10,000/minute across an application. Reset time varies by tenant—honour `Retry-After`, not an assumed midnight reset.
- [Pricing/policy FAQ, especially questions 6, 17, 24 and 27](https://developer.xero.com/faq/pricing-and-policy-updates): rollout/migration and exempt app types exist; tier changes are managed in the developer portal. Older generic “limits are the same for all apps” FAQ wording is less specific than the current pricing table and tier-aware rate-limit documentation.

**Decision:** first match Client ID `6216B6041EB8428CA3719086BB4A108F` and BNMS's organisation in the developer console, confirm the actual connected application's tier and applicability, then consider upgrading that application. Core increases the documented daily entitlement; it does not repair OAuth weaknesses, refresh races or incomplete throttling.

**Boundaries:** zero Xero provider requests, zero accounting mutations, zero database writes and no credential/configuration changes. Only this report was added. No raw credential evidence was retained. Application build/browser testing was not applicable to this read-only investigation.
