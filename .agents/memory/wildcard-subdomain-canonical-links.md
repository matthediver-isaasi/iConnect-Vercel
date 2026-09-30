---
name: Wildcard subdomain canonical links
description: Typo'd *.iconn.app subdomains serve the app for logged-in users; user-facing links must be cross-checked against the tenant's real slug.
---

**Rule:** `*.iconn.app` / `*.{dev,testing,preview,staging}.iconn.app` is wildcard DNS. Any user-facing link built from the request origin (`getPublicBaseUrl`) must be cross-checked against the resolved tenant via `getTenantTrustedBaseUrl(req, tenant)` / `getTrustedBaseUrlForTenant(req, supabase, tenantId)` in `api/_lib/publicBaseUrl.js`, or a typo'd subdomain leaks into emails.

**Why:** A logged-in user on a transposed subdomain (fgi for gfi) got a fully working app — session cookie scope + client tenant fallbacks resolve the tenant anyway — and team invites echoed the typo'd origin. Zero DB/code/env traces of "fgi"; root cause was a user's bookmarked tab.

**How to apply:**
- Any NEW email/link-building path that knows the tenant should use the trusted helpers, not raw `getPublicBaseUrl`.
- Custom domains rebuilt from stored `tenant.domain` must pass `sanitizeHostname` (bare hostname only) — otherwise a malformed stored value is an open redirect. Same validation duplicated client-side in TenantBrandingContext (`sanitizeRedirectHostname`).
- Client: host subdomain is authoritative over `?tenant=` on iconn hosts (publicClient); branding 404 on a slug-pattern host triggers redirect (authed) or a "Site not found" screen (guest).
- Server tenant resolution may still honour mismatched `?tenant=` for direct API calls (follow-up exists).
