import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const file = 'supabase/migrations/202610190001_sales_agreements.sql';
const sql = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
if (!args.length || args.join() === '--review') {
  console.log(JSON.stringify({ file, sha256, destination: PROJECT, applied: false }, null, 2));
} else {
  if (args.length !== 3 || !args.includes('--apply') || !args.includes(`--reviewed-sha256=${sha256}`)
    || !args.includes(`--confirm-destination=${PROJECT}`)) throw new Error('Explicit reviewed digest and DEST confirmation required');
  const db = await connectDestination();
  try {
    await db.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'");
    const evidence = `SELECT count(*)::text AS count,coalesce(sum(net_minor),0)::text AS net,
      coalesce(sum(tax_minor),0)::text AS tax,coalesce(sum(gross_minor),0)::text AS gross FROM sales_quote_version`;
    const before = (await db.query(evidence)).rows;
    await db.query(sql.replace(/^BEGIN;\s*$/gm, '').replace(/^COMMIT;\s*$/gm, ''));
    if (JSON.stringify(before) !== JSON.stringify((await db.query(evidence)).rows)) throw new Error('Historical quote totals changed');
    const checks = (await db.query(`SELECT
      has_table_privilege('anon','sales_agreement_envelope','SELECT') AS anon,
      has_table_privilege('authenticated','sales_agreement_envelope','UPDATE') AS authenticated,
      has_table_privilege('service_role','sales_agreement_envelope','INSERT') AS writer,
      (SELECT public FROM storage.buckets WHERE id='sales-agreements') AS bucket_public`)).rows[0];
    if (checks.anon || checks.authenticated || !checks.writer || checks.bucket_public !== false) throw new Error('Service-only/private storage checks failed');
    for (const table of ['sales_agreement_envelope', 'sales_agreement_verification', 'sales_agreement_signing_request', 'sales_agreement_completion_notice']) {
      const { rows: [row] } = await db.query(`SELECT c.relrowsecurity AS rls,
        has_table_privilege('anon',c.oid,'SELECT') AS anon,
        has_table_privilege('authenticated',c.oid,'UPDATE') AS authenticated,
        has_table_privilege('service_role',c.oid,'INSERT') AS writer
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1`, [table]);
      if (!row?.rls || row.anon || row.authenticated || !row.writer) throw new Error(`Agreement table permission check failed: ${table}`);
    }
    await db.query('COMMIT');
    console.log(JSON.stringify({ applied: true, destination: PROJECT, file, sha256, historicalTotalsUnchanged: true, privateStorage: true }));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await db.end(); }
}
