---
name: Tenant-scoped admin password resets
description: Security and tenant-selection rules for admin password recovery when one identity administers multiple tenants.
---

Resolve an admin password-reset request to an active admin membership in the request tenant before issuing the token. A tenant credential token remains authoritative for that tenant through password setup and session creation; never fall back to the identity's default tenant after finding a tenant-scoped token.

**Why:** Multi-tenant admins can have a different password per tenant. Selecting the default membership resets the wrong credential and creates the wrong tenant session. Reset URLs also carry account-control tokens, so reflecting an arbitrary `Origin` can leak them to an attacker.

**How to apply:** For admin reset issuance and completion, fail closed when the targeted active admin membership is missing. Build emailed links only from a validated tenant host, canonical environment host, or the tenant's sanitized stored custom domain; ignore untrusted origins.