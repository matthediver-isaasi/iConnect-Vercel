import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

const sql = await readFile(new URL('./20261124_speaker_recognition.sql', import.meta.url), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'speaker-recognition-'));
  const port = 46000 + Math.floor(Math.random() * 10000);
  execFileSync('initdb', ['-D', join(root, 'data'), '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', join(root, 'data'), '-o', `-F -p ${port} -k ${root}`, '-w', 'start'], { stdio: 'ignore' });
  const clients = [];
  const connect = async () => {
    const c = new pg.Client({ host: root, port, user: 'postgres', database: 'postgres' });
    await c.connect(); clients.push(c); return c;
  };
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    execFileSync('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    await rm(root, { recursive: true, force: true });
  });
  const c = await connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text);
    CREATE TABLE tenant(id uuid PRIMARY KEY);
    CREATE TABLE speaker(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,full_name text,email text,organization text);
    CREATE TABLE badge(id uuid PRIMARY KEY,tenant_id uuid,name text,image_url text);
    CREATE TABLE cpd_certificate_template(id uuid PRIMARY KEY,tenant_id uuid,status text,source_path text,source_bucket text,source_sha256 text);
    CREATE TABLE cpd_certificate_placeholder(id uuid PRIMARY KEY,tenant_id uuid,template_id uuid,page_number int,display_order int,placeholder_key text);
    CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,title text,start_date timestamptz,end_date timestamptz,
      timezone text,status text,event_state text,speaker_ids uuid[],speaker_award_config jsonb);
    CREATE TABLE complex_event(LIKE event INCLUDING ALL);
    CREATE TABLE event_agenda_item(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,speaker_ids jsonb);
    CREATE TABLE complex_event_session(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,speaker_ids uuid[]);
    CREATE TABLE speaker_award_grant(id uuid PRIMARY KEY,tenant_id uuid,event_type text,event_id uuid,speaker_id uuid,
      member_id uuid,member_badge_id uuid,badge_id uuid,status text);
    INSERT INTO tenant VALUES ('${id(1)}'),('${id(2)}');
    INSERT INTO speaker(id,tenant_id,full_name) VALUES ('${id(10)}','${id(1)}','External'),('${id(11)}','${id(1)}','Member');
    INSERT INTO badge VALUES ('${id(20)}','${id(1)}','Speaker',NULL);
    INSERT INTO cpd_certificate_template VALUES ('${id(30)}','${id(1)}','active','${id(1)}/source.pdf','private-uploads','${'a'.repeat(64)}');
  `);
  await c.query(sql);
  await c.query("UPDATE speaker_recognition_policy SET starts_at=now()-interval '1 day'");
  const config = { enabled: true, default: { badge_id: id(20), certificate_template_id: id(30) }, overrides: {} };
  const event = async (eventId = 40, type = 'event', overrides = {}) => {
    await c.query(`INSERT INTO ${type}(id,tenant_id,title,start_date,end_date,status,speaker_ids,speaker_award_config)
      VALUES($1,$2,'Original event',now()-interval '1 hour',now(),'published',$3,$4)`,
    [id(eventId), id(1), [id(10)], JSON.stringify({ ...config, ...overrides })]);
  };
  const sync = (eventId = 40, type = 'event', client = c) =>
    client.query('SELECT sync_speaker_recognition($1,$2,$3)', [id(1), type, id(eventId)]);
  const rows = async () => (await c.query('SELECT * FROM speaker_recognition ORDER BY event_id,speaker_id')).rows;
  return { c, connect, event, sync, rows, config };
}

test('external no-email certificate and badge recognition, retry deduplication and immutable snapshot', async t => {
  const { c, connect, event, sync, rows } = await fixture(t);
  await event();
  await Promise.all([sync(), sync(40, 'event', await connect())]);
  let records = await rows();
  assert.equal(records.length, 1);
  assert.equal(records[0].member_id, null);
  assert.equal(records[0].badge_id, id(20));
  assert.equal(records[0].certificate_status, 'pending');
  assert.equal(records[0].snapshot.speaker_name, 'External');
  const key = `${id(1)}/${records[0].id}.pdf`;
  await c.query('SELECT finish_speaker_certificate($1,$2,$3,$4)', [id(1), records[0].id, key, 'a'.repeat(64)]);
  await c.query("UPDATE event SET title='Edited title' WHERE id=$1", [id(40)]);
  await c.query("UPDATE cpd_certificate_template SET source_sha256=$1 WHERE id=$2", ['b'.repeat(64), id(30)]);
  await sync();
  await c.query('SELECT finish_speaker_certificate($1,$2,$3,$4)', [id(1), records[0].id, key, 'b'.repeat(64)]);
  records = await rows();
  assert.equal(records[0].snapshot.event_title, 'Original event');
  assert.equal(records[0].snapshot.template.source_sha256, 'a'.repeat(64));
  assert.equal(records[0].pdf_sha256, 'a'.repeat(64));
  const cutoff = (await c.query('SELECT starts_at FROM speaker_recognition_policy')).rows[0].starts_at;
  await c.query(sql);
  assert.equal(+(await c.query('SELECT starts_at FROM speaker_recognition_policy')).rows[0].starts_at, +cutoff);
  assert.equal((await rows()).length, 1);
});

test('final-reference removal serializes with completion and readdition reuses the one artifact', async t => {
  const { c, event, sync, rows } = await fixture(t);
  await event();
  await c.query('INSERT INTO event_agenda_item VALUES($1,$2,$3,$4)', [id(50), id(1), id(40), JSON.stringify([id(10)])]);
  await sync();
  const record = (await rows())[0];
  await c.query("UPDATE event SET speaker_ids='{}' WHERE id=$1", [id(40)]);
  assert.equal((await rows())[0].status, 'active'); // agenda reference remains
  await c.query('DELETE FROM event_agenda_item WHERE id=$1', [id(50)]);
  assert.equal((await rows())[0].status, 'revoked');
  const key = `${id(1)}/${record.id}.pdf`;
  assert.equal((await c.query('SELECT finish_speaker_certificate($1,$2,$3,$4) AS done',
    [id(1), record.id, key, 'a'.repeat(64)])).rows[0].done, false);
  await c.query('UPDATE event SET speaker_ids=$1 WHERE id=$2', [[id(10)], id(40)]);
  await sync();
  assert.equal((await rows())[0].id, record.id);
  assert.equal((await rows())[0].status, 'active');
});

test('complex-session dedupe, certificate opt-out, exclusions, certificate-only and cutoff', async t => {
  const { c, event, sync, rows } = await fixture(t);
  await event(40, 'complex_event', { overrides: { [id(11)]: { excluded: true } } });
  for (const n of [50, 51]) await c.query('INSERT INTO complex_event_session VALUES($1,$2,$3,$4)',
    [id(n), id(1), id(40), [id(10), id(11)]]);
  await sync(40, 'complex_event');
  assert.equal((await rows()).length, 1);
  await event(41, 'event', { default: { certificate_template_id: id(30) } });
  await sync(41);
  assert.equal((await rows())[1].badge_id, null);
  await event(42, 'event', { overrides: { [id(10)]: { certificate_template_id: null } } });
  await sync(42);
  assert.equal((await rows())[2].certificate_template_id, null);
  await event(43);
  await c.query("UPDATE event SET start_date=now()-interval '2 days' WHERE id=$1", [id(43)]);
  await sync(43);
  assert.equal((await rows()).length, 3);
});

test('assignment badges do not issue certificates early; member evidence and changed ownership', async t => {
  const { c, event, sync, rows } = await fixture(t);
  await event(40, 'event', { badge_timing: 'on_assignment' });
  await c.query("UPDATE event SET start_date=now()+interval '1 hour' WHERE id=$1", [id(40)]);
  await sync();
  assert.equal((await rows())[0].certificate_status, 'unavailable');
  await c.query("UPDATE event SET start_date=now()-interval '1 minute' WHERE id=$1", [id(40)]);
  await sync();
  assert.equal((await rows())[0].certificate_status, 'pending');
  await event(41);
  await c.query('UPDATE speaker SET member_id=$1 WHERE id=$2', [id(100), id(10)]);
  await sync(41);
  assert.equal((await rows())[1].member_id, id(100));
  assert.equal((await rows())[1].badge_id, null); // no fabricated member badge
  await c.query("UPDATE event SET speaker_ids='{}' WHERE id=$1", [id(41)]);
  await c.query('UPDATE speaker SET member_id=$1 WHERE id=$2', [id(101), id(10)]);
  await c.query('UPDATE event SET speaker_ids=$1 WHERE id=$2', [[id(10)], id(41)]);
  await sync(41);
  assert.equal((await rows())[1].member_id, id(100));
  assert.equal((await rows())[1].status, 'revoked');
});

test('active tenant template validation and private privileges fail closed', async t => {
  const { c, event, sync, rows } = await fixture(t);
  await assert.rejects(event(40, 'event', { default: { certificate_template_id: id(999) } }), /active template/);
  await c.query('INSERT INTO cpd_certificate_template(id,tenant_id,status) VALUES($1,$2,$3)', [id(31), id(2), 'active']);
  await assert.rejects(event(40, 'event', { default: { certificate_template_id: id(31) } }), /active template/);
  await event();
  await sync();
  for (const role of ['anon', 'authenticated']) {
    await c.query(`SET ROLE ${role}`);
    await assert.rejects(sync(), /permission denied/);
    await assert.rejects(rows(), /permission denied/);
    await c.query('RESET ROLE');
  }
  assert.equal((await c.query("SELECT public FROM storage.buckets WHERE id='speaker-certificates'")).rows[0].public, false);
});

test('disabled configs cannot starve the queue and late certificate settings do not issue retrospectively', async t => {
  const { c, event, sync, rows, config } = await fixture(t);
  await event(40, 'event', { enabled: false });
  await sync();
  assert.ok((await c.query('SELECT speaker_recognition_processed_at FROM event WHERE id=$1', [id(40)])).rows[0].speaker_recognition_processed_at);
  await c.query('UPDATE event SET speaker_award_config=$1 WHERE id=$2', [JSON.stringify(config), id(40)]);
  await sync();
  assert.equal((await rows()).length, 0);
  await event(41);
  await sync(41);
  const cert = (await rows())[0];
  await assert.rejects(c.query("UPDATE speaker_recognition SET snapshot='{}' WHERE id=$1", [cert.id]), /snapshot is immutable/);
  await assert.rejects(c.query('UPDATE speaker_recognition SET member_id=$1 WHERE id=$2', [id(900), cert.id]), /recipient and provenance are immutable/);
});

test('later member-badge success refreshes completed or failed certificate recognition without duplicate effects', async t => {
  const { c, event, sync, rows } = await fixture(t);
  await c.query('UPDATE speaker SET member_id=$1 WHERE id=$2', [id(100), id(10)]);
  for (const eventId of [40, 41]) {
    await event(eventId);
    await c.query(`INSERT INTO speaker_award_grant(id,tenant_id,event_type,event_id,speaker_id,member_id,badge_id,status)
      VALUES($1,$2,'event',$3,$4,$5,$6,'pending')`, [id(eventId + 200), id(1), id(eventId), id(10), id(100), id(20)]);
    await sync(eventId);
    const record = (await rows()).find(row => row.event_id === id(eventId));
    assert.equal(record.badge_id, null);
    assert.equal(record.member_badge_id, null);
    if (eventId === 40) {
      await c.query('SELECT finish_speaker_certificate($1,$2,$3,$4)',
        [id(1), record.id, `${id(1)}/${record.id}.pdf`, 'a'.repeat(64)]);
    } else {
      await c.query("UPDATE speaker_recognition SET certificate_status='error',error='Render failed' WHERE id=$1", [record.id]);
    }
    await c.query("UPDATE speaker_award_grant SET member_badge_id=$1,status='granted' WHERE event_id=$2",
      [id(eventId + 300), id(eventId)]);
    // Even subsequently disabling award configuration cannot hide successful
    // existing member-badge effects or make certificate failure affect them.
    if (eventId === 41) await c.query("UPDATE event SET speaker_award_config=jsonb_set(speaker_award_config,'{enabled}','false') WHERE id=$1", [id(eventId)]);
    // Neither event-start selection nor PDF retry is required for this repair.
    await c.query('SELECT refresh_speaker_recognition_badges()');
    const refreshed = (await rows()).find(row => row.event_id === id(eventId));
    assert.equal(refreshed.id, record.id);
    assert.equal(refreshed.badge_id, id(20));
    assert.equal(refreshed.member_badge_id, id(eventId + 300));
    assert.equal(refreshed.certificate_status, eventId === 40 ? 'issued' : 'error');
    assert.deepEqual(refreshed.snapshot, record.snapshot);
  }
  await c.query('SELECT refresh_speaker_recognition_badges()');
  assert.equal((await rows()).length, 2);
  assert.equal((await c.query('SELECT count(*)::int AS count FROM speaker_award_grant')).rows[0].count, 2);
});

test('explicit certificate opt-out while pending blocks finalization but preserves successful badge recognition', async t => {
  const { c, event, sync, rows, config } = await fixture(t);
  for (const eventId of [40, 41]) {
    await event(eventId);
    await sync(eventId);
    const record = (await rows()).find(row => row.event_id === id(eventId));
    const next = eventId === 40
      ? { ...config, overrides: { [id(10)]: { certificate_template_id: null } } }
      : { ...config, default: { badge_id: id(20), certificate_template_id: null } };
    await c.query('UPDATE event SET speaker_award_config=$1 WHERE id=$2', [JSON.stringify(next), id(eventId)]);
    const finished = await c.query('SELECT finish_speaker_certificate($1,$2,$3,$4) AS done',
      [id(1), record.id, `${id(1)}/${record.id}.pdf`, 'a'.repeat(64)]);
    assert.equal(finished.rows[0].done, false);
    const cancelled = (await rows()).find(row => row.event_id === id(eventId));
    assert.equal(cancelled.certificate_status, 'unavailable');
    assert.equal(cancelled.pdf_path, null);
    assert.equal(cancelled.status, 'active');
    assert.equal(cancelled.badge_id, id(20));
    assert.deepEqual(cancelled.snapshot, record.snapshot);
  }
});

test('exclusion or removal while pending cannot be undone by completion sync', async t => {
  const { c, event, sync, rows, config } = await fixture(t);
  for (const eventId of [40, 41]) {
    await event(eventId); await sync(eventId);
    const record = (await rows()).find(row => row.event_id === id(eventId));
    if (eventId === 40) await c.query('UPDATE event SET speaker_award_config=$1 WHERE id=$2',
      [JSON.stringify({ ...config, overrides: { [id(10)]: { excluded: true } } }), id(eventId)]);
    else await c.query("UPDATE event SET speaker_ids='{}' WHERE id=$1", [id(eventId)]);
    const finished = await c.query('SELECT finish_speaker_certificate($1,$2,$3,$4) AS done',
      [id(1), record.id, `${id(1)}/${record.id}.pdf`, 'a'.repeat(64)]);
    assert.equal(finished.rows[0].done, false);
    const revoked = (await rows()).find(row => row.event_id === id(eventId));
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.pdf_path, null);
  }
});

test('assignment-time no-certificate override is retained at start; clearing it before start inherits default', async t => {
  const { c, event, sync, rows, config } = await fixture(t);
  for (const eventId of [40, 41]) {
    const cfg = { ...config, badge_timing: 'on_assignment', overrides: { [id(10)]: { certificate_template_id: null } } };
    await event(eventId, 'event', cfg);
    await c.query("UPDATE event SET start_date=now()+interval '1 hour' WHERE id=$1", [id(eventId)]);
    await sync(eventId);
    const before = (await rows()).find(row => row.event_id === id(eventId));
    assert.equal(before.badge_id, id(20));
    assert.equal(before.certificate_template_id, null);
    if (eventId === 41) {
      delete cfg.overrides[id(10)].certificate_template_id;
      await c.query('UPDATE event SET speaker_award_config=$1 WHERE id=$2', [JSON.stringify(cfg), id(eventId)]);
    }
    await c.query("UPDATE event SET start_date=now()-interval '1 minute' WHERE id=$1", [id(eventId)]);
    await sync(eventId);
    const after = (await rows()).find(row => row.event_id === id(eventId));
    assert.equal(after.id, before.id);
    assert.equal(after.certificate_template_id, eventId === 40 ? null : id(30));
    assert.equal(after.certificate_status, eventId === 40 ? 'unavailable' : 'pending');
  }
});