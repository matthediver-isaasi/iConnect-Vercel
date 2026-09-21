import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { migrationUrl, runMigration } from '../../scripts/apply-member-group-membership-history.mjs';
import { destinationTarget } from '../../scripts/apply-custom-object-relationship-deleted-members-migration.mjs';

const sql = await readFile(migrationUrl, 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'group-history-'));
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
    CREATE TABLE member(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, login_enabled boolean DEFAULT false);
    CREATE TABLE member_group(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text, is_active boolean DEFAULT true);
    CREATE TABLE member_group_assignment(id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
      group_id uuid REFERENCES member_group ON DELETE CASCADE,
      member_id uuid REFERENCES member ON DELETE CASCADE, guest_id uuid,
      group_role text, expires_at date, notes text, assignment_source text);
    INSERT INTO member VALUES ('${id(1)}','${id(100)}'), ('${id(2)}','${id(100)}'), ('${id(3)}','${id(200)}');
    INSERT INTO member_group VALUES ('${id(10)}','${id(100)}','One',true),
      ('${id(11)}','${id(100)}','Empty',false), ('${id(12)}','${id(200)}','Other tenant',true);
  `);
  const insert = (n, opts = {}, client = c) => client.query(`
    INSERT INTO member_group_assignment
      (id,tenant_id,group_id,member_id,guest_id,group_role,expires_at,assignment_source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [id(n), id(opts.tenant ?? 100), id(opts.group ?? 10),
    opts.member === null ? null : id(opts.member ?? 1), opts.guest ? id(90) : null,
    opts.role ?? 'Member', opts.expiry ?? null, opts.source ?? 'manual']);
  const rows = async () => (await c.query('SELECT * FROM member_group_membership_history ORDER BY id')).rows;
  return { c, connect, insert, rows };
}

test('baseline is forward-only, idempotent, tenant-safe; guests/expired excluded and empty groups retained', async t => {
  const { c, insert, rows } = await fixture(t);
  await insert(20); await insert(21); // duplicates retained as evidence, NOT additive counts
  await insert(22, { guest: true });
  await insert(23, { member: null, guest: true });
  await insert(24, { expiry: '2000-01-01' });
  await insert(25, { member: 3 }); // cross-tenant corrupt source excluded
  await insert(26, { tenant: 200, group: 12, member: 3 });
  const v = await runMigration(c, sql);
  assert.equal(v.intervals, 3); assert.equal(v.groups, 3);
  const before = await rows();
  assert.ok(before.every(r => r.is_baseline && +r.valid_from === +v.baseline));
  assert.equal(new Set(before.filter(r => r.tenant_id === id(100)).map(r => r.member_id)).size, 1);
  await runMigration(c, sql);
  assert.deepEqual(await rows(), before);
  assert.equal((await c.query('SELECT started_at FROM member_group_history_baseline')).rows[0].started_at.getTime(), v.baseline.getTime());
  for (const role of ['anon', 'authenticated']) {
    await c.query(`SET ROLE ${role}`);
    await assert.rejects(c.query('SELECT * FROM member_group_membership_history'), /permission denied/);
    await c.query('RESET ROLE');
  }
  await c.query('SET ROLE service_role');
  assert.equal((await c.query('SELECT * FROM member_group_membership_history')).rowCount, 3);
  await assert.rejects(c.query('DELETE FROM member_group_membership_history'), /permission denied/);
  await c.query('RESET ROLE');
});

test('insert, role/expiry edits, no-op edits, rollback, guest conversion, delete/rejoin and automatic writes', async t => {
  const { c, insert, rows } = await fixture(t);
  await runMigration(c, sql);
  await insert(20, { source: 'automatic', expiry: '2099-01-01' });
  await c.query(`UPDATE member_group_assignment SET notes='unrelated' WHERE id='${id(20)}'`);
  assert.equal((await rows()).length, 1);
  await c.query(`UPDATE member_group_assignment SET group_role='Chair' WHERE id='${id(20)}'`);
  let r = await rows();
  assert.equal(r.length, 2); assert.equal(r[0].valid_until.getTime(), r[1].valid_from.getTime());
  assert.equal(r[1].role, 'Chair'); assert.equal(r[1].is_baseline, false);
  await c.query(`UPDATE member_group_assignment SET expires_at='2100-01-01' WHERE id='${id(20)}'`);
  r = await rows();
  assert.equal(r[1].valid_until.getTime(), r[2].valid_from.getTime());
  assert.equal(r[2].valid_until.toISOString(), '2100-01-01T00:00:00.000Z');
  await c.query('BEGIN');
  await c.query(`DELETE FROM member_group_assignment WHERE id='${id(20)}'`);
  await c.query('ROLLBACK');
  assert.deepEqual(await rows(), r);
  await c.query(`UPDATE member_group_assignment SET expires_at='2000-01-01' WHERE id='${id(20)}'`);
  r = await rows();
  assert.equal(r.length, 3); assert.equal(r[2].source_open, false);
  assert.ok(r[2].valid_until >= r[2].valid_from); // shortening never rewrites past membership
  await c.query(`UPDATE member_group_assignment SET expires_at=NULL WHERE id='${id(20)}'`);
  await c.query(`UPDATE member_group_assignment SET guest_id='${id(90)}' WHERE id='${id(20)}'`);
  assert.equal((await rows()).filter(x => x.source_open).length, 0);
  await c.query(`UPDATE member_group_assignment SET guest_id=NULL WHERE id='${id(20)}'`);
  await c.query(`DELETE FROM member_group_assignment WHERE id='${id(20)}'`);
  await insert(20);
  r = await rows();
  assert.equal(r.length, 6); assert.equal(r.filter(x => x.source_open).length, 1);
  assert.ok(r.at(-1).valid_from >= r.at(-2).valid_until);
});

