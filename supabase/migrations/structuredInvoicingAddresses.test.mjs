import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { INVOICING_ADDRESS_KEYS } from '../../shared/invoicingAddress.js';

test('disposable PostgreSQL: protected sidecar CRUD, grants/RLS, tenant ownership, cleanup and idempotency', { timeout: 45000 }, async () => {
  const h = await createLocalPostgresHarness('private-invoicing-');
  const run = (command, args, input, fails = false) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    if (fails) assert.notEqual(result.status, 0, 'private/invalid operation must fail');
    else assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const sql = (input, fails = false) => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], input, fails);
  const tenant = '10000000-0000-0000-0000-000000000001';
  const foreignTenant = '10000000-0000-0000-0000-000000000002';
  const owner = '20000000-0000-0000-0000-000000000001';
  const missingOwner = '20000000-0000-0000-0000-000000000002';
  const patch = (type, address, tenantId = tenant, ownerId = owner) => `
    SELECT invoicing_address_line1 FROM public.patch_private_invoicing_address(
      '${tenantId}', '${type}', '${ownerId}', '${JSON.stringify(address)}'::jsonb);`;
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.tenant(id uuid PRIMARY KEY);
      INSERT INTO public.tenant VALUES ('${tenant}'), ('${foreignTenant}');
      CREATE TABLE public.member(id uuid PRIMARY KEY, tenant_id uuid, email text);
      CREATE TABLE public.organization(id uuid PRIMARY KEY, tenant_id uuid, invoicing_address text);
      CREATE TABLE public.organization_group(id uuid PRIMARY KEY, tenant_id uuid, name text);
      INSERT INTO public.member VALUES ('${owner}','${tenant}','member@example.test');
      INSERT INTO public.organization VALUES ('${owner}','${tenant}',E'Legacy street\\nOriginal town\\nOriginal postcode');
      INSERT INTO public.organization_group VALUES ('${owner}','${tenant}','Original group');
      GRANT SELECT ON public.member, public.organization, public.organization_group TO anon, authenticated;
      CREATE TABLE public.saved_invoice(id text PRIMARY KEY, snapshot jsonb);
      INSERT INTO public.saved_invoice VALUES ('invoice','{"address":"Frozen purchase address","amount":125}');
    `);
    const original = sql(`SELECT row_to_json(organization) FROM public.organization; SELECT snapshot FROM public.saved_invoice;`);
    const migration = readFileSync(new URL('./202612310025_structured_invoicing_addresses.sql', import.meta.url), 'utf8');
    sql(migration);
    sql(migration);
    const keys = INVOICING_ADDRESS_KEYS.map(key => `'${key}'`).join(',');
    assert.equal(sql(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('member','organization','organization_group') AND column_name IN (${keys});`), '0');
    assert.equal(sql('SELECT count(*) FROM public.invoicing_address_private;'), '0', 'no backfill');
    assert.equal(sql(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name='invoicing_address_private' AND column_name IN (${keys}) AND data_type='text'
      AND is_nullable='YES' AND column_default IS NULL;`), '6');
    assert.equal(sql(`SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.invoicing_address_private'::regclass;`), 't');
    assert.equal(sql(`SELECT count(*) FROM pg_policy WHERE polrelid='public.invoicing_address_private'::regclass;`), '0');
    for (const role of ['anon', 'authenticated']) {
      assert.equal(sql(`SELECT has_table_privilege('${role}','public.invoicing_address_private','SELECT,INSERT,UPDATE,DELETE');`), 'f');
      assert.equal(sql(`SELECT has_function_privilege('${role}','public.patch_private_invoicing_address(uuid,text,uuid,jsonb)','EXECUTE');`), 'f');
      sql(`SET ROLE ${role}; SELECT * FROM public.invoicing_address_private;`, true);
      sql(`SET ROLE ${role}; ${patch('member', { invoicing_city: 'Forbidden' })}`, true);
      sql(`SET ROLE ${role}; DELETE FROM public.invoicing_address_private;`, true);
      // Browser-readable owner wildcards never contain new billing fields.
      assert.equal(sql(`SET ROLE ${role}; SELECT count(*) FROM public.member;`).split('\n').at(-1), '1');
    }
    for (const type of ['member', 'organization', 'organization_group']) {
      sql(`SET ROLE service_role; ${patch(type, { invoicing_address_line1: `${type} street`, invoicing_country: 'United Kingdom' })}`);
      sql(`SET ROLE service_role; ${patch(type, { invoicing_city: 'London' })}`);
      assert.equal(sql(`SELECT invoicing_address_line1 || ':' || invoicing_city FROM public.invoicing_address_private WHERE owner_type='${type}';`), `${type} street:London`);
    }
    sql(migration);
    assert.equal(sql('SELECT count(*) FROM public.invoicing_address_private;'), '3');
    sql(patch('member', { invoicing_city: null }));
    assert.equal(sql("SELECT invoicing_city IS NULL FROM public.invoicing_address_private WHERE owner_type='member';"), 't');
    sql(patch('member', { invoicing_country: '  ' }));
    assert.equal(sql("SELECT invoicing_country IS NULL FROM public.invoicing_address_private WHERE owner_type='member';"), 't');
    for (const type of ['member', 'organization', 'organization_group']) {
      sql(`UPDATE public.${type} SET tenant_id=tenant_id;`);
    }
    assert.equal(sql('SELECT count(*) FROM public.invoicing_address_private;'), '3', 'no-op tenant assignments must retain addresses');
    sql(patch('member', { invoicing_city: 'x' }, foreignTenant), true);
    sql(patch('member', { invoicing_city: 'x' }, tenant, missingOwner), true);
    sql(patch('member', { invoicing_country: 'x'.repeat(51) }), true);
    sql(patch('member', { unknown: 'x' }), true);
    sql(patch('member', { invoicing_city: {} }), true);
    assert.equal(sql(`SELECT row_to_json(organization) FROM public.organization; SELECT snapshot FROM public.saved_invoice;`), original);
    sql(`UPDATE public.member SET email='deleted_' || id::text || '@deleted.local';`);
    assert.equal(sql("SELECT count(*) FROM public.invoicing_address_private WHERE owner_type='member';"), '0');
    sql(`UPDATE public.organization_group SET tenant_id='${foreignTenant}';`);
    assert.equal(sql("SELECT count(*) FROM public.invoicing_address_private WHERE owner_type='organization_group';"), '0');
    sql('DELETE FROM public.organization;');
    assert.equal(sql('SELECT count(*) FROM public.invoicing_address_private;'), '0');
    assert.equal(sql('SELECT snapshot FROM public.saved_invoice;'), original.split('\n').at(-1));
    // Refuse an unexpected partially deployed public-column version; do not
    // silently retain private copies on browser-readable owner tables.
    sql('ALTER TABLE public.member ADD COLUMN invoicing_city text;');
    sql(migration, true);
    assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_name='member' AND column_name='invoicing_city';"), '1', 'guard must not drop or migrate existing data implicitly');
  } finally {
    try {
      if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    } finally {
      await h.cleanup();
    }
  }
});
