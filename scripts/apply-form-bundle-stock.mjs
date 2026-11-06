import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
const file = 'supabase/migrations/202701200001_form_bundle_stock.sql';
const sql = await readFile(file, 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ file, sha256, destination: PROJECT, applied: false }));
} else {
  if (!process.argv.includes(`--reviewed-sha256=${sha256}`)
    || !process.argv.includes(`--confirm-destination=${PROJECT}`)) throw new Error('Exact digest and destination confirmation required');
  const db = await connectDestination();
  try {
    await db.query("SET lock_timeout='5s'; SET statement_timeout='60s'");
    const ready = (await db.query("SELECT to_regclass('public.form_bundle_stock') IS NOT NULL ready")).rows[0].ready;
    if (ready) throw new Error('Migration already exists; verify before changing');
    await db.query(sql);
    const { rows } = await db.query(`SELECT relname,relrowsecurity,
      has_table_privilege('anon',oid,'SELECT') public_read,
      has_table_privilege('service_role',oid,'UPDATE') direct_update
      FROM pg_class WHERE oid IN ('public.form_bundle_stock'::regclass,'public.form_bundle_allocation'::regclass)`);
    if (rows.length !== 2 || rows.some(r => !r.relrowsecurity || r.public_read || r.direct_update)) throw new Error('Grant verification failed');
    console.log(JSON.stringify({ applied: true, destination: PROJECT, sha256, restrictedGrantsVerified: true }));
  } finally { await db.end(); }
}
