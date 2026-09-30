import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createLocalPostgresHarness } from '../scripts/test-support/local-postgres-harness.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
test('applicant grant SQL restricts roles, tenant binding, reuse, and concurrent claims', async t => {
  const harness = await createLocalPostgresHarness('applicant-grants-');
  execFileSync('initdb', ['-D', harness.data, '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', harness.data, '-o', `-F -p ${harness.port} -k ${harness.socket}`, '-w', 'start'], { stdio: 'ignore' });
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    execFileSync('pg_ctl', ['-D', harness.data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    await harness.cleanup();
  });
  async function connect() {
    const c = new pg.Client({ host: harness.socket, port: harness.port, user: 'postgres', database: 'postgres' });
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

test('organization deletion detaches and revokes grants while preserving bound and draft history', async t => {
  const harness = await createLocalPostgresHarness('applicant-grant-fk-');
  execFileSync('initdb', ['-D', harness.data, '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', harness.data, '-o', `-F -p ${harness.port} -k ${harness.socket}`, '-w', 'start'], { stdio: 'ignore' });
  const c = new pg.Client({ host: harness.socket, port: harness.port, user: 'postgres', database: 'postgres' });
  await c.connect();
  t.after(async () => {
    await c.end();
    execFileSync('pg_ctl', ['-D', harness.data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    await harness.cleanup();
  });
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE tenant(id uuid PRIMARY KEY);
    CREATE TABLE form(id uuid PRIMARY KEY, tenant_id uuid);
    CREATE TABLE organization(id uuid PRIMARY KEY, tenant_id uuid);
    CREATE TABLE form_draft_submission(id uuid PRIMARY KEY);
    CREATE TABLE form_submission(id uuid PRIMARY KEY, tenant_id uuid, form_id uuid, organization_id uuid);
    INSERT INTO tenant VALUES ('${id(1)}');
    INSERT INTO form VALUES ('${id(3)}','${id(1)}');
    INSERT INTO organization VALUES ('${id(4)}','${id(1)}');
    INSERT INTO form_submission VALUES ('${id(10)}','${id(1)}','${id(3)}','${id(4)}');
  `);
  const initial = await readFile(new URL('./20260924_form_applicant_continuation.sql', import.meta.url), 'utf8');
  const forward = await readFile(new URL('./20260925_form_applicant_continuation_organization_detachment.sql', import.meta.url), 'utf8');
  await c.query(initial);
  await c.query(`
    INSERT INTO form_applicant_continuation
      (id,tenant_id,form_id,organization_id,token_hash,draft_token_hashes,configuration_digest,
       expires_at,submission_id,bound_at)
    VALUES
      ('${id(5)}','${id(1)}','${id(3)}','${id(4)}','bound-hash',ARRAY['draft-hash'],
       'digest',now()+interval '1 day','${id(10)}',now()),
      ('${id(6)}','${id(1)}','${id(3)}','${id(4)}','unbound-hash',ARRAY[]::text[],
       'digest',now()+interval '1 day',null,null);
    INSERT INTO form_draft_submission(id,applicant_continuation_id)
      VALUES ('${id(20)}','${id(5)}');
  `);

  await c.query(forward);
  await c.query(forward);
  await c.query(`DELETE FROM organization WHERE id='${id(4)}'`);

  const grants = await c.query(`
    SELECT id,organization_id,revoked_at,submission_id,bound_at,draft_token_hashes
    FROM form_applicant_continuation ORDER BY id
  `);
  assert.equal(grants.rowCount, 2);
  assert.ok(grants.rows.every(row => row.organization_id === null && row.revoked_at instanceof Date));
  assert.equal(grants.rows[0].submission_id, id(10));
  assert.ok(grants.rows[0].bound_at instanceof Date);
  assert.deepEqual(grants.rows[0].draft_token_hashes, ['draft-hash']);
  assert.deepEqual((await c.query('SELECT * FROM form_draft_submission')).rows, [{
    id: id(20), applicant_continuation_id: id(5),
  }]);

  assert.equal((await c.query(
    'SELECT bind_form_applicant_continuation($1,$2,$3,$4,$5) AS bound',
    [id(5), id(1), id(3), id(10), 'digest'],
  )).rows[0].bound, false);
  assert.equal((await c.query(
    'SELECT bind_form_applicant_draft($1,$2,$3) AS bound',
    [id(5), id(1), 'another-draft'],
  )).rows[0].bound, false);
  await assert.rejects(
    c.query('UPDATE form_applicant_continuation SET organization_id=$1 WHERE id=$2', [id(7), id(5)]),
    /cannot be rebound/,
  );
  await assert.rejects(
    c.query('UPDATE form_applicant_continuation SET revoked_at=null WHERE id=$1', [id(5)]),
    /cannot be reactivated/,
  );

  const fk = await c.query(`
    SELECT con.confdeltype, a.attnotnull
    FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attname='organization_id'
    WHERE con.conrelid='form_applicant_continuation'::regclass
      AND con.conname='form_applicant_continuation_organization_id_fkey'
  `);
  assert.deepEqual(fk.rows, [{ confdeltype: 'n', attnotnull: false }]);
});
