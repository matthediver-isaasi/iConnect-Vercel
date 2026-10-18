import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

test('atomic catalogue create: ordered components, rollback, reference locks, permissions and concurrent uniqueness (disposable PG)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sales-catalogue-create-'));
  const data = path.join(dir, 'db'), socket = path.join(dir, 'sock');
  mkdirSync(socket);
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const port = 55473;
  let started = false;
  const clients = [];
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', path.join(dir, 'log'), '-o', `-F -k ${socket} -p ${port} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const client = async (service = false) => {
      const c = new pg.Client({ host: socket, port, user: 'postgres', database: 'postgres' });
      await c.connect();
      clients.push(c);
      if (service) await c.query("SET ROLE service_role; SET request.jwt.claim.role='service_role'");
      return c;
    };
    const admin = await client();
    const sql = async text => (await admin.query(text)).rows;
    const tenant = '00000000-0000-4000-8000-000000000001';
    const otherTenant = '00000000-0000-4000-8000-000000000002';
    await sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
      GRANT USAGE ON SCHEMA auth TO service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      INSERT INTO tenant VALUES('${tenant}'),('${otherTenant}');
      CREATE TABLE sales_audit_event(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
        actor_id text NOT NULL, actor_type text NOT NULL, action text NOT NULL,
        entity_type text NOT NULL, entity_id uuid NOT NULL, before_data jsonb, after_data jsonb
      );
      CREATE TABLE event(id uuid PRIMARY KEY, tenant_id uuid, pricing_config jsonb);
      CREATE TABLE complex_event(id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY, tenant_id uuid, complex_event_id uuid);
    `);
    await sql(readFileSync('supabase/migrations/20260908_sales_catalogue.sql', 'utf8'));
    // Only the two prerequisite columns are needed from the larger tax/task
    // migrations; this fixture deliberately avoids live provider/project setup.
    await sql(`ALTER TABLE sales_catalogue_product ADD COLUMN tax_code jsonb;
      ALTER TABLE sales_catalogue_product ADD COLUMN create_task_on_acceptance boolean NOT NULL DEFAULT false;`);
    const migration = readFileSync('supabase/migrations/202610130002_sales_catalogue_atomic_create.sql', 'utf8');
    await sql(migration);
    await sql(migration); // Forward migration is replay-safe.
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await sql(`SELECT has_function_privilege('${role}',
        'public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)','EXECUTE') AS allowed`))[0].allowed, false);
    }
    const writer = await client(true);
    const writer2 = await client(true);
    const create = async (c, type, record, items = null, tenantId = tenant) => (
      await c.query('SELECT create_sales_catalogue_record($1,$2,$3,$4,$5,$6) AS record',
        [tenantId, type, record, items == null ? null : JSON.stringify(items), 'actor-a', 'tenant_user'])
    ).rows[0].record;
    const product = code => ({
      code, name: 'Product copy', currency: 'GBP', standard_price_minor: 12345,
      minimum_price_minor: 11111, cost_minor: 1201, tax_treatment: 'standard', tax_rate_bps: 2000,
      tax_code: { provider: 'xero', id: 'OUTPUT', name: 'VAT', rateBps: 2000 },
      create_task_on_acceptance: true, capacity_metadata: { arbitrary: 'preserved' },
    });
    const bundle = code => ({
      code, name: 'Bundle copy', currency: 'GBP', selling_price_minor: 15001,
      minimum_price_minor: 1, presentation_mode: 'itemised',
    });
    await assert.rejects(create(admin, 'products', product('NO_ROLE')), e => e.code === '42501');
    const first = await create(writer, 'products', {
      ...product('P_FIRST'), id: '00000000-0000-4000-8000-000000000009',
      is_active: false, archived_at: '2020-01-01', created_by: 'forged', tenant_id: otherTenant,
    });
    const second = await create(writer, 'products', product('P_SECOND'));
    assert.notEqual(first.id, '00000000-0000-4000-8000-000000000009');
    assert.equal(first.tenant_id, tenant);
    assert.equal(first.is_active, true);
    assert.equal(first.archived_at, null);
    assert.equal(first.created_by, 'actor-a');
    assert.equal(first.standard_price_minor, 12345);
    assert.equal(first.create_task_on_acceptance, true);
    assert.deepEqual(first.capacity_metadata, { arbitrary: 'preserved' });
    const items = [
      { productId: second.id, quantity: 4, displayOrder: 99 },
      { productId: first.id, quantity: 2, displayOrder: 0 },
    ];
    const created = await create(writer, 'bundles', bundle('B_ORDERED'), items);
    assert.deepEqual(created.items.map(item => [item.productId, item.quantity, item.displayOrder]), [
      [second.id, 4, 0], [first.id, 2, 1],
    ]);
    assert.equal(created.selling_price_minor, 15001);
    assert.deepEqual((await sql(`SELECT after_data FROM sales_audit_event WHERE entity_id='${created.id}'`))[0].after_data, created);
    assert.equal((await sql('SELECT count(*)::int AS n FROM sales_catalogue_product'))[0].n, 2);
    assert.deepEqual((await sql(`SELECT to_jsonb(p) AS p FROM sales_catalogue_product p WHERE id='${first.id}'`))[0].p, first);

    const counts = async () => (await sql(`SELECT
      (SELECT count(*)::int FROM sales_catalogue_product) AS products,
      (SELECT count(*)::int FROM sales_catalogue_bundle) AS bundles,
      (SELECT count(*)::int FROM sales_catalogue_bundle_item) AS items,
      (SELECT count(*)::int FROM sales_audit_event) AS audits`))[0];
    const beforeFailure = await counts();
    // Fail AFTER the bundle parent and an earlier component have been inserted.
    await sql(`CREATE FUNCTION fail_component() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.display_order=1 THEN RAISE EXCEPTION 'forced component failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER component_failure BEFORE INSERT ON sales_catalogue_bundle_item
      FOR EACH ROW EXECUTE FUNCTION fail_component();`);
    await assert.rejects(create(writer, 'bundles', bundle('B_COMPONENT_FAIL'), items), /forced component failure/);
    assert.deepEqual(await counts(), beforeFailure);
    await sql('DROP TRIGGER component_failure ON sales_catalogue_bundle_item');
    await sql(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced audit failure'; END $$;
      CREATE TRIGGER audit_failure BEFORE INSERT ON sales_audit_event FOR EACH ROW EXECUTE FUNCTION fail_audit();`);
    await assert.rejects(create(writer, 'bundles', bundle('B_AUDIT_FAIL'), items), /forced audit failure/);
    await assert.rejects(create(writer, 'products', product('P_AUDIT_FAIL')), /forced audit failure/);
    assert.deepEqual(await counts(), beforeFailure);
    await sql('DROP TRIGGER audit_failure ON sales_audit_event');
    await assert.rejects(create(writer, 'bundles', bundle('B_BAD_QUANTITY'), [
      { productId: first.id, quantity: 0 },
    ]), e => e.code === '23514');
    assert.deepEqual(await counts(), beforeFailure);
    await assert.rejects(create(writer, 'bundles', bundle('B_CROSS_TENANT'), items, otherTenant), e => e.code === '22023');
    await assert.rejects(create(writer, 'bundles', bundle('B_DUPLICATE_ITEMS'), [items[0], items[0]]), e => e.code === '22023');
    await sql(`UPDATE sales_catalogue_product SET is_active=false, archived_at=now() WHERE id='${second.id}'`);
    await assert.rejects(create(writer, 'bundles', bundle('B_INACTIVE'), items), e => e.code === '22023');
    await assert.rejects(create(writer, 'products', product('P_SECOND')), e => e.code === '23505'
      && e.constraint === 'sales_catalogue_product_code_unique');
    await sql(`UPDATE sales_catalogue_product SET is_active=true, archived_at=NULL WHERE id='${second.id}'`);

    for (const type of ['products', 'bundles']) {
      const before = await counts();
      const record = type === 'products' ? product('CONCURRENT') : bundle('CONCURRENT');
      const outcomes = await Promise.allSettled([
        create(writer, type, record, type === 'bundles' ? items : null),
        create(writer2, type, record, type === 'bundles' ? items : null),
      ]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      const failure = outcomes.find(result => result.status === 'rejected').reason;
      assert.equal(failure.code, '23505');
      assert.equal(failure.constraint, `sales_catalogue_${type.slice(0, -1)}_code_unique`);
      const after = await counts();
      assert.equal(after.audits, before.audits + 1);
      assert.equal(after[type], before[type] + 1);
      if (type === 'bundles') assert.equal(after.items, before.items + 2);
    }

    const category = (await sql(`INSERT INTO sales_catalogue_category(tenant_id,code,name)
      VALUES('${tenant}','CATEGORY','Category') RETURNING id`))[0].id;
    const eventId = '00000000-0000-4000-8000-000000000003';
    const complexId = '00000000-0000-4000-8000-000000000004';
    const ticketId = '00000000-0000-4000-8000-000000000005';
    await sql(`INSERT INTO event VALUES('${eventId}','${tenant}','{"ticket_classes":[{"id":"ticket"}]}');
      INSERT INTO complex_event VALUES('${complexId}','${tenant}');
      INSERT INTO complex_event_ticket_class VALUES('${ticketId}','${tenant}','${complexId}');`);
    // A second transaction cannot mutate a referenced row until create commits.
    await admin.query("SET lock_timeout='100ms'");
    const lockCases = [
      ['bundles', bundle('LOCK_BUNDLE'), items, `UPDATE sales_catalogue_product SET name='changed' WHERE id='${first.id}'`],
      ['products', { ...product('LOCK_CATEGORY'), category_id: category }, null,
        `UPDATE sales_catalogue_category SET is_active=false,archived_at=now() WHERE id='${category}'`],
      ['products', { ...product('LOCK_SIMPLE'), event_reference_kind: 'simple', event_id: eventId, ticket_type_id: 'ticket' }, null,
        `UPDATE event SET pricing_config='{}' WHERE id='${eventId}'`],
      ['products', { ...product('LOCK_COMPLEX'), event_reference_kind: 'complex', event_id: complexId, ticket_type_id: ticketId }, null,
        `DELETE FROM complex_event_ticket_class WHERE id='${ticketId}'`],
    ];
    for (const [type, record, composition, mutation] of lockCases) {
      await writer.query('BEGIN');
      await create(writer, type, record, composition);
      await assert.rejects(admin.query(mutation), e => e.code === '55P03');
      await writer.query('ROLLBACK');
    }
    await assert.rejects(create(writer, 'products', {
      ...product('BAD_TICKET'), event_reference_kind: 'simple', event_id: eventId, ticket_type_id: 'retired',
    }), e => e.code === '22023');
    await assert.rejects(create(writer, 'products', {
      ...product('OTHER_EVENT'), event_reference_kind: 'complex', event_id: complexId, ticket_type_id: ticketId,
    }, null, otherTenant), e => e.code === '22023');
  } finally {
    await Promise.all(clients.map(c => c.end()));
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
