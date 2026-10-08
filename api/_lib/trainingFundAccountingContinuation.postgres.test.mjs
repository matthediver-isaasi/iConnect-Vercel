import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('training-fund SQL: atomic acceptance, duplicate requests, delayed links, pending and paid CAS, card recovery, grants', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('training-fund-continuation-');
  const command = (name, args) => {
    const r = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const read = file => readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
  let started = false;
  const clients = [];
  const tenant = '00000000-0000-4000-8000-000000000001';
  const org = '00000000-0000-4000-8000-000000000002';
  const member = '00000000-0000-4000-8000-000000000003';
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 3; i++) {
      const client = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await client.connect(); clients.push(client);
    }
    const [admin, worker, other] = clients;
    await admin.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE organization(id uuid PRIMARY KEY, tenant_id uuid, training_fund_balance numeric DEFAULT 0);
      CREATE TABLE member(id uuid PRIMARY KEY, tenant_id uuid, organization_id uuid);
      CREATE TABLE training_fund_transaction(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
        organization_id uuid,type text,amount numeric,balance_before numeric,balance_after numeric,
        reason text,created_by uuid,created_date timestamptz);
      INSERT INTO organization VALUES('${org}','${tenant}',0);
      INSERT INTO member VALUES('${member}','${tenant}','${org}');`);
    for (const file of ['20260621_training_fund_purchase.sql','202612050001_accounting_request_queue.sql',
      '202612050002_accounting_request_gc_preparation.sql','202612050004_training_fund_accounting_continuation.sql']) await admin.query(read(file));
    await admin.query(read('202612050004_training_fund_accounting_continuation.sql'));
    await worker.query('SET ROLE service_role');
    await other.query('SET ROLE service_role');
    const authority = provider => ({ provider, connectionId: 'connection', companyId: 'company',
      invoice: { totalMinor: 4250, args: { appTenantId: tenant, finalCost: 42.5 } }, environment: null });
    const accept = (key, method = 'invoice', provider = 'xero', client = worker, amount = 42.5) => client.query(
      'SELECT accept_training_fund_accounting($1,$2,$3,$4,$5,$6,NULL,true,$7) AS operation',
      [tenant, member, org, key, amount, method, authority(provider)]).then(r => r.rows[0].operation);
    const key = '00000000-0000-4000-8000-000000000010';
    const accepted = await Promise.all([accept(key), accept(key, 'invoice','xero',other)]);
    const op = accepted[0];
    assert.equal(op.purchase_id, accepted[1].purchase_id);
    assert.equal((await admin.query('SELECT count(*) FROM training_fund_purchase')).rows[0].count, '1');
    assert.equal((await admin.query('SELECT count(*) FROM accounting_request_queue')).rows[0].count, '1');
    await assert.rejects(accept(key, 'card'), /different purchase/);
    await assert.rejects(worker.query("UPDATE training_fund_accounting_operation SET amount=1"), /permission denied/);
    await assert.rejects(admin.query('UPDATE training_fund_purchase SET amount=1 WHERE id=$1', [op.purchase_id]), /immutable/);
    const link = (o, client = worker) => client.query('SELECT link_training_fund_accounting($1,$2,$3,$4,$5,NULL)',
      [tenant, o.purchase_id, o.authority.provider, `invoice-${o.purchase_id}`, 'INV-1']);
    await assert.rejects(link(op), /authority mismatch/);
    const balances = async () => (await admin.query('SELECT training_fund_balance AS available,training_fund_pending_balance AS pending FROM organization')).rows[0];
    assert.deepEqual(await balances(), { available: '0', pending: '0' });
    // Simulate a durable provider result through the queue's real fenced RPCs.
    const completeInvoice = async o => {
      const q = (await admin.query('SELECT * FROM accounting_request_queue WHERE source_id=$1', [o.purchase_id])).rows[0];
      const claim = (await worker.query('SELECT * FROM accounting_request_claim($1)', [q.id])).rows[0];
      const envelope = { version: 1, kind: 'invoice', provider: o.authority.provider, payload: { test: true },
        expected: { test: true }, operationKey: 'test-operation', marker: 'test-marker' };
      await worker.query('SELECT accounting_request_prepare($1,$2,$3)', [q.id, claim.lease_token,
        { ...q.snapshot, preparation: false, invoice: { envelope } }]);
      await worker.query("SELECT accounting_request_checkpoint($1,$2,'invoice','writing',NULL)", [q.id, claim.lease_token]);
      await worker.query("SELECT accounting_request_checkpoint($1,$2,'invoice','done',$3)", [q.id, claim.lease_token,
        { id: `invoice-${o.purchase_id}` }]);
      // Release the provider binding; linkage may be retried independently.
      await worker.query("SELECT accounting_request_finish($1,$2,'retry',NULL,1,0)", [q.id, claim.lease_token]);
    };
    await completeInvoice(op);
    // A crash after invoice creation has not credited or changed pending funds.
    assert.deepEqual(await balances(), { available: '0', pending: '0' });
    await Promise.all([link(op), link(op, other)]);
    assert.deepEqual(await balances(), { available: '0', pending: '42.5' });
    // Exact write used by pendingPoInvoice.js for a promised PO. The saved
    // original authority and duplicate checkout identity must stay unchanged.
    await admin.query('UPDATE training_fund_purchase SET purchase_order_number=$1,po_to_follow=false WHERE id=$2',
      ['PO-LATER', op.purchase_id]);
    const purchasePo = (await admin.query('SELECT purchase_order_number,po_to_follow FROM training_fund_purchase WHERE id=$1',
      [op.purchase_id])).rows[0];
    assert.deepEqual(purchasePo, { purchase_order_number: 'PO-LATER', po_to_follow: false });
    assert.deepEqual((await accept(key)).authority, op.authority);
    assert.equal((await accept(key)).purchase_order_number, null);
    await assert.rejects(admin.query("UPDATE training_fund_purchase SET purchase_order_number='REPLACEMENT' WHERE id=$1",
      [op.purchase_id]), /Only missing PO/);
    await assert.rejects(admin.query("UPDATE training_fund_purchase SET po_to_follow=true WHERE id=$1",
      [op.purchase_id]), /Only missing PO/);
    await admin.query("SELECT credit_training_fund_purchase($1,now(),'invoice_reconciliation')", [op.purchase_id]);
    await link(op);
    await admin.query("SELECT credit_training_fund_purchase($1,now(),'invoice_reconciliation')", [op.purchase_id]);
    assert.deepEqual(await balances(), { available: '42.5', pending: '0' });
    assert.equal((await admin.query('SELECT count(*) FROM training_fund_transaction')).rows[0].count, '1');
    const card = await accept('00000000-0000-4000-8000-000000000011','card','quickbooks');
    await assert.rejects(worker.query("SELECT start_training_fund_card_setup($1,$2,'acct:pk')", [tenant,card.purchase_id]), /not ready/);
    await completeInvoice(card); await link(card);
    assert.deepEqual(await balances(), { available: '42.5', pending: '0' });
    const setups = await Promise.all([worker,other].map(c => c.query("SELECT start_training_fund_card_setup($1,$2,'acct:pk') AS s", [tenant,card.purchase_id])));
    assert.equal(setups[0].rows[0].s.started_at, setups[1].rows[0].s.started_at);
    for (let i=0;i<2;i++) await worker.query('SELECT bind_training_fund_card_setup($1,$2,$3)', [tenant,card.purchase_id,'pi_one']);
    await assert.rejects(worker.query('SELECT bind_training_fund_card_setup($1,$2,$3)', [tenant,card.purchase_id,'pi_two']), /identity mismatch/);
    await assert.rejects(worker.query("SELECT start_training_fund_card_setup($1,$2,'acct:pk')", [org,card.purchase_id]), /not ready/);
    await assert.rejects(worker.query("SELECT start_training_fund_card_setup($1,$2,'other:pk')", [tenant,card.purchase_id]), /not ready/);
    await admin.query('SET ROLE authenticated');
    await assert.rejects(admin.query('SELECT * FROM training_fund_accounting_operation'), /permission denied/);
    await assert.rejects(admin.query("SELECT start_training_fund_card_setup($1,$2,'acct:pk')", [tenant,card.purchase_id]), /permission denied/);
  } finally {
    await Promise.all(clients.map(c => c.end()));
    if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
