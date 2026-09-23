import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
test('applicant grant SQL restricts roles, tenant binding, reuse, and concurrent claims', async t => {
  const root = await mkdtemp(join(tmpdir(), 'applicant-grants-'));
  const port = 46000 + Math.floor(Math.random() * 10000);
  execFileSync('initdb', ['-D', join(root, 'data'), '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', join(root, 'data'), '-o', `-F -p ${port} -k ${root}`, '-w', 'start'], { stdio: 'ignore' });
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    execFileSync('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    await rm(root, { recursive: true, force: true });
  });
  async function connect() {
    const c = new pg.Client({ host: root, port, user: 'postgres', database: 'postgres' });
    await c.connect(); clients.push(c); return c;
  }
  const c = await connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE tenant(id uuid PRIMARY KEY);
    CREATE TABLE form(id uuid PRIMARY KEY, tenant_id uuid);
    CREATE TABLE organization(id uuid PRIMARY KEY, tenant_id uuid);
    CREATE TABLE form_draft_submission(id uuid PRIMARY KEY);
    CREATE TABLE form_submission(id uuid PRIMARY KEY, tenant_id uuid, form_id uuid, organization_id uuid);
    INSERT INTO tenant VALUES ('${id(1)}'),('${id(2)}');
    INSERT INTO form VALUES ('${id(3)}','${id(1)}');
    INSERT INTO organization VALUES ('${id(4)}','${id(1)}');
    INSERT INTO form_submission VALUES
      ('${id(10)}','${id(1)}','${id(3)}','${id(4)}'),
      ('${id(11)}','${id(1)}','${id(3)}','${id(4)}'),
      ('${id(12)}','${id(2)}','${id(3)}','${id(4)}');
  `);
  const sql = await readFile(new URL('./20260924_form_applicant_continuation.sql', import.meta.url), 'utf8');
  await c.query(sql);
  await c.query(`INSERT INTO form_applicant_continuation
    (id,tenant_id,form_id,organization_id,token_hash,configuration_digest,expires_at)
    VALUES ($1,$2,$3,$4,'hash','digest',now()+interval '1 day')`, [id(5),id(1),id(3),id(4)]);
  const bind = (client, submission, tenant = id(1), digest = 'digest') => client.query(
    'SELECT bind_form_applicant_continuation($1,$2,$3,$4,$5) AS bound',
    [id(5),tenant,id(3),submission,digest],
  ).then(r => r.rows[0].bound);
  for (const role of ['anon', 'authenticated']) {
    await c.query(`SET ROLE ${role}`);
    await assert.rejects(c.query('SELECT * FROM form_applicant_continuation'), /permission denied/);
    await assert.rejects(bind(c,id(10)), /permission denied/);
    await assert.rejects(c.query('SELECT bind_form_applicant_draft($1,$2,$3)',[id(5),id(1),'draft-hash']), /permission denied/);
    await c.query('RESET ROLE');
  }
  assert.equal(await bind(c,id(12)),false);
  assert.equal(await bind(c,id(10),id(2)),false);
  assert.equal(await bind(c,id(10),id(1),'modified'),false);
  const other = await connect();
  const results = await Promise.all([bind(c,id(10)),bind(other,id(11))]);
  assert.equal(results.filter(Boolean).length,1);
  const winner = results[0] ? id(10) : id(11);
  assert.equal(await bind(c,winner),true);
  await c.query("UPDATE form_applicant_continuation SET revoked_at=now()");
  assert.equal(await bind(c,winner),false);
  await c.query("UPDATE form_applicant_continuation SET revoked_at=null, expires_at=now()-interval '1 day'");
  assert.equal(await bind(c,winner),false);
});