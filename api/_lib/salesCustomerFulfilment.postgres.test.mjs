import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('disposable PostgreSQL: forward-only enqueue, immutable recipient, activation, leases, tenant scope, replay and actual invitation capacity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fulfilment-sql-'));
  const data = join(dir, 'db'), socket = join(dir, 'socket');
  mkdirSync(socket);
  const run = (cmd, args, input) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const sql = query => run('psql', ['-h', socket, '-p', '55468', '-U', 'postgres', '-d', 'postgres', '-qXAt', '-v', 'ON_ERROR_STOP=1'], query);
  const service = query => sql(`SET ROLE service_role; SET request.jwt.claim.role='service_role'; ${query}`);
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tenant = id(1), sale = id(2), version = id(3), allocation = id(4), opportunity = id(5), org = id(6);
  const hash = 'a'.repeat(64), lease = id(8);
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-F -k ${socket} -p 55468 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      GRANT USAGE ON SCHEMA auth TO service_role;
      CREATE TABLE sales_commercial_sale(id uuid PRIMARY KEY,tenant_id uuid,quote_version_id uuid,opportunity_id uuid,UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_version(id uuid PRIMARY KEY,tenant_id uuid,customer_contact_snapshot jsonb);
      CREATE TABLE sales_quote_customer_decision(tenant_id uuid,quote_version_id uuid,decision text,token_id uuid,customer_name text);
      CREATE TABLE sales_quote_delivery_token(id uuid,tenant_id uuid,recipient_email text);
      CREATE TABLE sales_commercial_allocation(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,event_reference_kind text,event_id uuid,ticket_type_id text);
      CREATE TABLE opportunity(id uuid,tenant_id uuid,organization_id uuid);
      CREATE TABLE sales_commercial_allocation_manager(id uuid,tenant_id uuid,allocation_id uuid,organization_id uuid,member_id uuid,revoked_at timestamptz);
      CREATE TABLE sales_commercial_allocation_invitation(
        id uuid DEFAULT gen_random_uuid(),tenant_id uuid,allocation_id uuid,manager_id uuid,organization_id uuid,
        token_hash bytea,delegate_email text,delegate_first_name text,delegate_last_name text,expires_at timestamptz,
        idempotency_key text,actor_kind text,actor_id uuid,claimed_at timestamptz,released_at timestamptz);
      CREATE TABLE sales_commercial_allocation_movement(
        tenant_id uuid,allocation_id uuid,movement_kind text,places integer,idempotency_key text,actor_kind text,actor_id uuid,metadata jsonb);
      CREATE VIEW sales_commercial_allocation_totals AS SELECT a.id allocation_id,
        0 named, 1 remaining, COALESCE((SELECT sum(CASE WHEN m.movement_kind='reserved' THEN places ELSE -places END)
        FROM sales_commercial_allocation_movement m WHERE m.allocation_id=a.id),0) reserved
        FROM sales_commercial_allocation a;
      CREATE FUNCTION transition_sales_quote(uuid,uuid,integer,text,text,text,text) RETURNS void LANGUAGE plpgsql AS $$
        BEGIN RETURN; /* IF p_status='accepted' AND v.billing_schedule IS NOT NULL THEN */ END $$;
      INSERT INTO sales_commercial_sale VALUES('${sale}','${tenant}','${version}','${opportunity}');
      INSERT INTO sales_quote_version VALUES('${version}','${tenant}','{"email":"frozen@example.test","name":"Customer"}');
      INSERT INTO opportunity VALUES('${opportunity}','${tenant}','${org}');
      INSERT INTO sales_commercial_allocation VALUES('${id(20)}','${tenant}','${sale}','simple','${id(10)}','ticket');
    `);
    const hardening = readFileSync(new URL('../../supabase/migrations/20260913_sales_concurrency_hardening.sql', import.meta.url), 'utf8');
    const reserve = hardening.slice(hardening.indexOf('CREATE OR REPLACE FUNCTION public.reserve_sales_allocation_invitation'),
      hardening.indexOf('CREATE OR REPLACE FUNCTION public.claim_sales_allocation_invitation'));
    sql(reserve);
    sql(readFileSync(new URL('../../supabase/migrations/202610180008_sales_customer_fulfilment.sql', import.meta.url), 'utf8'));
    assert.equal(sql('SELECT count(*) FROM sales_customer_fulfilment'), '0', 'no backfill');
    sql(`INSERT INTO sales_commercial_allocation VALUES('${allocation}','${tenant}','${sale}','complex','${id(11)}','ticket')`);
    const fulfilment = sql('SELECT id FROM sales_customer_fulfilment');
    assert.equal(sql('SELECT customer_email FROM sales_customer_fulfilment'), 'frozen@example.test');
    assert.throws(() => sql(`UPDATE sales_customer_fulfilment SET customer_email='changed@example.test'`), /immutable/);
    const resolve = (t = tenant, h = hash) => service(`SELECT resolve_sales_customer_fulfilment('${t}','${h}')`);
    service(`SELECT claim_sales_customer_fulfilment('${fulfilment}','${hash}','${lease}')`);
    assert.throws(() => resolve(), /unavailable/, 'not active before durable delivery');
    assert.equal(service(`SELECT claim_sales_customer_fulfilment('${fulfilment}','${hash}','${id(9)}') IS NULL`), 't');
    assert.equal(service(`SELECT finish_sales_customer_fulfilment('${fulfilment}','${id(9)}','sent')`), 'f');
    service(`SELECT finish_sales_customer_fulfilment('${fulfilment}','${lease}','pending')`);
    sql('UPDATE sales_customer_fulfilment SET next_attempt_at=now()');
    service(`SELECT claim_sales_customer_fulfilment('${fulfilment}','${hash}','${lease}')`);
    service(`SELECT finish_sales_customer_fulfilment('${fulfilment}','${lease}','sent')`);
    assert.equal(JSON.parse(resolve()).customer_email, 'frozen@example.test');
    assert.throws(() => resolve(id(99)), /unavailable/);
    assert.throws(() => resolve(tenant, 'b'.repeat(64)), /unavailable/);
    const invite = (key, email = 'delegate@example.test', a = allocation) => service(`SELECT reserve_sales_customer_delegate(
      '${tenant}','${hash}','${a}','${'c'.repeat(64)}','${email}','First','Last','${key}')`);
    assert.ok(JSON.parse(invite('once')).invitationId);
    assert.equal(JSON.parse(invite('once')).replayed, true);
    assert.throws(() => invite('once', 'different@example.test'), /another delegate/);
    assert.throws(() => invite('twice'), /no remaining places/);
    assert.throws(() => invite('other', 'delegate@example.test', id(99)), /Allocation not found/);
    sql(`INSERT INTO sales_commercial_sale VALUES('${id(40)}','${id(41)}','${version}','${opportunity}');
      INSERT INTO sales_commercial_allocation VALUES('${id(42)}','${id(41)}','${id(40)}','simple','${id(43)}','ticket')`);
    assert.throws(() => invite('cross-tenant', 'delegate@example.test', id(42)), /Allocation not found/);
    // Replays cannot reuse a reservation after it has been consumed.
    sql('UPDATE sales_commercial_allocation_invitation SET claimed_at=now()');
    assert.throws(() => invite('once'), /no longer reusable/);
    // Expired tokens cannot activate or reserve even if the provider once sent.
    sql(`INSERT INTO sales_commercial_sale VALUES('${id(30)}','${tenant}','${version}','${opportunity}');
      INSERT INTO sales_customer_fulfilment(tenant_id,sale_id,token_hash,expires_at,status,sent_at)
      VALUES('${tenant}','${id(30)}','${'d'.repeat(64)}',now()-interval '1 second','sent',now())`);
    assert.throws(() => resolve(tenant, 'd'.repeat(64)), /unavailable/);
    sql('UPDATE sales_customer_fulfilment SET revoked_at=now()');
    assert.throws(() => resolve(), /unavailable/);
    assert.throws(() => sql(`SET ROLE anon; SELECT resolve_sales_customer_fulfilment('${tenant}','${hash}')`), /permission denied/);
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
