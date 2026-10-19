import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('carousel consent migration is default-off, idempotent and browser-write protected', { timeout: 45000 }, async () => {
  const h = await createLocalPostgresHarness('carousel-consent-');
  const run = (cmd, args, input, fail = false) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (fail) assert.notEqual(result.status, 0, 'unauthorized write must fail');
    else assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const sql = (input, fail = false) => run('psql',
    ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], input, fail);
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE dynamic_directory(id text, name text);
      CREATE TABLE system_settings(id text, tenant_id text, setting_key text, setting_value text);
      INSERT INTO dynamic_directory VALUES ('legacy','Legacy');
      GRANT ALL ON dynamic_directory, system_settings TO authenticated, anon, service_role;`);
    const migration = readFileSync(new URL('./202610190001_directory_carousel_public_consent.sql', import.meta.url), 'utf8');
    sql(migration);
    sql(migration);
    assert.equal(sql('SELECT public_carousel_enabled FROM dynamic_directory;').trim(), 'f');
    sql("SET ROLE authenticated; UPDATE dynamic_directory SET name='Private renamed';");
    sql("SET ROLE authenticated; UPDATE dynamic_directory SET public_carousel_enabled=true;", true);
    sql("SET ROLE anon; INSERT INTO dynamic_directory(id,public_carousel_enabled) VALUES ('bad',true);", true);
    sql("SET ROLE service_role; UPDATE dynamic_directory SET public_carousel_enabled=true;");
    sql("SET ROLE authenticated; UPDATE dynamic_directory SET name='Public broadened';", true);
    sql("SET ROLE authenticated; DELETE FROM dynamic_directory;", true);
    sql("SET ROLE authenticated; INSERT INTO system_settings VALUES ('p','a','member_directory_public_carousel_enabled','true');", true);
    sql("SET ROLE service_role; INSERT INTO system_settings VALUES ('p','a','member_directory_public_carousel_enabled','true');");
    sql("SET ROLE authenticated; UPDATE system_settings SET setting_key='unprotected';", true);
    sql("SET ROLE authenticated; DELETE FROM system_settings;", true);
    sql("INSERT INTO system_settings VALUES ('duplicate','a','member_directory_public_carousel_enabled','false');", true);
    sql("INSERT INTO system_settings VALUES ('other','b','member_directory_public_carousel_enabled','false');");
    sql("SET ROLE service_role; UPDATE dynamic_directory SET public_carousel_enabled=false;");
    assert.equal(sql('SELECT public_carousel_enabled FROM dynamic_directory;').trim(), 'f');
    sql("UPDATE dynamic_directory SET public_carousel_enabled=NULL;", true);
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
