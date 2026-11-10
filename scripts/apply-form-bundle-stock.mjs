import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
const stockOption = process.argv.includes('--stock-option');
const file = stockOption
  ? 'supabase/migrations/202701200002_form_bundle_submission_stock_option.sql'
  : 'supabase/migrations/202701200001_form_bundle_stock.sql';
const sql = await readFile(file, 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
if (process.argv.includes('--preflight')) {
  if (process.argv.includes('--apply')) throw new Error('Preflight is read-only; do not combine with apply');
  const db = await connectDestination();
  try {
    await db.query("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'");
    const { rows } = await db.query(`SELECT
      to_regclass('public.form_bundle_stock') IS NOT NULL AS stock_table,
      to_regclass('public.form_bundle_allocation') IS NOT NULL AS allocation_table,
      to_regclass('public.form_bundle_selection') IS NOT NULL AS stock_option_installed,
      EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.form_submission')
        AND tgname='allocate_submission_bundle' AND tgenabled='O') AS insert_trigger,
      EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.form_submission')
        AND tgname='settle_submission_bundle' AND tgenabled='O') AS settlement_trigger,
      to_regprocedure('public.reserve_form_bundle(uuid,uuid,uuid,text,text)') IS NOT NULL AS reservation_function,
      to_regprocedure('public.finalize_form_bundle(uuid,uuid,text,jsonb)') IS NOT NULL AS finalization_function`);
    await db.query('ROLLBACK');
    console.log(JSON.stringify({ destination: PROJECT, readOnly: true, prerequisites: rows[0] }));
  } finally { await db.end(); }
} else if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ file, sha256, destination: PROJECT, applied: false }));
} else {
  if (!process.argv.includes(`--reviewed-sha256=${sha256}`)
    || !process.argv.includes(`--confirm-destination=${PROJECT}`)) throw new Error('Exact digest and destination confirmation required');
  const db = await connectDestination();
  try {
    await db.query("SET lock_timeout='5s'; SET statement_timeout='60s'");
    const ready = (await db.query("SELECT to_regclass('public.form_bundle_stock') IS NOT NULL ready")).rows[0].ready;
    if (stockOption) {
      if (!ready) throw new Error('Base bundle stock migration is required first');
      const installed = (await db.query("SELECT to_regclass('public.form_bundle_selection') IS NOT NULL ready")).rows[0].ready;
      if (installed) throw new Error('Stock option migration already exists; verify before changing');
    } else if (ready) throw new Error('Migration already exists; verify before changing');
    await db.query(sql);
    const { rows } = await db.query(`SELECT relname,relrowsecurity,
      has_table_privilege('anon',oid,'SELECT') public_read,
      has_table_privilege('service_role',oid,'UPDATE') direct_update
      FROM pg_class WHERE oid IN ('public.form_bundle_stock'::regclass,'public.form_bundle_allocation'::regclass)
        OR (${stockOption} AND oid=to_regclass('public.form_bundle_selection'))`);
    if (rows.length !== (stockOption ? 3 : 2) || rows.some(r => !r.relrowsecurity || r.public_read || r.direct_update)) throw new Error('Grant verification failed');
    console.log(JSON.stringify({ applied: true, destination: PROJECT, sha256, restrictedGrantsVerified: true }));
  } finally { await db.end(); }
}
