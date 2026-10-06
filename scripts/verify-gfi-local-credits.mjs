// Read-only, destination-pinned verification. Never imports financial providers.
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { attachReportCredits } from '../api/reports/_credits.js';
import { formatRegistrationCreditsExport } from '../client/src/lib/eventRegistrationCredits.js';
const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const eventId = 'e5dd3f1f-f28e-475c-b0c8-143191c289df';
const url = process.env.DEST_DATABASE_URL;
const rest = process.env.DEST_SUPABASE_URL;
if (!url || !rest || new URL(rest).hostname !== 'lvmzliemqnieeoruhkik.supabase.co'
  || new URL(url).hostname !== 'aws-1-eu-central-1.pooler.supabase.com'
  || !new URL(url).username.endsWith('.lvmzliemqnieeoruhkik')) throw Error('Destination identity mismatch');
const sql = new pg.Client({ connectionString: url });
try {
  await sql.connect();
  await sql.query('BEGIN READ ONLY');
  const { rows: bookings } = await sql.query('SELECT id, booking_group_reference FROM booking WHERE tenant_id=$1 AND event_id=$2 ORDER BY id', [tenantId, eventId]);
  const map = new Map();
  for (const b of bookings) {
    const key = b.booking_group_reference || b.id;
    if (!map.has(key)) map.set(key, { attendees: [], bookingSource: 'booking' });
    map.get(key).attendees.push({ id: b.id });
  }
  const client = createClient(rest, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
  const db = { from(table) {
    if (!['booking', 'booking_reversal_evidence'].includes(table)) throw Error('Unexpected table');
    return { select: (...args) => client.from(table).select(...args) };
  } };
  const results = [];
  for (let i = 0; i < 2; i++) {
    const groups = structuredClone([...map.values()]);
    await attachReportCredits({ db, tenantId, bookings, groups });
    results.push({
      bookings: bookings.length, groups: groups.length,
      zero: groups.filter(g => g.credits.amount === 0).length,
      nonzero: groups.filter(g => g.credits.amount > 0).map(g => ({ amount: g.credits.amount, currency: g.credits.currency })),
      unknown: groups.filter(g => g.credits.amount == null).length,
      exportHasRecordedZero: groups.some(g => formatRegistrationCreditsExport(g.credits).includes('No credits recorded in iConnect')),
    });
  }
  if (JSON.stringify(results[0]) !== JSON.stringify(results[1])) throw Error('Reload results changed');
  console.log(JSON.stringify({ readOnlyDestination: true, reloadMatches: true, ...results[0] }));
  await sql.query('ROLLBACK');
} catch {
  console.error('Read-only local credit verification failed; no credentials or private records logged.');
  process.exitCode = 1;
} finally { await sql.end(); }
