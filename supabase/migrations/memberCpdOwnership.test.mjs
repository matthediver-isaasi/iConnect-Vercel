import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1), foreign = id(2), source = id(3), target = id(4), third = id(5), actor = id(6), outsider = id(7);
const json = v => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role';";

test('CPD ownership snapshots preserve immutable evidence, serialize retries and scope effective reads', { timeout: 90000 }, async t => {
  const h = await createLocalPostgresHarness('cpd-ownership-');
  const args = ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  const run = (cmd, argv, input) => {
    const r = spawnSync(cmd, argv, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = s => run('psql', args, s);
  const call = s => JSON.parse(sql(service + s) || 'null');
  const fail = (s, re) => {
    const r = spawnSync('psql', args, { input: service + s, encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, re);
  };
  const transfer = (a = source, b = target) => `SELECT transfer_member_cpd('${tenant}','${a}','${b}','${actor}');`;
  const history = (m, page = 1) => call(`SELECT get_member_cpd_points_history('${tenant}','${m}',${page},10);`);
  const concurrent = s => new Promise((resolve, reject) => {
    const child = spawn('psql', args); let output = '', error = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { error += b; });
    child.on('error', reject);
    child.on('close', code => code ? reject(new Error(error)) : resolve(JSON.parse(output.trim())));
    child.stdin.end(service + s);
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
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text,organization_id uuid);
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,excluded_features text[]);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,pricing_config jsonb,title text);
      CREATE TABLE complex_event(id uuid PRIMARY KEY,tenant_id uuid,title text);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,name text);
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,status text,attendee_email text,event_name text,
        member_id uuid,ticket_class_id text,ticket_class_name text,checked_in_at timestamptz,check_in_reversed_at timestamptz);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE complex_event_session_checkin(id uuid PRIMARY KEY,checked_in_at timestamptz,check_in_reversed_at timestamptz);
      CREATE TABLE attendance_outcome_transition(id uuid PRIMARY KEY);
      INSERT INTO tenant VALUES('${tenant}'),('${foreign}');
      INSERT INTO member(id,tenant_id,email) VALUES ${[source,target,third,actor].map(m => `('${m}','${tenant}','${m}@example.invalid')`).join(',')},
        ('${outsider}','${foreign}','outsider@example.invalid');
    `);
    for (const name of [
      '20261012_event_cpd_points_awards.sql', '20261020_historical_cpd_points_import.sql',
      '20261119_auditable_cpd_points_corrections.sql', '20261208_manual_cpd_awards.sql',
      '202701190001_member_cpd_ownership.sql',
      '202701190002_cpd_organization_tenant_scope.sql',
      '202701190003_cpd_transferred_lifecycle.sql',
    ]) sql(readFileSync(new URL(name, import.meta.url), 'utf8'));
    sql(readFileSync(new URL('202701190001_member_cpd_ownership.sql', import.meta.url), 'utf8'));
    sql(readFileSync(new URL('202701190002_cpd_organization_tenant_scope.sql', import.meta.url), 'utf8'));
    sql(readFileSync(new URL('202701190002_cpd_organization_tenant_scope.sql', import.meta.url), 'utf8'));
    sql(readFileSync(new URL('202701190003_cpd_transferred_lifecycle.sql', import.meta.url), 'utf8'));
    const rows = Array.from({ length: 25 }, (_, i) => ({
      source_entry_id: `row-${i}`, member_id: source, points_value: i ? '0.100001' : '0',
      activity_date: '2021-05-18', activity_title: `Historic ${i}`, activity_description: '',
      source_metadata: {}, row_hash: 'a'.repeat(64),
    }));
    const manifest = { workbook_sha256: 'b'.repeat(64), approval_sha256: 'c'.repeat(64),
      source_system: 'fixture', target: 'isolated-test', row_count: 25, points_total: '2.400024' };
    call(`SELECT import_historical_cpd_points_batch('${tenant}','${id(20)}',${json(manifest)},${json(rows)},'test');`);
    const imported = sql(`SELECT id FROM member_cpd_points_ledger WHERE source_entry_id='row-1';`);
    const correct = (owner, key, value) => `SELECT to_jsonb(correct_member_cpd_points('${tenant}','${owner}','${imported}',
      'adjust',${value},'Fixture correction','test','${key}'));`;
    call(correct(source, id(21), '-5'));
    const manual = m => `SELECT to_jsonb(record_manual_cpd_award('${tenant}','${m}','${id(m === source ? 22 : 23)}',
      1.25,'Manual training','2026-10-25','test',
      ${json({ path: `${tenant}/manual-cpd/${m}/original.pdf`, sha256: 'a'.repeat(64) })}));`;
    call(manual(source)); call(manual(target));
    sql(`INSERT INTO event VALUES('${id(30)}','${tenant}','{}','Event');
      INSERT INTO booking(id,tenant_id,event_id,status,attendee_email,member_id)
      VALUES('${id(31)}','${tenant}','${id(30)}','confirmed','${source}@example.invalid','${source}');
      INSERT INTO event_cpd_points_rule(tenant_id,event_type,event_id,trigger_type,points_value)
      VALUES('${tenant}','event','${id(30)}','registration',2.5);`);
    const attempt = { tenant_id: tenant, idempotency_key: 'original', event_type: 'event', event_id: id(30),
      booking_type: 'booking', booking_id: id(31), member_id: source, trigger_type: 'registration', status: 'awarded' };
    call(`SELECT to_jsonb(record_event_cpd_points_award(${json(attempt)}));`);
    const before = sql('SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM member_cpd_points_ledger l;');
    const expected = sql(`SELECT sum(points_value)::text FROM member_cpd_points_ledger WHERE tenant_id='${tenant}';`);

    await t.test('unauthorized and cross-tenant operations fail closed', () => {
      fail(`SET ROLE authenticated; ${transfer()}`, /permission denied/);
      fail(`SET ROLE authenticated; SELECT * FROM member_cpd_effective_ledger`, /permission denied/);
      fail(transfer(source, outsider), /must belong to the tenant/);
      fail(`SELECT transfer_member_cpd('${tenant}','${source}','${target}','${outsider}')`, /must belong/);
      fail(transfer(source, source), /Different source/);
      assert.equal(call(`SELECT get_member_cpd_points_history('${foreign}','${source}',1,10);`), null);
    });
    await t.test('concurrent retries move the finite snapshot once, without rewriting any evidence', async () => {
      sql(`INSERT INTO organization VALUES('${id(60)}','${tenant}');
        UPDATE member SET tenant_id=NULL,organization_id='${id(60)}' WHERE id IN('${target}','${actor}');
        INSERT INTO member(id,organization_id) VALUES('${id(61)}','${id(60)}');`);
      assert.equal(history(id(61)).balance,'0','organisation-scoped sources remain previewable');
      assert.equal(call(transfer(id(61),third)).historyCount,0,'empty organisation-scoped source can transfer');
      const results = await Promise.all([concurrent(transfer()), concurrent(transfer())]);
      assert.equal(results[0].mergeId, results[1].mergeId);
      assert.deepEqual(results.map(r => r.alreadyApplied).sort(), [false, true]);
      assert.equal(history(source).balance, '0');
      assert.equal(history(source).total, 0);
      assert.equal(history(target).balance, expected);
      assert.equal(sql('SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM member_cpd_points_ledger l;'), before);
      const entries = [1,2,3].flatMap(p => history(target, p).items);
      assert.equal(entries.length, 29);
      assert.equal(new Set(entries.map(e => e.id)).size, entries.length);
      assert.equal(entries.find(e => e.id === imported).points_value, 0.100001);
      fail(`UPDATE member_cpd_ownership SET target_id='${source}'`, /permission denied/);
      assert.equal(sql(`SELECT count(*) FROM member_cpd_merge`), '2');
    });
    await t.test('linked corrections and reversals follow ownership, future source activity does not', () => {
      // Legacy members may derive tenancy solely through their organisation.
      sql(`UPDATE member SET tenant_id=NULL,organization_id='${id(60)}' WHERE id='${source}';`);
      fail(correct(source, id(24), '-1'), /not found/);
      call(correct(target, id(24), '-1'));
      call(`SELECT to_jsonb(correct_member_cpd_points('${tenant}','${target}','${imported}',
        'reverse',NULL,'Reverse original','test',NULL));`);
      const entries = [1,2,3,4].flatMap(p => history(target,p).items);
      assert.equal(entries.find(e => e.id === imported).is_reversed, true);
      assert.equal(entries.filter(e => e.reversal_of === imported).length, 1);
      call(`SELECT to_jsonb(record_manual_cpd_award('${tenant}','${source}','${id(25)}',0.5,
        'New source activity','2026-11-11','test',
        ${json({ path: `${tenant}/manual-cpd/${source}/new.pdf`, sha256: 'b'.repeat(64) })}));`);
      assert.equal(history(source).balance, '0.500000');
      assert.equal(call(transfer()).alreadyApplied, true);
      assert.equal(history(source).total, 1, 'retry must not sweep new source activity');
    });
    await t.test('sequential merges retain root ownership and reject cycles', () => {
      const balance = history(target).balance;
      call(transfer(target, third));
      assert.equal(history(third).balance, balance);
      assert.equal(history(target).total, 0);
      fail(transfer(third, source), /cycle/);
      call(correct(third, id(26), '-10'));
      assert.ok(Number(history(third).balance) < 0);
      assert.equal(history(source).balance, '0.500000');
    });
    await t.test('award replay after booking reassignment does not create another award', () => {
      sql(`UPDATE booking SET member_id='${actor}' WHERE id='${id(31)}';`);
      sql(`UPDATE member SET email='deleted@example.invalid' WHERE id='${source}';`);
      const count = sql('SELECT count(*) FROM member_cpd_points_ledger');
      const result = call(`SELECT to_jsonb(record_event_cpd_points_award(${json({ ...attempt, idempotency_key: 'retry-after-merge' })}));`);
      assert.equal(result.status, 'already_awarded');
      assert.equal(sql('SELECT count(*) FROM member_cpd_points_ledger'), count);
    });
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
