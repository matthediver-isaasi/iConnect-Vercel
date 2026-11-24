import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('roster SQL: partial save, completion, replay, amendment, credentials, closure and tenant scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'purchaser-roster-'));
  const data = join(root, 'db'), socket = join(root, 'socket'); mkdirSync(socket);
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = q => run('psql', ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-qXAt', '-v', 'ON_ERROR_STOP=1'], q);
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tenant = id(1), fulfilment = id(2), sale = id(3), allocation = id(4), event = id(5), slot = id(6);
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(root, 'log'), '-o', `-F -k ${socket} -c listen_addresses=''`, '-w', 'start']); started = true;
    sql(`CREATE EXTENSION pgcrypto; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      CREATE TABLE sales_customer_fulfilment(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid);
      CREATE TABLE sales_commercial_allocation(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,event_reference_kind text,
        event_id uuid,ticket_type_id text,allocated_places integer,ticket_snapshot jsonb,UNIQUE(tenant_id,id));
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,closed boolean DEFAULT false);
      CREATE TABLE complex_event(LIKE event INCLUDING ALL);
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,organization_id uuid,member_id uuid,
        status text,attendee_first_name text,attendee_last_name text,attendee_email text,attendee_phone text,
        attendee_job_title text,booking_reference text,check_in_token text,checked_in_at timestamptz,
        ticket_class_id text,ticket_price numeric,total_cost numeric,payment_method text);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE complex_event_session_checkin(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,booking_id uuid,
        token text,checked_in_at timestamptz);
      CREATE TABLE sales_commercial_allocation_invitation(tenant_id uuid,allocation_id uuid,token_hash bytea,organization_id uuid);
      CREATE TABLE claims(booking_id uuid UNIQUE);
      CREATE FUNCTION resolve_sales_customer_fulfilment(t uuid,h text) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE r jsonb; BEGIN
        SELECT to_jsonb(x) INTO r FROM sales_customer_fulfilment x WHERE tenant_id=t AND h='allowed';
        IF r IS NULL THEN RAISE EXCEPTION 'unavailable'; END IF; RETURN r; END $$;
      CREATE FUNCTION sales_assert_ticket_open(t uuid,k text,e uuid,ti text,f boolean) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS(SELECT 1 FROM event WHERE id=e AND closed) THEN RAISE EXCEPTION 'closed'; END IF; END $$;
      -- These adapters isolate roster orchestration. Existing allocation suites
      -- separately exercise the actual ledger and capacity functions.
      CREATE FUNCTION reserve_sales_customer_delegate(t uuid,h text,a uuid,i text,em text,f text,l text,k text)
        RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO sales_commercial_allocation_invitation VALUES(t,a,decode(i,'hex'),NULL); RETURN '{}'; END $$;
      CREATE FUNCTION claim_sales_allocation_invitation(h text,k text,b uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO claims VALUES(b); RETURN '{}'; END $$;
      CREATE FUNCTION claim_sales_allocation_invitation_with_event_seat(h text,k text,b uuid) RETURNS jsonb LANGUAGE sql AS $$
        SELECT claim_sales_allocation_invitation(h,k,b) $$;
      CREATE FUNCTION sales_capacity_state(text,uuid,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ok":true}'::jsonb $$;
      CREATE FUNCTION event_funnel_counter_is_finite(text,jsonb) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      INSERT INTO sales_customer_fulfilment VALUES('${fulfilment}','${tenant}','${sale}');
      INSERT INTO sales_commercial_allocation VALUES('${allocation}','${tenant}','${sale}','simple','${event}','ticket',2,'{}');
      INSERT INTO event(id,tenant_id) VALUES('${event}','${tenant}');`);
    sql(readFileSync(new URL('../../supabase/migrations/202701240005_sales_purchaser_roster.sql', import.meta.url), 'utf8'));
    const save = (version, command, complete, details, owner = tenant, selectedAllocation = allocation, selectedSlot = slot) => JSON.parse(sql(
      `SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT save_sales_purchaser_slot('${owner}','allowed','${selectedAllocation}','${selectedSlot}',${version},
      '${id(command)}','${JSON.stringify(details)}',${complete},'${'a'.repeat(64)}','{}');`));
    const draft = { first_name: 'A' };
    assert.equal(save(0, 10, false, draft).version, 1);
    assert.equal(sql('SELECT count(*) FROM booking'), '0');
    const details = { first_name: 'A', last_name: 'Person', email: 'person@example.invalid' };
    assert.equal(save(1, 11, true, details).status, 'registered');
    const old = sql('SELECT check_in_token FROM booking');
    assert.equal(save(1, 11, true, details).version, 2, 'same command replays without another claim');
    assert.equal(sql('SELECT count(*) FROM claims'), '1');
    assert.equal(sql('SELECT total_cost FROM booking'), '0');
    assert.throws(() => save(1, 12, true, details), /changed elsewhere/);
    assert.equal(save(2, 13, true, { ...details, first_name: 'Changed' }).version, 3);
    assert.notEqual(sql('SELECT check_in_token FROM booking'), old);
    assert.equal(sql('SELECT count(*) FROM booking'), '1');
    sql(`INSERT INTO complex_event(id,tenant_id) VALUES('${id(70)}','${tenant}');
      INSERT INTO sales_commercial_allocation VALUES('${id(71)}','${tenant}','${sale}','complex','${id(70)}','ticket',2,'{}');`);
    const complexDetails={...details,email:'complex@example.invalid'};
    save(0,72,true,complexDetails,tenant,id(71),id(73));
    const complexBooking=sql('SELECT id FROM complex_event_booking');
    sql(`INSERT INTO complex_event_session_checkin VALUES('${id(74)}','${tenant}','${id(70)}','${complexBooking}','old-session-credential',NULL)`);
    save(1,75,true,{...complexDetails,first_name:'Replacement'},tenant,id(71),id(73));
    assert.notEqual(sql('SELECT token FROM complex_event_session_checkin'),'old-session-credential');
    sql('UPDATE complex_event_session_checkin SET checked_in_at=now()');
    assert.throws(()=>save(2,76,true,complexDetails,tenant,id(71),id(73)),/checked-in/);
    assert.equal(sql('SELECT count(*) FROM complex_event_booking'),'1');
    // A failing shared claim must roll back the new booking, slot and audit.
    sql(`UPDATE event SET closed=false;
      CREATE FUNCTION reject_claim_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'claim unavailable'; END $$;
      CREATE TRIGGER reject_claim_test BEFORE INSERT ON claims FOR EACH ROW EXECUTE FUNCTION reject_claim_test();`);
    assert.throws(()=>save(0,80,true,{...details,email:'rollback@example.invalid'},tenant,allocation,id(81)),/claim unavailable/);
    assert.equal(sql(`SELECT count(*) FROM sales_purchaser_slot WHERE id='${id(81)}'`),'0');
    assert.equal(sql('SELECT count(*) FROM booking'),'1');
    assert.equal(sql('SELECT count(*) FROM claims'), '2');
    assert.equal(sql('SELECT count(*) FROM sales_purchaser_slot_audit'), '5');
    assert.throws(() => save(3, 14, false, details), /completed registration/);
    assert.throws(() => save(3, 14, true, details, id(99)), /unavailable/);
    sql('UPDATE event SET closed=true');
    assert.throws(() => save(3, 14, true, details), /closed/);
    for (const role of ['anon', 'authenticated']) {
      assert.throws(() => sql(`SET ROLE ${role}; SELECT * FROM sales_purchaser_slot`), /permission denied/);
    }
    assert.equal(sql('SELECT count(*) FROM booking'), '1');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
