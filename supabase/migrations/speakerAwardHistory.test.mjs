import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

test('history view preserves legacy evidence, deduplicates recognition, scopes recipients, and is service-only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'speaker-history-'));
  const port = 46000 + Math.floor(Math.random() * 10000);
  execFileSync('initdb', ['-D', join(root, 'data'), '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', join(root, 'data'), '-o', `-F -p ${port} -k ${root}`, '-w', 'start'], { stdio: 'ignore' });
  const c = new pg.Client({ host: root, port, user: 'postgres', database: 'postgres' });
  await c.connect();
  t.after(async () => {
    await c.end();
    execFileSync('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    await rm(root, { recursive: true, force: true });
  });
  const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE speaker_recognition(id uuid,tenant_id uuid,speaker_id uuid,member_id uuid,event_type text,event_id uuid,
      snapshot jsonb,created_at timestamptz,status text,badge_id uuid,member_badge_id uuid,
      certificate_status text,pdf_path text,pdf_sha256 text);
    CREATE TABLE speaker_award_grant(id uuid,tenant_id uuid,speaker_id uuid,member_id uuid,event_type text,event_id uuid,
      created_at timestamptz,status text,badge_id uuid,member_badge_id uuid);
    CREATE TABLE member_badge(id uuid,tenant_id uuid,member_id uuid,badge_id uuid,revoked_at timestamptz,source text,source_ref text);
    CREATE TABLE badge(id uuid,tenant_id uuid,name text,image_url text);
    CREATE TABLE event(id uuid,tenant_id uuid,title text);
    CREATE TABLE complex_event(LIKE event);
    INSERT INTO badge VALUES('${id(5)}','${id(1)}','Speaker','https://example.test/badge.png');
    INSERT INTO member_badge VALUES('${id(6)}','${id(1)}','${id(2)}','${id(5)}',NULL,'manual',NULL);
    INSERT INTO event VALUES('${id(4)}','${id(1)}','Original event');
    INSERT INTO speaker_award_grant VALUES('${id(8)}','${id(1)}','${id(3)}','${id(2)}','event','${id(4)}',now(),'granted','${id(5)}','${id(6)}');
    INSERT INTO speaker_award_grant VALUES('${id(9)}','${id(1)}','${id(10)}',NULL,'event','${id(4)}',now(),'skipped_no_member','${id(5)}',NULL);
  `);
  const sql = await readFile(new URL('./20261124_speaker_recognition_history.sql', import.meta.url), 'utf8');
  await c.query(sql);
  await c.query(sql); // Idempotent.
  let rows = (await c.query('SELECT * FROM speaker_award_history')).rows;
  assert.equal(rows.length, 1); // no fabricated external legacy recognition
  assert.equal(rows[0].badge_evidence, 'existing_member_badge');
  assert.equal(rows[0].badge_status, 'active');
  assert.equal(rows[0].certificate_available, false);
  await c.query(`INSERT INTO speaker_recognition VALUES(
    $1,$2,$3,$4,'event',$5,$6,now(),'active',$7,$8,'issued','private/path','hash')`,
  [id(11), id(1), id(3), id(2), id(4), JSON.stringify({ event_title: 'Snapshot event', badge: { name: 'Snapshot badge' } }), id(5), id(6)]);
  rows = (await c.query('SELECT * FROM speaker_award_history')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_title, 'Snapshot event');
  assert.equal(rows[0].certificate_available, true);
  assert.equal(rows[0].snapshot, undefined);
  assert.equal(rows[0].pdf_path, undefined);
  // Certificate-first recognition may acquire real badge evidence on a retry.
  // Its immutable certificate snapshot must not be rewritten for presentation.
  await c.query("UPDATE speaker_recognition SET snapshot=snapshot-'badge',badge_id=NULL,member_badge_id=NULL");
  assert.equal((await c.query('SELECT count(*)::int AS n FROM speaker_award_history')).rows[0].n, 2);
  await c.query('UPDATE speaker_recognition SET badge_id=$1,member_badge_id=$2', [id(5), id(6)]);
  rows = (await c.query('SELECT * FROM speaker_award_history')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].badge_name, 'Speaker');
  assert.equal(rows[0].badge_image_url, 'https://example.test/badge.png');
  assert.equal(rows[0].badge_evidence, 'existing_member_badge');
  // Changing the current speaker link cannot transfer immutable recognition.
  await c.query('CREATE TABLE speaker(id uuid,tenant_id uuid,member_id uuid)');
  await c.query('INSERT INTO speaker VALUES($1,$2,$3)', [id(3), id(1), id(2)]);
  await c.query('UPDATE speaker SET member_id=$1 WHERE id=$2', [id(99), id(3)]);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM speaker_award_history WHERE tenant_id=$1 AND member_id=$2', [id(1), id(2)])).rows[0].n, 1);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM speaker_award_history WHERE tenant_id=$1 AND member_id=$2', [id(1), id(99)])).rows[0].n, 0);
  // The fallback join must not expose artwork from a badge in another tenant.
  await c.query('UPDATE badge SET tenant_id=$1', [id(99)]);
  assert.equal((await c.query('SELECT badge_image_url FROM speaker_award_history')).rows[0].badge_image_url, null);
  await c.query('UPDATE member_badge SET revoked_at=now()');
  assert.equal((await c.query('SELECT badge_status FROM speaker_award_history')).rows[0].badge_status, 'revoked');
  await c.query('UPDATE speaker_recognition SET status=$1', ['revoked']);
  assert.equal((await c.query('SELECT certificate_available FROM speaker_award_history')).rows[0].certificate_available, false);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM speaker_award_history WHERE tenant_id=$1 AND member_id=$2', [id(1), id(99)])).rows[0].n, 0);
  const guards = (await c.query(`SELECT
    has_table_privilege('anon','speaker_award_history','SELECT') AS anon,
    has_table_privilege('authenticated','speaker_award_history','SELECT') AS member,
    has_table_privilege('service_role','speaker_award_history','SELECT') AS service`)).rows[0];
  assert.deepEqual(guards, { anon: false, member: false, service: true });
});