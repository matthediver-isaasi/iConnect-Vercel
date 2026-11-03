import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('form credit bridge is scoped, idempotent, payment-fenced and service-only', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('form-voucher-');
  let db, started = false;
  const run = (name, args) => {
    const r = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const migration = name => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text);
      CREATE TABLE membership_successor_election(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,
        origin text,status text,quote jsonb,payment_method text,term_start_date date,term_end_date date,
        payment_quote_id uuid,switch_state text);
      CREATE TABLE membership_fee_token(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token text UNIQUE,tenant_id uuid,member_id uuid,
        organization_id uuid,membership_year text,status text,final_cost numeric,currency text,tier_label text,
        cost_breakdown jsonb,recipient_email text,expires_at timestamptz,stripe_payment_intent_id text,
        stripe_payment_attempted_at timestamptz,updated_at timestamptz DEFAULT now());
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,
        membership_successor_election_id uuid,status text,metadata jsonb);
      CREATE TABLE membership_voucher_settlement(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),fee_token_id uuid,state text);
      CREATE TABLE membership_payment_term_claim(tenant_id uuid,owner_type text,owner_id uuid,membership_year text,
        source_key text,rail text,PRIMARY KEY(tenant_id,owner_type,owner_id,membership_year));
      CREATE TABLE membership_fee_checkout_claim(fee_token_id uuid PRIMARY KEY,tenant_id uuid,rail text);
    `);
    const original = migration('202610200003_membership_voucher_settlement.sql');
    for (const name of ['membership_payment_term_guard', 'membership_fee_checkout_guard']) {
      const body = original.match(new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*?END \\$\\$;`))?.[0];
      assert.ok(body, `real ${name} definition must be present`);
      await db.query(body);
    }
    await db.query(migration('202611080001_form_membership_voucher_checkout.sql'));
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const tenant = id(1), member = id(2), other = id(3), election = id(4);
    await db.query('INSERT INTO tenant VALUES($1);', [tenant]);
    await db.query('INSERT INTO member VALUES($1,$3,$4),($2,$3,$4)', [member, other, tenant, 'fixture@example.invalid']);
    const sim = { success: true, finalCost: 100, totalWithVat: 100, currency: 'GBP', tierLabel: 'Test',
      membershipYear: { label: '2026/2027', start: '2026-10-01', end: '2027-09-30' } };
    const breakdown = { totalWithVat: 100, formVoucher: { version: 1, electionId: election,
      paymentMode: 'stripe_upfront', simulation: sim } };
    await db.query(`INSERT INTO membership_successor_election VALUES($1,$2,$3,NULL,'form','reserved',$4,
      'upfront','2026-10-01','2027-09-30',NULL,'idle')`, [election, tenant, member, { payerMemberId: member, simulation: sim }]);
    const bind = (who = member, cb = breakdown) => db.query(
      'SELECT bind_form_membership_voucher_checkout($1,$2,$3,$4,$5) AS token',
      [tenant, who, election, cb, 'a'.repeat(64)]);
    await assert.rejects(bind(other), /reservation is unavailable/);
    await assert.rejects(bind(member, { ...breakdown, totalWithVat: 101 }), /does not match/);
    const permissions = await db.query(`SELECT
      has_function_privilege('anon','bind_form_membership_voucher_checkout(uuid,uuid,uuid,jsonb,text)','EXECUTE') AS anon,
      has_function_privilege('authenticated','release_form_membership_voucher_checkout(uuid,uuid,uuid)','EXECUTE') AS auth,
      has_function_privilege('service_role','bind_form_membership_voucher_checkout(uuid,uuid,uuid,jsonb,text)','EXECUTE') AS service,
      form_membership_voucher_checkout_ready() AS ready`);
    assert.deepEqual(permissions.rows[0], { anon: false, auth: false, service: true, ready: false });
    await db.query('SET ROLE service_role');
    const first = (await bind()).rows[0].token;
    assert.equal((await bind()).rows[0].token.id, first.id);
    await assert.rejects(db.query('DELETE FROM form_membership_voucher_checkout'), /permission denied/);
    await db.query('RESET ROLE');
    await assert.rejects(db.query(`SELECT membership_payment_term_guard($1,$2,NULL,'2026/2027','form:other','create_payment')`,
      [tenant, member]), /already committed/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM membership_fee_token')).rows[0].n, 1);
    await db.query("INSERT INTO membership_voucher_settlement(fee_token_id,state) VALUES($1,'provider_pending')", [first.id]);
    const release = () => db.query('SELECT release_form_membership_voucher_checkout($1,$2,$3)', [tenant, member, election]);
    await assert.rejects(release(), /Cancel the existing payment/);
    await db.query("UPDATE membership_voucher_settlement SET state='released'");
    await release();
    assert.equal((await db.query('SELECT count(*)::int AS n FROM membership_payment_term_claim')).rows[0].n, 0);
    assert.equal((await db.query('SELECT status FROM membership_fee_token')).rows[0].status, 'cancelled');
  } finally {
    if (db) await db.end();
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop']);
    await h.cleanup();
  }
});
