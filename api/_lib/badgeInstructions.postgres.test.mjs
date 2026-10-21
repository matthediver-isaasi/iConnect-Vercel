import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const migration = fileURLToPath(new URL('../../supabase/migrations/202611100001_tenant_badge_instructions.sql', import.meta.url));
const tenant = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const first = '10000000-0000-4000-8000-000000000001';
const second = '10000000-0000-4000-8000-000000000002';
const third = '10000000-0000-4000-8000-000000000003';
function run(command, args, input, ok = true) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 4 * 1024 * 1024 });
  if (ok) assert.equal(result.status, 0, result.stderr || result.stdout);
  else assert.notEqual(result.status, 0, 'Expected rejection');
  return (ok ? result.stdout : result.stderr).trim();
}
function asyncSql(args, input) {
  return new Promise(resolve => {
    const child = spawn('psql', args);
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.on('close', status => resolve({ status, output: output.trim(), error }));
    child.stdin.end(input);
  });
}

test('disposable PostgreSQL: singleton, CAS races, tenant boundaries, RLS, quota, lifecycle and durable cleanup', { timeout: 60000 }, async t => {
  for (const executable of ['initdb', 'pg_ctl', 'psql']) {
    if (!(process.env.PATH || '').split(path.delimiter).some(dir => existsSync(path.join(dir, executable)))) {
      t.skip('PostgreSQL binaries unavailable'); return;
    }
  }
  const root = await mkdtemp(path.join(tmpdir(), 'badge-instructions-pg-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  let started = false;
  const args = ['-h', socket, '-p', '5432', '-U', 'postgres', '-d', 'postgres',
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
  const sql = input => run('psql', args, input);
  const denied = input => run('psql', args, input, false);
  const rpc = (action, revision = 'NULL', object = 'NULL', filename = 'NULL', size = 'NULL', mode = 'NULL', tid = tenant, backup = 'NULL') =>
    `SELECT public.badge_instructions_mutate('${tid}', '${action}', ${revision}, ${object}, ${filename}, ${size}, ${mode}, ${backup});`;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o',
      `-F -k ${socket} -c listen_addresses= -p 5432`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.tenant(id uuid PRIMARY KEY, storage_used_bytes bigint NOT NULL DEFAULT 0, plan_code text);
      CREATE TABLE public.plan(code text PRIMARY KEY, quotas jsonb);
      CREATE TABLE public.system_settings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
        setting_key text NOT NULL, setting_value text NOT NULL);
      ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
      GRANT ALL ON public.system_settings TO authenticated, service_role;
      CREATE POLICY broad_legacy_access ON public.system_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(), bucket_id text, name text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO authenticated;
      GRANT ALL ON storage.objects TO authenticated;
      CREATE POLICY broad_legacy_storage ON storage.objects FOR ALL TO authenticated USING (true) WITH CHECK (true);
      INSERT INTO public.tenant(id,plan_code) VALUES ('${tenant}','free'), ('${other}','free');
      INSERT INTO public.plan VALUES ('free','{"storage_mb":1}');
    `);
    run('psql', [...args, '-f', migration]);
    run('psql', [...args, '-f', migration]); // idempotent
    assert.equal(sql("SELECT public FROM storage.buckets WHERE id='badge-instructions'"), 'f');
    assert.match(denied(`SET ROLE authenticated; ${rpc('delete')}`), /permission denied/);
    assert.match(denied(`SET ROLE authenticated; SELECT * FROM public.badge_instruction_object;`), /permission denied/);
    assert.match(denied(`SET ROLE authenticated; INSERT INTO storage.objects(bucket_id,name) VALUES ('badge-instructions','${tenant}/x.pdf');`), /row-level security/);
    assert.match(denied(`SET ROLE service_role; INSERT INTO public.system_settings(tenant_id,setting_key,setting_value)
      VALUES ('${tenant}','tenant_badge_instructions','{}');`), /dedicated endpoint/);

    // Two first writes share the same NULL revision; tenant locking + CAS
    // allows exactly one winner even though no setting row exists initially.
    const racers = await Promise.all([1, 2].map(() => asyncSql(args, `SET ROLE service_role; ${rpc('mode', 'NULL', 'NULL', 'NULL', 'NULL', "'standard'")}`)));
    assert.equal(racers.filter(r => r.status === 0).length, 1);
    assert.match(racers.find(r => r.status !== 0).error, /changed/);
    assert.equal(sql(`SELECT count(*) FROM system_settings WHERE tenant_id='${tenant}' AND setting_key='tenant_badge_instructions'`), '1');
    let revision = JSON.parse(racers.find(r => r.status === 0).output).revision;
    assert.match(denied(`SET ROLE service_role; ${rpc('mode', `'${revision}'`, 'NULL', 'NULL', 'NULL', "'pdf'")}`), /valid PDF first/);
    sql(`SET ROLE service_role; ${rpc('prepare', `'${revision}'`, `'${first}'`, "'first.pdf'", '100')}`);
    const uploaded = JSON.parse(sql(`SET ROLE service_role; ${rpc('upload', `'${revision}'`, `'${first}'`)}`));
    assert.equal(uploaded.mode, 'standard'); // uploading never silently enables PDF
    revision = uploaded.revision;
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '100');
    assert.equal(sql(`SET ROLE authenticated; SELECT count(*) FROM system_settings WHERE setting_key='tenant_badge_instructions';`), '0');
    assert.match(denied(`SET ROLE service_role; UPDATE system_settings SET setting_key='another' WHERE tenant_id='${tenant}';`), /dedicated endpoint/);
    assert.match(denied(`SET ROLE service_role; DELETE FROM system_settings WHERE tenant_id='${tenant}';`), /dedicated endpoint/);

    // Mode transitions retain owned durable metadata; other tenants cannot
    // adopt, abandon or acknowledge this tenant's object.
    const enabled = JSON.parse(sql(`SET ROLE service_role; ${rpc('mode', `'${revision}'`, 'NULL', 'NULL', 'NULL', "'pdf'")}`));
    revision = enabled.revision;
    assert.equal(enabled.document.id, first);
    assert.match(denied(`SET ROLE service_role; ${rpc('upload', 'NULL', `'${first}'`, 'NULL', 'NULL', 'NULL', other)}`), /expired/);
    sql(`SET ROLE service_role; ${rpc('abandon', 'NULL', `'${first}'`, 'NULL', 'NULL', 'NULL', other)}`);
    assert.equal(sql(`SELECT state FROM badge_instruction_object WHERE id='${first}'`), 'current');
    assert.match(denied(`SET ROLE service_role; ${rpc('prepare', `'${revision}'`, `'${second}'`, "'large.pdf'", '1048576')}`), /quota exceeded/);
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '100');

    sql(`SET ROLE service_role; ${rpc('prepare', `'${revision}'`, `'${second}'`, "'second.pdf'", '200')}`);
    // A concurrent remove-from-use wins; stale replacement cannot commit.
    const removed = JSON.parse(sql(`SET ROLE service_role; ${rpc('mode', `'${revision}'`, 'NULL', 'NULL', 'NULL', "'standard'")}`));
    assert.match(denied(`SET ROLE service_role; ${rpc('upload', `'${revision}'`, `'${second}'`)}`), /changed/);
    assert.equal(sql(`SELECT state FROM badge_instruction_object WHERE id='${first}'`), 'current');
    sql(`SET ROLE service_role; ${rpc('abandon', 'NULL', `'${second}'`)}`);
    sql(`SET ROLE service_role; ${rpc('cleanup_ack', 'NULL', `'${second}'`)}`);
    sql(`SET ROLE service_role; ${rpc('cleanup_ack', 'NULL', `'${second}'`)}`); // accounting idempotent
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '100');
    revision = removed.revision;

    sql(`SET ROLE service_role; ${rpc('prepare', `'${revision}'`, `'${third}'`, "'third.pdf'", '300')}`);
    const replaced = JSON.parse(sql(`SET ROLE service_role; ${rpc('upload', `'${revision}'`, `'${third}'`)}`));
    assert.equal(sql(`SELECT state FROM badge_instruction_object WHERE id='${first}'`), 'garbage');
    assert.equal(sql(`SELECT state FROM badge_instruction_object WHERE id='${third}'`), 'current');
    sql(`SET ROLE service_role; ${rpc('cleanup_ack', 'NULL', `'${third}'`)}`); // cannot ack current!
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '400');
    sql(`SET ROLE service_role; ${rpc('cleanup_ack', 'NULL', `'${first}'`)}`);
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '300');
    assert.match(denied(`SET ROLE service_role; ${rpc('begin_delete', `'${revision}'`)}`), /changed/);
    const backup = "encode(convert_to(repeat('x',300),'UTF8'),'base64')";
    const claimed = JSON.parse(sql(`SET ROLE service_role; ${rpc('begin_delete', `'${replaced.revision}'`, 'NULL', 'NULL', 'NULL', 'NULL', tenant, backup)}`));
    assert.equal(claimed.mode, replaced.mode);
    assert.equal(claimed.document.id, third);
    assert.equal(claimed.revision, replaced.revision);
    assert.equal(sql(`SELECT state FROM badge_instruction_object WHERE id='${third}'`), 'deleting');
    assert.equal(sql(`SELECT length(deletion_backup)>0 FROM badge_instruction_object WHERE id='${third}'`), 't');
    assert.match(denied(`SET ROLE service_role; ${rpc('mode', `'${replaced.revision}'`, 'NULL', 'NULL', 'NULL', "'standard'")}`), /pending/);
    assert.match(denied(`SET ROLE service_role; ${rpc('prepare', `'${replaced.revision}'`, `'${second}'`, "'racing.pdf'", '200')}`), /pending/);
    // A physical deletion failure leaves the configuration and revision
    // unchanged. Backup delivery preserves access until an explicit retry.
    assert.deepEqual(JSON.parse(sql(`SELECT setting_value FROM system_settings WHERE tenant_id='${tenant}'`)), replaced);
    assert.equal(sql(`SELECT state FROM badge_instruction_object WHERE id='${third}'`), 'deleting');
    assert.equal(sql(`SELECT deletion_backup IS NOT NULL FROM badge_instruction_object WHERE id='${third}'`), 't');
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '300');
    sql(`SET ROLE service_role; ${rpc('begin_delete', `'${replaced.revision}'`, 'NULL', 'NULL', 'NULL', 'NULL', tenant, backup)}`);
    // A second request can resume the same durable deletion claim.
    sql(`SET ROLE service_role; ${rpc('begin_delete', `'${replaced.revision}'`)}`);
    const finalizers = await Promise.all([1, 2].map(() =>
      asyncSql(args, `SET ROLE service_role; ${rpc('finish_delete', `'${replaced.revision}'`)}`)));
    assert.equal(finalizers.filter(r => r.status === 0).length, 1);
    const deleted = JSON.parse(finalizers.find(r => r.status === 0).output);
    assert.equal(deleted.mode, 'standard');
    assert.equal(deleted.document, null);
    // Only successful physical removal permits finalization and byte release.
    assert.equal(sql(`SELECT state FROM badge_instruction_object WHERE id='${third}'`), 'cleaned');
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '0');
    sql(`SET ROLE service_role; ${rpc('cleanup_ack', 'NULL', `'${third}'`)}`);
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '0');

    const late = '10000000-0000-4000-8000-000000000004';
    sql(`SET ROLE service_role; ${rpc('prepare', `'${deleted.revision}'`, `'${late}'`, "'late.pdf'", '400')}`);
    sql(`UPDATE badge_instruction_object SET created_at=now()-interval '2 hours' WHERE id='${late}'`);
    sql(`SET ROLE service_role; ${rpc('expire')}`);
    assert.match(denied(`SET ROLE service_role; ${rpc('upload', `'${deleted.revision}'`, `'${late}'`)}`), /expired/);
    sql(`SET ROLE service_role; ${rpc('cleanup_ack', 'NULL', `'${late}'`)}`);
    sql(`SET ROLE service_role; ${rpc('abandon', 'NULL', `'${late}'`)}`); // late storage upload reopens cleanup
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '400');
    sql(`SET ROLE service_role; ${rpc('cleanup_ack', 'NULL', `'${late}'`)}`);
    assert.equal(sql(`SELECT storage_used_bytes FROM tenant WHERE id='${tenant}'`), '0');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