test('natural expiry is enforced without writes; renewals after a gap preserve expiry; UTC dates independent of session TZ', async t => {
  const { c, insert, rows } = await fixture(t);
  await runMigration(c, sql);
  await c.query("SET timezone='Pacific/Auckland'");
  await insert(20, { expiry: '2099-01-01' });
  assert.equal((await rows())[0].valid_until.toISOString(), '2099-01-01T00:00:00.000Z');
  const count = async at => +(await c.query(`SELECT count(*) FROM member_group_membership_history
    WHERE valid_from <= $1::timestamptz AND (valid_until IS NULL OR valid_until > $1::timestamptz)`, [at])).rows[0].count;
  assert.equal(await count('2098-12-31T23:59:59Z'), 1);
  assert.equal(await count('2099-01-01T00:00:00Z'), 0);
  // Move only fixture evidence back in time to simulate an already elapsed expiry.
  await c.query(`UPDATE member_group_membership_history SET valid_from='2000-01-01Z',valid_until='2001-01-01Z'`);
  await c.query(`UPDATE member_group_assignment SET expires_at='2100-01-01' WHERE id='${id(20)}'`);
  const r = await rows();
  assert.equal(r[0].valid_until.toISOString(), '2001-01-01T00:00:00.000Z');
  assert.ok(r[1].valid_from > r[0].valid_until);
});

test('group/member cascades close intervals and retain identities and historical member UUIDs', async t => {
  const { c, insert, rows } = await fixture(t);
  await runMigration(c, sql);
  await insert(20); await insert(21, { member: 2 }); await insert(22, { group: 11 });
  await c.query(`UPDATE member_group SET name='Renamed',is_active=false WHERE id='${id(10)}'`);
  await c.query(`DELETE FROM member WHERE id='${id(1)}'`);
  let r = await rows();
  assert.equal(r.filter(x => x.member_id === id(1) && x.source_open).length, 0);
  assert.equal(r.filter(x => x.member_id === id(1)).length, 2);
  await c.query(`DELETE FROM member_group WHERE id='${id(10)}'`);
  r = await rows();
  assert.equal(r.filter(x => x.source_open).length, 0);
  const identity = (await c.query(`SELECT * FROM member_group_history_group WHERE group_id='${id(10)}'`)).rows[0];
  assert.equal(identity.name, 'Renamed'); assert.ok(identity.deleted_at);
  assert.equal((await c.query('SELECT * FROM member_group_assignment')).rowCount, 0);
});

test('baseline waits for pre-existing writer; source writes block until snapshot AND triggers commit', async t => {
  const { c, connect, insert, rows } = await fixture(t);
  const writer = await connect();
  await writer.query('BEGIN');
  await insert(20, {}, writer);
  let done = false;
  const migration = runMigration(c, sql).then(v => { done = true; return v; });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(done, false);
  await writer.query('COMMIT');
  await migration;
  assert.equal((await rows())[0].is_baseline, true);
  // Recreate the initial installation boundary inside a transaction, while the
  // writer attempts another INSERT. It must not slip between snapshot/triggers.
  await c.query('BEGIN');
  await c.query(sql);
  done = false;
  const writing = insert(21, { member: 2 }, writer).then(() => { done = true; });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(done, false);
  await c.query('COMMIT');
  await writing;
  assert.equal((await rows()).at(-1).is_baseline, false);
});

test('concurrent edits serialize per assignment and never leave two open intervals', async t => {
  const { c, connect, insert, rows } = await fixture(t);
  await runMigration(c, sql); await insert(20);
  const writer = await connect();
  await c.query('BEGIN');
  await c.query(`UPDATE member_group_assignment SET group_role='Chair' WHERE id='${id(20)}'`);
  const waiting = writer.query(`UPDATE member_group_assignment SET group_role='Secretary' WHERE id='${id(20)}'`);
  await new Promise(r => setTimeout(r, 50));
  await c.query('COMMIT'); await waiting;
  const r = await rows();
  assert.equal(r.length, 3); assert.equal(r.filter(x => x.source_open).length, 1);
  assert.equal(r.at(-1).role, 'Secretary');
  assert.equal(r[0].valid_until.getTime(), r[1].valid_from.getTime());
  assert.equal(r[1].valid_until.getTime(), r[2].valid_from.getTime());
});

test('destination runner refuses source/wrong host and unsafe connection overrides', () => {
  const env = { DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co',
    DEST_DATABASE_URL: 'postgres://postgres.lvmzliemqnieeoruhkik:fake@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' };
  assert.equal(destinationTarget(env).hostname, 'aws-1-eu-central-1.pooler.supabase.com');
  assert.throws(() => destinationTarget({ ...env, DEST_DATABASE_URL: env.DEST_DATABASE_URL + '?host=evil.example' }));
  assert.throws(() => destinationTarget({ ...env, DEST_SUPABASE_URL: 'https://source.supabase.co' }));
  assert.throws(() => destinationTarget({ ...env, DEST_DATABASE_URL: env.DEST_DATABASE_URL.replace('postgres.lvmzliemqnieeoruhkik:', 'postgres.other:') }));
});