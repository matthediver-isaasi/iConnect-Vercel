import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('explicit event totals serialize cross-class purchases and preserve legacy and commercial contracts', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('event-total-');
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
  const clients = [];
  let started = false;
  const connect = async () => {
    const c = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    clients.push(c); await c.connect(); return c;
  };
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tenant = uuid(1), event = uuid(2), legacy = uuid(3), allocation = uuid(4);
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    const db = await connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,available_seats integer,
        is_unlimited_registration boolean,is_complex boolean DEFAULT false,pricing_config jsonb);
      CREATE TABLE complex_event(LIKE event INCLUDING ALL);
      CREATE TABLE complex_event_ticket_class(id uuid,tenant_id uuid,complex_event_id uuid,
        available_count integer,is_unlimited_tickets boolean);
      CREATE TABLE booking(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,event_id uuid,
        ticket_class_id text,status text,created_at timestamptz DEFAULT now(),member_id uuid,organization_id uuid,
        attendee_email text,attendee_first_name text,attendee_last_name text,payment_method text,
        stripe_payment_intent_id text);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE sales_commercial_allocation(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,
        event_reference_kind text,event_id uuid,ticket_type_id text);
      CREATE TABLE sales_commercial_allocation_movement(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,
        allocation_id uuid,movement_kind text,places integer);
      CREATE TABLE public_ticket_member_purchase(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,
        event_kind text,booking_ids uuid[] DEFAULT '{}',snapshot jsonb,state text DEFAULT 'prepared',
        stripe_payment_intent_id text,last_error_code text,updated_at timestamptz);
      CREATE FUNCTION normalize_public_ticket_email(text) RETURNS text LANGUAGE sql AS $$ SELECT lower(trim($1)) $$;
    `);
    const commercial = await readFile(new URL('../../supabase/migrations/20260910_sales_commercial_allocation.sql', import.meta.url), 'utf8');
    await db.query(commercial.slice(commercial.indexOf('CREATE VIEW public.sales_commercial_allocation_totals AS'),
      commercial.indexOf('CREATE OR REPLACE FUNCTION public.sales_capacity_state(')));
    for (const name of ['sales_capacity_state', 'check_oneoff_ticket_capacity', 'check_complex_event_ticket_capacity']) {
      const start = commercial.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      await db.query(commercial.slice(start, commercial.indexOf('END $$;', start) + 7));
    }
    await db.query(await readFile(new URL('../../supabase/migrations/20261005122000_public_ticket_member_booking_batch.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('../../supabase/migrations/202701220001_simple_event_total_capacity.sql', import.meta.url), 'utf8'));
    // Historical detached bookings must remain maintainable, not become an
    // accidental total-mode event lookup.
    await db.query("INSERT INTO booking(tenant_id,event_id,status) VALUES($1,$2,'cancelled')",[tenant,uuid(99)]);
    await db.query(`INSERT INTO event(id,tenant_id,available_seats,pricing_config) VALUES
      ($1,$3,146,'{"ticket_classes":[{"id":"A","is_unlimited_tickets":true},{"id":"B","is_unlimited_tickets":true}]}'),
      ($2,$3,146,'{}')`, [event, legacy, tenant]);
    await db.query(`INSERT INTO booking(tenant_id,event_id,status)
      SELECT $1,$2,CASE WHEN n<=118 THEN 'confirmed' ELSE 'cancelled' END FROM generate_series(1,137) n`, [tenant,event]);
    const state = async () => (await db.query('SELECT simple_event_capacity($1) s', [event])).rows[0].s;
    assert.equal((await db.query('SELECT capacity_mode FROM event WHERE id=$1',[event])).rows[0].capacity_mode, 'legacy');
    await db.query("UPDATE event SET capacity_mode='total',total_capacity=146 WHERE id=$1", [event]);
    assert.deepEqual(await state(), {total:146,confirmed:118,commercial_unused:0,used:118,remaining:28});
    assert.equal((await db.query('SELECT available_seats FROM event WHERE id=$1',[legacy])).rows[0].available_seats,146);
    await db.query('UPDATE event SET available_seats=999 WHERE id=$1',[event]);
    assert.equal((await db.query('SELECT available_seats FROM event WHERE id=$1',[event])).rows[0].available_seats,null);
    await db.query('UPDATE event SET total_capacity=100 WHERE id=$1',[event]);
    assert.equal((await state()).remaining,0);
    await assert.rejects(db.query("INSERT INTO booking(tenant_id,event_id,status) VALUES($1,$2,'confirmed')",[tenant,event]),{code:'23514'});
    assert.equal((await state()).confirmed,118);
    await db.query("UPDATE booking SET status='cancelled' WHERE id=(SELECT id FROM booking WHERE event_id=$1 AND status='confirmed' LIMIT 1)",[event]);
    assert.equal((await state()).confirmed,117);
    await db.query('UPDATE event SET total_capacity=146 WHERE id=$1',[event]);
    assert.equal((await state()).remaining,29);
    await db.query("INSERT INTO sales_commercial_allocation VALUES($1,$2,$1,'simple',$3,'A')",[allocation,tenant,event]);
    await db.query("INSERT INTO sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places) VALUES($1,$2,'allocated',3)",[tenant,allocation]);
    assert.equal((await state()).remaining,26);
    // Naming one place and inserting its booking is one transaction, not two places.
    await db.query('BEGIN');
    await db.query("INSERT INTO booking(tenant_id,event_id,status,ticket_class_id) VALUES($1,$2,'confirmed','A')",[tenant,event]);
    await db.query("INSERT INTO sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places) VALUES($1,$2,'named',1)",[tenant,allocation]);
    await db.query('COMMIT');
    assert.equal((await state()).remaining,26);
    await db.query("INSERT INTO sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places) VALUES($1,$2,'released',1)",[tenant,allocation]);
    assert.equal((await state()).remaining,27);
    await db.query('UPDATE event SET total_capacity=NULL WHERE id=$1',[event]);
    assert.equal((await state()).remaining,null);
    await db.query('UPDATE event SET total_capacity=(simple_event_capacity(id)->>\'used\')::integer+1 WHERE id=$1',[event]);
    const row = ticket => ({tenant_id:tenant,event_id:event,status:'confirmed',ticket_class_id:ticket});
    const [a,b] = await Promise.all([connect(),connect()]);
    const race = await Promise.allSettled([a,b].map((c,i) => c.query(
      'SELECT insert_simple_total_booking_batch($1,$2::jsonb)',[event,JSON.stringify([row(i ? 'B':'A')])],
    )));
    assert.equal(race.filter(r => r.status === 'fulfilled').length,1);
    assert.equal(race.find(r => r.status === 'rejected').reason.code,'23514');
    assert.equal((await state()).remaining,0);
    const before = await state();
    // A group batch is fully rolled back, never partially retained.
    await assert.rejects(db.query('SELECT insert_simple_total_booking_batch($1,$2::jsonb)',
      [event,JSON.stringify([row('A'),row('B')])]),{code:'23514'});
    assert.deepEqual(await state(),before);
    await assert.rejects(db.query("INSERT INTO sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places) VALUES($1,$2,'allocated',1)",[tenant,allocation]),{code:'23514'});
    const purchase = uuid(9);
    const snapshot = {booking_items:[{ticket_id:'A',attendees:[{email:'guest@example.invalid',first_name:'Test',last_name:'Guest'}]}]};
    await db.query(`INSERT INTO public_ticket_member_purchase(id,tenant_id,event_id,event_kind,snapshot,stripe_payment_intent_id)
      VALUES($1,$2,$3,'simple',$4,'pi_fixture')`,[purchase,tenant,event,snapshot]);
    const publicRows = [{ticket_class_id:'A',attendee_email:'guest@example.invalid',attendee_first_name:'Test',
      attendee_last_name:'Guest',payment_method:'card',stripe_payment_intent_id:'pi_fixture'}];
    assert.equal((await db.query('SELECT insert_public_ticket_booking_batch($1,$2) s',[purchase,JSON.stringify(publicRows)])).rows[0].s.error,'capacity_unavailable');
    assert.equal((await db.query('SELECT last_error_code FROM public_ticket_member_purchase WHERE id=$1',[purchase])).rows[0].last_error_code,'capacity_refund_pending');
    await db.query('UPDATE event SET total_capacity=total_capacity+1 WHERE id=$1',[event]);
    await db.query("UPDATE public_ticket_member_purchase SET state='prepared' WHERE id=$1",[purchase]);
    const result = (await db.query('SELECT insert_public_ticket_booking_batch($1,$2) s',[purchase,JSON.stringify(publicRows)])).rows[0].s;
    assert.equal(result.length,1);
    assert.deepEqual((await db.query('SELECT insert_public_ticket_booking_batch($1,$2) s',[purchase,JSON.stringify(publicRows)])).rows[0].s,result);
    assert.equal((await state()).remaining,0);
    await db.query("UPDATE booking SET status='cancelled' WHERE id=$1",[result[0].id]);
    assert.equal((await state()).remaining,1);
    assert.equal((await db.query("SELECT has_function_privilege('authenticated','simple_event_capacity(uuid)','EXECUTE') ok")).rows[0].ok,false);
    await assert.rejects(db.query("UPDATE event SET capacity_mode='legacy' WHERE id=$1",[event]));
  } finally {
    await Promise.all(clients.map(c=>c.end()));
    if (started) run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
