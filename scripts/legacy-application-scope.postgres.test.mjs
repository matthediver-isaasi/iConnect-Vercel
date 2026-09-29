import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

// Explicitly opt-in. Tests only session-temporary objects in a rollback-only
// transaction: never applies the cohort migration or touches production rows.
test('actual PostgreSQL roles cannot forge scope through existing INSERT grants', {
  skip: process.env.RUN_LEGACY_SCOPE_POSTGRES_TEST !== '1',
}, async () => {
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert.ok(response.ok);
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { ca: await response.text(), rejectUnauthorized: true, servername: target.hostname } });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const sql = await readFile(new URL('../supabase/migrations/20261125_legacy_public_application_links.sql', import.meta.url), 'utf8');
    const fn = sql.match(/CREATE OR REPLACE FUNCTION public\.keep_legacy_application_scope_immutable\(\)[\s\S]*?\$\$;/)[0]
      .replace('FUNCTION public.', 'FUNCTION pg_temp.');
    await client.query('CREATE TEMP TABLE legacy_scope_role_test (id integer, legacy_application_scope jsonb) ON COMMIT DROP');
    await client.query(fn);
    await client.query(`CREATE TRIGGER scope_boundary BEFORE INSERT OR UPDATE ON legacy_scope_role_test
      FOR EACH ROW EXECUTE FUNCTION pg_temp.keep_legacy_application_scope_immutable()`);
    await client.query('GRANT ALL ON legacy_scope_role_test TO anon, authenticated, service_role');
    for (const role of ['anon', 'authenticated', 'service_role', 'postgres']) {
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
      await client.query('INSERT INTO legacy_scope_role_test VALUES (1, NULL)');
      await client.query('SAVEPOINT check_scope');
      if (['anon', 'authenticated'].includes(role)) {
        await assert.rejects(client.query(`INSERT INTO legacy_scope_role_test VALUES (2, '{"version":1}')`), { code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT check_scope');
      } else {
        await client.query(`INSERT INTO legacy_scope_role_test VALUES (2, '{"version":1}')`);
      }
      await client.query('SAVEPOINT check_update');
      await assert.rejects(client.query(`UPDATE legacy_scope_role_test SET legacy_application_scope = '{"version":2}' WHERE id=1`), /immutable/);
      await client.query('ROLLBACK TO SAVEPOINT check_update');
      await client.query('RESET ROLE');
    }
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});