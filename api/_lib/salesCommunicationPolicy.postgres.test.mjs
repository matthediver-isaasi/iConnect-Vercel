import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const migration = name => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const categories = ['agreement_sender', 'agreement_customer', 'invoice', 'customer_fulfilment'];
test('Silent mode SQL: current policy, isolated authority, atomic audit, terminal suppression and concurrent saves',
  { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('silent-mode-');
  const clients = [];
  let started = false;
  const command = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 3; i++) {
      const c = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await c.connect(); clients.push(c);
    }
    const [db, a, b] = clients;
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'service_role') $$;
      CREATE TABLE opportunity(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,version integer DEFAULT 1,updated_at timestamptz);
      CREATE TABLE opportunity_activity(tenant_id uuid,opportunity_id uuid,organization_id uuid,actor_kind text,actor_id uuid,action text,summary text,metadata jsonb);
      CREATE TABLE sales_quote(id uuid PRIMARY KEY,tenant_id uuid,opportunity_id uuid);
      CREATE TABLE sales_commercial_sale(id uuid PRIMARY KEY,tenant_id uuid,opportunity_id uuid);
      CREATE TABLE sales_agreement_envelope(id uuid PRIMARY KEY,tenant_id uuid,quote_id uuid,finalization_status text,sender jsonb,customer jsonb);
      CREATE TABLE sales_agreement_completion_notice(envelope_id uuid,party text,recipient_email text,
        status text DEFAULT 'pending' CONSTRAINT sales_agreement_completion_notice_status_check CHECK(status IN ('pending','sending','sent','failed')),
        attempts integer DEFAULT 0,lease_until timestamptz,sent_at timestamptz,last_error text,PRIMARY KEY(envelope_id,party));
      CREATE TABLE sales_invoice_schedule(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,status text,
        delivery_status text CONSTRAINT sales_invoice_schedule_delivery_status_check CHECK(delivery_status IN ('pending','sending','sent','rejected','attention')),
        delivery_claim_token uuid,delivery_claimed_at timestamptz,last_error jsonb,updated_at timestamptz,
        next_attempt_at timestamptz,delivered_at timestamptz,delivery_message_id text);
      CREATE TABLE sales_customer_fulfilment(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,
        status text CONSTRAINT sales_customer_fulfilment_status_check CHECK(status IN ('pending','sending','sent','attention')),
        lease_token uuid,lease_until timestamptz,revoked_at timestamptz,expires_at timestamptz,
        last_error text,sent_at timestamptz,token_hash text,next_attempt_at timestamptz,attempts integer DEFAULT 0);
      INSERT INTO opportunity(id,tenant_id,organization_id) VALUES('${id(1)}','${id(10)}','${id(20)}'),('${id(2)}','${id(10)}','${id(20)}'),('${id(3)}','${id(11)}','${id(21)}');
      INSERT INTO sales_quote VALUES('${id(30)}','${id(10)}','${id(1)}');
      INSERT INTO sales_commercial_sale VALUES('${id(40)}','${id(10)}','${id(1)}');
      INSERT INTO sales_agreement_envelope VALUES('${id(50)}','${id(10)}','${id(30)}','complete','{"email":"sender@example.test"}','{"email":"customer@example.test"}');
    `);
    await db.query(migration('202701240001_opportunity_silent_mode.sql'));
    const grouped = migration('202610180005_sales_grouped_accounting.sql');
    await db.query(grouped.slice(grouped.indexOf('CREATE OR REPLACE FUNCTION public.claim_sales_schedule_delivery'),
      grouped.indexOf('CREATE OR REPLACE FUNCTION public.finish_sales_schedule_delivery')));
    const fulfilment = migration('202610180008_sales_customer_fulfilment.sql');
    await db.query(fulfilment.slice(fulfilment.indexOf('CREATE FUNCTION public.claim_sales_customer_fulfilment'),
      fulfilment.indexOf('CREATE FUNCTION public.finish_sales_customer_fulfilment')));
    const policy = async (enabled, allowed, expected) => (await db.query(
      'SELECT set_opportunity_silent_mode($1,$2,$3,$4,$5,$6,$7) value',
      [id(10), id(1), expected ?? (await db.query('SELECT version FROM opportunity WHERE id=$1',[id(1)])).rows[0].version,
        enabled, allowed, 'member', id(99)])).rows[0].value;
    const gate = async (category, tenant = id(10), claim = null) => (await db.query(
      'SELECT check_sales_automatic_delivery($1,$2,$3,$4) value',
      [tenant, category, category.startsWith('agreement') ? id(50) : category === 'invoice' ? id(60) : id(70),
        claim ?? (category.startsWith('agreement') ? '1' : id(80))])).rows[0].value;
    const seedClaims = async () => db.query(`
      TRUNCATE sales_agreement_completion_notice,sales_invoice_schedule,sales_customer_fulfilment;
      INSERT INTO sales_agreement_completion_notice(envelope_id,party,recipient_email,status,attempts,lease_until)
        VALUES('${id(50)}','sender','sender@example.test','sending',1,now()+interval '2 minutes'),
          ('${id(50)}','customer','customer@example.test','sending',1,now()+interval '2 minutes');
      INSERT INTO sales_invoice_schedule(id,tenant_id,sale_id,status,delivery_status,delivery_claim_token,delivery_claimed_at)
        VALUES('${id(60)}','${id(10)}','${id(40)}','invoiced','sending','${id(80)}',now());
      INSERT INTO sales_customer_fulfilment(id,tenant_id,sale_id,status,lease_token,lease_until,expires_at,next_attempt_at)
        VALUES('${id(70)}','${id(10)}','${id(40)}','sending','${id(80)}',now()+interval '5 minutes',now()+interval '1 day',now());
    `);
    assert.equal((await db.query('SELECT silent_mode FROM opportunity LIMIT 1')).rows[0].silent_mode, false);
    await seedClaims();
    for (const c of categories) assert.equal(await gate(c), 'permitted', 'default off');
    // Every possible checkbox combination, with work claimed before the edit.
    for (let mask = 0; mask < 16; mask++) {
      await seedClaims();
      const allowed = categories.filter((_, i) => mask & (1 << i));
      const saved = await policy(true, allowed);
      assert.deepEqual(saved.automatic_communications, allowed);
      for (const c of categories) assert.equal(await gate(c), allowed.includes(c) ? 'permitted' : 'suppressed');
    }
    await seedClaims();
    await policy(true, []);
    for (const c of categories) assert.equal(await gate(c), 'suppressed');
    await policy(false, []);
    assert.equal((await db.query('SELECT claim_sales_agreement_completion_notice($1,$2) value',[id(50),'sender'])).rows[0].value, null);
    assert.equal((await db.query('SELECT claim_sales_schedule_delivery($1,$2,$3) value',[id(10),id(60),id(81)])).rows[0].value, false);
    assert.equal((await db.query('SELECT claim_sales_customer_fulfilment($1,$2,$3) value',[id(70),'a'.repeat(64),id(81)])).rows[0].value, null);
    assert.equal((await db.query('SELECT status,delivered_at FROM sales_invoice_schedule')).rows[0].status, 'invoiced');
    assert.equal((await db.query('SELECT sent_at FROM sales_customer_fulfilment')).rows[0].sent_at, null);
    assert.equal((await db.query('SELECT sent_at FROM sales_agreement_completion_notice LIMIT 1')).rows[0].sent_at, null);
    assert.equal((await db.query('SELECT count(*)::int n FROM opportunity WHERE silent_mode')).rows[0].n, 0);
    await policy(true, ['invoice']);
    await policy(false, ['invoice']);
    assert.deepEqual((await policy(true, ['invoice'])).automatic_communications, ['invoice']);
    await assert.rejects(policy(true, ['invoice','invoice']), /Invalid communication policy/);
    await assert.rejects(policy(true, ['unknown']), /Invalid communication policy/);
    await assert.rejects(policy(null, []), /Invalid communication policy/);
    await seedClaims();
    await assert.rejects(gate('invoice',id(11)), /linkage or lease/);
    await assert.rejects(gate('invoice',id(10),id(81)), /linkage or lease/);
    await policy(true,[]);
    // A second opportunity in the same tenant does not inherit this policy.
    await db.query('UPDATE sales_commercial_sale SET opportunity_id=$1',[id(2)]);
    assert.equal(await gate('invoice'),'permitted');
    // A broken cross-tenant opportunity link is never treated as standalone.
    await db.query('UPDATE sales_commercial_sale SET opportunity_id=$1',[id(3)]);
    await assert.rejects(gate('invoice'), /policy unavailable/);
    // A real standalone sale is not a failed lookup.
    await db.query('UPDATE sales_commercial_sale SET opportunity_id=NULL');
    assert.equal(await gate('invoice'), 'permitted');
    await db.query('UPDATE sales_commercial_sale SET opportunity_id=$1',[id(1)]);
    await db.query('DELETE FROM sales_commercial_sale');
    await assert.rejects(gate('invoice'), /linkage or lease/);
    // Both callers loaded the same version: only one save/audit may commit.
    const version = (await db.query('SELECT version FROM opportunity WHERE id=$1',[id(1)])).rows[0].version;
    const args = [id(10),id(1),version,false,[],'member',id(99)];
    await a.query('BEGIN');
    await a.query('SELECT set_opportunity_silent_mode($1,$2,$3,$4,$5,$6,$7)',args);
    const losing = b.query('SELECT set_opportunity_silent_mode($1,$2,$3,$4,$5,$6,$7)',args);
    const rejection = assert.rejects(losing, e => e.code === 'PT409');
    await a.query('COMMIT'); await rejection;
    assert.equal((await db.query('SELECT version FROM opportunity WHERE id=$1',[id(1)])).rows[0].version, version+1);
    // Audit failure rolls the policy back.
    await db.query(`ALTER TABLE opportunity_activity ADD CONSTRAINT reject_test_audit CHECK(action<>'opportunity.silent_mode.updated') NOT VALID`);
    await assert.rejects(policy(true, []), /reject_test_audit/);
    assert.equal((await db.query('SELECT version FROM opportunity WHERE id=$1',[id(1)])).rows[0].version, version+1);
    await db.query('ALTER TABLE opportunity_activity DROP CONSTRAINT reject_test_audit');
    await policy(true,[]);
    await seedClaims();
    await db.query(`INSERT INTO sales_commercial_sale VALUES('${id(40)}','${id(10)}','${id(1)}');
      ALTER TABLE opportunity_activity ADD CONSTRAINT reject_suppression CHECK(action<>'sales.communication.suppressed') NOT VALID`);
    await assert.rejects(gate('invoice'), /reject_suppression/);
    assert.equal((await db.query('SELECT delivery_status FROM sales_invoice_schedule')).rows[0].delivery_status,'sending',
      'failed audit must not commit terminal suppression');
    await db.query("SET request.jwt.claim.role='authenticated'");
    await assert.rejects(gate('invoice'), /service role required/);
    await assert.rejects(policy(false,[]), /service role required/);
    for (const role of ['anon','authenticated']) {
      assert.equal((await db.query("SELECT has_function_privilege($1,'public.check_sales_automatic_delivery(uuid,text,uuid,text)','EXECUTE') ok",[role])).rows[0].ok, false);
      assert.equal((await db.query("SELECT has_function_privilege($1,'public.set_opportunity_silent_mode(uuid,uuid,integer,boolean,text[],text,uuid)','EXECUTE') ok",[role])).rows[0].ok, false);
    }
  } finally {
    for (const c of clients) await c.end();
    if (started) command('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
