import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DESTINATION_PROJECT_REF, isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

export const MIGRATIONS = [
  'supabase/migrations/202610180003_sales_grouped_billing.sql',
  'supabase/migrations/202610180004_sales_billing_configuration.sql',
  'supabase/migrations/202610180005_sales_grouped_accounting.sql',
];
const root = new URL('../', import.meta.url);
const hash = text => createHash('sha256').update(text).digest('hex');
export function validateGroupedBillingApply(args, env, digest) {
  if (args.length !== 3 || !args.includes('--apply')
    || !args.includes(`--reviewed-sha256=${digest}`)
    || !args.includes(`--confirm-destination=${DESTINATION_PROJECT_REF}`)) {
    throw new Error('Explicit --apply, independently reviewed bundle SHA256 and pinned destination confirmation are required');
  }
  if (!isApprovedDestinationSupabaseTarget(env.DEST_DATABASE_URL, env.DEST_SUPABASE_URL)
    || new URL(env.DEST_DATABASE_URL).search) {
    throw new Error('Only verified DEST connections with mandatory certificate verification are allowed; no SOURCE/runtime fallback');
  }
  if (env.SALES_INVOICE_SCHEDULE_ENABLED === 'true') throw new Error('Disable scheduled automation before schema changes');
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const files = await Promise.all(MIGRATIONS.map(async file => ({ file, sql: await readFile(new URL(file, root), 'utf8') })));
  const manifest = files.map(({ file, sql }) => ({ file, sha256: hash(sql) }));
  const digest = hash(JSON.stringify(manifest));
  if (!args.length || args.length === 1 && args[0] === '--review') {
    console.log(JSON.stringify({ manifest, bundleSha256: digest, destination: DESTINATION_PROJECT_REF,
      status: 'OFFLINE ONLY — nothing applied; schema review, explicit approval and schema-before-code rollout required' }, null, 2));
    return;
  }
  validateGroupedBillingApply(args, env, digest);
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: env.DEST_DATABASE_URL, ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000, application_name: 'sales-grouped-billing-approved-schema' });
  await db.connect();
  try {
    await db.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'");
    await db.query(`LOCK TABLE sales_settings,sales_catalogue_bundle,sales_quote_version,sales_commercial_sale,
      sales_accounting_invoice_link,sales_accounting_invoice_attempt,accounting_request_queue IN ACCESS EXCLUSIVE MODE`);
    const settings = (await db.query(`SELECT prosrc FROM pg_proc
      WHERE oid='patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure`)).rows[0]?.prosrc || '';
    for (const marker of ['quote_naming_v1', 'catalogue_visibility_v1', 'quote_task_list_name=CASE', 'FOR UPDATE', 'ON CONFLICT']) {
      if (!settings.includes(marker)) throw new Error('Latest naming, visibility and settings concurrency prerequisites must be reviewed/applied first');
    }
    const queue = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
      AND table_name='accounting_request_queue' AND column_name IN ('preparation_status','resolved_snapshot','source_type','company_id')`);
    if (queue.rowCount !== 4) throw new Error('Accounting queue and durable preparation prerequisites must be reviewed/applied first');
    // Assert immutable historical totals remain unchanged. This has no financial
    // side effects and the entire schema bundle rolls back on a failed check.
    const evidenceSql = `SELECT count(*)::text AS rows,
      coalesce(sum(net_minor),0)::text AS net,coalesce(sum(tax_minor),0)::text AS tax,
      coalesce(sum(gross_minor),0)::text AS gross FROM sales_quote_version`;
    const before = (await db.query(evidenceSql)).rows[0];
    for (const { sql } of files) await db.query(sql.replace(/^BEGIN;\s*$/gm, '').replace(/^COMMIT;\s*$/gm, ''));
    const after = (await db.query(evidenceSql)).rows[0];
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Historical quote financial evidence changed; rollback');
    const grants = (await db.query(`SELECT
      has_table_privilege('anon','sales_invoice_schedule','SELECT') AS anon,
      has_table_privilege('authenticated','sales_invoice_schedule','UPDATE') AS authenticated,
      has_function_privilege('service_role','update_sales_catalogue_bundle(uuid,uuid,timestamptz,jsonb,jsonb,text,text)','EXECUTE') AS writer`)).rows[0];
    if (grants.anon || grants.authenticated || !grants.writer) throw new Error('Service-only schema postconditions failed');
    await db.query('COMMIT');
    console.log(JSON.stringify({ applied: MIGRATIONS, destination: DESTINATION_PROJECT_REF, bundleSha256: digest,
      automation: 'NOT ACTIVATED', externalEffects: 'No provider or email calls; historical records unchanged' }));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Grouped billing migration stopped: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
