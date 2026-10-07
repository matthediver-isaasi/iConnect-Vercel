#!/usr/bin/env node
// Read-only aggregate verification. No exports, PII logging or mutation mode.
import { createClient } from '@supabase/supabase-js';
import { loadNmcReport } from '../api/_lib/nmcMembershipReportLoader.js';

try {
  if (process.argv.length !== 2) throw new Error('No arguments accepted');
  const url = new URL(process.env.DEST_SUPABASE_URL);
  if (url.protocol !== 'https:' || url.hostname !== 'lvmzliemqnieeoruhkik.supabase.co' || !process.env.DEST_SUPABASE_KEY) throw new Error('Destination unavailable');
  const db = createClient(url.toString(), process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
  const { rows, ...summary } = await loadNmcReport(db, new Date().toISOString().slice(0, 10));
  console.log(JSON.stringify({ ...summary, database: 'production DEST', writes: 0, migrations: 0 }, null, 2));
} catch {
  console.error('Read-only NMC report audit failed. No workbook or database changes were made.');
  process.exitCode = 1;
}
