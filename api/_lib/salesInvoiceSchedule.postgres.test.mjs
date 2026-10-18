import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('isolated schedule SQL: atomic queue identity, tenant authority, dates, multiple invoices and durable delivery fencing', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('sales-schedule-accounting-');
  const command = (name, args) => {
    const got = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(got.status, 0, got.stderr);
  };
  const clients = [];
  let started = false;
  const tenant = '00000000-0000-4000-8000-000000000001';
  const sale = '00000000-0000-4000-8000-000000000002';
  const version = '00000000-0000-4000-8000-000000000003';
  let first = '00000000-0000-4000-8000-000000000004';
  let second = '00000000-0000-4000-8000-000000000005';
  let third = '00000000-0000-4000-8000-000000000006';
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 3; i++) {
      const client = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await client.connect(); clients.push(client);
    }
    const [admin, a, b] = clients;
    await admin.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE sales_quote_version(id uuid PRIMARY KEY,tenant_id uuid,quote_id uuid,version_number integer,
        status text,currency text,net_minor bigint,tax_minor bigint,gross_minor bigint,UNIQUE(tenant_id,id));
      CREATE TABLE sales_commercial_sale(id uuid PRIMARY KEY,tenant_id uuid,quote_version_id uuid,UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_status_history(tenant_id uuid,quote_version_id uuid,to_status text,created_at timestamptz DEFAULT now());
      CREATE FUNCTION guard_quote_child_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE FUNCTION guard_quote_component_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE FUNCTION transition_sales_quote(p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_status text,p_note text,p_actor_id text,p_actor_type text)
      RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE q record; v sales_quote_version%ROWTYPE;
      BEGIN
      RETURN jsonb_build_object('id',q.id,'row_version',q.row_version,'status',p_status);
      END $$;
      CREATE FUNCTION save_sales_quote_draft(p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_payload jsonb,p_actor_id text,p_actor_type text)
      RETURNS void LANGUAGE plpgsql AS $$
      DECLARE calc_net bigint; calc_tax bigint; calc_gross bigint; v sales_quote_version%ROWTYPE;
      BEGIN
      UPDATE public.sales_quote_version SET net_minor=calc_net,tax_minor=calc_tax,gross_minor=calc_gross WHERE id=v.id;
      END $$;
      CREATE TABLE sales_accounting_invoice_link(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
        sale_id uuid,quote_version_id uuid,provider text,provider_invoice_id text,provider_invoice_number text,
        provider_invoice_url text,provider_status text,provider_status_raw text,created_by text,
        UNIQUE(tenant_id,sale_id,provider),UNIQUE(tenant_id,provider,provider_invoice_id));
      CREATE TABLE sales_accounting_invoice_attempt(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,sale_id uuid,provider text);
      CREATE TABLE sales_audit_event(tenant_id uuid,actor_id text,actor_type text,action text,entity_type text,entity_id text,after_data jsonb);
      INSERT INTO tenant VALUES('${tenant}');`);
    for (const name of ['202610180003_sales_grouped_billing.sql',
      '202612050001_accounting_request_queue.sql', '202612050002_accounting_request_gc_preparation.sql',
      '202610180005_sales_grouped_accounting.sql']) {
      await admin.query(readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    }
    await admin.query(readFileSync(new URL('../../supabase/migrations/202610180005_sales_grouped_accounting.sql', import.meta.url), 'utf8'));
    await a.query('SET ROLE service_role'); await b.query('SET ROLE service_role');
    const economics = { netMinor: 1000, taxMinor: 200, grossMinor: 1200, currency: 'GBP', paymentTerms: { days: 14 } };
    const groups = [first, second, third].map(id => ({ ...economics, id, name: 'Group', timing: { kind: 'acceptance', days: 0 }, contents: [] }));
    await admin.query(`INSERT INTO sales_quote_version VALUES($1,$2,$1,1,'accepted','GBP',3000,600,3600,$3)`,
      [version, tenant, { timezone: 'UTC', timezoneFallback: false, recipient: { email: 'frozen@example.test' }, groups }]);
    await admin.query(`INSERT INTO sales_quote_status_history VALUES($1,$2,'accepted',now()-interval '10 days')`, [tenant, version]);
    await admin.query('INSERT INTO sales_commercial_sale VALUES($1,$2,$3)', [sale, tenant, version]);
    const schedules = (await admin.query('SELECT * FROM sales_invoice_schedule ORDER BY group_id')).rows;
    [first, second, third] = schedules.map(row => row.id);
    const dates = (await admin.query("SELECT current_date::text AS issue,(current_date+14)::text AS due")).rows[0];
    const snapshot = id => ({ version: 1, preparation: true, environment: null, payment: null,
      invoice: { customer: { name: 'Frozen customer' }, payload: { ...economics,
        issueDate: dates.issue, dueDate: dates.due, idempotencyKey: `schedule-${id}` } },
      linkage: { scheduleId: id, saleId: sale, quoteVersionId: version, actorId: 'worker', actorType: 'system' } });
    const dispatchToken = '00000000-0000-4000-8000-000000000020';
    const enqueue = (client, id, authority = snapshot(id), tenantId = tenant) => client.query(
      'SELECT enqueue_sales_invoice_schedule($1,$2,$3,$4,$5,$6,$7) AS row',
      [tenantId, id, 'xero', 'connection', 'company', authority, dispatchToken]);
    await assert.rejects(enqueue(a, first, snapshot(first), '00000000-0000-4000-8000-000000000099'), /not found/);
    await assert.rejects(enqueue(a, first), /lease/);
    const claimDispatch = (client, id) => client.query('SELECT claim_sales_schedule_dispatch($1,$2,$3) AS claimed', [tenant, id, dispatchToken]);
    const dispatchClaims = await Promise.all([claimDispatch(a, first), claimDispatch(b, first)]);
    assert.equal(dispatchClaims.filter(value => value.rows[0].claimed).length, 1);
    await claimDispatch(a, second); await claimDispatch(a, third);
    const early = snapshot(first); early.invoice.payload.issueDate = '2000-01-01';
    await assert.rejects(enqueue(a, first, early), /dates/);
    const concurrent = await Promise.all([enqueue(a, first), enqueue(b, first)]);
    const firstRow = concurrent[0].rows[0].row;
    assert.equal(firstRow.accounting_request_id, concurrent[1].rows[0].row.accounting_request_id);
    assert.equal(firstRow.issue_date, dates.issue);
    assert.equal(firstRow.due_date, dates.due);
    assert.equal((await admin.query('SELECT count(*) FROM accounting_request_queue')).rows[0].count, '1');
    await assert.rejects(admin.query("UPDATE sales_invoice_schedule SET provider='quickbooks' WHERE id=$1", [first]), /immutable/);
    await assert.rejects(admin.query("UPDATE sales_invoice_schedule SET provider_company_id='other' WHERE id=$1", [first]), /immutable/);
    await assert.rejects(admin.query("UPDATE accounting_request_queue SET company_id='other' WHERE id=$1",
      [firstRow.accounting_request_id]), /immutable/);
    await assert.rejects(admin.query('INSERT INTO sales_accounting_invoice_attempt(tenant_id,sale_id,provider) VALUES($1,$2,$3)',
      [tenant, sale, 'xero']), /whole-sale/);
    const secondRow = (await enqueue(a, second)).rows[0].row;
    const acceptedSnapshot = (await admin.query('SELECT snapshot FROM accounting_request_queue WHERE id=$1',
      [secondRow.accounting_request_id])).rows[0].snapshot;
    await admin.query("UPDATE accounting_request_queue SET state='review' WHERE id=$1", [secondRow.accounting_request_id]);
    await admin.query(`UPDATE sales_invoice_schedule SET last_error=$2 WHERE id=$1`, [second,
      { code: 'AMBIGUOUS_CUSTOMER_MATCH', details: { candidates: [{ id: 'customer-a', name: 'A' }, { id: 'customer-b', name: 'B' }] } }]);
    const confirm = (id, yes) => a.query('SELECT retry_sales_invoice_schedule_preparation($1,$2,$3,$4,$5,$6)',
      [tenant, second, id, yes, 'reviewer', 'tenant_user']);
    await assert.rejects(confirm('customer-a', false), /Explicit selection/);
    await assert.rejects(confirm('not-a-candidate', true), /Explicit selection/);
    await confirm('customer-b', true);
    assert.deepEqual((await admin.query('SELECT snapshot FROM accounting_request_queue WHERE id=$1',
      [secondRow.accounting_request_id])).rows[0].snapshot, acceptedSnapshot);
    assert.equal((await admin.query('SELECT customer_resolution FROM sales_invoice_schedule WHERE id=$1', [second]))
      .rows[0].customer_resolution.providerCustomerId, 'customer-b');
    const link = async (row, invoice) => {
      await admin.query(`UPDATE accounting_request_queue SET preparation_status='done',
        resolved_snapshot=coalesce(resolved_snapshot,snapshot-'preparation'),invoice_status='done',invoice_result=$2 WHERE id=$1`,
        [row.accounting_request_id, { id: invoice, invoiceNumber: invoice }]);
      return a.query('SELECT link_sales_invoice_schedule($1,$2,$3)', [tenant, row.id, row.accounting_request_id]);
    };
    await link(firstRow, 'INV-1');
    await link(firstRow, 'INV-1');
    await link(secondRow, 'INV-2');
    const thirdRow = (await enqueue(a, third)).rows[0].row;
    await assert.rejects(link(thirdRow, 'INV-1'), /linked elsewhere/);
    assert.equal((await admin.query('SELECT count(*) FROM sales_accounting_invoice_link')).rows[0].count, '2');
    const offSweep = (await a.query('SELECT * FROM due_sales_invoice_schedules(40,false)')).rows;
    assert.equal(offSweep.length, 2);
    assert.ok(offSweep.every(row => row.status === 'invoiced'));
    const token = '00000000-0000-4000-8000-000000000010';
    const claim = client => client.query('SELECT claim_sales_schedule_delivery($1,$2,$3) AS claimed', [tenant, first, token]);
    const claims = await Promise.all([claim(a), claim(b)]);
    assert.equal(claims.filter(value => value.rows[0].claimed).length, 1);
    await a.query("SELECT finish_sales_schedule_delivery($1,$2,$3,'sent','message-id',NULL)", [tenant, first, token]);
    assert.equal((await claim(b)).rows[0].claimed, false);
    await assert.rejects(admin.query("UPDATE sales_invoice_schedule SET delivery_status='pending' WHERE id=$1", [first]), /immutable/);
    await admin.query("UPDATE sales_invoice_schedule SET delivery_status='sending',delivery_claimed_at=now()-interval '1 hour' WHERE id=$1", [second]);
    await a.query('SELECT * FROM due_sales_invoice_schedules(40)');
    assert.equal((await admin.query('SELECT delivery_status FROM sales_invoice_schedule WHERE id=$1', [second])).rows[0].delivery_status, 'attention');
    await admin.query('SET ROLE authenticated');
    await assert.rejects(admin.query('SELECT * FROM due_sales_invoice_schedules(40)'), /permission denied/);
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await h.cleanup();
  }
});
