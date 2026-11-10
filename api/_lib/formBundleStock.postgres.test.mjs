import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = (command, args, input = '') => {
  const result = spawnSync(command, args, { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
const asyncRun = (command, args, input) => new Promise((resolve, reject) => {
  const child = spawn(command, args);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', status => resolve({ status, stdout, stderr }));
  child.stdin.end(input);
});
const tenant = '10000000-0000-4000-8000-000000000001';
const bundle = '20000000-0000-4000-8000-000000000001';
const sub = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('bundle ledger serializes last unit, CAS edits, rollback and provider finalization', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'form-bundle-stock-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  let started = false;
  try {
    run('initdb', ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const args = ['-X', '-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
    const sql = statement => run('psql', args, statement);
    const denied = (statement, pattern) => {
      const result = spawnSync('psql', args, { input: statement, encoding: 'utf8' });
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, pattern);
    };
    const reserve = n => `SELECT reserve_form_bundle('${tenant}','${bundle}','${sub(n)}','bundle','attempt-${n}');`;
    const finish = (n, state, evidence = 'NULL') => `SELECT finalize_form_bundle('${tenant}','${sub(n)}','${state}',${evidence});`;
    const stock = () => JSON.parse(sql(`SELECT row_to_json(s) FROM form_bundle_stock s;`));
    const edit = (version, remaining) => `SELECT set_form_bundle_stock('${tenant}','${bundle}',${version},${remaining},'fixture-admin');`;
    const migration = fileURLToPath(new URL('../../supabase/migrations/202701200001_form_bundle_stock.sql', import.meta.url));
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE sales_catalogue_bundle(
        id uuid PRIMARY KEY,tenant_id uuid,name text,selling_price_minor bigint,currency text,
        is_active boolean,archived_at timestamptz,available_from timestamptz,available_to timestamptz,
        UNIQUE(tenant_id,id));
      CREATE TABLE form_submission(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,
        idempotency_key text,submission_data jsonb,payment_status text,payment_provider text,payment_reference text,
        payment_amount numeric,payment_currency text);
      CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,fields jsonb,form_type text);
      CREATE TABLE sales_audit_event(tenant_id uuid,actor_id text,actor_type text,action text,
        entity_type text,entity_id text,before_data jsonb,after_data jsonb);
      INSERT INTO sales_catalogue_bundle VALUES('${bundle}','${tenant}','Historical bundle',12345,'GBP',true,NULL,NULL,NULL);
      ${Array.from({ length: 8 }, (_, i) => `INSERT INTO form_submission(id,tenant_id,form_id,idempotency_key,submission_data)
        VALUES('${sub(i + 1)}','${tenant}','${tenant}','key-${i + 1}','{"bundle":"${bundle}"}');`).join('\n')}
      \\i ${migration}
      \\i ${fileURLToPath(new URL('../../supabase/migrations/202701200002_form_bundle_submission_stock_option.sql', import.meta.url))}
    `);
    assert.equal(sql('SET ROLE service_role; SELECT form_bundle_stock_option_version();'), '1');
    denied('SET ROLE anon; SELECT form_bundle_stock_option_version();', /permission denied/);
    // Unconfigured is Unlimited, not zero; rollback leaves no lazy stock row.
    sql(`BEGIN; ${reserve(1)} ROLLBACK;`);
    assert.equal(sql('SELECT count(*) FROM form_bundle_stock;'), '0');
    sql(`SET ROLE service_role; ${edit(0, 1)}`);
    const races = await Promise.all([1, 2].map(n => asyncRun('psql', args,
      `SET ROLE service_role; BEGIN; ${reserve(n)} SELECT pg_sleep(0.05); COMMIT;`)));
    assert.equal(races.filter(r => r.status === 0).length, 1);
    assert.match(races.find(r => r.status !== 0).stderr, /sold out/);
    const winner = races[0].status === 0 ? 1 : 2;
    assert.equal(stock().remaining, 0);
    assert.equal(stock().reserved, 1);
    const version = stock().version;
    const receipt = JSON.parse(sql(`SET ROLE service_role; ${reserve(winner)}`));
    assert.equal(receipt.bundle_name, 'Historical bundle');
    assert.equal(receipt.amount_minor, 12345);
    assert.equal(stock().version, version, 'idempotent replay does not alter stock');
    denied(`SET ROLE service_role; ${edit(1, 1)}`, /reload and retry/);
    denied(`SET ROLE service_role; ${edit(version, 'NULL')}`, /existing holds/);
    denied(`SET ROLE service_role; ${finish(winner, 'released')}`, /provider evidence/);
    denied(`UPDATE form_submission SET submission_data='{}' WHERE id='${sub(winner)}';`, /cannot change/);
    denied(`DELETE FROM form_submission WHERE id='${sub(winner)}';`, /foreign key/);
    sql(`SET ROLE service_role; ${finish(winner, 'consumed')} ${finish(winner, 'consumed')}`);
    assert.equal(stock().reserved, 0);
    assert.equal(stock().remaining, 0);
    denied(`SET ROLE service_role; ${finish(winner, 'released')}`, /already finalized/);
    // Failed persistence shares the transaction and cannot lose a unit.
    sql(edit(stock().version, 1));
    denied(`BEGIN; ${reserve(3)} SELECT 1/0; COMMIT;`, /division by zero/);
    assert.equal(stock().remaining, 1);
    assert.equal(sql(`SELECT count(*) FROM form_bundle_allocation WHERE submission_id='${sub(3)}';`), '0');
    // Provider result versus cleanup: one terminal transition only.
    sql(`UPDATE form_submission SET payment_provider='stripe',payment_reference='pi_fixture',payment_status='pending' WHERE id='${sub(3)}'; ${reserve(3)}`);
    denied(finish(3, 'consumed'), /payment success/);
    const evidence = `'{"provider":"stripe","terminal_status":"cancelled","reference":"pi_fixture","verified_at":"2026-11-06T00:00:00Z"}'::jsonb`;
    const finalized = await Promise.all([
      asyncRun('psql', args, `BEGIN; UPDATE form_submission SET payment_status='paid' WHERE id='${sub(3)}'; ${finish(3, 'consumed')} COMMIT;`),
      asyncRun('psql', args, finish(3, 'released', evidence)),
    ]);
    assert.equal(finalized.filter(r => r.status === 0).length, 1);
    const terminal = sql(`SELECT state FROM form_bundle_allocation WHERE submission_id='${sub(3)}';`);
    assert.equal(stock().remaining, terminal === 'released' ? 1 : 0);
    assert.equal(stock().reserved, 0);
    sql(finish(3, terminal, terminal === 'released' ? evidence : 'NULL'));
    assert.equal(stock().reserved, 0);
    denied(`SET ROLE authenticated; ${reserve(4)}`, /permission denied/);
    denied(`SET ROLE service_role; DELETE FROM form_bundle_allocation;`, /permission denied/);
    denied(`SET ROLE service_role; UPDATE form_bundle_stock SET remaining=999;`, /permission denied/);
    denied(edit(stock().version, -1), /Invalid bundle stock/);
    denied(edit(stock().version, '1.5'), /does not exist/);
    denied(reserve(4).replace(tenant, sub(8)), /Submission not found/);
    sql(edit(stock().version, 'NULL'));
    sql(`${reserve(4)} ${finish(4, 'consumed')}`);
    assert.equal(stock().remaining, null);
    assert.equal(stock().reserved, 0);
    // Exercise the actual shared INSERT/paid-UPDATE transaction boundaries,
    // not just direct ledger commands.
    sql(`INSERT INTO form VALUES('${tenant}','${tenant}',
      '[{"id":"bundle","type":"sales_bundle","allowed_bundle_ids":["${bundle}"]},
        {"id":"payment","type":"payment","price_field_id":"bundle","payment_currency":"GBP"}]','standard');`);
    sql(edit(stock().version, 3));
    const insert = (n, payment = false, price = '123.45', extra = '') =>
      `INSERT INTO form_submission(id,tenant_id,form_id,idempotency_key,submission_data,payment_provider,payment_status,payment_amount,payment_currency)
      VALUES('${sub(n)}','${tenant}','${tenant}','key-${n}','{"bundle":"${bundle}"${extra}}',
        ${payment ? "'stripe','pending'" : 'NULL,NULL'},${price},'GBP');`;
    sql(insert(9));
    assert.equal(stock().remaining, 2);
    assert.equal(stock().reserved, 0);
    assert.equal(sql(`SELECT submission_data->'__bundle_labels'->>'bundle' FROM form_submission WHERE id='${sub(9)}'`), 'Historical bundle');
    denied(insert(10, true, '0.01'), /price changed/);
    assert.equal(stock().remaining, 2, 'failed price check rolls back the reservation and submission');
    sql(insert(10, true));
    assert.equal(stock().remaining, 1);
    assert.equal(stock().reserved, 1);
    denied(`UPDATE form_submission SET payment_amount=1 WHERE id='${sub(10)}'`, /immutable/);
    denied(`UPDATE form_submission SET submission_data=submission_data||'{"other":"changed"}' WHERE id='${sub(10)}'`, /immutable/);
    sql(`UPDATE form_submission SET payment_reference='pi_10' WHERE id='${sub(10)}';
      UPDATE form_submission SET payment_status='paid' WHERE id='${sub(10)}';
      UPDATE form_submission SET payment_status='paid' WHERE id='${sub(10)}';`);
    assert.equal(stock().reserved, 0);
    assert.equal(stock().remaining, 1);
    denied(`BEGIN; ${insert(11)} SELECT 1/0; COMMIT;`, /division by zero/);
    assert.equal(stock().remaining, 1);
    sql(insert(12, false, '0', ',"__bundle_hidden":"bundle"'));
    assert.equal(stock().remaining, 1, 'server-resolved hidden selection does not allocate');
    denied(`DELETE FROM form_submission WHERE id='${sub(9)}'`, /foreign key/);
    const setting = value => sql(`UPDATE form SET fields=jsonb_set(fields,'{0,reduce_bundle_stock_on_submission}','${value}');`);
    setting(false);
    sql(insert(13));
    sql(insert(14, true));
    assert.equal(stock().remaining, 1);
    assert.equal(stock().reserved, 0);
    assert.equal(sql(`SELECT count(*) FROM form_bundle_allocation WHERE submission_id IN ('${sub(13)}','${sub(14)}')`), '0');
    assert.equal(sql(`SELECT count(*) FROM form_bundle_selection`), '2');
    assert.equal(sql(`SELECT submission_data->'__bundle_labels'->>'bundle' FROM form_submission WHERE id='${sub(13)}'`), 'Historical bundle');
    denied(insert(15, true, '0.01'), /price changed/);
    denied(`BEGIN; ${insert(15)} SELECT 1/0; COMMIT;`, /division by zero/);
    assert.equal(sql(`SELECT count(*) FROM form_bundle_selection`), '2');
    denied(`UPDATE form_submission SET payment_amount=1 WHERE id='${sub(14)}'`, /immutable/);
    denied(`UPDATE form_submission SET submission_data='{}' WHERE id='${sub(13)}'`, /cannot change/);
    denied(`SET ROLE service_role; INSERT INTO form_bundle_selection SELECT * FROM form_bundle_selection;`, /permission denied/);
    denied(`SET ROLE anon; SELECT * FROM form_bundle_selection;`, /permission denied/);
    setting(true);
    denied(reserve(13), /does not allocate/);
    assert.equal(stock().remaining, 1, 'failed retroactive allocation rolls back stock changes');
    sql(`UPDATE form_submission SET payment_status='paid' WHERE id='${sub(14)}';`);
    assert.equal(stock().remaining, 1, 'disabled attempt stays non-allocating after enabling');
    sql(insert(15, true));
    assert.equal(stock().remaining, 0);
    setting(false);
    denied(insert(16), /sold out/);
    sql(`UPDATE form_submission SET payment_status='paid' WHERE id='${sub(15)}';`);
    assert.equal(stock().remaining, 0);
    assert.equal(stock().reserved, 0, 'enabled hold settles even after disabling');
    sql(edit(stock().version, 'NULL'));
    sql(insert(16));
    assert.equal(stock().remaining, null);
    sql(insert(17, false, '0', ',"__bundle_hidden":"bundle"'));
    sql(`INSERT INTO form_submission(id,tenant_id,form_id,submission_data) VALUES('${sub(18)}','${tenant}','${tenant}','{}');`);
    assert.equal(sql(`SELECT count(*) FROM form_bundle_selection WHERE submission_id IN ('${sub(17)}','${sub(18)}')`), '0');
    setting('"false"');
    denied(insert(19), /on or off/);
    setting(true);
    sql(edit(stock().version, 1));
    const insertRaces = await Promise.all([19,20].map(n => asyncRun('psql', args, insert(n))));
    assert.equal(insertRaces.filter(r => r.status === 0).length, 1);
    assert.equal(stock().remaining, 0);
    const accepted = insertRaces[0].status === 0 ? 19 : 20;
    denied(insert(accepted), /duplicate key/);
    assert.equal(stock().remaining, 0);
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
