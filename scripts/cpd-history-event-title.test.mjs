import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('CPD history resolves missing names without changing ledger evidence or crossing tenants', async () => {
  const h = await createLocalPostgresHarness('cpd-title-');
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const args = ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
  const sql = input => run('psql', args, input);
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'pg.log'), '-o', `-k ${h.socket} -p ${h.port} -h ''`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      CREATE TABLE member(id uuid,tenant_id uuid);
      CREATE TABLE booking(id uuid,tenant_id uuid,event_name text);
      CREATE TABLE complex_event_booking(LIKE booking);
      CREATE TABLE event(id uuid,tenant_id uuid,title text);
      CREATE TABLE complex_event(LIKE event);
      CREATE TABLE member_cpd_points_ledger(id uuid,tenant_id uuid,member_id uuid,
        entry_kind text,points_value numeric,ticket_name_snapshot text,award_trigger text,evidence_type text,
        reason text,reversal_of uuid,created_at timestamptz,activity_date date,activity_title text,
        activity_description text,booking_type text,booking_id uuid,event_type text,event_id uuid,evidence_snapshot jsonb);
      INSERT INTO member VALUES('${id(1)}','${id(2)}');
      INSERT INTO event VALUES('${id(3)}','${id(2)}','Standard event'),('${id(4)}','${id(99)}','Private other tenant');
      INSERT INTO complex_event VALUES('${id(5)}','${id(2)}','Complex event');
      INSERT INTO booking VALUES('${id(6)}','${id(2)}','Saved booking title');
      INSERT INTO complex_event_booking VALUES('${id(7)}','${id(2)}','   ');
      INSERT INTO member_cpd_points_ledger
        (id,tenant_id,member_id,entry_kind,points_value,created_at,event_type,event_id,booking_type,booking_id,activity_title)
      VALUES
        ('${id(10)}','${id(2)}','${id(1)}','event_award',1,'2026-01-01','event','${id(3)}','booking',null,null),
        ('${id(11)}','${id(2)}','${id(1)}','event_award',2,'2026-01-02','complex_event','${id(5)}','complex_event_booking','${id(7)}',' '),
        ('${id(12)}','${id(2)}','${id(1)}','event_award',3,'2026-01-03','event','${id(3)}','booking','${id(6)}',null),
        ('${id(13)}','${id(2)}','${id(1)}','manual_adjustment',4,'2026-01-04','event','${id(3)}','booking','${id(6)}','Saved activity'),
        ('${id(14)}','${id(2)}','${id(1)}','event_award',5,'2026-01-05','event','${id(4)}','booking',null,null),
        ('${id(15)}','${id(2)}','${id(1)}','reversal',-1,'2026-01-06','event','${id(98)}','booking',null,null);
      UPDATE member_cpd_points_ledger SET reversal_of='${id(10)}' WHERE id='${id(15)}';`);
    const original = readFileSync('supabase/migrations/20261118_member_cpd_points_history.sql', 'utf8');
    const migration = readFileSync('supabase/migrations/202701180001_cpd_history_event_title_fallback.sql', 'utf8');
    const read = (tenant = id(2), page = 1, size = 20) => JSON.parse(sql(
      `SET request.jwt.claim.role='service_role'; SELECT COALESCE(get_member_cpd_points_history('${tenant}','${id(1)}',${page},${size}),'null'::jsonb);`).split('\n').at(-1));
    sql(original);
    const before = read();
    const ledgerBefore = sql('select jsonb_agg(to_jsonb(l) order by id) from member_cpd_points_ledger l');
    sql(migration);
    const after = read();
    const names = Object.fromEntries(after.items.map(i => [i.id, i.event_name]));
    assert.deepEqual(names, { [id(15)]: 'Event', [id(14)]: 'Event', [id(13)]: 'Saved activity',
      [id(12)]: 'Saved booking title', [id(11)]: 'Complex event', [id(10)]: 'Standard event' });
    const withoutNames = x => ({ ...x, items: x.items.map(({ event_name, ...rest }) => rest) });
    assert.deepEqual(withoutNames(after), withoutNames(before));
    assert.equal(sql('select jsonb_agg(to_jsonb(l) order by id) from member_cpd_points_ledger l'), ledgerBefore);
    assert.equal(after.items.find(i => i.id === id(10)).is_reversed, true);
    assert.equal(read(id(99)), null);
    assert.deepEqual(read(id(2), 2, 2).items, after.items.slice(2, 4));
    assert.equal(sql(`SELECT has_function_privilege('anon','get_member_cpd_points_history(uuid,uuid,integer,integer)','EXECUTE'),
      has_function_privilege('authenticated','get_member_cpd_points_history(uuid,uuid,integer,integer)','EXECUTE'),
      has_function_privilege('service_role','get_member_cpd_points_history(uuid,uuid,integer,integer)','EXECUTE');`), 'f|f|t');
    const denied = spawnSync('psql', args, { input: `SET request.jwt.claim.role='authenticated'; SELECT get_member_cpd_points_history('${id(2)}','${id(1)}');`, encoding: 'utf8' });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /service_role is required/);
    sql(migration);
    assert.deepEqual(read(), after, 'migration replay is unchanged');
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
