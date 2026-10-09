import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('direct-tax migration preserves legacy data, supports empty configuration, restricts RPC and replays', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sales-tax-'));
  const data = path.join(dir, 'db'), socket = path.join(dir, 'sock');
  mkdirSync(socket);
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', path.join(dir, 'log'), '-o', `-F -k ${socket} -p 55449 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const sql = text => run('psql', ['-h', socket, '-p', '55449', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', text]).trim();
    const tenant = '00000000-0000-4000-8000-000000000001';
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
      CREATE TABLE sales_catalogue_product(id int, tax_rate_bps int);
      INSERT INTO sales_catalogue_product VALUES(1,2000);
      CREATE TABLE sales_accounting_tax_mapping(tenant_id uuid, provider text, tax_treatment text,
        tax_rate_bps int,provider_tax_code text,provider_tax_name text,
        UNIQUE(tenant_id,provider,tax_treatment,tax_rate_bps));
      INSERT INTO sales_accounting_tax_mapping VALUES('${tenant}','xero','standard',0,'EXEMPT','Exempt');
      CREATE TABLE system_settings(tenant_id uuid,setting_key text,setting_value text,UNIQUE(tenant_id,setting_key));`);
    const migration = readFileSync('supabase/migrations/202610090002_sales_direct_tax_codes.sql', 'utf8');
    sql(migration);
    assert.equal(sql('SELECT tax_code IS NULL AND tax_rate_bps=2000 FROM sales_catalogue_product'), 't');
    assert.equal(sql("SELECT has_function_privilege('anon','public.save_sales_accounting_configuration(uuid,text,jsonb,text)','EXECUTE')"), 'f');
    sql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
      SELECT save_sales_accounting_configuration('${tenant}','xero','[]',NULL);
      SELECT save_sales_accounting_configuration('${tenant}','quickbooks','[]','item-1'); RESET ROLE;`);
    assert.equal(sql('SELECT provider_tax_code FROM sales_accounting_tax_mapping'), 'EXEMPT');
    assert.equal(sql('SELECT setting_value FROM system_settings'), 'item-1');
    sql(migration);
    assert.equal(sql('SELECT count(*) FROM sales_accounting_tax_mapping'), '1');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
