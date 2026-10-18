#!/usr/bin/env node
// Offline by default; verified destination only, exact reviewed SQL hash required.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const migrations = [
  '202610130002_sales_catalogue_atomic_create.sql',
  '202610180001_sales_catalogue_visibility.sql',
];
const sources = await Promise.all(migrations.map(name => readFile(`supabase/migrations/${name}`, 'utf8')));
const sha256 = createHash('sha256').update(sources.join('\n')).digest('hex');
const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ dryRun: true, destination: 'lvmzliemqnieeoruhkik', migrations, sha256 }));
} else {
  const inspect = args.length === 1 && args[0] === '--inspect';
  if (!inspect && (args.length !== 2 || !args.includes('--apply') || !args.includes(`--review-sha256=${sha256}`))) {
    throw new Error('Use --inspect or --apply with the exact --review-sha256 from offline review');
  }
  const target = destinationTarget(process.env);
  const caResponse = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!caResponse.ok) throw new Error('Could not retrieve the destination TLS certificate');
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca: await caResponse.text(), servername: target.hostname },
  });
  try {
    await client.connect();
    await client.query(inspect ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    const before = (await client.query(`SELECT
      pg_get_functiondef('public.patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure) AS settings_rpc,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_catalogue_product' AND column_name='tax_code') AS tax_ready,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_catalogue_product' AND column_name='create_task_on_acceptance') AS tasks_ready`)).rows[0];
    if (inspect) {
      console.log(JSON.stringify({ destination: 'lvmzliemqnieeoruhkik', migrations, sha256, ...before }));
    } else {
      if (!before.tax_ready || !before.tasks_ready) throw new Error('Catalogue prerequisite migrations are missing');
      for (const source of sources) {
        // Keep the entire batch and its postconditions in this outer transaction.
        await client.query(source.replace(/^BEGIN;\s*/m, '').replace(/^COMMIT;\s*$/m, ''));
      }
      const verification = (await client.query(`SELECT
        (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_settings'
          AND column_name IN ('show_internal_code','show_sku') AND data_type='boolean'
          AND is_nullable='NO' AND column_default='true') AS columns_ready,
        has_function_privilege('service_role','public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)','EXECUTE')
          AND NOT has_function_privilege('authenticated','public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)','EXECUTE')
          AND NOT has_function_privilege('anon','public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)','EXECUTE') AS create_grants,
        has_function_privilege('service_role','public.patch_sales_settings(uuid,integer,jsonb,text,text)','EXECUTE')
          AND NOT has_function_privilege('authenticated','public.patch_sales_settings(uuid,integer,jsonb,text,text)','EXECUTE')
          AND NOT has_function_privilege('anon','public.patch_sales_settings(uuid,integer,jsonb,text,text)','EXECUTE') AS settings_grants,
        position('catalogue_visibility_v1' in pg_get_functiondef('public.patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure))>0 AS settings_ready`)).rows[0];
      if (Object.values(verification).some(value => value !== true)) throw new Error('Migration postconditions failed');
      await client.query("NOTIFY pgrst, 'reload schema'");
      await client.query('COMMIT');
      console.log(JSON.stringify({ applied: true, destination: 'lvmzliemqnieeoruhkik', migrations, sha256, verification, sourceUntouched: true }));
    }
    if (inspect) await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Do not print connection details from provider errors.
    console.error(`Destination migration/inspection failed (${error.code || 'validation'}). No transaction committed.`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
