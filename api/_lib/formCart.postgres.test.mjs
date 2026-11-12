import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = (cmd, args, input = '') => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();
};
const asyncRun = (args, input) => new Promise((resolve, reject) => {
  const child = spawn('psql', args); let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr })); child.stdin.end(input);
});
const tenant = '10000000-0000-4000-8000-000000000001';
const product = '20000000-0000-4000-8000-000000000001';
const bundle = '20000000-0000-4000-8000-000000000002';
const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const answer = (pq = 1, bq = 1) => ({ version: 1, lines: [
  ...(bq ? [{ kind: 'bundle', id: bundle, quantity: bq }] : []),
  ...(pq ? [{ kind: 'product', id: product, quantity: pq }] : []),
] });

test('mixed cart transaction: shared bundle stock, quantities, replay, rollback, grants and terminal outcomes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'form-cart-stock-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket'); await mkdir(socket);
  let started = false;
  try {
    run('initdb', ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const args = ['-X', '-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
    const sql = q => run('psql', args, q);
    const denied = (q, pattern) => {
      const r = spawnSync('psql', args, { input: q, encoding: 'utf8' });
      assert.notEqual(r.status, 0, r.stdout); assert.match(r.stderr, pattern);
    };
    const migration = name => fileURLToPath(new URL(`../../supabase/migrations/${name}`, import.meta.url));
    const field = { id: 'cart', type: 'sales_cart', cart_version: 1, required: true,
      allowed_product_ids: [product], allowed_bundle_ids: [bundle], bundle_tax: { [bundle]: { treatment: 'zero_rated', rateBps: 0 } } };
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE sales_catalogue_bundle(id uuid PRIMARY KEY,tenant_id uuid,name text,description text,selling_price_minor bigint,currency text,
        is_active boolean,archived_at timestamptz,available_from timestamptz,available_to timestamptz,UNIQUE(tenant_id,id));
      CREATE TABLE sales_catalogue_product(id uuid PRIMARY KEY,tenant_id uuid,name text,description text,standard_price_minor bigint,currency text,
        tax_treatment text,tax_rate_bps integer,event_reference_kind text,event_id uuid,ticket_type_id text,space_requirement_id uuid,
        is_active boolean,archived_at timestamptz,available_from timestamptz,available_to timestamptz,UNIQUE(tenant_id,id));
      CREATE TABLE sales_catalogue_bundle_item(tenant_id uuid,bundle_id uuid,product_id uuid);
      CREATE TABLE form_submission(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,idempotency_key text,submission_data jsonb,
        payment_status text,payment_provider text,payment_reference text,payment_amount numeric,payment_currency text);
      CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,fields jsonb,form_type text);
      CREATE TABLE sales_audit_event(tenant_id uuid,actor_id text,actor_type text,action text,entity_type text,entity_id text,before_data jsonb,after_data jsonb);
      INSERT INTO sales_catalogue_bundle VALUES('${bundle}','${tenant}','Bundle before edit','Bundle description',500,'GBP',true,NULL,NULL,NULL);
      INSERT INTO sales_catalogue_product(id,tenant_id,name,description,standard_price_minor,currency,tax_treatment,tax_rate_bps,is_active)
        VALUES('${product}','${tenant}','Product before edit','Product description',101,'GBP','standard',2000,true);
      INSERT INTO sales_catalogue_bundle_item VALUES('${tenant}','${bundle}','${product}');
      INSERT INTO form VALUES('${tenant}','${tenant}','${JSON.stringify([field, { id: 'pay', type: 'payment', price_field_id: 'cart', payment_currency: 'GBP' }])}','standard');
      \\i ${migration('202701200001_form_bundle_stock.sql')}
      \\i ${migration('202701200002_form_bundle_submission_stock_option.sql')}
      \\i ${migration('202701200003_form_cart.sql')}
      \\i ${migration('202701200007_form_cart_inactivity.sql')}
    `);
    const insert = (n, pq = 1, bq = 1, amount = (pq * 101 + Math.round(pq * 101 * .2) + bq * 500) / 100) =>
      `INSERT INTO form_submission VALUES('${id(n)}','${tenant}','${tenant}','attempt-${n}',
        '{"cart":${JSON.stringify(answer(pq, bq))},"other":"accepted"}','pending','stripe','pi_${n}',${amount},'GBP');`;
    const stock = kind => JSON.parse(sql(`SELECT row_to_json(s) FROM form_${kind}_stock s;`));
    const edit = (kind, qty) => sql(`SELECT set_form_${kind}_stock('${tenant}','${kind === 'product' ? product : bundle}',
      COALESCE((SELECT version FROM form_${kind}_stock),0),${qty},'fixture-admin');`);
    assert.equal(sql('SET ROLE service_role; SELECT form_cart_version();'), '1');
    denied('SET ROLE anon; SELECT form_cart_version();', /permission denied/);
    edit('product', 1); edit('bundle', 5);
    const races = await Promise.all([1, 2].map(n => asyncRun(args, `BEGIN; ${insert(n)} SELECT pg_sleep(.05); COMMIT;`)));
    assert.equal(races.filter(r => r.status === 0).length, 1, JSON.stringify(races));
    assert.match(races.find(r => r.status !== 0).stderr, /insufficient stock/);
    const winner = races[0].status === 0 ? 1 : 2;
    assert.equal(stock('product').remaining, 0);
    assert.equal(stock('bundle').remaining, 4, 'failed second line rolled back bundle deduction');
    assert.equal(stock('bundle').reserved, 1);
    const terms = JSON.parse(sql(`SELECT terms FROM form_cart_receipt WHERE submission_id='${id(winner)}';`));
    assert.equal(terms.grossMinor, 621);
    assert.equal(terms.taxMinor, 20);
    sql(`SET ROLE service_role; SELECT reserve_form_cart('${tenant}','${id(winner)}');`);
    assert.equal(stock('bundle').remaining, 4);
    denied(`SELECT set_form_product_stock('${tenant}','${product}',${stock('product').version},NULL,'admin');`, /existing holds/);
    denied(`SELECT set_form_bundle_stock('${tenant}','${bundle}',${stock('bundle').version},NULL,'admin');`, /existing holds/);
    denied(`UPDATE form_submission SET payment_amount=1 WHERE id='${id(winner)}';`, /immutable/);
    denied(`UPDATE form_submission SET submission_data='{}' WHERE id='${id(winner)}';`, /immutable/);
    denied(`DELETE FROM form_submission WHERE id='${id(winner)}';`, /foreign key/);
    denied(`SELECT finalize_form_cart('${tenant}','${id(winner)}','consumed');`, /payment success/);
    denied(`SELECT finalize_form_cart('${tenant}','${id(winner)}','released');`, /provider evidence/);
    sql(`UPDATE sales_catalogue_product SET name='Edited',standard_price_minor=10000;
      UPDATE sales_catalogue_bundle SET name='Edited',selling_price_minor=90000;`);
    assert.deepEqual(JSON.parse(sql(`SELECT reserve_form_cart('${tenant}','${id(winner)}');`)), terms);
    sql(`UPDATE form_submission SET payment_status='paid' WHERE id='${id(winner)}';
      SELECT finalize_form_cart('${tenant}','${id(winner)}','consumed');
      SELECT finalize_form_cart('${tenant}','${id(winner)}','consumed');`);
    assert.equal(stock('product').reserved, 0);
    assert.equal(stock('bundle').reserved, 0);
    assert.equal(stock('product').remaining, 0);
    sql(`UPDATE sales_catalogue_product SET standard_price_minor=101;
      UPDATE sales_catalogue_bundle SET selling_price_minor=500;`);
    // Bundle-only checkout must not touch its component's zero product stock.
    sql(insert(3, 0, 2));
    assert.equal(stock('product').remaining, 0);
    assert.equal(stock('bundle').remaining, 2);
    const evidence = `'{"provider":"stripe","reference":"pi_3","terminal_status":"cancelled","verified_at":"2026-11-10T00:00:00Z"}'::jsonb`;
    const finalize = await Promise.all([
      asyncRun(args, `UPDATE form_submission SET payment_status='paid' WHERE id='${id(3)}';`),
      asyncRun(args, `SELECT finalize_form_cart('${tenant}','${id(3)}','released',${evidence});`),
    ]);
    assert.equal(finalize.filter(r => r.status === 0).length, 1);
    const state = sql(`SELECT state FROM form_cart_receipt WHERE submission_id='${id(3)}';`);
    assert.equal(stock('bundle').remaining, state === 'released' ? 4 : 2);
    assert.equal(stock('bundle').reserved, 0);
    edit('product', 'NULL');
    sql(insert(4, 3, 0));
    assert.equal(stock('product').remaining, null);
    assert.equal(stock('product').reserved, 3);
    assert.equal(JSON.parse(sql(`SELECT terms FROM form_cart_receipt WHERE submission_id='${id(4)}';`)).taxMinor, 61);
    denied(insert(5, 1, 0, 1), /terms changed/);
    assert.equal(stock('product').reserved, 3, 'price conflict rolled back hold');
    sql(`UPDATE sales_catalogue_product SET space_requirement_id='${tenant}';`);
    denied(insert(6, 1, 0), /exhibition/);
    denied(insert(7, 0, 1), /exhibition/);
    sql(`UPDATE sales_catalogue_product SET space_requirement_id=NULL;`);
    denied(`SET ROLE authenticated; SELECT reserve_form_cart('${tenant}','${id(4)}');`, /permission denied/);
    denied('SET ROLE service_role; UPDATE form_product_stock SET remaining=99;', /permission denied/);
    denied('SET ROLE service_role; DELETE FROM form_cart_receipt;', /permission denied/);
    denied(`SELECT reserve_form_cart('${id(9)}','${id(4)}');`, /Submission not found/);
    denied(`BEGIN; ${insert(8)} SELECT 1/0; COMMIT;`, /division by zero/);
    assert.equal(sql(`SELECT count(*) FROM form_cart_receipt WHERE submission_id='${id(8)}';`), '0');
    assert.equal(stock('product').reserved, 3);
    assert.equal(sql("SELECT count(*) FROM sales_audit_event WHERE action='product.stock_updated';"), '2');
    // Activity extends only a live hold. Cleanup cannot act on a stale
    // candidate selected before that renewal, and claimed cleanup cannot revive.
    sql(insert(30, 1, 0));
    assert.equal(sql(`SELECT next_check_at BETWEEN now()+interval '4 minutes' AND now()+interval '6 minutes'
      FROM form_cart_receipt WHERE submission_id='${id(30)}';`), 't');
    assert.equal(sql(`SELECT touch_form_cart_activity('${tenant}','${id(30)}');`), 't');
    assert.equal(sql(`SELECT claim_form_cart_cleanup('${tenant}','${id(30)}');`), 'f');
    assert.equal(sql(`SELECT touch_form_cart_activity('10000000-0000-4000-8000-000000000099','${id(30)}');`), 'f');
    sql(`UPDATE form_submission SET payment_status='failed' WHERE id='${id(30)}';`);
    assert.equal(sql(`SELECT touch_form_cart_activity('${tenant}','${id(30)}');`), 'f');
    assert.equal(sql(`SELECT claim_form_cart_cleanup('${tenant}','${id(30)}');`), 't');
    assert.equal(sql(`SELECT touch_form_cart_activity('${tenant}','${id(30)}');`), 'f');
    denied(`SET ROLE authenticated; SELECT touch_form_cart_activity('${tenant}','${id(30)}');`, /permission denied/);
    denied(`SET ROLE authenticated; SELECT claim_form_cart_cleanup('${tenant}','${id(30)}');`, /permission denied/);
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
