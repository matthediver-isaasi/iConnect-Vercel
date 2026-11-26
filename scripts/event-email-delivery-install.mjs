// Narrow SQL builder for the managed Supabase migration connection.
// No credentials, generic migration replay, provider calls or customer writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const destination = 'lvmzliemqnieeoruhkik';
export const migrationFile = 'supabase/migrations/202702010001_event_email_delivery.sql';
export const reviewedSha256 = '1bebb5412ea8bf34a6ba4bc437fa7de22c10159c9cb9ba3f0175450914aec563';
export const signatures = [
  'record_event_email_send_result(uuid,boolean,text,text,text,timestamptz)',
  'apply_event_email_delivery_event(uuid,text,text,text,timestamptz,text,text,text)',
  'event_email_delivery_stats(uuid,uuid)',
];
const literal = text => `'${text.replaceAll("'", "''")}'`;

export function managedInstallQuery({ projectId, reviewSha256 }) {
  assert.equal(projectId, destination, 'Destination pin mismatch');
  assert.equal(reviewSha256, reviewedSha256, 'Reviewed SHA required');
  const sql = readFileSync(new URL(`../${migrationFile}`, import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(sql).digest('hex'), reviewedSha256, 'Migration changed');
  assert.equal((sql.match(/^BEGIN;$/gm) || []).length, 1);
  assert.equal((sql.match(/^COMMIT;$/gm) || []).length, 1);
  const body = sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
  assert.ok(!/^(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(body));
  // One atomic statement also protects managed execution implementations that
  // do not preserve an explicit multi-statement BEGIN/COMMIT client session.
  return `DO $event_email_install$
BEGIN
  PERFORM set_config('lock_timeout','2s',true);
  PERFORM set_config('statement_timeout','30000',true);
  IF current_database()<>'postgres' OR NOT EXISTS (
    SELECT 1 FROM public.event e JOIN public.tenant t ON t.id=e.tenant_id
    WHERE e.id='1fb90343-a129-4fcf-affd-07db4d572a51'
      AND t.id='ff2df806-b321-4254-b651-3af11fccf1db' AND t.name='BNMS'
  ) THEN RAISE EXCEPTION 'Destination event identity mismatch'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('event-email-delivery-install',0))
    THEN RAISE EXCEPTION 'Another installer is running'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname LIKE 'event_email_delivery%'
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('record_event_email_send_result','apply_event_email_delivery_event','event_email_delivery_stats')
  ) THEN RAISE EXCEPTION 'Existing or concurrent installation: inspect and preserve; do not replay'; END IF;
  EXECUTE ${literal(body)};
  IF (SELECT count(*) FROM public.event_email_delivery_tracking) <> 1
    OR NOT EXISTS(SELECT 1 FROM public.event_email_delivery_tracking
      WHERE id AND isfinite(started_at) AND started_at=transaction_timestamp())
    THEN RAISE EXCEPTION 'Invalid tracking singleton'; END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN
      ('event_email_delivery_tracking','event_email_delivery','event_email_delivery_event')
      AND c.relkind='r' AND c.relrowsecurity) <> 3
    THEN RAISE EXCEPTION 'Missing tables or RLS'; END IF;
  IF EXISTS(SELECT 1 FROM public.event_email_delivery)
    OR EXISTS(SELECT 1 FROM public.event_email_delivery_event)
    THEN RAISE EXCEPTION 'Unexpected initial ledger evidence'; END IF;
  PERFORM * FROM public.event_email_delivery_stats(
    'ff2df806-b321-4254-b651-3af11fccf1db','1fb90343-a129-4fcf-affd-07db4d572a51');
  NOTIFY pgrst, 'reload schema';
END
$event_email_install$;`;
}
