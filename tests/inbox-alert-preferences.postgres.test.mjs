import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('popup preferences isolate members, tenants, and logins; patch independently and deny browser roles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inbox-alert-pg-'));
  const data = path.join(root, 'data');
  const port = String(20000 + process.pid % 20000);
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { encoding: 'utf8', input });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const args = ['-h', root, '-p', port, '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
  const sql = input => run('psql', args, input);
  const t = '00000000-0000-4000-8000-000000000001';
  const m = '00000000-0000-4000-8000-000000000002';
  const other = '00000000-0000-4000-8000-000000000003';
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${root} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY); CREATE TABLE member(id uuid PRIMARY KEY);
      CREATE TABLE session(sid varchar PRIMARY KEY);
      INSERT INTO tenant VALUES ('${t}'), ('${other}');
      INSERT INTO member VALUES ('${m}'), ('${other}');
      INSERT INTO session VALUES ('login-one'), ('login-two');
    `);
    sql(await readFile('supabase/migrations/20261006_inbox_alert_preferences.sql', 'utf8'));
    const patch = (field, value, sid = 'login-one') => sql(`SET ROLE service_role;
      SELECT set_inbox_alert_preference('${sid}', '${t}', '${m}', '${field}', ${value});`);
    patch('hide_until_login', true);
    patch('shown', true);
    assert.equal(sql('SELECT hide_until_login AND shown FROM member_inbox_alert_login'), 't');
    patch('always_hide', true);
    patch('shown', true, 'login-two');
    assert.equal(sql("SELECT hide_until_login FROM member_inbox_alert_login WHERE sid='login-two'"), 'f');
    assert.equal(sql(`SELECT always_hide FROM member_inbox_alert_preference WHERE member_id='${m}' AND tenant_id='${t}'`), 't');
    assert.equal(sql(`SELECT count(*) FROM member_inbox_alert_preference WHERE member_id='${other}' OR tenant_id='${other}'`), '0');
    patch('hide_until_login', false);
    assert.equal(sql("SELECT shown FROM member_inbox_alert_login WHERE sid='login-one'"), 'f');
    assert.equal(sql("SELECT shown FROM member_inbox_alert_login WHERE sid='login-two'"), 't');
    for (const role of ['anon', 'authenticated']) {
      const denied = spawnSync('psql', args, { encoding: 'utf8', input: `SET ROLE ${role}; SELECT * FROM member_inbox_alert_preference;` });
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /permission denied/);
      const rpc = spawnSync('psql', args, { encoding: 'utf8', input: `SET ROLE ${role}; SELECT set_inbox_alert_preference('login-one','${t}','${m}','always_hide',false);` });
      assert.notEqual(rpc.status, 0);
    }
    sql("DELETE FROM session WHERE sid='login-one'");
    assert.equal(sql("SELECT count(*) FROM member_inbox_alert_login WHERE sid='login-one'"), '0');
    assert.equal(sql('SELECT always_hide FROM member_inbox_alert_preference'), 't');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
