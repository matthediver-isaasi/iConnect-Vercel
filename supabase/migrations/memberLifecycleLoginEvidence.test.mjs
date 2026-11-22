import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

test('genuine login evidence is atomic, tenant scoped, replay safe and service only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lifecycle-login-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  const port = String(22000 + process.pid % 15000);
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const tenant = '11111111-1111-4111-8111-111111111111';
  const member = '22222222-2222-4222-8222-222222222222';
  const other = '33333333-3333-4333-8333-333333333333';
  const event = '44444444-4444-4444-8444-444444444444';
  const org = '55555555-5555-4555-8555-555555555555';
  let started = false, client;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    client = new pg.Client({ host: socket, port: Number(port), user: 'postgres', database: 'postgres' });
    await client.connect();
    const sql = (query, params) => client.query(query, params);
    await sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS
        $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,email text);
      CREATE TABLE session(sid text PRIMARY KEY,sess json NOT NULL,expire timestamptz NOT NULL);
      GRANT SELECT,INSERT,UPDATE,DELETE ON session TO service_role;
      INSERT INTO organization VALUES('${org}','${tenant}');
      INSERT INTO member VALUES('${member}','${tenant}',NULL,'fixture@example.invalid'),
        ('${other}',NULL,'${org}','legacy@example.invalid');`);
    const migration = await readFile(new URL('20261122_member_lifecycle_login_evidence.sql', import.meta.url), 'utf8');
    await sql(migration);
    await sql(migration);
    for (const role of ['anon', 'authenticated']) {
      const row = (await sql(`SELECT has_table_privilege($1,'member_lifecycle_login_evidence','SELECT') r,
        has_table_privilege($1,'member_lifecycle_login_evidence','INSERT') w,
        has_function_privilege($1,'capture_member_lifecycle_login()','EXECUTE') f`, [role])).rows[0];
      assert.deepEqual(row, { r: false, w: false, f: false });
    }
    await sql("SET ROLE service_role; SET request.jwt.claim.role='service_role'");
    const base = { userType: 'member', tenantId: tenant, memberId: member, cookie: { secure: true } };
    const marker = { id: event, source: 'password', version: 1 };
    const insert = (id, session = base, expiry = '2100-01-01') =>
      sql('INSERT INTO session VALUES($1,$2,$3)', [id, JSON.stringify(session), expiry]);
    const update = (id, session) => sql('UPDATE session SET sess=$2 WHERE sid=$1', [id, JSON.stringify(session)]);
    await insert('one');
    assert.equal((await sql('SELECT count(*)::int n FROM member_lifecycle_login_evidence')).rows[0].n, 0);
    await update('one', { ...base, memberLoginEvidence: marker });
    const observed = (await sql('SELECT * FROM member_lifecycle_login_evidence')).rows[0];
    assert.equal(observed.id, event);
    assert.equal(observed.member_id, member);
    assert.equal(observed.tenant_id, tenant);
    assert.equal(observed.source, 'password');
    // Refresh and promotion retain the original immutable event.
    await update('one', { ...base, userType: 'tenant_user', tenantUserId: 'team',
      memberLoginEvidence: marker });
    assert.deepEqual((await sql('SELECT * FROM member_lifecycle_login_evidence')).rows, [observed]);
    await sql("DELETE FROM session WHERE sid='one'");
    assert.equal((await sql('SELECT count(*)::int n FROM member_lifecycle_login_evidence')).rows[0].n, 1);
    await assert.rejects(sql('DELETE FROM member_lifecycle_login_evidence'), /permission denied/);
    await assert.rejects(sql("UPDATE member_lifecycle_login_evidence SET source='google'"), /permission denied/);
    await assert.rejects(insert('copied', { ...base, memberLoginEvidence: marker }), /newly finalized/);
    // No token, email, IP or complete session payload is persisted in the evidence.
    assert.deepEqual(Object.keys(observed).sort(), ['id','member_id','occurred_at','source','tenant_id']);

    for (const [id, extra] of [
      ['masquerade', { isMasquerading: true }],
      ['platform', { isPlatformImpersonation: true }],
      ['team', { tenantUserId: 'team' }],
      ['promoted', { promotedFromMember: true }],
      ['admin-lineage', { masqueradeAdminSessionId: 'admin' }],
      ['wrong-tenant', { tenantId: other }],
    ]) {
      const initial = { ...base, ...extra };
      await insert(id, initial);
      await assert.rejects(update(id, { ...initial, memberLoginEvidence: { ...marker, id: other } }));
      const stored = (await sql('SELECT sess FROM session WHERE sid=$1', [id])).rows[0].sess;
      assert.equal(stored.memberLoginEvidence, undefined);
    }
    await insert('expired', base, '2000-01-01');
    await assert.rejects(update('expired', { ...base, memberLoginEvidence: marker }), /Invalid genuine/);
    await insert('changed');
    await assert.rejects(update('changed', { ...base, memberId: other, memberLoginEvidence: marker }), /Invalid genuine/);
    await insert('retry');
    await assert.rejects(update('retry', { ...base, memberLoginEvidence: marker }), /duplicate key/);
    assert.equal((await sql('SELECT count(*)::int n FROM member_lifecycle_login_evidence')).rows[0].n, 1);

    const legacy = { ...base, memberId: other };
    await insert('legacy', legacy);
    await update('legacy', { ...legacy, memberLoginEvidence: { ...marker, id: other, source: 'google' } });
    assert.equal((await sql('SELECT count(*)::int n FROM member_lifecycle_login_evidence')).rows[0].n, 2);
    await sql("SET request.jwt.claim.role='authenticated'");
    await insert('untrusted');
    await assert.rejects(update('untrusted', { ...base, memberLoginEvidence: { ...marker, id: tenant } }), /service_role/);
    await sql('RESET ROLE');
    assert.equal((await sql("SELECT email FROM member WHERE id=$1", [member])).rows[0].email, 'fixture@example.invalid');
    assert.equal((await sql("SELECT relrowsecurity FROM pg_class WHERE relname='member_lifecycle_login_evidence'")).rows[0].relrowsecurity, true);
  } finally {
    await client?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
