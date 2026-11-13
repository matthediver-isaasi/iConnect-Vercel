import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('document bucket is private; anonymous and authenticated storage access is denied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'member-documents-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  const run = (command, args, input = '') => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  let started = false;
  try {
    run('initdb', ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'log'), '-o', `-k ${socket} -h ''`, '-w', 'start']);
    started = true;
    const sql = text => run('psql', ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1'], text);
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint);
      CREATE TABLE storage.objects(id int,bucket_id text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;
      CREATE POLICY existing_permissive ON storage.objects FOR ALL USING(true) WITH CHECK(true);
      INSERT INTO storage.objects VALUES(1,'member-note-documents'),(2,'unrelated');`);
    const migration = await readFile(new URL('../../supabase/migrations/202701210001_member_note_documents.sql', import.meta.url), 'utf8');
    sql(migration);
    sql(migration);
    assert.equal(sql('SET ROLE service_role; SELECT public.member_note_documents_ready();').split('\n').at(-1), 't');
    for (const role of ['anon', 'authenticated']) {
      assert.equal(sql(`SET ROLE ${role}; SELECT count(*) FROM storage.objects WHERE bucket_id='member-note-documents';`).split('\n').at(-1), '0');
      assert.equal(sql(`SET ROLE ${role}; SELECT count(*) FROM storage.objects WHERE bucket_id='unrelated';`).split('\n').at(-1), '1');
      const denied = spawnSync('psql', ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1'],
        { input: `SET ROLE ${role}; INSERT INTO storage.objects VALUES(3,'member-note-documents');`, encoding: 'utf8' });
      assert.notEqual(denied.status, 0);
    }
    assert.equal(sql("SELECT public FROM storage.buckets WHERE id='member-note-documents';"), 'f');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
