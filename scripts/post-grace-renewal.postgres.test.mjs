import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('post-grace journal isolates owners, pins payment dates and denies browser writes', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('post-grace-');
  const command = (name, args) => {
    const r = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  let db, started = false;
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        payment_status text,billing_agreement_id uuid,term_start_date date,term_end_date date,
        term_key text,renewal_policy_snapshot jsonb,commitment_snapshot jsonb,incentive_snapshot jsonb);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,
        structure_scope_type text,billing_period text,is_active boolean);
      CREATE TABLE membership_successor_election(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        organization_id uuid,previous_term_id uuid,payment_method text,status text,origin text);
    `);
    const migration = readFileSync(new URL('../supabase/migrations/20261103_post_grace_renewal_storage.sql', import.meta.url), 'utf8');
    await db.query(migration);
    await db.query(migration); // additive migration is idempotent
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const tenant = id(1), member = id(2), prior = id(3), config = id(4), election = id(5), reservation = id(6);
    await db.query(`INSERT INTO tenant VALUES($1);`, [tenant]);
    await db.query('INSERT INTO member VALUES($1,$2)', [member, tenant]);
    await db.query(`INSERT INTO member_membership_history VALUES($1,$2,$3,'paid',NULL,
      current_date-500,current_date-135,'rolling:old','{"renewal_grace_days":90}',NULL,NULL)`, [prior, tenant, member]);
    await db.query("INSERT INTO membership_tier_config VALUES($1,$2,'member','annual',true)", [config, tenant]);
    await db.query("INSERT INTO membership_successor_election VALUES($1,$2,$3,NULL,$4,'direct_debit','reserved','form')", [election, tenant, member, prior]);
    const insert = () => db.query(`INSERT INTO membership_post_grace_renewal
      (id,tenant_id,member_id,previous_term_id,config_id,election_id,payment_method,first_payment_minor,
      currency,grace_end_date,created_at) VALUES($1,$2,$3,$4,$5,$6,'direct_debit',1300,'GBP',current_date-44,now()-interval '3 days')`,
    [reservation, tenant, member, prior, config, election]);
    await assert.rejects(insert(), /not enabled/);
    await db.query('INSERT INTO membership_post_grace_policy(tenant_id,enabled) VALUES($1,true)', [tenant]);
    await insert();
    const privileged = await db.query(`SELECT
      has_table_privilege('anon','membership_post_grace_renewal','SELECT') a,
      has_table_privilege('authenticated','membership_post_grace_policy','UPDATE') b,
      has_table_privilege('service_role','membership_post_grace_renewal','UPDATE') c,
      has_function_privilege('anon','record_post_grace_payment(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text)','EXECUTE') d`);
    assert.deepEqual(privileged.rows[0], { a: false, b: false, c: false, d: false });
    const paidAt = new Date(Date.now() - 86400000).toISOString();
    const call = (overrides = {}) => {
      const x = { tenant, member, reservation, provider: 'gocardless', payment: 'payment-one',
        status: 'confirmed', paidAt, amount: 1300, currency: 'GBP', ...overrides };
      return db.query('SELECT record_post_grace_payment($1,$2,$3,$4,$5,$6,$7,$8,$9) result',
        [x.tenant, x.member, x.reservation, x.provider, x.payment, x.status, x.paidAt, x.amount, x.currency]);
    };
    await db.query('SET ROLE service_role');
    for (const override of [{ tenant: id(9) }, { member: id(9) }, { amount: 1301 }, { status: 'active' },
      { currency: 'USD' }, { paidAt: null }, { provider: 'stripe', status: 'confirmed' }]) {
      await assert.rejects(call(override));
    }
    const first = (await call()).rows[0].result;
    assert.equal(first.status, 'settled');
    assert.equal(first.term_start_date, paidAt.slice(0, 10));
    assert.deepEqual((await call()).rows[0].result, first);
    await assert.rejects(call({ payment: 'payment-two' }), /different settlement/);
    await db.query('RESET ROLE');
    await assert.rejects(db.query("UPDATE membership_post_grace_renewal SET status='released' WHERE id=$1", [reservation]), /immutable/);
    await assert.rejects(db.query('DELETE FROM membership_post_grace_renewal WHERE id=$1', [reservation]), /cannot be deleted/);
    assert.equal((await db.query('SELECT term_end_date=current_date-135 unchanged FROM member_membership_history WHERE id=$1', [prior])).rows[0].unchanged, true);
  } finally {
    if (db) await db.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await h.cleanup();
  }
});
