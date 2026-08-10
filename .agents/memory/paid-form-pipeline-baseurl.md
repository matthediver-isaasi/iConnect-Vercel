---
name: Paid-form pipeline needs a baseUrl on every finalize path
description: Server-driven payment finalization (webhook/cron) silently skips entity pipelines when baseUrl is null
---

The paid-form entity pipeline runner is an HTTP wrapper around /api/forms/process-application and used to silently no-op when `baseUrl` was falsy (now it writes a processing note + console.error, but still cannot run).

**Why:** the GC webhook and the cron reconcile sweep finalized payments with baseUrl null, so GoCardless-paid submissions never created member records and membership finalization looped on `awaiting_entity` forever — the retry sweep itself also lacked a baseUrl, so the state could never self-heal.

**How to apply:** any new server-driven path that finalizes a paid form submission (webhook, cron, admin action) must resolve a tenant-trusted base URL per submission via `getTrustedBaseUrlForTenant(null, supabase, tenantId)` (per-tenant cached in a multi-tenant sweep; wildcard-domain rules — never env-var-built). Caller-supplied request-derived baseUrl wins when present.
