import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('grouped billing SQL: replay, durable acceptance, exact snapshot, tenancy and legacy guard', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('sales-billing-');
  const command = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  let started = false;
  let db;
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE sales_quote_version(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, quote_id uuid, version_number integer,
        status text, currency text, net_minor bigint, tax_minor bigint, gross_minor bigint, UNIQUE(tenant_id,id));
      CREATE TABLE sales_commercial_sale(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, quote_version_id uuid, UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_status_history(tenant_id uuid,quote_version_id uuid,to_status text,created_at timestamptz DEFAULT now());
      CREATE TABLE sales_accounting_invoice_attempt(id uuid,tenant_id uuid,sale_id uuid);
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
    `);
    const migration = readFileSync(new URL('../../supabase/migrations/202610180003_sales_grouped_billing.sql', import.meta.url), 'utf8');
    await db.query(migration);
    await db.query(migration);
    const tenant = '00000000-0000-4000-8000-000000000001';
    const version = '00000000-0000-4000-8000-000000000002';
    const sale = '00000000-0000-4000-8000-000000000003';
    const group = { id: '00000000-0000-4000-8000-000000000004', name: 'Deposit', currency: 'GBP',
      netMinor: 100, taxMinor: 20, grossMinor: 120, timing: { kind: 'acceptance', days: 2 },
      paymentTerms: { name: '14 days', days: 14 }, contents: [] };
    const schedule = { timezone: 'America/New_York', timezoneFallback: false,
      recipient: { email: 'fixture@example.test', name: 'Fixture' }, groups: [group] };
    await db.query('INSERT INTO tenant VALUES($1)', [tenant]);
    await db.query(`INSERT INTO sales_quote_version(id,tenant_id,quote_id,version_number,status,currency,net_minor,tax_minor,gross_minor,billing_schedule)
      VALUES($1,$2,$1,1,'issued','GBP',100,20,120,$3)`, [version, tenant, schedule]);
    await assert.rejects(db.query('INSERT INTO sales_commercial_sale VALUES($1,$2,$3)', [sale, tenant, version]), /durable acceptance/);
    assert.equal((await db.query('SELECT count(*) FROM sales_invoice_schedule')).rows[0].count, '0');
    await db.query('BEGIN');
    await db.query('INSERT INTO sales_commercial_sale VALUES($1,$2,$3)', [sale, tenant, version]);
    await db.query(`INSERT INTO sales_quote_status_history VALUES($1,$2,'accepted','2024-03-10T04:30:00Z')`, [tenant, version]);
    await db.query(`UPDATE sales_quote_version SET status='converted' WHERE id=$1`, [version]);
    await db.query('COMMIT');
    const row = (await db.query(`SELECT *,planned_issue_date::text AS planned FROM sales_invoice_schedule`)).rows[0];
    assert.equal(row.planned, '2024-03-11');
    assert.deepEqual(row.snapshot.recipient, schedule.recipient);
    assert.equal((await db.query(`SELECT sales_invoice_schedule_is_due(s,now()) AS due FROM sales_invoice_schedule s`)).rows[0].due, true);
    await assert.rejects(db.query(`UPDATE sales_invoice_schedule SET snapshot=snapshot||'{"netMinor":99}'`), /immutable/);
    await assert.rejects(db.query(`UPDATE sales_invoice_schedule SET tenant_id=gen_random_uuid()`), /immutable/);
    await assert.rejects(db.query(`INSERT INTO sales_accounting_invoice_attempt VALUES(gen_random_uuid(),$1,$2)`, [tenant, sale]), /whole-sale/);
    await db.query(`UPDATE sales_invoice_schedule SET issue_date='2024-03-12',due_date='2024-03-26'`);
    await assert.rejects(db.query(`UPDATE sales_invoice_schedule SET issue_date='2024-03-13'`), /frozen/);
    await db.query('SET ROLE authenticated');
    await assert.rejects(db.query('SELECT * FROM sales_invoice_schedule'), /permission denied/);
    await db.query('RESET ROLE');
    await assert.rejects(db.query(`UPDATE sales_quote_version SET billing_schedule=jsonb_set(billing_schedule,'{groups,0,grossMinor}','121')`), /Invalid billing group/);
  } finally {
    await db?.end();
    if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
