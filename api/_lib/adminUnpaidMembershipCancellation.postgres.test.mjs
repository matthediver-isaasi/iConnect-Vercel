import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('admin unpaid cancellation requires an invoice void and releases the same-term checkout fence', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('admin-unpaid-');
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  let db, peer, started = false;
  const t = '10000000-0000-0000-0000-000000000001', m = '20000000-0000-0000-0000-000000000001';
  const historyId = '30000000-0000-0000-0000-000000000001', actor = '40000000-0000-0000-0000-000000000001';
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']); started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' }); await db.connect();
    await db.query(`CREATE EXTENSION btree_gist;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid primary key);
      CREATE TABLE member(id uuid primary key,tenant_id uuid,membership_paused boolean,membership_cancelled boolean,organization_id uuid);
      CREATE TABLE form_joining_voucher_checkout(tenant_id uuid,member_id uuid,released_at timestamptz,breakdown jsonb);
      CREATE TABLE membership_payment_quote(id uuid primary key,tenant_id uuid,member_id uuid,organization_id uuid,
       quote jsonb,stripe_payment_intent_id text,cancelled_for_switch_at timestamptz);
      CREATE TABLE membership_billing_agreements(id uuid primary key,tenant_id uuid,member_id uuid,organization_id uuid,status text,
       membership_successor_election_id uuid,previous_term_id uuid,provider text,environment text,
       gocardless_mandate_id text,gocardless_subscription_id text,stripe_subscription_id text,
       stripe_checkout_session_id text,gocardless_billing_request_id text,idempotency_key text,membership_year text,
       metadata jsonb,cancelled_for_switch_at timestamptz);
      CREATE TABLE member_membership_history(id uuid primary key,tenant_id uuid,member_id uuid,status text,payment_status text,
       payment_method text,total_with_vat numeric,commitment_snapshot jsonb,accounting_provider text,membership_year text,
       term_key text,term_start_date date,membership_renewal_date date,payment_grace_exit_id uuid,restart_supersession_id uuid,
       paid_at timestamptz,previous_term_id uuid,membership_successor_election_id uuid,billing_agreement_id uuid,
       membership_payment_quote_id uuid,stripe_payment_intent_id text,xero_invoice_id text,accounting_invoice_id text,cancelled_for_switch_at timestamptz,
       CONSTRAINT member_membership_history_payment_status_chk CHECK(payment_status IN ('unpaid','paid','partial','voided','unverified')),
       CONSTRAINT member_membership_history_tenant_id_member_id_membership_ye_key UNIQUE(tenant_id,member_id,membership_year),
       CONSTRAINT member_membership_history_rolling_no_overlap EXCLUDE USING gist
        (tenant_id WITH =,member_id WITH =,daterange(term_start_date,membership_renewal_date,'[)') WITH &&)
        WHERE(term_key IS NOT NULL AND payment_grace_exit_id IS NULL AND restart_supersession_id IS NULL
         AND status IS DISTINCT FROM 'replaced' AND status IS DISTINCT FROM 'cancelled_by_request'));
      CREATE TABLE membership_payment_plans(tenant_id uuid,member_id uuid,billing_agreement_id uuid);
      CREATE TABLE membership_payment_term_claim(tenant_id uuid,owner_type text,owner_id uuid,source_key text,membership_year text);
      CREATE TABLE membership_voucher_settlement(id uuid,tenant_id uuid,fee_token_id uuid);
      CREATE TABLE membership_fee_token(id uuid,tenant_id uuid,member_id uuid,status text,cost_breakdown jsonb);`);
    for (const file of ['202701210001_initial_checkout_recovery.sql', '202702070001_admin_unpaid_membership_cancellation.sql']) {
      await db.query(readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await db.query('INSERT INTO tenant VALUES($1)', [t]);
    await db.query('INSERT INTO member VALUES($1,$2,false,false,null)', [m, t]);
    await db.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,payment_status,payment_method,
      total_with_vat,xero_invoice_id,membership_year,term_key,term_start_date,membership_renewal_date)
      VALUES($1,$2,$3,'pending_payment_setup','unpaid','invoice',128,'invoice','rolling:2026-11-06','rolling:2026-11-06','2026-11-06','2027-11-06')`, [historyId, t, m]);
    const history = async () => (await db.query('SELECT to_jsonb(h) AS h FROM member_membership_history h WHERE id=$1', [historyId])).rows[0].h;
    const invoice = { id: 'invoice', providerTenantId: 'books', contactId: 'payer', currency: 'GBP',
      status: 'AUTHORISED', paidMinor: 0, creditedMinor: 0, dueMinor: 12800, grossMinor: 12800 };
    const begin = async row => (await db.query(
      'SELECT begin_admin_unpaid_membership_cancellation($1,$2,$3,$4,$5,$6) AS op',
      [t, m, actor, row || await history(), invoice, 'Member wants to start again'])).rows[0].op;
    // The self-service recovery protocol still cannot claim an invoice checkout.
    await assert.rejects(db.query('SELECT begin_form_initial_checkout_recovery($1,$2)', [t, m]), /No unfinished/);
    await db.query("UPDATE member_membership_history SET payment_status='partial'");
    await assert.rejects(begin(), /Only an original unpaid/);
    await db.query("UPDATE member_membership_history SET payment_status='unpaid'");
    await db.query("INSERT INTO membership_fee_token VALUES(gen_random_uuid(),$1,$2,'pending','{}')", [t, m]);
    await assert.rejects(begin(), /finance review/);
    await db.query('DELETE FROM membership_fee_token');
    const old = await history();
    await db.query('UPDATE member_membership_history SET total_with_vat=129');
    await assert.rejects(begin(old), /changed/);
    await db.query('UPDATE member_membership_history SET total_with_vat=128');
    peer = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' }); await peer.connect();
    await db.query('BEGIN');
    const op = await begin();
    let concurrentFinished = false;
    const concurrent = peer.query('SELECT begin_admin_unpaid_membership_cancellation($1,$2,$3,$4,$5,$6) AS op',
      [t, m, actor, await history(), invoice, 'Second administrator confirmation']).then(res => {
      concurrentFinished = true; return res.rows[0].op;
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(concurrentFinished, false, 'the shared purchase lock fences concurrent confirmations');
    await db.query('COMMIT');
    assert.equal((await concurrent).id, op.id);
    assert.equal((await begin()).id, op.id);
    assert.equal(op.snapshot.adminUnpaidCancellation.actorId, actor);
    await assert.rejects(db.query('DELETE FROM member_membership_history WHERE id=$1', [historyId]), /protects this purchase/);
    await assert.rejects(db.query("INSERT INTO membership_fee_token VALUES(gen_random_uuid(),$1,$2,'pending','{}')", [t, m]), /protects this purchase/);
    await assert.rejects(db.query('INSERT INTO membership_payment_plans(tenant_id,member_id) VALUES($1,$2)', [t, m]), /protects this purchase/);
    await assert.rejects(db.query("UPDATE member_membership_history SET payment_status='paid'"), /reconciled/);
    await assert.rejects(db.query("SELECT finish_form_initial_checkout_recovery($1,$2,$3,'[]',false)", [t, m, op.id]), /Administrator invoice/);
    await assert.rejects(db.query("SELECT finish_form_initial_checkout_recovery($1,$2,$3,'[]',true)", [t, m, op.id]), /Administrator invoice/);
    const finish = receipt => db.query('SELECT finish_admin_unpaid_membership_cancellation($1,$2,$3,$4,$5)', [t, m, op.id, actor, receipt]);
    await assert.rejects(finish({ ...invoice, status: 'VOIDED', paidMinor: 1 }), /invoice void/);
    await assert.rejects(finish({ ...invoice, status: 'VOIDED', id: 'wrong' }), /invoice void/);
    await assert.rejects(finish(null), /invoice void/);
    const before = await history();
    await finish({ ...invoice, status: 'VOIDED', dueMinor: 0 });
    await finish({ ...invoice, status: 'VOIDED', dueMinor: 0 });
    const retired = await history();
    assert.equal(retired.status, 'expired_checkout');
    assert.ok(retired.cancelled_for_switch_at);
    assert.equal(retired.xero_invoice_id, before.xero_invoice_id);
    assert.equal(retired.payment_status, 'voided');
    assert.equal((await db.query('SELECT membership_cancelled FROM member')).rows[0].membership_cancelled, false);
    // Same membership year is now available, but stale checkout generations and
    // late invoice settlement cannot resurrect the abandoned purchase.
    await assert.rejects(db.query("UPDATE member_membership_history SET status='active' WHERE id=$1", [historyId]), /released/);
    const agreement = metadata => db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,
      status,provider,environment,gocardless_billing_request_id,membership_year,metadata)
      VALUES(gen_random_uuid(),$1,$2,'payment_setup_required','gocardless','sandbox','BR-next','rolling:2026-11-06',$3)`, [t, m, metadata]);
    await assert.rejects(agreement({}), /Refresh/);
    await agreement({ initialRecoveryGeneration: op.id });
    await db.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,payment_status,payment_method,
      membership_year,term_key,term_start_date,membership_renewal_date)
      VALUES(gen_random_uuid(),$1,$2,'pending_payment_setup','unpaid','direct_debit',
       'rolling:2026-11-06','rolling:2026-11-06','2026-11-06','2027-11-06')`, [t, m]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM member_membership_history')).rows[0].n, 2);
    await assert.rejects(db.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,payment_status,membership_year)
      VALUES(gen_random_uuid(),$1,$2,'active','paid','rolling:2026-11-06')`, [t, m]), /unique constraint/);
    await assert.rejects(db.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,payment_status,payment_method,
      membership_year,term_key,term_start_date,membership_renewal_date)
      VALUES(gen_random_uuid(),$1,$2,'active','paid','card','overlap','rolling:2026-11-07','2026-11-07','2027-11-07')`, [t, m]), /exclusion constraint/);
    await db.query('SET ROLE service_role');
    await assert.rejects(db.query("SELECT finish_form_initial_checkout_recovery_internal($1,$2,$3,'[]',false)", [t, m, op.id]), /permission denied/);
    await db.query('RESET ROLE');
    await db.query('SET ROLE authenticated');
    await assert.rejects(begin(), /permission denied/);
    await assert.rejects(finish({ ...invoice, status: 'VOIDED' }), /permission denied/);
    await db.query('RESET ROLE');
  } finally {
    if (peer) await peer.end();
    if (db) await db.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop']);
    await h.cleanup();
  }
});
