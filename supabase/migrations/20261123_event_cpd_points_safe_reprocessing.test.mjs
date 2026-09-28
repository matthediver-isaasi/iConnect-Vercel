import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const baseline = readFileSync(new URL('./20261012_event_cpd_points_awards.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('./20261123_event_cpd_points_safe_reprocessing.sql', import.meta.url), 'utf8');
const id = n => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const tenant = id(1), other = id(2), member = id(3), event = id(4), complex = id(5);
const lit = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role';";
test('safe CPD reprocessing executes as service_role against isolated PostgreSQL', { timeout: 90000 }, async t => {
  const h = await createLocalPostgresHarness('cpd-reprocessing-');
  const args = ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  const run = (command, argv, input) => {
    const r = spawnSync(command, argv, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = input => run('psql', args, input);
  const call = input => JSON.parse(sql(service + input));
  const fails = (input, pattern) => {
    const r = spawnSync('psql', args, { input: service + input, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'expected rejection');
    assert.match(r.stderr, pattern);
  };
  const scope = (booking, source = 'standard', ev = event) => ({ mode: 'selected', registrations: [
    { booking_id: booking, booking_source: source, event_id: ev },
  ] });
  const preview = value => call(`SELECT preview_event_cpd_points_reprocessing('${tenant}',${lit(value)});`);
  const confirm = (value, digest, request = id(900), reason = 'Recover missing award') => call(
    `SELECT confirm_event_cpd_points_reprocessing('${tenant}','admin:test',${lit(value)},'${digest}','${reason}','${request}');`);
  const result = request => call(`SELECT event_cpd_points_reprocessing_results('${tenant}','${request}',1,50);`);
  const loadAttempt = request => JSON.parse(sql(`SELECT
    jsonb_build_object('tenant_id',o.tenant_id,'idempotency_key',o.idempotency_key,
      'booking_type',o.booking_type,'booking_id',o.booking_id,'event_type',i.approved->>'event_type',
      'member_id',i.approved->>'member_id','status','awarded','trigger_type',o.trigger_type,
      'evidence_type',o.evidence_type,'evidence_id',o.evidence_id,'evidence_snapshot',o.evidence_snapshot)
    FROM event_cpd_points_reprocessing_item i JOIN event_cpd_points_outbox o
      ON i.tenant_id=o.tenant_id AND i.idempotency_key=o.idempotency_key WHERE i.replay_id='${request}';`));
  const process = request => call(`SELECT to_jsonb(record_event_cpd_points_award(${lit(loadAttempt(request))}));`);
  const concurrent = input => new Promise((resolve, reject) => {
    const child = spawn('psql', args);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr)));
    child.stdin.end(service + input);
  });
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,pricing_config jsonb);
      CREATE TABLE complex_event(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,name text);
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,status text,attendee_email text,member_id uuid,
        attendee_first_name text,attendee_last_name text,ticket_class_id text,ticket_class_name text,
        checked_in_at timestamptz,check_in_reversed_at timestamptz,check_in_reversal_reason text);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE complex_event_session(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid);
      CREATE TABLE complex_event_session_checkin(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,
        booking_id uuid,session_id uuid,checked_in_at timestamptz,check_in_reversed_at timestamptz,check_in_reversal_reason text);
      CREATE TABLE attendance_target(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,tracking_enabled boolean);
      CREATE TABLE attendance_current_outcome(tenant_id uuid,provider text,attendance_target_id uuid,
        booking_type text,booking_id uuid,status text,outcome_revision_id uuid);
      CREATE TABLE attendance_outcome_transition(id uuid PRIMARY KEY);
      INSERT INTO tenant VALUES('${tenant}'),('${other}');
      INSERT INTO member VALUES('${member}','${tenant}','member@example.invalid');
      INSERT INTO event VALUES('${event}','${tenant}','{"ticket_classes":[{"id":"ticket","name":"Ticket"},{"id":"none","name":"None"},{"id":"online","name":"Online"}]}');
      INSERT INTO complex_event VALUES('${complex}','${tenant}');
    `);
    sql(baseline);
    sql(`BEGIN; ${migration} COMMIT;`);
    sql(`BEGIN; ${migration} COMMIT;`);
    // Fixture inserts are separate from previews; normal booking triggers queue
    // automatic jobs, so dry-run checks compare before/after counts.
    sql(`INSERT INTO booking(id,tenant_id,event_id,status,attendee_email,attendee_first_name)
      SELECT ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'${tenant}','${event}',
        CASE n WHEN 12 THEN 'cancelled' ELSE 'confirmed' END,
        CASE n WHEN 13 THEN 'unmatched@example.invalid' ELSE 'member@example.invalid' END,'Attendee'
      FROM generate_series(10,119) n;
      INSERT INTO complex_event_booking(id,tenant_id,event_id,status,attendee_email)
      VALUES('${id(200)}','${tenant}','${complex}','confirmed','member@example.invalid');`);
    sql(service + `SELECT replace_event_cpd_points_rules('${tenant}','event','${event}',
      '[{"trigger_type":"registration","points_value":"0.100001"}]');
      SELECT replace_event_cpd_points_rules('${tenant}','complex_event','${complex}',
      '[{"trigger_type":"attendance","points_value":"1.500000"}]');`);

    await t.test('bounded resumable dry run has no business writes; totals count unique registrations', () => {
      const counts = () => sql(`SELECT (SELECT count(*) FROM member_cpd_points_ledger)||':'||
        (SELECT count(*) FROM event_cpd_points_award_attempt)||':'||(SELECT count(*) FROM event_cpd_points_outbox)||':'||
        (SELECT count(*) FROM event_cpd_points_reprocessing_run);`);
      const before = counts();
      const all = { mode: 'all_event', event_id: event, event_type: 'simple' };
      const first = preview(all);
      assert.equal(first.rows.length, 100);
      assert.equal(first.complete, false);
      const second = call(`SELECT preview_event_cpd_points_reprocessing('${tenant}',${lit(all)},
        '${first.after}','${first.digest}',${first.totals.registrations},${first.totals.eligible},${first.totals.proposed_points});`);
      assert.equal(second.complete, true);
      assert.equal(second.totals.registrations, 110);
      assert.equal(second.totals.eligible, 108);
      assert.equal(second.totals.proposed_points, '10.800108');
      assert.equal(counts(), before);
      assert.equal(preview(scope(id(12))).rows[0].outcome, 'ineligible');
      assert.equal(preview(scope(id(13))).rows[0].outcome, 'unmatched_member');
    });
    await t.test('confirmation is durable/idempotent and only worker creates actual ledger award', () => {
      const value = scope(id(10)), p = preview(value);
      const run = confirm(value, p.digest);
      assert.equal(run.enqueued_count, 1);
      assert.deepEqual(confirm(value, p.digest), run);
      assert.equal(result(run.replay_id).totals.pending, 1);
      const awarded = process(run.replay_id);
      assert.equal(awarded.status, 'awarded');
      assert.equal(process(run.replay_id).id, awarded.id);
      assert.equal(result(run.replay_id).totals.awarded, 1);
      assert.equal(result(run.replay_id).totals.awarded_points, '0.100001');
      assert.equal(preview(value).rows[0].outcome, 'already_awarded');
      fails(`SELECT confirm_event_cpd_points_reprocessing('${tenant}','admin:other',${lit(value)},'${p.digest}','Recover missing award','${run.replay_id}');`, /identity conflict/);
    });
    await t.test('stale rule previews fail confirmation; post-confirm changes require renewed review', () => {
      const value = scope(id(11)), p = preview(value);
      sql(service + `SELECT replace_event_cpd_points_rules('${tenant}','event','${event}',
        '[{"trigger_type":"registration","points_value":"2"}]');`);
      fails(`SELECT confirm_event_cpd_points_reprocessing('${tenant}','admin:test',${lit(value)},'${p.digest}','Recovery','${id(901)}');`, /preview stale/);
      const fresh = preview(value);
      confirm(value, fresh.digest, id(901));
      sql(service + `SELECT replace_event_cpd_points_rules('${tenant}','event','${event}',
        '[{"trigger_type":"registration","points_value":"3"}]');`);
      assert.equal(process(id(901)).status, 'skipped_not_qualifying');
      assert.equal(result(id(901)).totals.unchanged, 1);
      assert.match(result(id(901)).rows[0].detail, /needs_review/);
    });
    await t.test('complex QR evidence, duplicate evidence and reversed checkins', () => {
      const value = scope(id(200), 'complex', complex);
      assert.equal(preview(value).rows[0].outcome, 'missing_attendance');
      sql(`INSERT INTO complex_event_session VALUES('${id(300)}','${tenant}','${complex}');
        INSERT INTO complex_event_session_checkin(id,tenant_id,complex_event_id,booking_id,session_id,checked_in_at)
        VALUES('${id(301)}','${tenant}','${complex}','${id(200)}','${id(300)}',now()),
          ('${id(302)}','${tenant}','${complex}','${id(200)}','${id(300)}',now());`);
      const p = preview(value);
      assert.equal(p.totals.registrations, 1);
      assert.equal(p.totals.proposed_points, '1.500000');
      confirm(value, p.digest, id(902));
      assert.equal(process(id(902)).status, 'awarded');
      sql(`UPDATE complex_event_session_checkin SET check_in_reversed_at=now()+interval '1 minute' WHERE id='${id(301)}';`);
      assert.equal(preview(value).rows[0].outcome, 'already_awarded', 'reversal never reopens positive award recovery');
    });
    await t.test('no-award ticket replaces event-wide rule and attendance trigger is derived', () => {
      sql(`UPDATE booking SET ticket_class_id='none' WHERE id='${id(14)}';
        UPDATE booking SET ticket_class_id='online' WHERE id='${id(15)}';`);
      sql(service + `SELECT replace_event_cpd_points_rules('${tenant}','event','${event}', '[
        {"trigger_type":"registration","points_value":"3"},
        {"ticket_id":"none","trigger_type":"registration","is_no_award":true},
        {"ticket_id":"online","trigger_type":"attendance","points_value":"4"}]');`);
      assert.equal(preview(scope(id(14))).rows[0].outcome, 'no_award');
      const online = preview(scope(id(15))).rows[0];
      assert.equal(online.trigger, 'attendance');
      assert.equal(online.outcome, 'missing_attendance');
      sql(`INSERT INTO attendance_target VALUES('${id(400)}','${tenant}','${event}',true);
        INSERT INTO attendance_current_outcome VALUES('${tenant}','teams','${id(400)}','booking','${id(15)}','attended','${id(401)}');`);
      const p = preview(scope(id(15)));
      confirm(scope(id(15)), p.digest, id(903));
      sql(`UPDATE attendance_current_outcome SET status='absent' WHERE booking_id='${id(15)}';`);
      assert.equal(process(id(903)).status, 'skipped_not_qualifying');
    });
    await t.test('retry/dead results, result pagination and tenant/security isolation', () => {
      const value = scope(id(16)), p = preview(value);
      confirm(value, p.digest, id(904));
      sql(`UPDATE event_cpd_points_outbox SET status='retry',attempts=1,last_error='provider temporarily unavailable'
        WHERE idempotency_key LIKE 'reviewed:${id(904)}:%';`);
      assert.equal(result(id(904)).totals.retrying, 1);
      sql(`UPDATE event_cpd_points_outbox SET status='dead' WHERE idempotency_key LIKE 'reviewed:${id(904)}:%';`);
      assert.equal(result(id(904)).totals.failed, 1);
      assert.equal(result(id(904)).complete, true);
      fails(`SELECT event_cpd_points_reprocessing_results('${other}','${id(904)}',1,50);`, /not found/);
      fails(`SELECT preview_event_cpd_points_reprocessing('${other}',${lit(value)});`, /not found/);
      fails(`SET ROLE authenticated; SELECT preview_event_cpd_points_reprocessing('${tenant}',${lit(value)});`, /permission denied/);
      fails(`SELECT record_event_cpd_points_award_unreviewed('{}');`, /permission denied/);
      fails(`UPDATE event_cpd_points_reprocessing_run SET reason='changed';`, /permission denied/);
    });
    await t.test('concurrent automatic processing and confirmed replay produce one positive award', async () => {
      const value = scope(id(17)), p = preview(value);
      confirm(value, p.digest, id(905));
      const replayAttempt = loadAttempt(id(905));
      const autoAttempt = { ...replayAttempt, idempotency_key: 'automatic-concurrency-test' };
      const results = await Promise.all([replayAttempt, autoAttempt].map(attempt =>
        concurrent(`SELECT to_jsonb(record_event_cpd_points_award(${lit(attempt)}));`)));
      assert.deepEqual(results.map(row => row.status).sort(), ['already_awarded', 'awarded']);
      assert.equal(sql(`SELECT count(*) FROM member_cpd_points_ledger WHERE booking_id='${id(17)}' AND entry_kind='event_award';`), '1');
      assert.equal(result(id(905)).totals.pending, 0);
    });
    await t.test('mixed-source scope preserves source identity and concurrent confirmations reuse one run', async () => {
      sql(`INSERT INTO complex_event_booking(id,tenant_id,event_id,status,attendee_email)
        VALUES('${id(18)}','${tenant}','${complex}','confirmed','member@example.invalid');`);
      const mixed = { mode: 'selected', registrations: [
        ...scope(id(18)).registrations, ...scope(id(18), 'complex', complex).registrations,
      ] };
      const p = preview(mixed);
      assert.equal(p.rows.length, 2);
      assert.equal(p.totals.registrations, 2);
      assert.equal(p.totals.eligible, 1);
      const statement = `SELECT confirm_event_cpd_points_reprocessing('${tenant}','admin:test',
        ${lit(mixed)},'${p.digest}','Recovery','${id(907)}');`;
      const runs = await Promise.all([concurrent(statement), concurrent(statement)]);
      assert.deepEqual(runs[0], runs[1]);
      assert.equal(runs[0].enqueued_count, 1);
      const reopened = result(id(907));
      assert.equal(reopened.rows.length, 2);
      assert.equal(reopened.totals.pending, 1);
      assert.equal(reopened.totals.unchanged, 1);
    });
    await t.test('all-event confirmation detects added rows, and reopened results paginate the complete immutable scope', () => {
      const all = { mode: 'all_event', event_id: event, event_type: 'simple' };
      const fullPreview = () => {
        const a = preview(all);
        return call(`SELECT preview_event_cpd_points_reprocessing('${tenant}',${lit(all)},
          '${a.after}','${a.digest}',${a.totals.registrations},${a.totals.eligible},${a.totals.proposed_points});`);
      };
      const old = fullPreview();
      sql(`INSERT INTO booking(id,tenant_id,event_id,status,attendee_email)
        VALUES('${id(120)}','${tenant}','${event}','confirmed','member@example.invalid');`);
      fails(`SELECT confirm_event_cpd_points_reprocessing('${tenant}','admin:test',${lit(all)},
        '${old.digest}','Recovery','${id(906)}');`, /preview stale/);
      const p = fullPreview();
      assert.equal(p.totals.registrations, 111);
      confirm(all, p.digest, id(906));
      const first = result(id(906));
      const second = call(`SELECT event_cpd_points_reprocessing_results('${tenant}','${id(906)}',2,50);`);
      const third = call(`SELECT event_cpd_points_reprocessing_results('${tenant}','${id(906)}',3,50);`);
      assert.equal(first.total, 111);
      assert.equal(first.rows.length, 50);
      assert.equal(second.rows.length, 50);
      assert.equal(third.rows.length, 11);
      assert.equal(new Set([...first.rows, ...second.rows, ...third.rows].map(row => row.booking_id)).size, 111);
      assert.equal(first.totals.registrations, first.totals.pending + first.totals.unchanged);
    });
    await t.test('provider read failures produce a visible incomplete evaluation-error row, not missing attendance', () => {
      sql('ALTER TABLE attendance_current_outcome RENAME TO unavailable_outcome;');
      try {
        const p = preview(scope(id(15)));
        assert.equal(p.rows[0].outcome, 'evaluation_error');
        assert.equal(p.complete, false);
        assert.equal(p.evaluation_failed, true);
        assert.equal(p.totals.eligible, 0);
      } finally {
        sql('ALTER TABLE unavailable_outcome RENAME TO attendance_current_outcome;');
      }
    });
    await t.test('member resolution mirrors escaped exact email matching and validated member_id fallback', () => {
      sql(`INSERT INTO member VALUES('${id(600)}','${tenant}',' padded@example.invalid ');
        UPDATE booking SET attendee_email='padded@example.invalid',member_id=NULL WHERE id='${id(20)}';`);
      assert.equal(preview(scope(id(20))).rows[0].outcome, 'unmatched_member');
      sql(`UPDATE booking SET member_id='${id(600)}' WHERE id='${id(20)}';`);
      assert.equal(preview(scope(id(20))).rows[0].member_id, id(600));
      sql(`UPDATE booking SET attendee_email='somebodyelse@example.invalid' WHERE id='${id(20)}';`);
      assert.equal(preview(scope(id(20))).rows[0].outcome, 'unmatched_member');
      sql(`INSERT INTO member VALUES('${id(601)}','${tenant}','member@example.invalid');`);
      assert.equal(preview(scope(id(21))).rows[0].outcome, 'unmatched_member', 'ambiguous email never falls back to purchaser hint');
    });
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});