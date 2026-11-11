import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tenant = '10000000-0000-4000-8000-000000000001';
const product = '20000000-0000-4000-8000-000000000001';
const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = (command, args, input = '') => {
  const result = spawnSync(command, args, { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
test('invoice order commits unpaid stock and queue atomically; retries, tampering and missing opt-in are rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'form-invoice-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  let started = false;
  try {
    run('initdb', ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const args = ['-X', '-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
    const sql = text => run('psql', args, text);
    const denied = (text, pattern) => {
      const r = spawnSync('psql', args, { input: text, encoding: 'utf8' });
      assert.notEqual(r.status, 0); assert.match(r.stderr, pattern);
    };
    const migration = name => fileURLToPath(new URL(`../../supabase/migrations/${name}`, import.meta.url));
    const fields = [{ id: 'cart', type: 'sales_cart', cart_version: 1, required: true,
      allowed_product_ids: [product], allowed_bundle_ids: [], bundle_tax: {} },
    { id: 'pay', type: 'payment', price_field_id: 'cart', payment_currency: 'GBP', payment_providers: ['invoice', 'stripe'] }];
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE sales_catalogue_bundle(id uuid PRIMARY KEY,tenant_id uuid,name text,description text,selling_price_minor bigint,currency text,
        is_active boolean,archived_at timestamptz,available_from timestamptz,available_to timestamptz,UNIQUE(tenant_id,id));
      CREATE TABLE sales_catalogue_product(id uuid PRIMARY KEY,tenant_id uuid,name text,description text,standard_price_minor bigint,currency text,
        tax_treatment text,tax_rate_bps integer,event_reference_kind text,event_id uuid,ticket_type_id text,space_requirement_id uuid,
        is_active boolean,archived_at timestamptz,available_from timestamptz,available_to timestamptz,UNIQUE(tenant_id,id));
      CREATE TABLE sales_catalogue_bundle_item(tenant_id uuid,bundle_id uuid,product_id uuid);
      CREATE TABLE form_submission(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,idempotency_key text,submission_data jsonb,
        payment_status text,payment_provider text,payment_reference text,payment_amount numeric,payment_currency text,payment_meta jsonb);
      CREATE UNIQUE INDEX unique_attempt ON form_submission(form_id,idempotency_key);
      CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,fields jsonb,form_type text);
      CREATE TABLE sales_audit_event(tenant_id uuid,actor_id text,actor_type text,action text,entity_type text,entity_id text,before_data jsonb,after_data jsonb);
      INSERT INTO sales_catalogue_product(id,tenant_id,name,description,standard_price_minor,currency,tax_treatment,tax_rate_bps,is_active)
        VALUES('${product}','${tenant}','Item','Item',10000,'GBP','standard',2000,true);
      INSERT INTO form VALUES('${tenant}','${tenant}','${JSON.stringify(fields)}','standard');
      \\i ${migration('202701200001_form_bundle_stock.sql')}
      \\i ${migration('202701200002_form_bundle_submission_stock_option.sql')}
      \\i ${migration('202701200003_form_cart.sql')}
      \\i ${migration('202612050001_accounting_request_queue.sql')}
      \\i ${migration('202612050002_accounting_request_gc_preparation.sql')}
      \\i ${migration('202701200006_form_invoice_orders.sql')}
      SELECT set_form_product_stock('${tenant}','${product}',0,3,'test');
    `);
    const authority = { version: 1, provider: 'xero', connectionId: 'connection', companyId: 'company',
      amount: 120, currency: 'GBP', snapshot: { version: 1, preparation: true, payment: null,
        invoice: { totalMinor: 12000 }, linkage: { formId: tenant },
        lines: [{ quantity: 1, netMinor: 10000, taxMinor: 2000, grossMinor: 12000 }] } };
    const insert = (n, auth = authority) => `INSERT INTO form_submission VALUES('${id(n)}','${tenant}','${tenant}','pay:attempt-${n}',
      '{"cart":{"version":1,"lines":[{"kind":"product","id":"${product}","quantity":1}]}}',
      'unpaid','invoice',NULL,120,'GBP','${JSON.stringify({ invoice_order: auth })}');`;
    sql(insert(1));
    assert.equal(sql('SELECT remaining||\':\'||reserved FROM form_product_stock;'), '2:0');
    assert.equal(sql('SELECT state FROM form_cart_receipt;'), 'consumed');
    assert.equal(sql('SELECT payment_status FROM form_submission;'), 'unpaid');
    assert.equal(sql('SELECT payment_status||\':\'||preparation_status FROM accounting_request_queue;'), 'skipped:pending');
    denied(insert(1), /duplicate key/);
    assert.equal(sql('SELECT count(*) FROM accounting_request_queue;'), '1');
    denied(`UPDATE form_submission SET payment_amount=1 WHERE id='${id(1)}';`, /immutable/);
    denied(insert(2, { ...authority, amount: 1 }), /authority/);
    const mismatch = structuredClone(authority);
    mismatch.snapshot.lines[0].taxMinor = 1;
    denied(insert(2, mismatch), /terms differ/);
    assert.equal(sql('SELECT remaining FROM form_product_stock;'), '2');
    sql(`UPDATE form SET fields=jsonb_set(fields,'{1,payment_providers}','["stripe"]');`);
    denied(insert(2), /authority/);
    denied('SET ROLE anon; SELECT form_invoice_order_version();', /permission denied/);
    assert.equal(sql('SET ROLE service_role; SELECT form_invoice_order_version();'), '1');
    // Existing Stripe reservations still require actual payment success.
    sql(`INSERT INTO form_submission VALUES('${id(3)}','${tenant}','${tenant}','stripe-test',
      '{"cart":{"version":1,"lines":[{"kind":"product","id":"${product}","quantity":1}]}}',
      'pending','stripe','pi_test',120,'GBP','{}');`);
    denied(`SELECT finalize_form_cart('${tenant}','${id(3)}','consumed');`, /payment success/);
    sql(`UPDATE form_submission SET payment_status='paid' WHERE id='${id(3)}';`);
    assert.equal(sql(`SELECT state FROM form_cart_receipt WHERE submission_id='${id(3)}';`), 'consumed');
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
