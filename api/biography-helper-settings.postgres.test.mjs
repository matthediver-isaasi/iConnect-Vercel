import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { createLocalPostgresHarness } from '../scripts/test-support/local-postgres-harness.mjs';

test('biography setting migration blocks direct browser writes and constrains only the new tenant key', async () => {
  const h = await createLocalPostgresHarness('biography-helper-');
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
  let started = false;
  const key = 'professional_biography_helper_text';
  try {
    run('initdb', ['-D', h.data, '-U', 'postgres', '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', h.data, '-l', join(h.root, 'log'), '-o', `-k ${h.socket} -p ${h.port} -h ''`, '-w', 'start']);
    started = true;
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.system_settings(id serial PRIMARY KEY, tenant_id text, setting_key text, setting_value text);
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT ALL ON public.system_settings TO anon, authenticated, service_role;
      GRANT USAGE, SELECT ON SEQUENCE public.system_settings_id_seq TO anon, authenticated, service_role;
      ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
      CREATE POLICY legacy_permissive ON public.system_settings FOR ALL USING (true) WITH CHECK (true);
      INSERT INTO public.system_settings(tenant_id,setting_key,setting_value)
        VALUES ('a','legacy','original'), ('a','legacy','duplicate');
    `);
    const migration = await readFile('supabase/migrations/202611270001_biography_helper_text.sql', 'utf8');
    await db.query(migration);
    await db.query(migration);
    assert.equal((await db.query('SELECT count(*) FROM system_settings')).rows[0].count, '2', 'migration changes no tenant records');
    await db.query('SET ROLE service_role');
    await db.query('INSERT INTO system_settings(tenant_id,setting_key,setting_value) VALUES ($1,$2,$3),($4,$2,$5)', ['a', key, 'Tenant A', 'b', 'Tenant B']);
    await assert.rejects(db.query('INSERT INTO system_settings(tenant_id,setting_key) VALUES ($1,$2)', ['a', key]), { code: '23505' });
    await db.query('RESET ROLE');
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      assert.equal((await db.query('SELECT * FROM system_settings WHERE setting_key=$1', [key])).rowCount, 0, 'restrictive read policy defeats permissive policy');
      await assert.rejects(db.query('INSERT INTO system_settings(tenant_id,setting_key,setting_value) VALUES ($1,$2,$3)', ['c', key, 'Forbidden']), { code: '42501' });
      assert.equal((await db.query('UPDATE system_settings SET setting_value=$1 WHERE setting_key=$2', ['Forbidden', key])).rowCount, 0);
      await assert.rejects(db.query('UPDATE system_settings SET setting_key=$1 WHERE id=1', [key]), { code: '42501' });
      await db.query('RESET ROLE');
    }
    await db.query('ALTER TABLE system_settings DISABLE ROW LEVEL SECURITY');
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      for (const statement of [
        'UPDATE system_settings SET setting_value=\'Forbidden\' WHERE setting_key=$1',
        'UPDATE system_settings SET setting_key=\'renamed\' WHERE setting_key=$1',
        'DELETE FROM system_settings WHERE setting_key=$1',
      ]) await assert.rejects(db.query(statement, [key]), { code: '42501' });
      await db.query("UPDATE system_settings SET setting_value='Allowed legacy update' WHERE id=1");
      await db.query('RESET ROLE');
    }
    assert.deepEqual((await db.query('SELECT setting_value FROM system_settings WHERE setting_key=$1 ORDER BY tenant_id', [key])).rows.map(row => row.setting_value), ['Tenant A', 'Tenant B']);
  } finally {
    await db.end().catch(() => {});
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
