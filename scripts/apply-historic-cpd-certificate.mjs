import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const sql = await readFile('supabase/migrations/20261208_historic_cpd_certificate.sql', 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ sha256, dryRun: true, destination: 'lvmzliemqnieeoruhkik' }));
} else {
  if (args.length !== 2 || !args.includes('--apply') || !args.includes(`--review-sha256=${sha256}`)) throw new Error('Exact reviewed hash required');
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('CA unavailable');
  const client = new pg.Client({ connectionString: target.toString(), ssl: {
    rejectUnauthorized: true, ca: await response.text(), servername: target.hostname,
  } });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    const check = (await client.query(`SELECT current_database()='postgres' AND
      to_regclass('public.cpd_certificate_template') IS NOT NULL AND
      to_regclass('public.member_cpd_points_ledger') IS NOT NULL AS ok`)).rows[0];
    if (!check.ok) throw new Error('Target schema mismatch');
    await client.query(sql);
    const guards = (await client.query(`SELECT
      NOT has_table_privilege('authenticated','public.historic_cpd_certificate','SELECT') AS private,
      NOT has_table_privilege('service_role','public.historic_cpd_certificate','INSERT') AS rpc_only,
      NOT has_function_privilege('anon','public.set_historic_cpd_certificate(uuid,uuid,integer)','EXECUTE') AS anon_blocked,
      NOT has_function_privilege('authenticated','public.set_historic_cpd_certificate(uuid,uuid,integer)','EXECUTE') AS member_blocked,
      has_function_privilege('service_role','public.set_historic_cpd_certificate(uuid,uuid,integer)','EXECUTE') AS service_allowed,
      (SELECT count(*)=0 FROM public.historic_cpd_certificate) AS no_automatic_selection`)).rows[0];
    if (Object.values(guards).some(v => v !== true)) throw new Error('Privilege verification failed');
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, sha256, destination: 'lvmzliemqnieeoruhkik', guards, sourceUntouched: true }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Migration failed (${error.code || 'validation'}); no transaction committed.`);
    process.exitCode = 1;
  } finally { await client.end(); }
}
