import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

test('historic singleton ownership, concurrent replacement, lifecycle invalidation and server-only grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'historic-cpd-'));
  const socket = join(root, 'socket');
  await mkdir(socket);
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const client = new pg.Client({ host: socket, port: 55447, user: 'postgres', database: 'postgres' });
  const other = new pg.Client({ host: socket, port: 55447, user: 'postgres', database: 'postgres' });
  let started = false;
  try {
    run('initdb', ['-D', join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'log'), '-o', `-k ${socket} -p 55447 -h ''`, '-w', 'start']);
    started = true;
    await client.connect(); await other.connect();
    await client.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE cpd_certificate_template(id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenant,
        status text, version int, source_bucket text,source_path text,source_sha256 text,UNIQUE(tenant_id,id));`);
    await client.query(await readFile('supabase/migrations/20261208_historic_cpd_certificate.sql', 'utf8'));
    const tenant = '11111111-1111-4111-8111-111111111111';
    const foreign = '22222222-2222-4222-8222-222222222222';
    const a = '33333333-3333-4333-8333-333333333333';
    const b = '44444444-4444-4444-8444-444444444444';
    await client.query('INSERT INTO tenant VALUES($1),($2)', [tenant, foreign]);
    for (const id of [a, b]) await client.query(`INSERT INTO cpd_certificate_template VALUES
      ($1,$2,'active',1,'private-uploads',$3,$4)`, [id, tenant, `${tenant}/${id}.pdf`, 'a'.repeat(64)]);
    const select = (conn, id, version = 1, tid = tenant) => conn.query('SELECT set_historic_cpd_certificate($1,$2,$3)', [tid, id, version]);
    await Promise.all([select(client, a), select(other, b)]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM historic_cpd_certificate')).rows[0].n, 1);
    await assert.rejects(select(client, a, 2), { code: '40001' });
    await assert.rejects(select(client, a, 1, foreign), { code: '40001' });
    await assert.rejects(client.query('INSERT INTO historic_cpd_certificate VALUES($1,$2,gen_random_uuid())', [foreign, a]), { code: '23503' });
    await select(client, a);
    await client.query(`INSERT INTO cpd_certificate_template
      SELECT '55555555-5555-4555-8555-555555555555', tenant_id, 'draft', 1,
        source_bucket, source_path, source_sha256 FROM cpd_certificate_template WHERE id=$1`, [a]);
    assert.equal((await client.query('SELECT template_id FROM historic_cpd_certificate')).rows[0].template_id, a);
    await client.query('BEGIN');
    await client.query("UPDATE cpd_certificate_template SET status='archived',version=2 WHERE id=$1", [a]);
    const competing = select(other, a).then(() => null, error => error.code);
    await client.query('COMMIT');
    assert.equal(await competing, '40001');
    assert.equal((await client.query('SELECT * FROM historic_cpd_certificate')).rowCount, 0);
    await select(client, b);
    await select(client, null);
    assert.equal((await client.query('SELECT * FROM historic_cpd_certificate')).rowCount, 0);
    await select(client, b);
    await client.query('DELETE FROM cpd_certificate_template WHERE id=$1', [b]);
    assert.equal((await client.query('SELECT * FROM historic_cpd_certificate')).rowCount, 0);
    const privileges = (await client.query(`SELECT
      has_function_privilege('service_role','set_historic_cpd_certificate(uuid,uuid,integer)','EXECUTE') AS allowed,
      has_function_privilege('authenticated','set_historic_cpd_certificate(uuid,uuid,integer)','EXECUTE') AS forbidden,
      has_table_privilege('service_role','historic_cpd_certificate','INSERT') AS direct`)).rows[0];
    assert.deepEqual(privileges, { allowed: true, forbidden: false, direct: false });
  } finally {
    await other.end().catch(() => {}); await client.end().catch(() => {});
    if (started) run('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
