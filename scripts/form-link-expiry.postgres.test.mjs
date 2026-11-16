import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('tenant link expiry: defaults, isolation, validation and immutable issued lifetimes', async () => {
  const h = await createLocalPostgresHarness('form-link-expiry-');
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = text => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres',
    '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At'], text);
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE system_settings(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,setting_key text,setting_value text);
      CREATE TABLE form_alert_delivery(id serial PRIMARY KEY,tenant_id uuid,expires_at timestamptz DEFAULT now()+interval '7 days');
      CREATE TABLE form_submission_forward(LIKE form_alert_delivery INCLUDING ALL);
      GRANT SELECT,INSERT,UPDATE ON system_settings,form_alert_delivery,form_submission_forward TO service_role;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
      INSERT INTO form_alert_delivery(tenant_id,expires_at) VALUES('${a}',now()-interval '1 day');`);
    const migration = readFileSync('supabase/migrations/202611161600_form_submission_link_expiry.sql', 'utf8');
    sql(migration);
    sql(migration);
    assert.equal(sql(`SELECT expires_at < now() FROM form_alert_delivery WHERE id=1`), 't');
    const duration = (table, tenant) => sql(`SET ROLE service_role;
      INSERT INTO ${table}(tenant_id) VALUES('${tenant}')
      RETURNING round(extract(epoch from (expires_at-now()))/86400);`);
    assert.equal(duration('form_alert_delivery', a), '7');
    sql(`SET ROLE service_role; INSERT INTO system_settings(tenant_id,setting_key,setting_value)
      VALUES('${a}','form_submission_link_expiry_days','30');`);
    assert.equal(duration('form_alert_delivery', a), '30');
    assert.equal(duration('form_submission_forward', a), '30');
    assert.equal(duration('form_submission_forward', b), '7');
    for (const value of ['0', '-1', '366', '7.5', '', 'NaN', '9999999999']) {
      sql(`DO $$ BEGIN
        BEGIN UPDATE system_settings SET setting_value='${value}' WHERE tenant_id='${a}';
          RAISE EXCEPTION 'Invalid value accepted';
        EXCEPTION WHEN check_violation THEN NULL; END;
      END $$;`);
    }
    sql(`DO $$ BEGIN
      BEGIN INSERT INTO system_settings(tenant_id,setting_key,setting_value)
        VALUES('${a}','form_submission_link_expiry_days','14'); RAISE EXCEPTION 'Duplicate accepted';
      EXCEPTION WHEN unique_violation THEN NULL; END;
    END $$;`);
    for (const days of [1, 365]) {
      sql(`UPDATE system_settings SET setting_value='${days}' WHERE tenant_id='${a}'`);
      assert.equal(duration('form_alert_delivery', a), String(days));
    }
    assert.equal(sql(`SELECT expires_at < now() FROM form_alert_delivery WHERE id=1`), 't');
    assert.equal(sql(`SELECT round(extract(epoch from(expires_at-now()))/86400)
      FROM form_submission_forward WHERE tenant_id='${a}'`), '30');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','set_form_submission_link_expiry()','EXECUTE')
      OR has_function_privilege('anon','validate_form_submission_link_expiry_setting()','EXECUTE')`), 'f');
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop'], { encoding: 'utf8' });
    await h.cleanup();
  }
});
