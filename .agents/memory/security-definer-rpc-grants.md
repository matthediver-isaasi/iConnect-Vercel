---
name: SECURITY DEFINER RPC grants
description: New Postgres functions are PUBLIC-executable by default — server-only RPCs must revoke PUBLIC and validate inputs in SQL
---
Postgres grants EXECUTE on newly created functions to PUBLIC by default, and PostgREST exposes them at `/rest/v1/rpc/<name>` to anyone with the anon key.

**Why:** a code review caught a server-only lease RPC that anonymous callers could invoke (DoS by holding the lock with a huge TTL, plus leaking holder metadata) because only `anon`/`authenticated` were revoked — that does NOT remove the PUBLIC grant.

**How to apply:** for any server-only / SECURITY DEFINER function: `revoke all on function ... from public, anon, authenticated;` then `grant execute ... to service_role;` (and RLS/revoke on backing tables). Validate inputs (bounded TTLs, constrained key formats) inside the SQL body — grants can drift, validation can't. Verify with `set local role anon; select fn(...)` expecting permission denied.

DEST also grants service_role ALL through owner default privileges on new tables/functions. A subsequent GRANT SELECT does not remove those inherited direct write grants.

**Why:** Production ACL checks exposed writable automation evidence tables despite a migration that granted only SELECT; a vanilla disposable PostgreSQL instance did not reproduce the owner's default ACLs.

**How to apply:** For RPC-owned tables, explicitly REVOKE ALL from service_role before granting SELECT. Model Supabase owner default privileges in database fixtures and inspect effective live privileges after applying migrations.
