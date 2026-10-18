import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

test('billing settings and bundle saves: real SQL replay, CAS, tenancy, integrity and rollback', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sales-billing-config-'));
  const data = path.join(dir, 'db'), socket = path.join(dir, 'sock');
  mkdirSync(socket);
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const port = 55479, clients = [];
  let started = false;
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const migration = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', data, '-l', path.join(dir, 'log'), '-o', `-F -k ${socket} -p ${port} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const connect = async service => {
      const c = new pg.Client({ host: socket, port, user: 'postgres', database: 'postgres' });
      await c.connect(); clients.push(c);
      if (service) await c.query("SET ROLE service_role; SET request.jwt.claim.role='service_role'");
      return c;
    };
    const db = await connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
      GRANT USAGE ON SCHEMA auth TO service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY); CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,excluded_features text[]);
      INSERT INTO tenant VALUES('${id(1)}'),('${id(2)}');
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,pricing_config jsonb);
      CREATE TABLE complex_event(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid);`);
    await db.query(migration('20260907_sales_foundation'));
    await db.query(migration('20260908_sales_catalogue'));
    await db.query(`${migration('202610120004_sales_automatic_quote_task_lists').split('-- Board links')[0]} COMMIT;`);
    await db.query(migration('202610180001_sales_catalogue_visibility'));
    await db.query(migration('202610180002_sales_quote_naming'));
    await db.query('ALTER TABLE sales_catalogue_product ADD COLUMN tax_code jsonb; ALTER TABLE sales_catalogue_product ADD COLUMN create_task_on_acceptance boolean NOT NULL DEFAULT false');
    await db.query(migration('202610130002_sales_catalogue_atomic_create'));
    await db.query(migration('202610180004_sales_billing_configuration'));
    await db.query(migration('202610180004_sales_billing_configuration'));
    const a = await connect(true), b = await connect(true);
    const patch = (c, version, fields, tenant = id(1)) => c.query('SELECT * FROM patch_sales_settings($1,$2,$3,$4,$5)', [tenant, version, fields, 'actor', 'tenant_user']);
    const term = { id: id(3), name: '7 days', days: 7, isActive: true, isDefault: true };
    const presets = { issueDelays: [], paymentTerms: [term] };
    const results = await Promise.allSettled([patch(a, 1, { billingPresets: presets }), patch(b, 1, { showSku: false })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, '40001', JSON.stringify(results.find(r => r.status === 'rejected').reason));
    let version = (await db.query('SELECT version FROM sales_settings WHERE tenant_id=$1', [id(1)])).rows[0].version;
    await patch(a, version++, { billingPresets: presets, showSku: false, quoteSingularName: 'Proposal', quoteTaskListName: 'Fulfilment' });
    await patch(a, version++, { billingPresets: presets });
    const settings = (await db.query('SELECT * FROM sales_settings WHERE tenant_id=$1', [id(1)])).rows[0];
    assert.equal(settings.show_sku, false); assert.equal(settings.quote_singular_name, 'Proposal'); assert.equal(settings.quote_task_list_name, 'Fulfilment');
    await assert.rejects(patch(a, version, { billingPresets: { ...presets, paymentTerms: [{ ...term, days: '7' }] } }), e => e.code === '22023');
    const create = async (type, record, items, tenant = id(1)) => (await a.query('SELECT create_sales_catalogue_record($1,$2,$3,$4,$5,$6) AS record',
      [tenant, type, record, items ? JSON.stringify(items) : null, 'actor', 'tenant_user'])).rows[0].record;
    const p = await create('products', { code: 'P1', name: 'Product', currency: 'GBP', standard_price_minor: 100, tax_treatment: 'standard' });
    const p2 = await create('products', { code: 'P2', name: 'Other', currency: 'GBP', standard_price_minor: 0, tax_treatment: 'standard' });
    const items = [{ productId: p.id, quantity: 1 }, { productId: p2.id, quantity: 1 }];
    const groups = [{ id: id(4), name: 'Deposit', position: 0, allocatedMinor: 75, productIds: [p.id], timing: { kind: 'acceptance', days: 0 }, paymentTerms: { id: term.id, name: term.name, days: term.days } },
      { id: id(5), name: 'Other', position: 1, allocatedMinor: 25, productIds: [p2.id], timing: { kind: 'fixed', date: '2026-10-18' }, paymentTerms: { id: term.id, name: term.name, days: term.days } }];
    const record = { code: 'B1', name: 'Bundle', currency: 'GBP', selling_price_minor: 100, presentation_mode: 'bundle', display_order: 0, billing_groups: groups };
    const bundle = await create('bundles', record, items);
    assert.deepEqual(bundle.billing_groups, groups);
    const update = async (r, i = items, expected = bundle.updated_at) => (await a.query('SELECT update_sales_catalogue_bundle($1,$2,$3,$4,$5,$6,$7) AS record',
      [id(1), bundle.id, expected, r, JSON.stringify(i), 'actor', 'tenant_user'])).rows[0].record;
    const original = async () => (await db.query('SELECT to_jsonb(b) AS b FROM sales_catalogue_bundle b WHERE id=$1', [bundle.id])).rows[0].b;
    const before = await original();
    await assert.rejects(update({ ...record, name: 'Must rollback', selling_price_minor: 99 }), e => e.code === '22023');
    await assert.rejects(update(record, [items[0]]), e => e.code === '22023');
    assert.deepEqual(await original(), before);
    await assert.rejects(create('bundles', { ...record, code: 'B_FOREIGN' }, items, id(2)), e => e.code === '22023');
    await patch(a, version++, { billingPresets: { ...presets, paymentTerms: [{ ...term, isActive: false, isDefault: false }] } });
    const updated = await update({ ...record, name: 'Retains saved terms' });
    assert.deepEqual(updated.billing_groups, groups);
    await assert.rejects(update(record), e => e.code === '40001');
    await assert.rejects(create('bundles', { ...record, code: 'B_INACTIVE' }, items), e => e.code === '22023');
    const copiedGroups = groups.map((group, index) => ({ ...group, id: id(index + 10), sourceGroupId: group.id }));
    const copied = await create('bundles', { ...record, code: 'B_COPY', copy_source_id: bundle.id, billing_groups: copiedGroups }, items);
    assert.deepEqual(copied.billing_groups, copiedGroups.map(({ sourceGroupId, ...group }) => group));
    assert.notEqual(copied.id, bundle.id);
    await assert.rejects(create('bundles', { ...record, code: 'B_COPY_BAD', copy_source_id: bundle.id,
      billing_groups: copiedGroups.map(group => ({ ...group, paymentTerms: { ...group.paymentTerms, days: 0 } })) }, items), e => e.code === '22023');
    await assert.rejects(create('bundles', { ...record, code: 'B_COPY_ID', copy_source_id: bundle.id,
      billing_groups: groups.map(group => ({ ...group, sourceGroupId: group.id })) }, items), e => e.code === '22023');
    await assert.rejects(db.query('DELETE FROM sales_catalogue_bundle_item WHERE bundle_id=$1 AND product_id=$2', [bundle.id, p.id]), e => e.code === '22023');
    await db.query(`CREATE FUNCTION fail_billing_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit rollback'; END$$;
      CREATE TRIGGER fail_billing_audit BEFORE INSERT ON sales_audit_event FOR EACH ROW EXECUTE FUNCTION fail_billing_audit();`);
    const preAudit = await original();
    await assert.rejects(update({ ...record, name: 'Cannot persist' }, items, updated.updated_at), /audit rollback/);
    assert.deepEqual(await original(), preAudit);
    for (const role of ['anon', 'authenticated']) {
      const access = (await db.query(`SELECT has_function_privilege('${role}','update_sales_catalogue_bundle(uuid,uuid,timestamptz,jsonb,jsonb,text,text)','EXECUTE') AS allowed`)).rows[0];
      assert.equal(access.allowed, false);
    }
  } finally {
    await Promise.all(clients.map(c => c.end().catch(() => {})));
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
