---
name: Bearer-token (mobile) API auth
description: How native/mobile clients authenticate alongside web cookie sessions
---

Native/mobile clients authenticate with `Authorization: Bearer <token>` as an
ADDITIVE alternative to the `iconnect.sid` browser cookie. There is NO separate
token table — bearer tokens reuse the existing `session` table.

**The token IS the session row's `sid`** (random, unsigned, 96 hex chars). Web
cookie sids are signed (`s:<sid>.<sig>`); bearer tokens are the raw sid sent
verbatim. Bearer rows are tagged `sess.authMethod === 'bearer'`.

**Why authMethod gating matters:** `getSession` resolves the cookie path FIRST
(unchanged, byte-for-byte identical when no token present); only when no cookie
sid exists does it fall back to the bearer token. A token resolved via the bearer
path is rejected unless `sess.authMethod === 'bearer'`, so a web cookie's
underlying sid can never be replayed as a bearer token (and vice-versa).
`revokeBearerSession` likewise only deletes rows tagged bearer.

**How to apply / extend:**
- Helpers live in `api/_lib/session.js`: `getBearerToken`, `createBearerSession`,
  `revokeBearerSession` (alongside the existing cookie `createSession`).
- Mobile endpoints: `api/auth/mobile-login.js`, `api/auth/mobile-logout.js`.
- Bearer sessions reuse the EXACT web session shapes (tenant_user vs member), so
  all downstream RBAC works unchanged — `getTenantContext` / `getSessionMember` /
  `getSessionTenantUser` need NO bearer-specific code. Tenant is honoured from the
  session's stored `tenantId` claim (no subdomain), so tenantContext.js is untouched.
- Tenant is resolved explicitly at login (body `tenantId`); multi-org identities
  get `{ requiresTenantSelection, organisations[] }` and re-login with a chosen id.
- TTL = `BEARER_TOKEN_MAX_AGE` (7d, same as web). Expiry/cleanup is the existing
  `session.expire` path in getSession.
