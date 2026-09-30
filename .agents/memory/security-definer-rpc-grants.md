---
name: SECURITY DEFINER RPC grants
description: New Postgres functions are PUBLIC-executable by default — server-only RPCs must revoke PUBLIC and validate inputs in SQL
---
Postgres grants EXECUTE on newly created functions to PUBLIC by default, and PostgREST exposes them at `/rest/v1/rpc/<name>` to anyone with the anon key.

**Why:** a code review caught a server-only lease RPC that anonymous callers could invoke (DoS by holding the lock with a huge TTL, plus leaking holder metadata) because only `anon`/`authenticated` were revoked — that does NOT remove the PUBLIC grant.

**How to apply:** for any server-only / SECURITY DEFINER function: `revoke all on function ... from public, anon, authenticated;` then `grant execute ... to service_role;` (and RLS/revoke on backing tables). Validate inputs (bounded TTLs, constrained key formats) inside the SQL body — grants can drift, validation can't. Verify with `set local role anon; select fn(...)` expecting permission denied.
