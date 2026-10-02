import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('isolated queue SQL: service-only RPC, immutable authority, concurrent leases, fences, discovery, cooldown', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('accounting-request-queue-');
  const command = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const migration = readFileSync(new URL('../../supabase/migrations/202612050001_accounting_request_queue.sql', import.meta.url), 'utf8');
  const extension = readFileSync(new URL('../../supabase/migrations/202612050002_accounting_request_gc_preparation.sql', import.meta.url), 'utf8');
  const snapshot = { version: 1, invoice: { amount: 100 }, payment: { amount: 100 }, linkage: { source: 'real-source' } };
  const tenant = '00000000-0000-4000-8000-000000000001';
  let started = false;
  const clients = [];
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let index = 0; index < 3; index++) {
      const client = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await client.connect();
      clients.push(client);
    }
    const [admin, worker, second] = clients;
    await admin.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    await admin.query(migration);
    await admin.query(extension);
    await worker.query('SET ROLE service_role');
    await second.query('SET ROLE service_role');
    assert.equal((await worker.query('SELECT accounting_request_health() AS health')).rows[0].health.status, 'healthy');
    const enqueue = async (source, overrides = {}) => {
      const values = [tenant, 'xero', 'connection', 'company', 'booking', source, 'invoice', snapshot];
      for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
      const result = await worker.query('SELECT * FROM accounting_request_enqueue($1,$2,$3,$4,$5,$6,$7,$8)', values);
      return result.rows[0];
    };
    const claim = async (id, client = worker) => (await client.query('SELECT * FROM accounting_request_claim($1)', [id])).rows[0];
    const checkpoint = async (row, stage, status, result = null) => (await worker.query(
      'SELECT * FROM accounting_request_checkpoint($1,$2,$3,$4,$5)', [row.id, row.lease_token, stage, status, result])).rows[0];
    const finish = async (row, state, cooldown = 0) => (await worker.query(
      'SELECT * FROM accounting_request_finish($1,$2,$3,NULL,1,$4)', [row.id, row.lease_token, state, cooldown])).rows[0];
    const expire = async row => admin.query(`UPDATE accounting_request_queue SET lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second' WHERE id=$1;
      `, [row.id]).then(() => admin.query("UPDATE accounting_request_binding SET lease_until=now()-interval '1 second'"));

    const original = await enqueue('one');
    assert.equal((await worker.query('SELECT accounting_request_health() AS health')).rows[0].health.pending, 1);
    assert.equal((await enqueue('one')).id, original.id);
    for (const overrides of [
      { 1: 'quickbooks' }, { 2: 'changed-connection' }, { 3: 'other-company' },
      { 7: { ...snapshot, invoice: { amount: 101 } } },
    ]) await assert.rejects(enqueue('one', overrides), /conflicts/);
    for (const overrides of [
      { 0: null }, { 1: null }, { 1: 'none' }, { 2: ' ' }, { 3: 'PENDING_SELECTION' },
      { 4: 'x'.repeat(101) }, { 5: '' }, { 6: 'payment' }, { 7: {} },
      { 7: { ...snapshot, payment: [] } }, { 7: { ...snapshot, linkage: {} } },
      { 7: { ...snapshot, invoice: { envelope: { version: 1, provider: 'quickbooks', kind: 'invoice', operationKey: 'key', payload: {}, expected: {} } } } },
      { 7: { ...snapshot, invoice: { huge: 'a'.repeat(262144) } } },
    ]) await assert.rejects(enqueue('invalid', overrides), /Invalid/);
    await assert.rejects(worker.query('UPDATE accounting_request_queue SET state=$1', ['complete']), /permission denied/);
    await assert.rejects(admin.query('UPDATE accounting_request_queue SET snapshot=$1 WHERE id=$2', [{}, original.id]), /immutable/);
    await assert.rejects(admin.query('DELETE FROM accounting_request_queue WHERE id=$1', [original.id]), /cannot be deleted/);
    for (const role of ['anon', 'authenticated']) {
      await admin.query(`SET ROLE ${role}`);
      await assert.rejects(admin.query('SELECT * FROM accounting_request_queue'), /permission denied/);
      await assert.rejects(admin.query('SELECT accounting_request_claim()'), /permission denied/);
      await admin.query('RESET ROLE');
    }
    const grants = await admin.query(`SELECT proname,has_function_privilege('authenticated',oid,'EXECUTE') AS allowed
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'accounting_request_%'`);
    assert.ok(grants.rows.length >= 6);
    assert.equal(grants.rows.some(row => row.allowed), false);

    const sibling = await enqueue('two');
    await worker.query('BEGIN');
    let row = await claim(original.id);
    assert.ok(row.lease_token);
    assert.equal((await claim(sibling.id, second)).id, null, 'transaction lock serializes shared company');
    await worker.query('COMMIT');
    assert.equal((await claim(original.id, second)).id, null);
    assert.equal((await claim(sibling.id, second)).id, null);
    await assert.rejects(checkpoint(row, 'payment', 'writing'), /prerequisites/);
    await assert.rejects(finish(row, 'complete'), /Invalid/);
    await assert.rejects(worker.query('SELECT accounting_request_guard($1,$2,$3)', [row.id, row.lease_token, 'invoice']), /not fenced/);
    row = await checkpoint(row, 'invoice', 'writing');
    assert.equal((await worker.query('SELECT accounting_request_guard($1,$2,$3) AS ok', [row.id, row.lease_token, 'invoice'])).rows[0].ok, true);
    const stale = row;
    await expire(row);
    row = await claim(row.id);
    assert.equal(row.invoice_status, 'unknown', 'expired financial intent requires discovery');
    assert.notEqual(row.lease_token, stale.lease_token);
    await assert.rejects(checkpoint(stale, 'invoice', 'done', { id: 'inv' }), /lease lost/);
    await assert.rejects(checkpoint(row, 'invoice', 'writing'), /transition/);
    await assert.rejects(checkpoint(row, 'invoice', 'pending'), /transition/);
    await assert.rejects(finish(row, 'retry'), /Invalid/);
    await assert.rejects(checkpoint(row, 'invoice', 'done', {}), /evidence/);
    row = await checkpoint(row, 'invoice', 'done', { id: 'inv' });
    row = await checkpoint(row, 'payment', 'writing');
    row = await checkpoint(row, 'payment', 'done', { id: 'pay' });
    row = await checkpoint(row, 'link', 'writing');
    await assert.rejects(checkpoint(row, 'link', 'done', {}), /evidence/);
    row = await checkpoint(row, 'link', 'pending');
    row = await finish(row, 'retry', 120);
    const crossTenant = await enqueue('other-tenant', { 0: '00000000-0000-4000-8000-000000000002', 2: 'other-connection' });
    assert.equal((await claim(crossTenant.id)).id, null, 'company cooldown shared even across app tenant connections');
    await admin.query("UPDATE accounting_request_binding SET cooldown_until=now()-interval '1 second'");
    await admin.query("UPDATE accounting_request_queue SET next_attempt_at=now()-interval '1 second'");
    row = await claim(original.id);
    assert.equal(row.invoice_result.id, 'inv');
    assert.equal(row.payment_result.id, 'pay');
    row = await checkpoint(row, 'link', 'writing');
    row = await checkpoint(row, 'link', 'done', { linked: true, sourceId: 'real-source' });
    row = await finish(row, 'complete');
    assert.equal(row.state, 'complete');
    assert.equal((await claim(row.id)).id, null);
    const before = (await admin.query('SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS rows FROM accounting_request_queue q')).rows[0].rows;
    await admin.query(migration);
    await admin.query(extension);
    const after = (await admin.query('SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS rows FROM accounting_request_queue q')).rows[0].rows;
    assert.deepEqual(after, before, 'migration replay cannot reset financial authority or progress');
    // QBO uses the same state machine, no-payment requests skip settlement.
    const qbo = await enqueue('qbo', { 1: 'quickbooks', 3: 'qbo-company', 7: { ...snapshot, payment: null } });
    row = await claim(qbo.id);
    assert.equal(row.payment_status, 'skipped');
    row = await checkpoint(row, 'invoice', 'writing');
    row = await checkpoint(row, 'invoice', 'done', { id: 'qbo-invoice' });
    row = await checkpoint(row, 'link', 'writing');
    row = await checkpoint(row, 'link', 'done', { linked: true });
    assert.equal((await finish(row, 'complete')).state, 'complete');
    const health = (await worker.query('SELECT accounting_request_health() AS health')).rows[0].health;
    assert.equal(health.complete, 2);
    assert.equal(health.pending, 2);
    assert.equal(health.total, 4);
    assert.equal(Object.keys(health).some(key => /snapshot|token|tenant/.test(key)), false);
    const delayed = await claim(sibling.id);
    await finish(delayed, 'retry', 99999999);
    assert.equal((await admin.query(`SELECT cooldown_until > now()+interval '99999990 seconds' AS long
      FROM accounting_request_binding WHERE provider='xero' AND company_id='company'`)).rows[0].long, true);
    assert.equal((await claim(crossTenant.id)).id, null);
    await admin.query("UPDATE accounting_request_binding SET cooldown_until=now()-interval '1 second'");
    const extreme = await claim(crossTenant.id);
    await finish(extreme, 'retry', -1);
    assert.equal((await admin.query(`SELECT cooldown_until::text AS embargo
      FROM accounting_request_binding WHERE provider='xero' AND company_id='company'`)).rows[0].embargo, 'infinity');
    assert.equal((await claim(sibling.id)).id, null);
    // GC payment-only is one authority, with a durable original evidence stage.
    for (const provider of ['xero', 'quickbooks']) {
      const originalEvidence = { ...snapshot, preparation: true, existingInvoice: { id: `${provider}-existing` },
        original: { gcPaymentId: `PM-${provider}`, amountMinor: 10000, currency: 'GBP', date: '2026-01-01' } };
      const gcOverrides = { 1: provider, 3: `${provider}-gc`, 4: 'gocardless_payment', 6: 'payment', 7: originalEvidence };
      let gc = await enqueue(`PM-${provider}`, gcOverrides);
      assert.equal(gc.invoice_status, 'done');
      assert.deepEqual(gc.invoice_result, originalEvidence.existingInvoice);
      assert.equal(gc.preparation_status, 'pending');
      assert.equal((await enqueue(`PM-${provider}`, gcOverrides)).id, gc.id);
      await assert.rejects(enqueue(`PM-${provider}`, { ...gcOverrides, 6: 'invoice' }), /conflicts/);
      gc = await claim(gc.id);
      await assert.rejects(checkpoint(gc, 'invoice', 'writing'), /transition/);
      await assert.rejects(checkpoint(gc, 'payment', 'writing'), /preparation prerequisites/);
      const envelope = kind => ({ version: 1, provider, kind, operationKey: `PM-${provider}-${kind}`,
        payload: { amount: 100 }, expected: { amount: 100 } });
      const resolved = { ...originalEvidence, preparation: false,
        payment: { envelope: envelope('payment') }, existingInvoice: { ...originalEvidence.existingInvoice, verified: true } };
      const prepare = (r, value) => worker.query('SELECT * FROM accounting_request_prepare($1,$2,$3)',
        [r.id, r.lease_token, value]);
      await assert.rejects(prepare(gc, { ...resolved, existingInvoice: { id: 'wrong-invoice' } }), /Invalid/);
      await assert.rejects(prepare(gc, { ...resolved, linkage: { source: 'changed' } }), /Invalid/);
      await assert.rejects(prepare(gc, { ...resolved, payment: { envelope: { ...envelope('payment'), provider: 'wrong' } } }), /Invalid/);
      const staleGc = gc;
      await expire(gc);
      gc = await claim(gc.id);
      await assert.rejects(prepare(staleGc, resolved), /lease/);
      gc = (await prepare(gc, resolved)).rows[0];
      assert.deepEqual(gc.snapshot, originalEvidence);
      assert.deepEqual(gc.resolved_snapshot, resolved);
      assert.equal(gc.invoice_result.verified, true);
      await assert.rejects(prepare(gc, resolved), /Invalid/);
      await assert.rejects(admin.query('UPDATE accounting_request_queue SET resolved_snapshot=$1 WHERE id=$2', [{}, gc.id]), /immutable/);
      await assert.rejects(admin.query('UPDATE accounting_request_queue SET invoice_result=$1 WHERE id=$2', [{ id: 'changed' }, gc.id]), /immutable/);
      gc = await checkpoint(gc, 'payment', 'writing');
      await expire(gc);
      gc = await claim(gc.id);
      assert.equal(gc.payment_status, 'unknown');
      await assert.rejects(checkpoint(gc, 'payment', 'writing'), /transition/);
      gc = await checkpoint(gc, 'payment', 'done', { id: `${provider}-payment` });
      gc = await checkpoint(gc, 'link', 'writing');
      gc = await checkpoint(gc, 'link', 'done', { linked: true });
      assert.equal((await finish(gc, 'complete')).state, 'complete');
      // Invoice+payment preparation shares the same immutable GC source lock.
      const invoiceEvidence = { ...originalEvidence };
      delete invoiceEvidence.existingInvoice;
      let preparedInvoice = await enqueue(`PM-${provider}-new`, {
        ...gcOverrides, 6: 'invoice', 7: invoiceEvidence,
      });
      preparedInvoice = await claim(preparedInvoice.id);
      await assert.rejects(checkpoint(preparedInvoice, 'invoice', 'writing'), /preparation prerequisites/);
      preparedInvoice = await finish(preparedInvoice, 'retry', 120);
      await admin.query("UPDATE accounting_request_queue SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [preparedInvoice.id]);
      assert.equal((await claim(preparedInvoice.id)).id, null, 'preparation throttles obey company embargo');
      await admin.query("UPDATE accounting_request_binding SET cooldown_until=now()-interval '1 second' WHERE company_id=$1", [`${provider}-gc`]);
      preparedInvoice = await claim(preparedInvoice.id);
      const preparedPayload = { ...invoiceEvidence, preparation: false,
        invoice: { envelope: envelope('invoice') }, payment: { envelope: envelope('payment') } };
      preparedInvoice = (await prepare(preparedInvoice, preparedPayload)).rows[0];
      assert.deepEqual(preparedInvoice.snapshot, invoiceEvidence);
      preparedInvoice = await checkpoint(preparedInvoice, 'invoice', 'writing');
      preparedInvoice = await checkpoint(preparedInvoice, 'invoice', 'done', { id: `${provider}-new-invoice` });
      preparedInvoice = await checkpoint(preparedInvoice, 'payment', 'writing');
      preparedInvoice = await checkpoint(preparedInvoice, 'payment', 'done', { id: `${provider}-new-payment` });
      preparedInvoice = await checkpoint(preparedInvoice, 'link', 'writing');
      preparedInvoice = await checkpoint(preparedInvoice, 'link', 'done', { linked: true });
      assert.equal((await finish(preparedInvoice, 'complete')).state, 'complete');
    }
  } finally {
    await Promise.all(clients.map(client => client.end()));
    if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});