import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { convert, parseGrid, makePlan, applyUpdates, FIELD, TENANT } from './correct-bnms-member-expiry-dates.mjs';

const id = '10000000-0000-4000-8000-000000000001';
const pref = '20000000-0000-4000-8000-000000000001';
const grid = [['member_id', 'YM Date Membership Expires'], [id, '1/13/27']];
const source = parseGrid(grid, 1);
const members = [{ id, tenant_id: TENANT }];
const values = [{ id: pref, member_id: id, field_id: FIELD, value: '1/13/27' }];

test('US parsing, actual years, padding and invalid dates', () => {
  assert.equal(convert('1/2/24'), '02/01/2024');
  assert.equal(convert('1/13/27'), '13/01/2027');
  assert.equal(convert('2/29/24'), '29/02/2024');
  assert.equal(convert('12/1/25'), '01/12/2025');
  assert.equal(convert('9/20/26'), '20/09/2026');
  for (const bad of ['2/29/25', '4/31/26', '13/1/27', '0/1/26', '1/0/26', '1/1/99', '1/1/2027', 1]) {
    assert.throws(() => convert(bad));
  }
});
test('source identities and scope fail closed; missing/conflicting values never become writes', () => {
  assert.throws(() => parseGrid([...grid, grid[1]], 2), /Duplicate/);
  assert.throws(() => makePlan(source, [{ id, tenant_id: id }], values), /cross-tenant/);
  assert.throws(() => makePlan(source, [], values), /Missing/);
  assert.throws(() => makePlan(source, members, [...values, ...values]), /Duplicate/);
  assert.equal(makePlan(source, members, [])[0].action, 'blocked-missing');
  assert.equal(makePlan(source, members, [{ ...values[0], value: 'newer' }])[0].action, 'blocked-conflict');
  assert.equal(makePlan(source, members, [{ ...values[0], value: '13/01/2027' }])[0].action, 'unchanged');
});

test('real isolated PostgreSQL: CAS rejects concurrent edits and rolls back partial updates', async () => {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const root = mkdtempSync(path.join(tmpdir(), 'expiry-cas-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  mkdirSync(socket);
  run('initdb', ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
  run('pg_ctl', ['-D', data, '-l', path.join(root, 'log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']);
  const db = new pg.Client({ host: socket, user: 'postgres', database: 'postgres' });
  try {
    await db.connect();
    await db.query(`CREATE TABLE member(id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE member_preference_value(id uuid PRIMARY KEY, member_id uuid, field_id uuid, value text,
        created_at timestamptz DEFAULT '2026-09-20 12:00:00.123456+00')`);
    await db.query('INSERT INTO member VALUES($1,$2)', [id, TENANT]);
    await db.query('INSERT INTO member_preference_value VALUES($1,$2,$3,$4)', [pref, id, FIELD, '1/13/27']);
    const snapshot = (await db.query('SELECT to_jsonb(v) AS data FROM member_preference_value v')).rows.map(r => r.data);
    const plan = makePlan(source, members, snapshot);
    await db.query("UPDATE member_preference_value SET value='concurrent edit'");
    await db.query('BEGIN');
    await assert.rejects(applyUpdates(db, plan), /Concurrent edit/);
    await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT value FROM member_preference_value')).rows[0].value, 'concurrent edit');
    await db.query("UPDATE member_preference_value SET value='1/13/27'");
    await db.query('BEGIN');
    const missing = { ...plan[0], before: { ...plan[0].before, id: '20000000-0000-4000-8000-000000000002' } };
    await assert.rejects(applyUpdates(db, [...plan, missing]), /Concurrent edit/);
    await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT value FROM member_preference_value')).rows[0].value, '1/13/27');
    await db.query('BEGIN');
    assert.equal(await applyUpdates(db, plan), 1);
    await db.query('COMMIT');
    const after = (await db.query('SELECT * FROM member_preference_value')).rows;
    assert.equal(await applyUpdates(db, makePlan(source, members, after)), 0);
    await db.query('UPDATE member SET tenant_id=$1', [id]);
    await db.query("UPDATE member_preference_value SET value='1/13/27'");
    await assert.rejects(applyUpdates(db, plan), /Concurrent edit/);
  } finally {
    await db.end();
    run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});