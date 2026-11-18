import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { persistAttendanceReport, buildAttendanceSnapshotIdempotencyKey } from '../api/_lib/attendanceEngine.js';
import { zoomAttendanceIntervalIdentities } from '../api/_lib/zoomAttendanceIntervalIdentity.js';

test('installed snapshot contract: duplicates, replay, concurrency, isolation and rollback', async () => {
  const h = await createLocalPostgresHarness('attendance-conflicts-');
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  let started = false;
  const clients = [];
  const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 2; i++) {
      const db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await db.connect(); clients.push(db);
      await db.query("SELECT set_config('request.jwt.claim.role','service_role',false)");
    }
    const [db, other] = clients;
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS
      $$ SELECT current_setting('request.jwt.claim.role',true) $$;`);
    const base = readFileSync('supabase/migrations/20260829_provider_neutral_attendance.sql', 'utf8');
    // Real table/function definitions, excluding unrelated historical data backfills.
    await db.query(base.slice(base.indexOf('CREATE TABLE IF NOT EXISTS attendance_policy'),
      base.indexOf('-- Existing Zoom links')));
    await db.query(base.slice(base.indexOf('CREATE OR REPLACE FUNCTION attendance_upsert_policy_snapshot'),
      base.indexOf('CREATE OR REPLACE FUNCTION replace_attendance_report_snapshot')));
    await db.query(readFileSync('supabase/migrations/20260830_attendance_transition_outbox.sql', 'utf8'));
    for (const file of ['202612110001_attendance_snapshot_target_conflict.sql', '202612110002_attendance_snapshot_service_claims.sql']) {
      await db.query(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    }
    const adapter = connection => ({ rpc: async (name, args) => {
      try {
        const result = await connection.query(`SELECT * FROM ${name}($1,$2,$3,$4::jsonb)`,
          [args.p_tenant_id, args.p_provider, args.p_idempotency_key, JSON.stringify(args.p_snapshot)]);
        return { data: result.rows };
      } catch (error) { return { error }; }
    } });
    const interval = { participantKey: 'p', intervalKey: 'join1', durationSeconds: 40 };
    const input = {
      tenantId: id(1), provider: 'zoom',
      target: { type: 'event', id: id(2), providerTargetId: 'fixture', providerTargetType: 'meeting', thresholdMinutes: 1 },
      intervals: [interval, { ...interval }],
      matches: [{ participantKey: 'p', bookingId: id(3), bookingType: 'booking', matchStatus: 'matched' }],
      bookings: [{ id: id(3), bookingType: 'booking' }],
    };
    const save = async (connection, overrides = {}) => {
      const data = { ...input, ...overrides };
      return persistAttendanceReport(adapter(connection), {
        ...data, idempotencyKey: buildAttendanceSnapshotIdempotencyKey(data),
      });
    };
    const first = await save(db);
    assert.equal(first.outcomes[0].durationSeconds, 40);
    assert.equal(first.outcomes[0].status, 'below_threshold');
    assert.equal((await save(db)).syncRunId, first.syncRunId);
    const counts = async () => (await db.query(`SELECT
      (SELECT count(*)::int FROM attendance_participant_interval) intervals,
      (SELECT count(*)::int FROM attendance_outcome_revision) revisions,
      (SELECT count(*)::int FROM attendance_transition_outbox) rewards`)).rows[0];
    assert.deepEqual(await counts(), { intervals: 1, revisions: 1, rewards: 1 });
    const changed = { intervals: [interval, { ...interval, intervalKey: 'rejoin', durationSeconds: 30 }] };
    // Hold the transaction open to force the other session to overlap.
    await db.query('BEGIN');
    await save(db, changed);
    let finished = false;
    const waiting = save(other, changed).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(finished, false);
    await db.query('COMMIT');
    await waiting;
    assert.deepEqual(await counts(), { intervals: 2, revisions: 2, rewards: 2 });
    await save(db, { tenantId: id(9) });
    await save(db, { provider: 'teams' });
    assert.deepEqual(await counts(), { intervals: 4, revisions: 4, rewards: 4 });
    const before = await counts();
    await assert.rejects(save(db, { intervals: [interval, { ...interval, durationSeconds: 41 }] }),
      /Conflicting attendance interval facts/);
    // Error AFTER interval deletion/insertion must roll back the entire snapshot.
    await assert.rejects(save(db, { intervals: [{ ...interval, intervalKey: 'replacement' }],
      matches: [{ participantKey: 'p', bookingId: 'not-a-uuid', matchStatus: 'matched' }] }), /uuid/);
    assert.deepEqual(await counts(), before);
    assert.equal((await db.query('SELECT count(*)::int n FROM attendance_participant_interval WHERE interval_key=$1', ['replacement'])).rows[0].n, 0);
    await db.query('BEGIN');
    await save(db, { intervals: [{ ...interval, intervalKey: 'snapshot-a', durationSeconds: 70 }] });
    const next = save(other, { intervals: [{ ...interval, intervalKey: 'snapshot-b', durationSeconds: 80 }] });
    await db.query('COMMIT');
    await next;
    const final = (await db.query(`SELECT interval_key,duration_seconds FROM attendance_participant_interval
      WHERE attendance_target_id=$1`, [first.targetId])).rows;
    assert.deepEqual(final, [{ interval_key: 'snapshot-b', duration_seconds: 80 }]);
    const rewardsBeforeAnonymous = (await counts()).rewards;
    const anonymous = zoomAttendanceIntervalIdentities([
      { join_time: '2026-01-01T12:00:00Z', duration: 60 },
      { join_time: '2026-01-01T12:00:00Z', duration: 60 },
    ]).map(i => ({ ...i, participantKey: `provider:${i.intervalKey}`, durationSeconds: 60 }));
    await save(db, { intervals: anonymous, matches: [], bookings: [] });
    assert.equal((await db.query('SELECT count(*)::int n FROM attendance_participant_interval WHERE attendance_target_id=$1', [first.targetId])).rows[0].n, 2);
    assert.equal((await counts()).rewards, rewardsBeforeAnonymous);
  } finally {
    for (const db of clients) await db.end();
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
