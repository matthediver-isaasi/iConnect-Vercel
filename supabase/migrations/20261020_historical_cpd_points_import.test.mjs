import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const baseline = readFileSync(new URL('./20261012_event_cpd_points_awards.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('./20261020_historical_cpd_points_import.sql', import.meta.url), 'utf8');
const tenant = '10000000-0000-0000-0000-000000000001';
const otherTenant = '10000000-0000-0000-0000-000000000002';
const member = '20000000-0000-0000-0000-000000000001';
const otherMember = '20000000-0000-0000-0000-000000000002';
const event = '30000000-0000-0000-0000-000000000001';
const booking = '40000000-0000-0000-0000-000000000001';
const literal = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const row = (id, overrides = {}) => ({
  source_entry_id: id, member_id: member, points_value: '0.100001',
  activity_date: '2021-05-18', activity_title: 'Certification code', activity_description: "Member's activity",
  source_metadata: { locked: false, score: null, expires: null }, row_hash: 'a'.repeat(64), ...overrides,
});
const microPoints = value => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
};
const manifest = rows => ({
  workbook_sha256: 'b'.repeat(64), approval_sha256: 'c'.repeat(64), source_system: 'bnms',
  target: 'isolated-test', row_count: rows.length,
  points_total: (rows.reduce((sum, r) => sum + microPoints(r.points_value), 0n) / 1000000n).toString()
    + '.' + (rows.reduce((sum, r) => sum + microPoints(r.points_value), 0n) % 1000000n).toString().padStart(6, '0'),
});
const rpc = (key, rows, options = {}) => `SELECT public.import_historical_cpd_points_batch(
  '${options.tenant || tenant}','${key}',${literal(options.manifest || manifest(rows))},${literal(rows)},'test:operator');`;
const service = `SET request.jwt.claim.role='service_role';`;

test('isolated PostgreSQL historical import, replay, rollback, security and native regression', { timeout: 60000 }, async t => {
  const h = await createLocalPostgresHarness('historical-cpd-');
  const conn = ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = input => run('psql', conn, input);
  const fails = (input, regex) => {
    const r = spawnSync('psql', conn, { input: service + input, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'expected SQL rejection');
    assert.match(r.stderr, regex);
  };
  const call = (key, rows, options) => JSON.parse(sql(service + rpc(key, rows, options)));
  const counts = () => sql(`SELECT (SELECT count(*) FROM member_cpd_points_ledger)||':'||
    (SELECT count(*) FROM historical_cpd_points_import_batch);`);
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    // Only upstream dependencies are stubbed. Both CPD migrations run unmodified.
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS
        $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,pricing_config jsonb);
      CREATE TABLE complex_event(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,name text);
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,status text,attendee_email text,
        ticket_class_id text,ticket_class_name text,checked_in_at timestamptz,check_in_reversed_at timestamptz);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE complex_event_session_checkin(id uuid PRIMARY KEY,checked_in_at timestamptz,check_in_reversed_at timestamptz);
      CREATE TABLE attendance_outcome_transition(id uuid PRIMARY KEY);
      INSERT INTO tenant VALUES('${tenant}'),('${otherTenant}');
      INSERT INTO member VALUES('${member}','${tenant}','test@example.invalid'),('${otherMember}','${otherTenant}','other@example.invalid');
    `);
    sql(baseline);
    sql(migration);

    await t.test('exact points, native-free historical context, durable provenance', () => {
      assert.deepEqual(call('first', [row('1'), row('2')]), {
        applied_count: 2, skipped_count: 0, applied_points: '0.200002', skipped_points: '0',
      });
      assert.equal(sql(`SELECT count(*) FROM member_cpd_points_ledger WHERE activity_date='2021-05-18'
        AND event_id IS NULL AND booking_id IS NULL AND rule_snapshot IS NULL
        AND source_metadata->>'locked'='false' AND import_batch_id IS NOT NULL;`), '2');
      fails(`UPDATE member_cpd_points_ledger SET points_value=1;`, /immutable/);
      fails(`DELETE FROM member_cpd_points_ledger;`, /immutable/);
      fails(`UPDATE historical_cpd_points_import_batch SET created_by='changed';`, /immutable/);
      fails(`DELETE FROM historical_cpd_points_import_batch;`, /immutable/);
    });
    await t.test('full replay writes nothing, including fresh batch key; changed content requires review', () => {
      const before = counts();
      assert.equal(call('first', [row('1'), row('2')]).skipped_count, 2);
      assert.equal(call('fresh-replay', [row('1'), row('2')]).applied_count, 0);
      assert.equal(counts(), before);
      fails(rpc('changed', [row('1', { activity_title: 'changed with unchanged hash' })]), /review conflict/);
      fails(rpc('first', [row('new'), row('2')]), /manifest conflict/);
      fails(rpc('first', [row('1'), row('2')], {
        manifest: { ...manifest([row('1'), row('2')]), target: 'different' },
      }), /manifest conflict/);
      assert.equal(counts(), before);
    });
    await t.test('transaction rollback, ownership, precision, date, chunk and reconciliation validation', () => {
      const before = counts();
      fails(rpc('rollback', [row('3'), row('4', { member_id: otherMember })]), /cross-tenant/);
      fails(rpc('missing', [row('3', { member_id: '20000000-0000-0000-0000-000000000099' })]), /missing/);
      fails(rpc('precision', [row('3', { points_value: '0.0000001' })]), /invalid historical/);
      fails(rpc('date', [row('3', { activity_date: '2021-02-30' })]), /date\/time|out of range/);
      fails(rpc('duplicate', [row('3'), row('3')]), /duplicate source/);
      fails(rpc('max', Array.from({ length: 101 }, (_, i) => row(`limit-${i}`))), /1 to 100/);
      fails(rpc('bad-total', [row('3')], { manifest: { ...manifest([row('3')]), points_total: '1' } }), /points mismatch/);
      fails(rpc('bad-count', [row('3')], { manifest: { ...manifest([row('3')]), row_count: 2 } }), /row count/);
      assert.equal(counts(), before);
      assert.equal(call('rollback', [row('3'), row('4')]).applied_count, 2, 'resume rejected transaction');
      assert.equal(call('partial', [row('3'), row('5')]).skipped_count, 1, 'resume partial overlap');
    });
    await t.test('concurrent retry writes exactly once', async () => {
      const concurrent = key => new Promise((resolve, reject) => {
        const child = spawn('psql', conn);
        let output = '', error = '';
        child.stdout.on('data', x => { output += x; });
        child.stderr.on('data', x => { error += x; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(error)));
        child.stdin.end(service + rpc(key, [row('concurrent')]));
      });
      const results = await Promise.all([concurrent('concurrent'), concurrent('concurrent'), concurrent('concurrent-fresh')]);
      assert.equal(results.reduce((n, r) => n + r.applied_count, 0), 1);
      assert.equal(results.reduce((n, r) => n + r.skipped_count, 0), 2);
      assert.equal(sql(`SELECT count(*) FROM historical_cpd_points_import_batch WHERE batch_key IN ('concurrent','concurrent-fresh');`), '1');
    });
    await t.test('tenant-scoped source identity, zero/max precision and 100-row boundary', () => {
      assert.equal(call('other-tenant', [row('1', { member_id: otherMember })], { tenant: otherTenant }).applied_count, 1);
      assert.equal(call('max-precision', [row('max', { points_value: '99999999999999.999999' })]).applied_points,
        '99999999999999.999999');
      assert.equal(call('zero', [row('zero', { points_value: '0' })]).applied_count, 1);
      const hundred = Array.from({ length: 100 }, (_, i) => row(`hundred-${i}`));
      assert.equal(call('hundred', hundred).applied_count, 100);
      assert.equal(call('hundred', hundred).skipped_count, 100);
    });
    await t.test('service-only RPC and no generic/direct writes', () => {
      for (const role of ['anon', 'authenticated']) {
        fails(`SET ROLE ${role};` + rpc('forbidden', [row('forbidden')]), /permission denied/);
      }
      fails(`SET request.jwt.claim.role='authenticated';` + rpc('forbidden', [row('forbidden')]), /service_role is required/);
      fails(`SET ROLE service_role; INSERT INTO member_cpd_points_ledger DEFAULT VALUES;`, /permission denied/);
      fails(`SET ROLE service_role; INSERT INTO historical_cpd_points_import_batch DEFAULT VALUES;`, /permission denied/);
      assert.equal(JSON.parse(sql(service + 'SET ROLE service_role;' + rpc('service', [row('service')]))).applied_count, 1);
    });
    await t.test('manual linked reversal retains dates/provenance, exactly once and tenant scoped', () => {
      const id = sql(`SELECT id FROM member_cpd_points_ledger WHERE source_entry_id='1' AND tenant_id='${tenant}';`);
      const reverse = `SELECT reverse_historical_cpd_points_award('${tenant}','${id}','approved correction','operator');`;
      fails(`SELECT reverse_historical_cpd_points_award('${otherTenant}','${id}','reason','operator');`, /not found/);
      fails(`SELECT reverse_historical_cpd_points_award('${tenant}','${id}','','operator');`, /reason and actor/);
      const reversal = sql(service + reverse);
      assert.equal(sql(service + reverse), reversal);
      assert.equal(sql(`SELECT count(*) FROM member_cpd_points_ledger r JOIN member_cpd_points_ledger a ON r.reversal_of=a.id
        WHERE r.id='${reversal}' AND r.points_value=-a.points_value AND r.activity_date=a.activity_date
          AND r.import_batch_id=a.import_batch_id AND r.source_metadata=a.source_metadata AND r.row_hash=a.row_hash;`), '1');
      assert.equal(call('after-reversal', [row('1')]).skipped_count, 1);
    });
    await t.test('native RPC still awards, deduplicates and reverses; null native context cannot pass CHECK', () => {
      sql(service + `
        INSERT INTO event VALUES('${event}','${tenant}','{}');
        INSERT INTO booking(id,tenant_id,event_id,status,attendee_email)
          VALUES('${booking}','${tenant}','${event}','confirmed','test@example.invalid');
        SELECT replace_event_cpd_points_rules('${tenant}','event','${event}',
          '[{"trigger_type":"registration","points_value":"2.5"}]');
      `);
      const attempt = { tenant_id: tenant, member_id: member, booking_id: booking, booking_type: 'booking',
        event_type: 'event', event_id: event, idempotency_key: 'native', trigger_type: 'registration', status: 'awarded' };
      assert.equal(sql(service + `SELECT (record_event_cpd_points_award(${literal(attempt)})).status;`), 'awarded');
      assert.equal(sql(service + `SELECT (record_event_cpd_points_award(${literal({ ...attempt, idempotency_key: 'native-retry' })})).status;`), 'already_awarded');
      const nativeId = sql(`SELECT id FROM member_cpd_points_ledger WHERE entry_kind='event_award';`);
      sql(service + `SELECT reverse_event_cpd_points_award('${tenant}','${nativeId}','manual test','operator');`);
      assert.equal(sql(`SELECT points_value FROM member_cpd_points_ledger WHERE reversal_of='${nativeId}';`), '-2.500000');
      for (const column of ['event_type', 'event_id', 'booking_type', 'booking_id', 'award_trigger', 'rule_snapshot', 'occurrence_key']) {
        const fields = { tenant_id: `'${tenant}'`, member_id: `'${member}'`, entry_kind: "'event_award'",
          points_value: '1', event_type: "'event'", event_id: `'${event}'`, booking_type: "'booking'",
          booking_id: `'${booking}'`, award_trigger: "'registration'", rule_snapshot: "'{}'", occurrence_key: "'null-test'" };
        fields[column] = 'NULL';
        fails(`INSERT INTO member_cpd_points_ledger(${Object.keys(fields)}) VALUES(${Object.values(fields)});`, /cpd_entry_context/);
      }
    });
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});