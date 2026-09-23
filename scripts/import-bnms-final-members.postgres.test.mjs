import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { insertRow, verifySafeMembers } from './import-bnms-final-members.mjs';

test('disposable PostgreSQL: atomic metadata rollback, readback and blocking concurrent identity writes', async () => {
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  const root = mkdtempSync(path.join(tmpdir(), 'bnms-final-pg-')), socket = path.join(root, 'socket'), data = path.join(root, 'data');
  mkdirSync(socket);
  const port = 55449;
  let started = false;
  const a = new pg.Client({ host: socket, port, user: 'postgres', database: 'postgres' });
  const b = new pg.Client({ host: socket, port, user: 'postgres', database: 'postgres' });
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'pg.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start']); started = true;
    await a.connect(); await b.connect();
    await a.query(`create table member(id uuid primary key,tenant_id uuid,email text,first_name text,last_name text,mobile text,
      organization_group_id uuid,organization_id uuid,login_enabled boolean,role_id uuid,identity_id uuid,google_id text,created_on timestamptz,show_in_directory boolean);
      create table member_preference_value(member_id uuid references member(id),field_id uuid,value text);
      create table member_resource_category(member_id uuid references member(id),resource_category_id uuid,subcategory_name text);`);
    const values = Array(21).fill(''); values[0] = '123'; values[5] = 'Test'; values[6] = 'Only';
    const row = { values, email: 'fixture@example.invalid' }, id = '00000000-0000-4000-8000-000000000001';
    await a.query('begin');
    await insertRow(a, row, id);
    await assert.rejects(a.query("insert into member_preference_value values ('00000000-0000-4000-8000-000000000099',gen_random_uuid(),'invalid')"));
    await a.query('rollback');
    assert.equal((await a.query('select count(*)::int n from member')).rows[0].n, 0);
    assert.equal((await a.query('select count(*)::int n from member_preference_value')).rows[0].n, 0);
    await a.query('begin');
    await a.query('lock table member,member_preference_value in share row exclusive mode');
    await b.query("set lock_timeout='100ms'");
    await assert.rejects(b.query("insert into member(id,email) values(gen_random_uuid(),'fixture@example.invalid')"), e => e.code === '55P03');
    await insertRow(a, row, id); await verifySafeMembers(a, [id]); await a.query('commit');
    await verifySafeMembers(b, [id]);
    assert.equal((await b.query('select count(*)::int n from member')).rows[0].n, 1);
    // Reserved-ID replay cannot accidentally create a second record.
    await assert.rejects(insertRow(b, row, id), e => e.code === '23505');
    assert.equal((await b.query('select count(*)::int n from member')).rows[0].n, 1);
  } finally {
    await a.end().catch(() => {}); await b.end().catch(() => {});
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});