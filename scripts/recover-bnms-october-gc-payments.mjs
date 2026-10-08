// Pinned recovery of already-issued October payments. Never sends GC writes.
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const target = destinationTarget(process.env);
const apply = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 400;
if (!Number.isInteger(limit) || limit < 1 || limit > 400) throw new Error('Invalid limit');
// Configure this process only, before loading application modules. Never print
// credentials; destinationTarget pins both the REST and SQL destination.
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
const nativeFetch = globalThis.fetch;
let gcReads = 0;
let blockedGcWrites = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'api.gocardless.com' || url.hostname === 'api-sandbox.gocardless.com') {
    const method = (init.method || input?.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      blockedGcWrites++;
      throw new Error('Recovery prohibits every GoCardless mutation');
    }
    gcReads++;
    return nativeFetch(input, { ...init, redirect: 'error' });
  }
  return nativeFetch(input, init);
};
// Application errors can contain private records; report counters only.
console.error = () => {};
console.warn = () => {};
const report = console.log.bind(console);
console.log = () => {};
const { supabase: db } = await import('../api/_lib/database.js');
const { getGocardlessCredentials } = await import('../api/_lib/gocardlessCredentials.js');
const { createGocardlessClient } = await import('../api/_lib/gocardless.js');
const { processGocardlessEvent } = await import('../api/_lib/gocardlessWebhookProcessor.js');
const creds = await getGocardlessCredentials(tenant, { db });
if (creds.environment !== 'live') throw new Error('Live tenant credentials required');
const gc = createGocardlessClient(creds);
const ca = await (await nativeFetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt')).text();
const sql = new pg.Client({ connectionString: target.toString(), ssl: {
  rejectUnauthorized: true, ca, servername: target.hostname,
}});
const summary = { selected: 0, checked: 0, processed: 0, failed: 0, posted: 0, accountingPending: 0 };
try {
  await sql.connect();
  await sql.query('BEGIN READ ONLY');
  const { rows } = await sql.query(`
    SELECT DISTINCT ON (p.gocardless_payment_id)
      e.id, e.event_id, e.payload, p.gocardless_payment_id,
      p.amount_minor, p.currency, p.charge_date::text, p.gocardless_mandate_id
    FROM gocardless_payments p JOIN payment_webhook_events e
      ON e.tenant_id=p.tenant_id AND e.provider='gocardless'
      AND e.payload->'links'->>'payment'=p.gocardless_payment_id
    WHERE p.tenant_id=$1 AND p.charge_date='2026-10-06'
      AND p.environment='live' AND p.accounting_invoice_id IS NULL
      AND e.resource_type='payments' AND e.action IN ('confirmed','failed','cancelled')
      AND e.processing_status='failed'
    ORDER BY p.gocardless_payment_id,e.received_at DESC LIMIT $2`, [tenant, limit]);
  await sql.query('ROLLBACK');
  summary.selected = rows.length;
  for (const row of rows) {
    try {
      const current = await gc.getPayment(row.gocardless_payment_id);
      const expected = row.payload.action;
      if (Number(current.amount) !== Number(row.amount_minor)
          || current.currency !== row.currency || current.charge_date !== row.charge_date
          || current.links?.mandate !== row.gocardless_mandate_id
          || !(current.status === expected || (expected === 'confirmed' && current.status === 'paid_out'))) {
        throw new Error('Provider evidence differs');
      }
      summary.checked++;
      if (!apply) continue;
      const outcome = await processGocardlessEvent(row.payload, {
        db, gc, sendEmail: async () => ({ sent: false, reason: 'recovery-suppressed' }),
      });
      if (!outcome.handled) throw new Error('Event not handled');
      const { data: after, error } = await db.from('gocardless_payments')
        .select('status,accounting_sync_status,accounting_invoice_id')
        .eq('tenant_id', tenant).eq('gocardless_payment_id', row.gocardless_payment_id).single();
      if (error || !after || !(after.status === expected || (expected === 'confirmed' && after.status === 'paid_out'))) {
        throw new Error('Payment outcome not persisted');
      }
      if (expected === 'confirmed') {
        if (after.accounting_sync_status === 'posted' && after.accounting_invoice_id) summary.posted++;
        else { summary.accountingPending++; continue; }
      }
      const { error: markError } = await db.from('payment_webhook_events').update({
        processing_status: 'processed', processing_error: null, processed_at: new Date().toISOString(),
      }).eq('id', row.id).eq('tenant_id', tenant).eq('processing_status', 'failed');
      if (markError) throw new Error('Audit update failed');
      summary.processed++;
    } catch {
      summary.failed++;
    }
    if (blockedGcWrites) break;
  }
} finally {
  await sql.end();
  report(JSON.stringify({ apply, ...summary, gcReads, blockedGcWrites, gcWritesSent: 0 }));
}
