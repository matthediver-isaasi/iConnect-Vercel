---
name: Supabase realtime requires explicit publication membership
description: Why useRealtimeSubscription silently does nothing for a table until that table is added to the supabase_realtime publication.
---

# Supabase realtime needs the table in the `supabase_realtime` publication

`useRealtimeSubscription` (and any `supabase.channel(...).on('postgres_changes', ...)`) only
receives events for tables that belong to the `supabase_realtime` Postgres publication. Most
tables in this DB are NOT published by default — check before assuming a subscription works.

**Why:** Subscribing to a non-published table fails silently — the channel subscribes fine but
no payloads ever arrive, so the UI just never updates and there's no error to debug.

**How to apply:**
- Check membership: `SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='<t>'`.
- Add idempotently (works from this workspace via `pg` + `DEST_DATABASE_URL` pooler — DDL is allowed):
  `ALTER PUBLICATION supabase_realtime ADD TABLE <t>` guarded by a `DO $$ ... IF NOT EXISTS ... $$`
  block, or a standalone apply script (see `scripts/migrations/add-zoho-sync-log-to-realtime.mjs`).
- The realtime filter (`tenant_id=eq.X`) is matched against the `new` row for INSERT/UPDATE and the
  `old` row for DELETE. With default replica identity the `old` row on UPDATE/DELETE only carries the
  PK, so DELETE events won't match a tenant_id filter — fine if you only care about INSERT/UPDATE.
