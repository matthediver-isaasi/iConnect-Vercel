import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('public quote rate limiter resolves extension digest and preserves counters and grants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quote-rate-'));
  const data = join(dir, 'db'), socket = join(dir, 'socket');
  mkdirSync(socket);
  function run(command, args, input) {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Command failed');
    return result.stdout.trim();
  }
  const sql = query => run('psql', ['-h', socket, '-p', '55453', '-U', 'postgres', '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1'], query);
  const digest = 'a'.repeat(64);
  const call = `SELECT public.consume_sales_quote_public_rate_limit('${digest}','fixture-client',2,60);`;
  const asService = query => sql(`SET ROLE service_role; SET request.jwt.claim.role='service_role'; ${query}`).split('\n').at(-1);
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(dir, 'log'), '-o', `-F -k ${socket} -p 55453 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA extensions;
      CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
      GRANT USAGE ON SCHEMA auth TO service_role;`);
    const original = readFileSync('supabase/migrations/20260913_sales_concurrency_hardening.sql', 'utf8');
    const start = original.indexOf('CREATE TABLE IF NOT EXISTS public.sales_quote_public_rate_limit');
    const end = original.indexOf('TO service_role;', original.indexOf('GRANT EXECUTE ON FUNCTION public.consume_sales_quote_public_rate_limit', start)) + 'TO service_role;'.length;
    assert.ok(start > 0 && end > start);
    sql(original.slice(start, end));
    assert.throws(() => asService(call), /function digest.*does not exist/);
    const migration = readFileSync('supabase/migrations/202610120001_sales_quote_rate_limit_digest.sql', 'utf8');
    sql(migration);
    assert.equal(asService(call), 'f');
    assert.equal(asService(call), 'f');
    assert.equal(asService(call), 't');
    assert.equal(sql('SELECT request_count FROM sales_quote_public_rate_limit'), '3');
    assert.equal(sql("SELECT octet_length(client_key_hash) FROM sales_quote_public_rate_limit"), '32');
    sql("UPDATE sales_quote_public_rate_limit SET window_started=now()-interval '61 seconds'");
    assert.equal(asService(call), 'f');
    assert.equal(sql('SELECT request_count FROM sales_quote_public_rate_limit'), '1');
    for (const role of ['anon', 'authenticated']) {
      assert.throws(() => sql(`SET ROLE ${role}; ${call}`), /permission denied/);
    }
    assert.throws(() => asService("SELECT consume_sales_quote_public_rate_limit('bad','client',2,60)"), /invalid public quote/);
    sql(migration);
    assert.equal(asService(call), 'f');
    assert.equal(sql("SELECT prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE proname='consume_sales_quote_public_rate_limit'"), 't');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
