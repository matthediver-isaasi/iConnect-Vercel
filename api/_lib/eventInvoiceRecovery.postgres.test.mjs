import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('isolated PostgreSQL recovery: grants, immutable authority, fence, mirrors, cooldown, sweep and health', { timeout: 120_000 }, async () => {
  const h = await createLocalPostgresHarness('event-invoice-recovery-');
  const run = (cmd, args, input, fail = false) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (fail) assert.notEqual(result.status, 0, 'unsafe operation must fail');
    else assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const sql = (text, fail = false) => run('psql',
    ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], text, fail);
  let started = false;
  const tenant = '00000000-0000-4000-8000-000000000001';
  const tenant2 = '00000000-0000-4000-8000-000000000002';
  const snapshot = JSON.stringify({ version: 1, provider: { connectionId: 'connection1', xeroTenantId: 'org1' },
    invoice: { Type: 'ACCREC' }, paymentMethod: 'invoice', immutable: 'original' });
  const enqueue = (group, payload = `'${snapshot}'`, valid = true, source = 'booking', t = tenant) =>
    `SELECT (public.event_invoice_recovery_enqueue('${t}','${source}','${group}',${payload},${valid})).status;`;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE booking(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
      booking_group_reference text,payment_method text DEFAULT 'invoice',status text DEFAULT 'confirmed',
      payment_status text DEFAULT 'paid',ticket_price numeric DEFAULT 20,created_at timestamptz DEFAULT now()-interval '1 hour',
      xero_invoice_id text,xero_invoice_number text,accounting_invoice_id text,stripe_payment_intent_id text);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      INSERT INTO booking(tenant_id,booking_group_reference) VALUES('${tenant}','group1'),('${tenant}','group2'),
      ('${tenant}','history'),('${tenant}','cancelled'),('${tenant}','public'),('${tenant}','free'),('${tenant2}','other');
      UPDATE booking SET status='cancelled' WHERE booking_group_reference='cancelled';
      UPDATE booking SET payment_method='public_invoice_po' WHERE booking_group_reference='public';
      UPDATE booking SET payment_method='free',ticket_price=0 WHERE booking_group_reference='free';
      INSERT INTO complex_event_booking(tenant_id,booking_group_reference) VALUES('${tenant}','complex');
    `);
    const migration = readFileSync(new URL('../../supabase/migrations/202611300001_event_invoice_recovery.sql', import.meta.url), 'utf8');
    sql(migration);
    assert.equal(JSON.parse(sql('SELECT event_invoice_recovery_health();')).status, 'never_succeeded');
    for (const role of ['anon', 'authenticated']) {
      sql(`SET ROLE ${role}; SELECT event_invoice_recovery_claim();`, true);
      sql(`SET ROLE ${role}; SELECT * FROM event_invoice_recovery;`, true);
      sql(`SET ROLE ${role}; SELECT event_invoice_recovery_health();`, true);
    }
    sql(`SET ROLE service_role; UPDATE event_invoice_recovery SET status='complete';`, true);
    assert.equal(sql(enqueue('group1')), 'pending');
    assert.equal(sql(`SELECT invoice_recovery_status FROM booking WHERE booking_group_reference='group1';`), 'pending');
    assert.equal(sql(enqueue('group1', "'{}'")), 'pending');
    assert.equal(sql(`SELECT snapshot->>'immutable' FROM event_invoice_recovery WHERE booking_group_reference='group1';`), 'original');
    sql(`UPDATE event_invoice_recovery SET snapshot='{}';`, true);
    for (const group of ['cancelled', 'public', 'free']) assert.equal(sql(enqueue(group)), 'not_applicable');
    assert.equal(sql(enqueue('group2')), 'pending');
    const claim = JSON.parse(sql(`SELECT row_to_json(event_invoice_recovery_claim('${tenant}','booking','group1'));`));
    assert.ok(claim.lease_token);
    assert.equal(sql(`SELECT invoice_recovery_status FROM booking WHERE booking_group_reference='group1';`), 'processing');
    assert.equal(sql(`SELECT (event_invoice_recovery_claim('${tenant}')).id IS NULL;`), 't');
    // Expire both leases, then claim with a new fence.
    sql(`UPDATE event_invoice_recovery SET lease_expires_at=now()-interval '1 second' WHERE id='${claim.id}';
      UPDATE event_invoice_recovery_connection SET lease_expires_at=now()-interval '1 second';`);
    const next = JSON.parse(sql(`SELECT row_to_json(event_invoice_recovery_claim('${tenant}','booking','group1'));`));
    assert.notEqual(next.lease_token, claim.lease_token);
    assert.equal(sql(`SELECT event_invoice_recovery_finish('${claim.id}','${claim.lease_token}','complete',NULL,'bad');`), 'f');
    assert.equal(sql(`SELECT event_invoice_recovery_finish('${next.id}','${next.lease_token}','retry',
      now()+interval '10 minutes',NULL,NULL,NULL,'provider_rate_limited',now()+interval '10 minutes');`), 't');
    assert.equal(sql(`SELECT (event_invoice_recovery_claim('${tenant}')).id IS NULL;`), 't');
    assert.equal(sql(`SELECT invoice_recovery_next_attempt_at IS NOT NULL FROM booking WHERE booking_group_reference='group1';`), 't');
    // A second tenant is not held by another tenant's provider embargo.
    assert.equal(sql(enqueue('other', `'${snapshot.replaceAll('connection1', 'connection2').replaceAll('org1', 'org2')}'`, true, 'booking', tenant2)), 'pending');
    const other = JSON.parse(sql(`SELECT row_to_json(event_invoice_recovery_claim());`));
    assert.equal(other.tenant_id, tenant2);
    assert.equal(sql(`SELECT event_invoice_recovery_finish('${other.id}','${other.lease_token}','complete',NULL,'invoice2','INV2');`), 't');
    assert.equal(sql(`SELECT xero_invoice_id||':'||invoice_recovery_status||':'||payment_status FROM booking WHERE booking_group_reference='other';`), 'invoice2:complete:paid');
    sql(`SELECT event_invoice_recovery_sweep(100);`);
    assert.equal(sql(`SELECT status FROM event_invoice_recovery WHERE booking_group_reference='history';`), 'needs_review');
    assert.equal(sql(`SELECT invoice_recovery_status FROM complex_event_booking WHERE booking_group_reference='complex';`), 'needs_review');
    assert.equal(sql(`SELECT snapshot IS NULL FROM event_invoice_recovery WHERE booking_group_reference='history';`), 't');
    sql(`SELECT event_invoice_recovery_heartbeat(true);`);
    assert.equal(JSON.parse(sql('SELECT event_invoice_recovery_health();')).status, 'waiting_provider');
    sql(`UPDATE event_invoice_recovery_monitor SET last_success_at=now()-interval '20 minutes';`);
    assert.equal(JSON.parse(sql('SELECT event_invoice_recovery_health();')).status, 'stale');
    sql(`UPDATE event_invoice_recovery_monitor SET last_success_at=now();
      UPDATE event_invoice_recovery_connection SET cooldown_until=NULL;
      UPDATE event_invoice_recovery SET next_attempt_at=now()-interval '20 minutes' WHERE booking_group_reference='group2';`);
    assert.equal(JSON.parse(sql('SELECT event_invoice_recovery_health();')).status, 'overdue');
    // Real concurrent transactions: second cron skips the first cron's uncommitted lease.
    const clients = [0, 1].map(() => new pg.Client({
      host: h.socket, port: h.port, user: 'postgres', database: 'postgres',
    }));
    try {
      await Promise.all(clients.map(client => client.connect()));
      await clients[0].query('BEGIN');
      const first = await clients[0].query('SELECT (event_invoice_recovery_claim()).id AS id');
      assert.ok(first.rows[0].id);
      const second = await clients[1].query('SELECT (event_invoice_recovery_claim()).id AS id');
      assert.equal(second.rows[0].id, null);
      await clients[0].query('ROLLBACK');
    } finally {
      await Promise.all(clients.map(client => client.end()));
    }
    const stripeSnapshot = JSON.stringify({
      version: 1, provider: { connectionId: 'stripe-connection', xeroTenantId: 'stripe-org' },
      invoice: { Type: 'ACCREC' }, paymentMethod: 'stripe', settlement: { paymentIntentId: 'pi_shared' },
    });
    sql(`INSERT INTO booking(tenant_id,booking_group_reference,payment_method,stripe_payment_intent_id)
      VALUES('${tenant}','stripe-owner','card','pi_shared'),('${tenant}','stripe-owner','card',NULL);
      INSERT INTO complex_event_booking(tenant_id,booking_group_reference,payment_method,stripe_payment_intent_id)
      VALUES('${tenant}','stripe-racer','card','pi_shared');`);
    assert.equal(sql(enqueue('stripe-owner', `'${stripeSnapshot}'`)), 'pending');
    assert.equal(sql(enqueue('stripe-racer', `'${stripeSnapshot}'`, true, 'complex_event_booking')), 'needs_review');
    assert.equal(sql(`SELECT reason_code FROM event_invoice_recovery WHERE booking_group_reference='stripe-racer';`), 'settlement_already_owned');
    assert.equal(sql(`SELECT count(*) FROM event_invoice_recovery WHERE settlement_payment_intent_id='pi_shared';`), '1');
    const stripe = JSON.parse(sql(`SELECT row_to_json(event_invoice_recovery_claim('${tenant}','booking','stripe-owner'));`));
    assert.equal(sql(`SELECT event_invoice_recovery_guard('${stripe.id}','${stripe.lease_token}');`), 't');
    // Null sibling PI is normal complex checkout storage; cancellation/conflicting non-null PI are not.
    sql(`UPDATE booking SET status='cancelled' WHERE booking_group_reference='stripe-owner' AND stripe_payment_intent_id IS NULL;`);
    assert.equal(sql(`SELECT event_invoice_recovery_guard('${stripe.id}','${stripe.lease_token}');`), 'f');
    sql(`UPDATE booking SET status='confirmed',stripe_payment_intent_id='pi_conflict'
      WHERE booking_group_reference='stripe-owner' AND stripe_payment_intent_id IS NULL;`);
    assert.equal(sql(`SELECT event_invoice_recovery_guard('${stripe.id}','${stripe.lease_token}');`), 'f');
    sql(`UPDATE booking SET stripe_payment_intent_id=NULL WHERE stripe_payment_intent_id='pi_conflict';`);
    assert.equal(sql(`SELECT event_invoice_recovery_start_write('${stripe.id}','${stripe.lease_token}','invoice');`), 't');
    assert.equal(sql(`SELECT event_invoice_recovery_start_write('${stripe.id}','${stripe.lease_token}','invoice');`), 'f');
    assert.equal(sql(`SELECT event_invoice_recovery_record_invoice('${stripe.id}','${stripe.lease_token}','known-invoice','INV');`), 't');
    assert.equal(sql(`SELECT event_invoice_recovery_record_invoice('${stripe.id}','${stripe.lease_token}','different-invoice','INV');`), 'f');
    assert.equal(sql(`SELECT event_invoice_recovery_start_write('${stripe.id}','${stripe.lease_token}','payment');`), 't');
    assert.equal(sql(`SELECT event_invoice_recovery_start_write('${stripe.id}','${stripe.lease_token}','payment');`), 'f');
    sql(`UPDATE event_invoice_recovery SET settlement_payment_intent_id='pi_stolen' WHERE id='${stripe.id}';`, true);
    sql(`SELECT event_invoice_recovery_sweep(NULL);`, true);
    sql(`INSERT INTO booking(tenant_id,booking_group_reference,payment_method,stripe_payment_intent_id)
      VALUES('${tenant}','race-a','card','pi_concurrent');
      INSERT INTO complex_event_booking(tenant_id,booking_group_reference,payment_method,stripe_payment_intent_id)
      VALUES('${tenant}','race-b','card','pi_concurrent');`);
    const racers = [0, 1].map(() => new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' }));
    try {
      await Promise.all(racers.map(client => client.connect()));
      await racers[0].query('BEGIN');
      const concurrentSnapshot = JSON.parse(stripeSnapshot);
      concurrentSnapshot.settlement.paymentIntentId = 'pi_concurrent';
      const args = [tenant, 'booking', 'race-a', concurrentSnapshot];
      const call = 'SELECT (event_invoice_recovery_enqueue($1,$2,$3,$4,true)).status AS status';
      const owner = await racers[0].query(call, args);
      const contender = racers[1].query(call, [tenant, 'complex_event_booking', 'race-b', concurrentSnapshot]);
      await racers[0].query('COMMIT');
      assert.equal(owner.rows[0].status, 'pending');
      assert.equal((await contender).rows[0].status, 'needs_review');
    } finally {
      await Promise.all(racers.map(client => client.end()));
    }
    assert.equal(sql(`SELECT count(*) FROM event_invoice_recovery WHERE settlement_payment_intent_id='pi_concurrent';`), '1');
    // A single linked sibling must never disappear through bool_and(NULL).
    // Exercise both source tables and legacy/generic invoice links against real RPCs.
    for (const source of ['booking', 'complex_event_booking']) {
      const group = `part-linked-${source}`;
      const partialSnapshot = JSON.stringify({
        version: 1, provider: { connectionId: `connection-${group}`, xeroTenantId: 'partial-org' },
        invoice: { Type: 'ACCREC' }, paymentMethod: 'invoice',
      });
      sql(`INSERT INTO ${source}(tenant_id,booking_group_reference,xero_invoice_id)
        VALUES('${tenant}','${group}',NULL),('${tenant}','${group}','preexisting');`);
      assert.equal(sql(enqueue(group, `'${partialSnapshot}'`, true, source)), 'pending');
      const partial = JSON.parse(sql(`SELECT row_to_json(event_invoice_recovery_claim('${tenant}','${source}','${group}'));`));
      assert.equal(partial.invoice_id, null);
      const guard = `SELECT event_invoice_recovery_guard('${partial.id}','${partial.lease_token}');`;
      assert.equal(sql(guard), 'f', 'linked sibling with no durable recovery ID must block the entire group');
      assert.equal(sql(`SELECT event_invoice_recovery_start_write('${partial.id}','${partial.lease_token}','invoice');`), 'f');
      assert.equal(sql(`SELECT event_invoice_recovery_finish('${partial.id}','${partial.lease_token}','complete',NULL,'replacement');`), 'f');
      assert.equal(sql(`SELECT count(*) FROM ${source} WHERE booking_group_reference='${group}' AND xero_invoice_id IS NULL;`), '1');
      // A generic-only link is also an explicit veto, not an unknown/null predicate.
      sql(`UPDATE ${source} SET xero_invoice_id=NULL,accounting_invoice_id='generic-existing'
        WHERE booking_group_reference='${group}' AND xero_invoice_id='preexisting';`);
      assert.equal(sql(guard), 'f');
      assert.equal(sql(`SELECT event_invoice_recovery_start_write('${partial.id}','${partial.lease_token}','invoice');`), 'f');
      sql(`UPDATE ${source} SET accounting_invoice_id=NULL WHERE booking_group_reference='${group}';`);
      assert.equal(sql(guard), 't');
      assert.equal(sql(`SELECT event_invoice_recovery_record_invoice('${partial.id}','${partial.lease_token}','known-partial','INV');`), 't');
      sql(`UPDATE ${source} SET xero_invoice_id='known-partial' WHERE id=(
        SELECT id FROM ${source} WHERE booking_group_reference='${group}' ORDER BY id LIMIT 1);`);
      assert.equal(sql(guard), 't', 'known matching Xero ID is permitted alongside an unlinked sibling');
      sql(`UPDATE ${source} SET xero_invoice_id='unrelated' WHERE booking_group_reference='${group}' AND xero_invoice_id IS NOT NULL;`);
      assert.equal(sql(guard), 'f', 'a conflicting non-null ID always blocks recovery');
    }
    // Replay the complete migration while durable snapshots, fences, cooldowns,
    // ownership and heartbeat state exist. Reapplication must not reset any of them.
    const state = () => ['event_invoice_recovery', 'event_invoice_recovery_connection', 'event_invoice_recovery_monitor']
      .map(table => sql(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM ${table} t;`));
    const beforeReplay = state();
    sql(migration);
    assert.deepEqual(state(), beforeReplay);
    sql('SET ROLE anon; SELECT event_invoice_recovery_claim();', true);
    sql('SET ROLE authenticated; SELECT * FROM event_invoice_recovery;', true);
    sql(`UPDATE event_invoice_recovery SET snapshot='{}';`, true);
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});