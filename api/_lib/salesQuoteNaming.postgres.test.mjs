import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewedSettingsRpcBodies } from '../../scripts/apply-sales-quote-naming.mjs';

const migration = new URL('../../supabase/migrations/202610180002_sales_quote_naming.sql', import.meta.url);
const tenant = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const signature = 'public.patch_sales_settings(uuid,integer,jsonb,text,text)';
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role';";
const patch = (n, version, values, actor = 'test-actor') => `SELECT version FROM public.patch_sales_settings(
 '${tenant(n)}',${version},'${JSON.stringify(values).replaceAll("'", "''")}'::jsonb,'${actor}','tenant_user');`;

test('disposable PostgreSQL: naming constraints, first-save/update CAS, grants, audit, tenant and task-list preservation', {
  timeout: 60_000,
}, async (t) => {
  for (const executable of ['initdb', 'pg_ctl', 'psql']) {
    if (spawnSync('sh', ['-c', `command -v ${executable}`]).status !== 0) {
      t.skip('PostgreSQL command-line tools unavailable; no external database is used');
      return;
    }
  }
  const root = await mkdtemp(path.join(tmpdir(), 'sales-naming-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  await mkdir(socket);
  const run = (cmd, args, input) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const connection = ['-h', socket, '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  const sql = (input) => run('psql', connection, input);
  const failure = (input, expected) => {
    const result = spawnSync('psql', connection, { input, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  };
  const asyncSql = (input) => new Promise((resolve, reject) => {
    const child = spawn('psql', connection);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions', '--encoding=UTF8', '--locale=C']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p 5432`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS
       $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      CREATE TABLE public.tenant(id uuid PRIMARY KEY);
      CREATE TABLE public.role(id uuid PRIMARY KEY,tenant_id uuid,excluded_features text[]);
      INSERT INTO public.tenant VALUES ${[1, 2, 3, 4].map((n) => `('${tenant(n)}')`).join(',')};`);
    sql(await readFile(new URL('../../supabase/migrations/20260907_sales_foundation.sql', import.meta.url), 'utf8'));
    const predecessor = await readFile(new URL('../../supabase/migrations/202610120004_sales_automatic_quote_task_lists.sql', import.meta.url), 'utf8');
    // Exercise the actual latest settings DDL/RPC, not a reconstructed older RPC.
    // Board automation is outside this settings fixture and is not replaced here.
    sql(`${predecessor.split('-- Board links')[0]} COMMIT;`);
    const namingSql = await readFile(migration, 'utf8');
    failure(namingSql, /Review the installed catalogue visibility settings RPC/);
    assert.equal(sql(`SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='sales_settings' AND column_name='quote_singular_name'`), '0');
    const visibility = await readFile(new URL('../../supabase/migrations/202610180001_sales_catalogue_visibility.sql', import.meta.url), 'utf8');
    sql(visibility);
    const expectedBodies = reviewedSettingsRpcBodies(predecessor, visibility, namingSql);
    const beforeBody = sql(`SELECT prosrc FROM pg_proc WHERE oid='${signature}'::regprocedure`);
    assert.equal(beforeBody.replace(/\s+/g, ' ').trim(), expectedBodies.predecessor);
    sql(`${service}${patch(1, 1, { quotePrefix: 'P', quoteNumberPadding: 8, defaultCurrency: 'USD',
      defaultTaxRateBps: 2000, defaultTerms: 'Existing terms', moduleEnabled: false, quoteTaskListName: 'Delivery tasks',
      showInternalCode: false, showSku: false })}`);
    const before = JSON.parse(sql(`SELECT row_to_json(s) FROM public.sales_settings s WHERE tenant_id='${tenant(1)}'`));
    sql(namingSql);
    assert.equal(
      sql(`SELECT prosrc FROM pg_proc WHERE oid='${signature}'::regprocedure`).replace(/\s+/g, ' ').trim(),
      expectedBodies.migrated,
    );
    const after = JSON.parse(sql(`SELECT row_to_json(s) FROM public.sales_settings s WHERE tenant_id='${tenant(1)}'`));
    for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value, `migration preserves ${key}`);
    assert.deepEqual([after.quote_singular_name, after.quote_plural_name, after.quote_url_segment], ['Quote', 'Quotes', 'quotes']);
    sql(namingSql); // Idempotent forward migration, including grants.
    assert.equal(sql(`SELECT count(*) FROM public.sales_audit_event`), '1');
    // Strict visibility handling survives the naming extension unchanged.
    for (const key of ['showInternalCode', 'showSku']) {
      for (const value of [null, 'false', 0, {}, []]) {
        failure(`${service}${patch(2, 1, { [key]: value })}`, /Catalogue visibility settings must be booleans/);
      }
    }
    // Reapplying the latest visibility migration cannot erase naming either.
    sql(visibility);
    assert.equal(sql(`SELECT prosrc FROM pg_proc WHERE oid='${signature}'::regprocedure`).replace(/\s+/g, ' ').trim(), expectedBodies.migrated);
    assert.equal(sql(`SELECT has_function_privilege('service_role','${signature}','EXECUTE')
      AND NOT has_function_privilege('anon','${signature}','EXECUTE')
      AND NOT has_function_privilege('authenticated','${signature}','EXECUTE')`), 't');
    for (const role of ['anon', 'authenticated']) {
      failure(`SET ROLE ${role}; SET request.jwt.claim.role='service_role';${patch(2, 1, { quoteSingularName: 'Injected' })}`, /permission denied/);
      failure(`SET ROLE ${role}; SELECT * FROM public.sales_settings`, /permission denied/);
    }
    failure(`SET ROLE service_role;${patch(2, 1, { quoteSingularName: 'Wrong claim' })}`, /service role required/);
    failure(`${service}UPDATE public.sales_settings SET quote_singular_name='Direct write' WHERE tenant_id='${tenant(1)}'`, /permission denied/);
    for (const values of [
      { quoteSingularName: null }, { quotePluralName: 42 }, { quoteSingularName: '\u00a0\u3000' },
      { quotePluralName: '😀'.repeat(101) }, { quoteUrlSegment: null },
      ...['', 'Quotes', '-x', 'x-', 'x--y', 'a/b', 'café', 'a'.repeat(101),
        'dashboard', 'pipeline', 'opportunities', 'catalogue', 'reports', 'settings', 'allocations', 'products', 'bundles', 'tasks']
        .map((quoteUrlSegment) => ({ quoteUrlSegment })),
    ]) failure(`${service}${patch(2, 1, values)}`, /must contain|must be a non-reserved/);
    assert.equal(sql(`SELECT count(*) FROM public.sales_settings WHERE tenant_id='${tenant(2)}'`), '0');
    // PostgreSQL CHECKs also close direct owner writes outside the RPC.
    failure(`UPDATE public.sales_settings SET quote_url_segment='tasks' WHERE tenant_id='${tenant(1)}'`, /check constraint/);
    failure(`UPDATE public.sales_settings SET quote_singular_name=' padded ' WHERE tenant_id='${tenant(1)}'`, /check constraint/);
    sql(`${service}${patch(1, 2, { quoteSingularName: '\u3000提案\u00a0', quotePluralName: '😀'.repeat(100), quoteUrlSegment: 'proposals-2026' })}`);
    const renamed = JSON.parse(sql(`SELECT row_to_json(s) FROM public.sales_settings s WHERE tenant_id='${tenant(1)}'`));
    assert.equal(renamed.quote_singular_name, '提案');
    assert.equal(renamed.quote_plural_name, '😀'.repeat(100));
    assert.equal(renamed.quote_task_list_name, 'Delivery tasks');
    for (const key of ['quote_prefix', 'quote_number_padding', 'default_currency', 'default_tax_rate_bps', 'default_terms', 'module_enabled', 'show_internal_code', 'show_sku']) {
      assert.deepEqual(renamed[key], before[key], `naming PATCH preserves ${key}`);
    }
    sql(`${service}${patch(2, 1, { quoteSingularName: 'Offer', quoteUrlSegment: 'proposals-2026' })}`);
    assert.equal(sql(`SELECT quote_singular_name FROM public.sales_settings WHERE tenant_id='${tenant(1)}'`), '提案');
    assert.equal(sql(`SELECT quote_task_list_name FROM public.sales_settings WHERE tenant_id='${tenant(2)}'`), 'Quote tasks');
    // Both missing-row first-save and existing-row races must have exactly one winner.
    for (const [n, version] of [[3, 1], [1, 3]]) {
      const races = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        asyncSql(`${service}${patch(n, version, { quoteSingularName: `Offer ${i}` }, `actor-${i}`)}`)));
      assert.equal(races.filter((result) => result.status === 0).length, 1);
      for (const loser of races.filter((result) => result.status !== 0)) assert.match(loser.stderr, /version conflict/);
      assert.equal(sql(`SELECT version FROM public.sales_settings WHERE tenant_id='${tenant(n)}'`), String(version + 1));
    }
    assert.equal(sql(`SELECT count(*) FROM public.sales_settings WHERE tenant_id='${tenant(4)}'`), '0');
    assert.equal(sql(`SELECT count(*) FROM public.sales_audit_event WHERE tenant_id='${tenant(3)}'`), '1');
    assert.equal(sql(`SELECT bool_and(before_data->>'version'='1' AND after_data->>'version'='2'
      AND before_data->>'quote_singular_name'='Quote' AND actor_id LIKE 'actor-%' AND actor_type='tenant_user')
      FROM public.sales_audit_event WHERE tenant_id='${tenant(3)}'`), 't');
    assert.equal(sql(`SELECT count(*) FROM public.sales_audit_event`), '5');
    failure(`UPDATE public.sales_audit_event SET actor_id='rewrite'`, /immutable/);
    // Updating the separate task-list setting must not overwrite saved naming.
    sql(`${service}${patch(2, 2, { quoteTaskListName: 'Future delivery' })}`);
    assert.equal(sql(`SELECT quote_singular_name||':'||quote_url_segment||':'||quote_task_list_name
      FROM public.sales_settings WHERE tenant_id='${tenant(2)}'`), 'Offer:proposals-2026:Future delivery');
    sql(`${service}${patch(2, 3, { showInternalCode: false, showSku: false, quotePluralName: 'Offers' })}`);
    assert.equal(sql(`SELECT quote_singular_name||':'||quote_plural_name||':'||quote_url_segment||':'||
      show_internal_code::text||':'||show_sku::text FROM public.sales_settings WHERE tenant_id='${tenant(2)}'`),
    'Offer:Offers:proposals-2026:false:false');
    assert.equal(sql(`SELECT count(*) FROM public.sales_audit_event
      WHERE tenant_id='${tenant(2)}' AND before_data->>'version'='3' AND after_data->>'version'='4'
      AND before_data->>'show_internal_code'='true' AND after_data->>'show_internal_code'='false'
      AND before_data->>'show_sku'='true' AND after_data->>'show_sku'='false'
      AND after_data->>'quote_plural_name'='Offers' AND after_data->>'quote_task_list_name'='Future delivery'`), '1');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
