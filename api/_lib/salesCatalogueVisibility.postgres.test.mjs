import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const id = n => `'10000000-0000-4000-8000-${String(n).padStart(12, '0')}'`;
const migration = readFileSync('supabase/migrations/202610180001_sales_catalogue_visibility.sql', 'utf8');

test('catalogue visibility migration and versioned RPC on disposable PostgreSQL', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sales-visibility-'));
  const data = join(dir, 'db'), socket = join(dir, 'socket');
  mkdirSync(socket);
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Command failed');
    return result.stdout.trim();
  };
  const args = ['-h', socket, '-p', '55458', '-U', 'postgres', '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1'];
  const sql = text => run('psql', args, text);
  const service = text => sql(`SET ROLE service_role; SET request.jwt.claim.role='service_role'; ${text}`);
  const patch = (tenant, version, body) =>
    `SELECT version FROM public.patch_sales_settings(${id(tenant)},${version},'${JSON.stringify(body)}','settings-admin','tenant_user');`;
  const row = tenant => JSON.parse(sql(`SELECT row_to_json(s) FROM sales_settings s WHERE tenant_id=${id(tenant)}`));
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(dir, 'log'), '-o',
      `-F -k ${socket} -p 55458 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
      GRANT USAGE ON SCHEMA auth TO service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE public.role(id uuid PRIMARY KEY, excluded_features text[]);
      INSERT INTO tenant VALUES(${id(1)}),(${id(2)}),(${id(3)}),(${id(4)});`);
    sql(readFileSync('supabase/migrations/20260907_sales_foundation.sql', 'utf8'));
    // Install the real settings portion of the task-list migration without
    // creating unrelated quote/project automation fixtures.
    const taskMigration = readFileSync('supabase/migrations/202610120004_sales_automatic_quote_task_lists.sql', 'utf8');
    const settingsSection = taskMigration.slice(taskMigration.indexOf('ALTER TABLE public.sales_settings'),
      taskMigration.indexOf('-- Board links'));
    assert.match(settingsSection, /CREATE OR REPLACE FUNCTION public.patch_sales_settings/);
    sql(settingsSection);
    service(patch(1, 1, { quoteTaskListName: 'Delivery', defaultCurrency: 'USD',
      defaultTerms: 'Original terms', quotePrefix: 'S', defaultTaxRateBps: 500, moduleEnabled: false }));
    // Model another independently added field/RPC branch before this migration.
    sql(`ALTER TABLE sales_settings ADD COLUMN future_setting text NOT NULL DEFAULT 'future default';
      DO $test$ DECLARE definition text; BEGIN
        SELECT pg_get_functiondef('public.patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure) INTO definition;
        definition := replace(definition,'UPDATE public.sales_settings SET',
          'UPDATE public.sales_settings SET future_setting=CASE WHEN p_patch ? ''futureSetting'' THEN p_patch->>''futureSetting'' ELSE future_setting END,');
        EXECUTE definition;
      END $test$;`);
    sql(migration);

    await t.test('defaults and replay preserve existing rows and installed future RPC branches', () => {
      const before = row(1);
      assert.equal(before.show_internal_code, true);
      assert.equal(before.show_sku, true);
      assert.equal(before.quote_task_list_name, 'Delivery');
      assert.equal(before.default_currency, 'USD');
      const definition = sql("SELECT pg_get_functiondef('public.patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure)");
      sql(migration);
      assert.deepEqual(row(1), before);
      assert.equal(sql("SELECT pg_get_functiondef('public.patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure)"), definition);
      assert.equal((definition.match(/catalogue_visibility_v1/g) || []).length, 1);
    });
    await t.test('explicit false is independent and partial patches retain current and future settings', () => {
      const before = row(1);
      assert.equal(service(patch(1, 2, { showInternalCode: false })), '3');
      assert.equal(row(1).show_internal_code, false);
      assert.equal(row(1).show_sku, true);
      for (const key of ['quote_prefix', 'quote_number_padding', 'default_currency',
        'default_tax_rate_bps', 'default_terms', 'module_enabled', 'quote_task_list_name', 'future_setting']) {
        assert.equal(row(1)[key], before[key], key);
      }
      service(patch(1, 3, { showSku: false, futureSetting: 'future value' }));
      assert.equal(row(1).show_internal_code, false);
      assert.equal(row(1).show_sku, false);
      assert.equal(row(1).future_setting, 'future value');
      service(patch(1, 4, { quoteTaskListName: 'Updated tasks', showInternalCode: true }));
      assert.equal(row(1).show_sku, false);
      assert.equal(row(1).future_setting, 'future value');
      assert.equal(row(1).quote_task_list_name, 'Updated tasks');
    });
    await t.test('SQL rejects non-booleans before insertion, and stale versions do not write or audit', () => {
      for (const key of ['showInternalCode', 'showSku']) {
        for (const value of [null, 'false', 'true', 0, 1, [], {}]) {
          assert.throws(() => service(patch(4, 1, { [key]: value })), /must be booleans/);
        }
      }
      assert.equal(sql(`SELECT count(*) FROM sales_settings WHERE tenant_id=${id(4)}`), '0');
      const before = row(1), auditCount = sql('SELECT count(*) FROM sales_audit_event');
      assert.throws(() => service(patch(1, 1, { showSku: true })), /version conflict/);
      assert.deepEqual(row(1), before);
      assert.equal(sql('SELECT count(*) FROM sales_audit_event'), auditCount);
    });
    await t.test('concurrent first saves serialize with one conflict and one audit event', async () => {
      const command = `SET ROLE service_role; SET request.jwt.claim.role='service_role';
        BEGIN; ${patch(3, 1, { showSku: false })} SELECT pg_sleep(0.15); COMMIT;`;
      const results = await Promise.allSettled([0, 1].map(() =>
        promisify(execFile)('psql', [...args, '-c', command])));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.match(results.find(r => r.status === 'rejected').reason.stderr, /version conflict/);
      assert.equal(row(3).version, 2);
      assert.equal(row(3).show_sku, false);
      assert.equal(row(3).show_internal_code, true);
      assert.equal(sql(`SELECT count(*) FROM sales_audit_event WHERE tenant_id=${id(3)}`), '1');
    });
    await t.test('tenant settings and version histories are independent', () => {
      const before = row(1);
      service(patch(2, 1, { showSku: false }));
      assert.equal(row(2).show_internal_code, true);
      assert.equal(row(2).show_sku, false);
      assert.equal(row(2).quote_task_list_name, 'Quote tasks');
      assert.equal(row(2).version, 2);
      assert.deepEqual(row(1), before);
    });
    await t.test('RPC grants, actor audit snapshots, rollback and failed audit are atomic', () => {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(sql(`SELECT has_function_privilege('${role}',
          'public.patch_sales_settings(uuid,integer,jsonb,text,text)','EXECUTE')`), 'f');
        assert.throws(() => sql(`SET ROLE ${role}; ${patch(2, 2, { showSku: true })}`), /permission denied/);
        assert.throws(() => sql(`SET ROLE ${role}; SELECT * FROM sales_settings`), /permission denied/);
      }
      assert.equal(sql(`SELECT has_function_privilege('service_role',
        'public.patch_sales_settings(uuid,integer,jsonb,text,text)','EXECUTE')`), 't');
      const audit = JSON.parse(sql(`SELECT row_to_json(a) FROM sales_audit_event a
        WHERE tenant_id=${id(2)}`));
      assert.equal(audit.actor_id, 'settings-admin');
      assert.equal(audit.actor_type, 'tenant_user');
      assert.equal(audit.before_data.show_sku, true);
      assert.equal(audit.after_data.show_sku, false);
      const before = row(2), count = sql('SELECT count(*) FROM sales_audit_event');
      service(`BEGIN; ${patch(2, 2, { showSku: true })} ROLLBACK;`);
      assert.deepEqual(row(2), before);
      assert.equal(sql('SELECT count(*) FROM sales_audit_event'), count);
      sql(`CREATE FUNCTION fail_visibility_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced audit failure'; END $$;
        CREATE TRIGGER fail_visibility_audit BEFORE INSERT ON sales_audit_event
        FOR EACH ROW EXECUTE FUNCTION fail_visibility_audit();`);
      assert.throws(() => service(patch(2, 2, { showSku: true })), /forced audit failure/);
      assert.deepEqual(row(2), before);
      assert.equal(sql('SELECT count(*) FROM sales_audit_event'), count);
      assert.throws(() => service(patch(4, 1, { showSku: false })), /forced audit failure/);
      assert.equal(sql(`SELECT count(*) FROM sales_settings WHERE tenant_id=${id(4)}`), '0');
    });
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
