import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

test('issued certificate migration protects immutable metadata and private PDFs even with broad storage policies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'issued-cpd-'));
  const socket = join(root, 'socket');
  await mkdir(socket);
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const db = new pg.Client({ host: socket, port: 55449, user: 'postgres', database: 'postgres' });
  let started = false;
  try {
    run('initdb', ['-D', join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'log'), '-o', `-k ${socket} -p 55449 -h ''`, '-w', 'start']);
    started = true; await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean);
      CREATE TABLE storage.objects(id text,bucket_id text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO anon,authenticated;
      GRANT ALL ON storage.objects TO anon,authenticated;
      CREATE POLICY broad ON storage.objects FOR ALL TO anon,authenticated USING(true) WITH CHECK(true);`);
    await db.query(await readFile('supabase/migrations/202612090012_issued_cpd_certificates.sql', 'utf8'));
    await db.query(`INSERT INTO storage.objects VALUES ('private','issued-cpd-certificates'),('other','unrelated');
      SET ROLE authenticated;`);
    assert.deepEqual((await db.query('SELECT id FROM storage.objects')).rows, [{ id: 'other' }]);
    await assert.rejects(db.query("INSERT INTO storage.objects VALUES('forged','issued-cpd-certificates')"), { code: '42501' });
    await assert.rejects(db.query('SELECT * FROM issued_cpd_certificate'), { code: '42501' });
    await db.query('RESET ROLE; SET ROLE service_role');
    const tenant = '11111111-1111-4111-8111-111111111111';
    const insert = `INSERT INTO issued_cpd_certificate(tenant_id,certificate_key,source_path,pdf_sha256,snapshot,capture_reason)
      VALUES($1,$2,$3,$4,'{}','member_download')`;
    const args = [tenant, `historic:${tenant}`, `${tenant}/issued-cpd/file.pdf`, 'a'.repeat(64)];
    await db.query(insert, args);
    assert.equal((await db.query('SELECT * FROM issued_cpd_certificate')).rowCount, 1);
    await assert.rejects(db.query(insert, args), { code: '23505' });
    await assert.rejects(db.query("UPDATE issued_cpd_certificate SET snapshot='{}'"), { code: '42501' });
    await assert.rejects(db.query('DELETE FROM issued_cpd_certificate'), { code: '42501' });
    await db.query('RESET ROLE');
    assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='issued-cpd-certificates'")).rows[0].public, false);
  } finally {
    await db.end().catch(() => {});
    if (started) run('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
