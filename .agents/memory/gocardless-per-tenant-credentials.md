---
name: GoCardless per-tenant credentials
description: GoCardless follows the tenant_integrations per-tenant credential model, not platform env vars.
---

Tenant-facing payment providers (Stripe, Xero, QBO, GoCardless) resolve credentials PER TENANT from `tenant_integrations` (encrypted with INTEGRATION_ENCRYPTION_KEY/SESSION_SECRET, same scheme as stripeCredentials.js); the `GOCARDLESS_*` env vars are platform-level fallback only.

**Why:** each tenant owns their own GoCardless account and creditor; user explicitly confirmed this direction and expects setup under /admin/integrations.

**How to apply:** get a client via `gocardlessForTenant(tenantId)` — never call the env-based top-level exports for tenant work. Webhooks: each tenant registers `/api/webhooks/gocardless?tenant=<uuid>`; the signature is verified against that tenant's stored `webhook_secret` (bare URL = platform secret). The /admin/integrations UI card for GoCardless is a later phase — backend stores `access_token`, `webhook_secret`, `environment`, `creditor_id` in the credentials JSON.
