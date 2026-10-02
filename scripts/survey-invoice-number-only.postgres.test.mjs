import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('real PostgreSQL: number-only exception preserves confirmations; every other booking change invalidates', async () => {
  const h = await createLocalPostgresHarness('survey-number-only-');
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = text => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres',
    '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At'], text);
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE booking(id integer PRIMARY KEY, tenant_id text DEFAULT 'tenant',
        xero_invoice_number text DEFAULT 'old', accounting_invoice_number text,
        xero_invoice_id text DEFAULT 'immutable-provider', total numeric DEFAULT 166.67,
        purchaser_context jsonb DEFAULT '{"email":"offline@example.test"}', status text DEFAULT 'confirmed',
        survey_invitation_revision bigint DEFAULT 7, future_column text);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE member(id integer PRIMARY KEY, email text DEFAULT 'offline@example.test',
        tenant_id text DEFAULT 'tenant', login_enabled boolean DEFAULT true,
        membership_paused boolean DEFAULT false, survey_invitation_revision bigint DEFAULT 7);
      CREATE TABLE certificate_survey_entitlement(id integer PRIMARY KEY, booking_id integer,
        booking_source text, tenant_id text DEFAULT 'tenant', recipient_email text DEFAULT 'offline@example.test',
        assignment_id integer DEFAULT 1, revoked_at timestamptz, completed_at timestamptz,
        expires_at timestamptz, survey_invitation_revision bigint DEFAULT 7);
      CREATE TABLE survey_invitation_attendee(entitlement_id integer, member_id integer,
        confirmed_at text DEFAULT 'original-confirmation', booking_fingerprint text DEFAULT 'original-fingerprint');`);
    const original = readFileSync(new URL('../supabase/migrations/20261125_survey_invitation_attendee.sql', import.meta.url), 'utf8');
    for (const fn of ['bump_survey_invitation_revision', 'invalidate_survey_invitation_attendee']) {
      const start = original.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}()`);
      sql(original.slice(start, original.indexOf(`REVOKE ALL ON FUNCTION public.${fn}()`, start)));
    }
    for (const table of ['booking', 'complex_event_booking', 'member', 'certificate_survey_entitlement']) {
      sql(`CREATE TRIGGER survey_invitation_revision BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION bump_survey_invitation_revision();
        CREATE TRIGGER invalidation AFTER UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION invalidate_survey_invitation_attendee();`);
    }
    const reset = (table = 'booking') => {
      sql(`TRUNCATE booking,complex_event_booking,member,certificate_survey_entitlement,survey_invitation_attendee;
        INSERT INTO ${table}(id) VALUES(1);
        INSERT INTO member(id) VALUES(1);
        INSERT INTO certificate_survey_entitlement(id,booking_id,booking_source)
          VALUES(1,1,'${table === 'booking' ? 'standard' : 'complex'}');
        INSERT INTO survey_invitation_attendee(entitlement_id,member_id) VALUES(1,1);`);
    };
    reset();
    sql("UPDATE booking SET xero_invoice_number='new'");
    assert.equal(sql('SELECT survey_invitation_revision FROM booking'), '8');
    assert.equal(sql('SELECT count(*) FROM survey_invitation_attendee'), '0', 'reproduces old unwanted invalidation');
    sql(readFileSync(new URL('../supabase/migrations/202612030001_survey_invoice_number_only.sql', import.meta.url), 'utf8'));
    for (const table of ['booking', 'complex_event_booking']) {
      for (const assignment of ["xero_invoice_number='new'", "accounting_invoice_number='new'",
        "xero_invoice_number=NULL", "xero_invoice_number='new',accounting_invoice_number='new'"]) {
        reset(table);
        const confirmation = sql('SELECT to_jsonb(a) FROM survey_invitation_attendee a');
        const before = sql(`SELECT to_jsonb(b)-ARRAY['xero_invoice_number','accounting_invoice_number'] FROM ${table} b`);
        sql(`UPDATE ${table} SET ${assignment}`);
        assert.equal(sql(`SELECT to_jsonb(b)-ARRAY['xero_invoice_number','accounting_invoice_number'] FROM ${table} b`), before);
        assert.equal(sql('SELECT to_jsonb(a) FROM survey_invitation_attendee a'), confirmation);
      }
      for (const assignment of ["total=200", "status='cancelled'", "purchaser_context='{}'",
        "xero_invoice_id='different'", "tenant_id='different'", "future_column='changed'",
        "xero_invoice_number='new',total=200", "xero_invoice_number=xero_invoice_number",
        "xero_invoice_number='new',survey_invitation_revision=0"]) {
        reset(table);
        sql(`UPDATE ${table} SET ${assignment}`);
        assert.equal(sql(`SELECT survey_invitation_revision FROM ${table}`), '8', assignment);
        assert.equal(sql('SELECT count(*) FROM survey_invitation_attendee'), '0', assignment);
      }
      reset(table);
      sql(`DELETE FROM ${table}`);
      assert.equal(sql('SELECT count(*) FROM survey_invitation_attendee'), '0');
    }
    for (const statement of ["UPDATE member SET email='changed@example.test'", 'DELETE FROM member',
      "UPDATE certificate_survey_entitlement SET revoked_at=now()", 'DELETE FROM certificate_survey_entitlement']) {
      reset();
      sql(statement);
      assert.equal(sql('SELECT count(*) FROM survey_invitation_attendee'), '0', statement);
    }
    reset();
    sql('UPDATE certificate_survey_entitlement SET expires_at=now()');
    assert.equal(sql('SELECT count(*) FROM survey_invitation_attendee'), '1', 'resend exception retained');
    assert.equal(sql(`SELECT prosecdef AND proconfig=ARRAY['search_path=public'] FROM pg_proc
      WHERE oid='public.invalidate_survey_invitation_attendee()'::regprocedure`), 't');
    assert.equal(sql("SELECT has_function_privilege('anon','bump_survey_invitation_revision()','EXECUTE')"), 'f');
    // Exercise the actual deployed recovery immutability and no-op mirror
    // functions too: changing the permitted display mirror cannot touch booking
    // authority or the immutable checkout financial snapshot.
    sql(`ALTER TABLE booking ADD COLUMN booking_group_reference text DEFAULT 'group';
      ALTER TABLE booking ADD COLUMN invoice_recovery_status text DEFAULT 'complete';
      ALTER TABLE booking ADD COLUMN invoice_recovery_next_attempt_at timestamptz;
      CREATE TABLE event_invoice_recovery(id integer PRIMARY KEY, tenant_id text DEFAULT 'tenant',
        source text DEFAULT 'booking', booking_group_reference text DEFAULT 'group',
        snapshot jsonb DEFAULT '{"amount":166.67}', connection_id text DEFAULT 'connection',
        xero_tenant_id text DEFAULT 'provider', settlement_payment_intent_id text DEFAULT 'payment',
        invoice_number text DEFAULT 'old', invoice_id text DEFAULT 'original-invoice',
        payment_id text DEFAULT 'original-payment', status text DEFAULT 'complete',
        reason_code text, next_attempt_at timestamptz, updated_at timestamptz);
      CREATE TABLE event_invoice_recovery_historical_evidence(operation_id integer,state text,snapshot jsonb);`);
    for (const [file, fn] of [
      ['202611300002_event_invoice_recovery_historical.sql', 'event_invoice_recovery_immutable'],
      ['202611300005_event_invoice_survey_revision_fencing.sql', 'event_invoice_recovery_mirror'],
    ]) {
      const source = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
      const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}()`);
      const end = source.indexOf('END $$;', start);
      assert.ok(start >= 0 && end >= start);
      sql(source.slice(start, end + 'END $$;'.length));
    }
    sql(`CREATE TRIGGER immutable BEFORE UPDATE ON event_invoice_recovery
      FOR EACH ROW EXECUTE FUNCTION event_invoice_recovery_immutable();
      CREATE TRIGGER mirror AFTER UPDATE ON event_invoice_recovery
      FOR EACH ROW EXECUTE FUNCTION event_invoice_recovery_mirror();`);
    reset();
    sql('INSERT INTO event_invoice_recovery(id) VALUES(1)');
    const bookingBefore = sql('SELECT to_jsonb(b) FROM booking b');
    const recoveryBefore = sql("SELECT to_jsonb(r)-'invoice_number' FROM event_invoice_recovery r");
    const confirmationBefore = sql('SELECT to_jsonb(a) FROM survey_invitation_attendee a');
    sql("UPDATE event_invoice_recovery SET invoice_number='INV-offline'");
    assert.equal(sql('SELECT to_jsonb(b) FROM booking b'), bookingBefore);
    assert.equal(sql("SELECT to_jsonb(r)-'invoice_number' FROM event_invoice_recovery r"), recoveryBefore);
    assert.equal(sql('SELECT to_jsonb(a) FROM survey_invitation_attendee a'), confirmationBefore);
    sql(`DO $$ BEGIN
      BEGIN
        UPDATE event_invoice_recovery SET snapshot='{"amount":200}';
        RAISE EXCEPTION 'test_expected_immutability_rejection_missing';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'Recovery identity and snapshot are immutable' THEN RAISE; END IF;
      END;
    END $$;`);
    assert.equal(sql("SELECT to_jsonb(r)-'invoice_number' FROM event_invoice_recovery r"), recoveryBefore);
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});