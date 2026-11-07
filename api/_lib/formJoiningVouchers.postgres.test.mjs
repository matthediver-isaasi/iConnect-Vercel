import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('first-purchase voucher reservation is scoped, immutable, replayable and fences other payment rails', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('joining-credit-');
  let db, second, started = false;
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const tenant = '10000000-0000-0000-0000-000000000001';
  const member = '20000000-0000-0000-0000-000000000001';
  const other = '20000000-0000-0000-0000-000000000002';
  const form = '30000000-0000-0000-0000-000000000001';
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    const config = { host: h.socket, port: h.port, user: 'postgres', database: 'postgres' };
    db = new pg.Client(config); second = new pg.Client(config);
    await db.connect(); await second.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text,membership_paused boolean DEFAULT false);
      CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,fields jsonb,is_active boolean,require_authentication boolean);
      CREATE TABLE membership_fee_token(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token text UNIQUE,tenant_id uuid,
        member_id uuid,organization_id uuid,membership_year text,status text,final_cost numeric,currency text,tier_label text,
        cost_breakdown jsonb,recipient_email text,expires_at timestamptz,history_record_id uuid);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,status text,term_end_date date);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,status text,metadata jsonb);
      CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,quote jsonb);
      CREATE TABLE membership_successor_election(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,
        previous_term_id uuid,status text,term_start_date date,term_end_date date);
      CREATE TABLE membership_voucher_settlement(id uuid PRIMARY KEY,tenant_id uuid,fee_token_id uuid,state text);
    `);
    const settlementMigration = readFileSync(new URL('../../supabase/migrations/202610200003_membership_voucher_settlement.sql', import.meta.url), 'utf8');
    await db.query(settlementMigration.slice(0, settlementMigration.indexOf('CREATE TABLE public.membership_voucher_settlement')));
    await db.query(readFileSync(new URL('../../supabase/migrations/202701200001_form_joining_vouchers.sql', import.meta.url), 'utf8'));
    await db.query(readFileSync(new URL('../../supabase/migrations/202701200002_form_joining_voucher_successor.sql', import.meta.url), 'utf8'));
    await db.query('INSERT INTO tenant VALUES($1);', [tenant]);
    await db.query("INSERT INTO member(id,tenant_id,email) VALUES($1,$3,'one@example.test'),($2,$3,'two@example.test')", [member, other, tenant]);
    await db.query("INSERT INTO form VALUES($1,$2,$3,true,true)", [form, tenant, JSON.stringify([{ id: 'payment', type: 'membership_payment' }])]);
    const simulation = { success: true, finalCost: 100, totalWithVat: 100, currency: 'GBP',
      config: { id: 'config', structure_scope_type: 'member' },
      membershipYear: { label: '2027', start: '2027-01-01', end: '2027-12-31' } };
    const breakdown = { ...simulation, formJoiningVoucher: { version: 1, formId: form,
      paymentFieldId: 'payment', paymentMode: 'stripe_upfront', simulation } };
    const bind = (connection, owner = member, body = breakdown, token = 'a'.repeat(64)) =>
      connection.query('SELECT bind_form_joining_voucher_checkout($1,$2,$3,$4) AS token', [tenant, owner, body, token]);
    await db.query('SET ROLE service_role');
    await second.query('SET ROLE service_role');
    const results = await Promise.all([bind(db), bind(second, member, breakdown, 'b'.repeat(64))]);
    const token = results[0].rows[0].token;
    assert.equal(results[1].rows[0].token.id, token.id, 'concurrent requests adopt one quote');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM form_joining_voucher_checkout')).rows[0].n, 1);
    await assert.rejects(bind(db, member, { ...breakdown, formJoiningVoucher: {
      ...breakdown.formJoiningVoucher, paymentMode: 'direct_debit' } }), /original first-membership/);
    await assert.rejects(db.query('UPDATE form_joining_voucher_checkout SET breakdown=$1', [breakdown]), /permission denied/);
    await db.query('RESET ROLE');
    // A genuine next term can be reserved while the first monthly plan remains
    // pending; neither an overlapping quote nor a forged election may pass.
    const prior = '50000000-0000-0000-0000-000000000001';
    const successor = '60000000-0000-0000-0000-000000000001';
    await db.query("INSERT INTO member_membership_history VALUES($1,$2,$3,'active','2027-12-31')", [prior, tenant, member]);
    await db.query('UPDATE membership_fee_token SET history_record_id=$1 WHERE id=$2', [prior, token.id]);
    await db.query("INSERT INTO membership_successor_election VALUES($1,$2,$3,null,$4,'reserved','2028-01-01','2028-12-31')", [successor, tenant, member, prior]);
    const nextQuote = { simResult: { formRenewalElectionId: successor, membershipYear: { start: '2028-01-01', end: '2028-12-31' } } };
    await db.query('INSERT INTO membership_payment_quote VALUES(gen_random_uuid(),$1,$2,$3)', [tenant, member, nextQuote]);
    await assert.rejects(db.query('INSERT INTO membership_payment_quote VALUES(gen_random_uuid(),$1,$2,$3)',
      [tenant, member, { simResult: { ...nextQuote.simResult, membershipYear: { start: '2027-01-01', end: '2027-12-31' } } }]), /existing first-membership/);
    await db.query('DELETE FROM membership_payment_quote');
    await db.query('UPDATE membership_fee_token SET history_record_id=null WHERE id=$1', [token.id]);
    await db.query('DELETE FROM member_membership_history');
    await assert.rejects(db.query("INSERT INTO membership_payment_quote VALUES(gen_random_uuid(),$1,$2,'{}')", [tenant, member]), /existing first-membership/);
    await assert.rejects(db.query("INSERT INTO membership_billing_agreements VALUES(gen_random_uuid(),$1,$2,null,'pending','{}')", [tenant, member]), /existing first-membership/);
    const settlement = '40000000-0000-0000-0000-000000000001';
    await db.query("INSERT INTO membership_voucher_settlement VALUES($1,$2,$3,'reserved')", [settlement, tenant, token.id]);
    await db.query("INSERT INTO membership_billing_agreements VALUES(gen_random_uuid(),$1,$2,null,'pending',$3)",
      [tenant, member, { card: { voucher_funding: { settlement_id: settlement } } }]);
    await assert.rejects(bind(db, other, { ...breakdown, totalWithVat: 1 }, 'c'.repeat(64)), /Invalid first-membership/);
    await db.query("INSERT INTO member_membership_history VALUES(gen_random_uuid(),$1,$2,'active','2026-12-31')", [tenant, other]);
    await assert.rejects(bind(db, other, breakdown, 'c'.repeat(64)), /Existing membership payment/);
    await db.query('DELETE FROM member_membership_history WHERE member_id=$1', [other]);
    await db.query("INSERT INTO membership_payment_quote VALUES(gen_random_uuid(),$1,$2,'{}')", [tenant, other]);
    await assert.rejects(bind(db, other, breakdown, 'c'.repeat(64)), /Existing membership payment/);
    await db.query('DELETE FROM membership_payment_quote WHERE member_id=$1', [other]);
    await db.query('UPDATE member SET membership_paused=true WHERE id=$1', [other]);
    await assert.rejects(bind(db, other, breakdown, 'c'.repeat(64)), /paused/);
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(bind(db), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM form_joining_voucher_checkout'), /permission denied/);
      await db.query('RESET ROLE');
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM membership_fee_token')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM member_membership_history')).rows[0].n, 0);
    const release = () => db.query('SELECT release_form_joining_voucher_checkout($1,$2,$3,$4)', [tenant, member, form, 'payment']);
    await assert.rejects(release(), /Reconcile/);
    await db.query("UPDATE membership_voucher_settlement SET state='released'");
    await assert.rejects(release(), /Reconcile/, 'live agreement cannot be abandoned');
    await db.query("UPDATE membership_billing_agreements SET status='cancelled'");
    await db.query('SET ROLE service_role');
    assert.equal((await release()).rows[0].release_form_joining_voucher_checkout, true);
    assert.equal((await release()).rows[0].release_form_joining_voucher_checkout, true);
    await db.query('RESET ROLE');
    assert.equal((await db.query('SELECT status FROM membership_fee_token WHERE id=$1', [token.id])).rows[0].status, 'cancelled');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM membership_payment_term_claim')).rows[0].n, 0);
    for (const mode of ['stripe_monthly', 'direct_debit']) {
      const body = { ...breakdown, formJoiningVoucher: { ...breakdown.formJoiningVoucher, paymentMode: mode } };
      const next = await bind(db, member, body, (mode === 'stripe_monthly' ? 'd' : 'e').repeat(64));
      assert.equal(next.rows[0].token.cost_breakdown.formJoiningVoucher.paymentMode, mode);
      await release();
    }
    await assert.rejects(db.query('SELECT bind_form_joining_voucher_checkout($1,$2,$3,$4)',
      ['10000000-0000-0000-0000-000000000002', member, breakdown, 'f'.repeat(64)]), /owner unavailable/);
  } finally {
    await db?.end(); await second?.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
