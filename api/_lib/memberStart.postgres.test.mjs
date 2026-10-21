import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { buildStartQuote } from './memberStartQuote.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('isolated PostgreSQL start: atomic purchase, replay, stale quotes, creator fencing, immutable terms, paid activation and tenant permissions', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('member-start-');
  const clients = [];
  let started = false;
  const command = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 3; i++) {
      const client = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await client.connect(); clients.push(client);
    }
    const [db, a, b] = clients;
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,first_name text,last_name text,email text);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,structure_scope_type text,is_active boolean,
        billing_period text,start_mode text,effective_from date,effective_to date,currency text,pricing_model text,flat_cost numeric,
        prorata_enabled boolean,membership_start_month int,membership_start_day int);
      CREATE TABLE membership_tier_band(id uuid PRIMARY KEY,tenant_id uuid,config_id uuid,annual_cost numeric,label text);
      CREATE TABLE membership_tier_discount(id uuid PRIMARY KEY,tenant_id uuid,config_id uuid);
      CREATE TABLE membership_tier_vat_override(LIKE membership_tier_discount);
      CREATE TABLE member_membership_override(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid);
      CREATE TABLE system_settings(id uuid PRIMARY KEY,tenant_id uuid,setting_key text,setting_value text);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,
        membership_year text,config_id uuid,band_id uuid,tier_label text,annual_cost numeric,prorata_cost numeric,final_cost numeric,
        currency text,billing_period text,vat_rate_percent numeric,vat_amount numeric,total_with_vat numeric,
        term_start_date date,term_end_date date,membership_renewal_date date,term_duration_months int,term_anchor_date date,term_key text,
        previous_term_id uuid,commitment_snapshot jsonb,billing_agreement_id uuid,status text,payment_status text,
        payment_method text,paid_at timestamptz,scheduled_activation_date date,notes text,stripe_payment_intent_id text,
        accounting_provider text,accounting_invoice_id text);
      CREATE TABLE organisation_membership_history(LIKE member_membership_history INCLUDING DEFAULTS);
      CREATE TABLE membership_billing_agreements(LIKE member_membership_history INCLUDING DEFAULTS);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,status text);
      CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,stripe_payment_intent_id text);
      CREATE TABLE membership_fee_token(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,status text);
      CREATE TABLE membership_successor_election(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,status text,term_end_date date);
    `);
    // Real deployed completeness constraint, including the dated-DD exception:
    // fixed upfront snapshots must not be slipped past it.
    await db.query(readFileSync(new URL('../../supabase/migrations/20261108_direct_debit_dated_commitments.sql', import.meta.url), 'utf8').split('END $$;')[0] + 'END $$;');
    await db.query(readFileSync(new URL('../../supabase/migrations/202612310022_member_membership_start.sql', import.meta.url), 'utf8'));
    await db.query('INSERT INTO tenant VALUES($1),($2)', [id(1), id(2)]);
    for (let n = 10; n < 20; n++) await db.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [id(n), id(1)]);
    await db.query(`INSERT INTO membership_tier_config(id,tenant_id,structure_scope_type,is_active,billing_period,start_mode,effective_from,currency,pricing_model,flat_cost)
      VALUES($1,$2,'member',true,'annual','immediate','2020-01-01','GBP','flat',100)`, [id(3), id(1)]);
    const cfg = (await db.query('SELECT to_jsonb(t) AS value FROM membership_tier_config t')).rows[0].value;
    const today = new Date().toISOString().slice(0, 10);
    const state = async member => (await db.query('SELECT member_start_state($1,$2) s', [id(1), id(member)])).rows[0].s;
    const request = member => ({ memberId: id(member), configId: id(3), bandId: null, startDate: today,
      paymentMode: 'invoice', reason: 'Explicit purchase, no paid history asserted', expectedQuote: 'a'.repeat(64) });
    const quote = async member => ({ ...buildStartQuote({ request: request(member), config: cfg, today }), ownerState: (await state(member)).fingerprint });
    const invoke = (client, member, key, q, r = request(member)) => client.query('SELECT create_member_start($1,$2,$3,$4,$5,$6) result',
      [id(1), id(member), id(4), key, r, q]).then(result => result.rows[0].result);
    await a.query('SET ROLE service_role'); await b.query('SET ROLE service_role');
    const q = await quote(10);
    const concurrent = await Promise.all([invoke(a, 10, 'same-key-0001', q), invoke(b, 10, 'same-key-0001', q)]);
    assert.equal(concurrent.filter(r => r.replayed).length, 1);
    assert.equal(concurrent[0].request.record_id, concurrent[1].request.record_id);
    const recordId = concurrent[0].request.record_id;
    const record = (await db.query('SELECT * FROM member_membership_history WHERE id=$1', [recordId])).rows[0];
    assert.equal(record.payment_status, 'unpaid');
    assert.equal(record.status, 'pending_payment_setup');
    assert.equal(record.paid_at, null);
    await assert.rejects(invoke(a, 10, 'same-key-0001', q, { ...request(10), reason: 'different' }), /Idempotency/);
    await assert.rejects(invoke(a, 10, 'different-key', q), /obligations changed/);
    await assert.rejects(db.query("UPDATE member_membership_history SET status='active' WHERE id=$1", [recordId]), /before settlement/);
    await assert.rejects(db.query("UPDATE member_membership_history SET config_id=$1 WHERE id=$2", [id(99), recordId]), /immutable/);
    await assert.rejects(db.query("UPDATE member_membership_history SET member_id=$1 WHERE id=$2", [id(19), recordId]), /ownership is immutable/);
    await db.query("UPDATE member_membership_history SET accounting_provider='xero',accounting_invoice_id='invoice-1' WHERE id=$1", [recordId]);
    await db.query("UPDATE member_membership_history SET payment_status='paid',status='active',paid_at=now() WHERE id=$1", [recordId]);
    await assert.rejects(db.query('INSERT INTO membership_billing_agreements(tenant_id,member_id,status) VALUES($1,$2,$3)', [id(1), id(10), 'active']), /already owns/);
    // An evidenced, non-overlapping successor is still allowed through normal
    // renewal paths; the fence does not prohibit all future annual purchases.
    await db.query(`INSERT INTO member_membership_history(tenant_id,member_id,term_start_date,term_end_date,payment_status,status)
      SELECT tenant_id,member_id,term_end_date+1,term_end_date+365,'unpaid','pending_payment_setup'
      FROM member_membership_history WHERE id=$1`, [recordId]);
    await db.query("UPDATE member_membership_history SET status='expired' WHERE id=$1", [recordId]);
    // Separate-key and competing creator serialize at the member row.
    const q11 = await quote(11);
    await a.query('BEGIN');
    await invoke(a, 11, 'concurrent-start', q11);
    const racing = db.query("INSERT INTO membership_payment_quote(tenant_id,member_id) VALUES($1,$2)", [id(1), id(11)]);
    const rejected = assert.rejects(racing, /already owns/);
    await a.query('COMMIT'); await rejected;
    // Failed-provider authority is not consent to revive after another purchase.
    const failed = (await db.query("INSERT INTO membership_billing_agreements(tenant_id,member_id,status) VALUES($1,$2,'failed') RETURNING id", [id(1), id(17)])).rows[0].id;
    await invoke(a, 17, 'late-provider-001', await quote(17));
    await assert.rejects(db.query("UPDATE membership_billing_agreements SET status='active' WHERE id=$1", [failed]), /already owns/);
    // A creator that wins first invalidates the quoted state.
    const q12 = await quote(12);
    await db.query("INSERT INTO membership_fee_token(tenant_id,member_id,status) VALUES($1,$2,'pending')", [id(1), id(12)]);
    await assert.rejects(invoke(a, 12, 'stale-member', q12), /obligations changed/);
    assert.ok((await state(12)).blockers.length);
    const q13 = await quote(13);
    await db.query('UPDATE membership_tier_config SET flat_cost=101 WHERE id=$1', [id(3)]);
    await assert.rejects(invoke(a, 13, 'stale-price', q13), /Structure changed/);
    await db.query('UPDATE membership_tier_config SET flat_cost=100 WHERE id=$1', [id(3)]);
    // Free fixed-date starts work under the untouched legacy constraint.
    await db.query("UPDATE membership_tier_config SET flat_cost=0,start_mode='fixed_date' WHERE id=$1", [id(3)]);
    const freeConfig = (await db.query('SELECT to_jsonb(t) v FROM membership_tier_config t')).rows[0].v;
    const freeRequest = { ...request(14), paymentMode: 'free' };
    const freeQuote = { ...buildStartQuote({ request: freeRequest, config: freeConfig, today }), ownerState: (await state(14)).fingerprint };
    const free = await invoke(a, 14, 'free-start-001', freeQuote, freeRequest);
    const freeRow = (await db.query('SELECT * FROM member_membership_history WHERE id=$1', [free.request.record_id])).rows[0];
    assert.equal(freeRow.payment_status, 'paid'); assert.equal(freeRow.payment_method, null);
    assert.equal(freeRow.commitment_snapshot, null);
    assert.equal(free.request.quote.targetSnapshot.config.start_mode, 'fixed_date');
    // Legacy expiry-only/unverified evidence is never converted to paid history.
    await db.query("INSERT INTO member_membership_history(tenant_id,member_id,payment_status) VALUES($1,$2,'unverified')", [id(1), id(15)]);
    assert.ok((await state(15)).blockers.length);
    await db.query('SET ROLE authenticated');
    await assert.rejects(db.query('SELECT member_start_state($1,$2)', [id(1), id(16)]), /permission denied/);
    await db.query('RESET ROLE');
    await assert.rejects(a.query('DELETE FROM member_membership_start'), /permission denied/);
    await assert.rejects(a.query('SELECT create_member_start($1,$2,$3,$4,$5,$6)', [id(2), id(16), id(4), 'wrong-tenant', request(16), q13]), /not found in tenant/);
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await h.cleanup();
  }
});
