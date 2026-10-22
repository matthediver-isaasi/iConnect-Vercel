import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { INVOICING_ADDRESS_KEYS } from '../../shared/invoicingAddress.js';

test('disposable PostgreSQL: three independent nullable addresses, idempotency and legacy/no-backfill preservation', { timeout: 45000 }, async () => {
  const h = await createLocalPostgresHarness('structured-invoicing-');
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const sql = input => run('psql', [
    '-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres',
    '-X', '-v', 'ON_ERROR_STOP=1', '-At',
  ], input);
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE TABLE public.member(id text PRIMARY KEY, organization_id text, first_name text);
      CREATE TABLE public.organization(id text PRIMARY KEY, organization_group_id text, invoicing_address text);
      CREATE TABLE public.organization_group(id text PRIMARY KEY, name text);
      INSERT INTO public.member VALUES ('member', 'org', 'Original member');
      INSERT INTO public.organization VALUES ('org', 'group', E'Legacy street\\nOriginal town\\nOriginal postcode');
      INSERT INTO public.organization_group VALUES ('group', 'Original group');
      CREATE TABLE public.saved_invoice(id text PRIMARY KEY, snapshot jsonb);
      INSERT INTO public.saved_invoice VALUES ('invoice', '{"address":"Frozen purchase address","amount":125}');
    `);
    const legacy = sql("SELECT invoicing_address FROM public.organization WHERE id='org';");
    const invoice = sql('SELECT snapshot FROM public.saved_invoice;');
    const migration = readFileSync(new URL('./202612310025_structured_invoicing_addresses.sql', import.meta.url), 'utf8');
    sql('CREATE ROLE anon; CREATE ROLE authenticated; GRANT SELECT ON public.member TO anon;');
    const blocked = spawnSync('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1'], { input: migration, encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Private invoicing address rollout blocked/);
    assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='invoicing_address_line1';"), '0');
    sql('REVOKE SELECT ON public.member FROM anon;');
    sql(migration);
    const quotedKeys = INVOICING_ADDRESS_KEYS.map(key => `'${key}'`).join(',');
    const allNull = INVOICING_ADDRESS_KEYS.map(key => `${key} IS NULL`).join(' AND ');
    for (const table of ['member', 'organization', 'organization_group']) {
      assert.equal(sql(`SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='${table}' AND column_name IN (${quotedKeys})
          AND data_type='text' AND is_nullable='YES' AND column_default IS NULL;`), '6');
      assert.equal(sql(`SELECT count(*) FROM public.${table};`), '1');
      assert.equal(sql(`SELECT ${allNull} FROM public.${table};`), 't', `${table} must not be backfilled`);
    }
    // Distinct owner values survive reapplication and never propagate to the
    // member's organization, the group's descendants, or saved invoice evidence.
    for (const [table, owner] of [['member', 'member'], ['organization', 'org'], ['organization_group', 'group']]) {
      sql(`UPDATE public.${table} SET invoicing_address_line1='${owner} street', invoicing_country='United Kingdom';`);
    }
    sql(migration);
    for (const [table, owner] of [['member', 'member'], ['organization', 'org'], ['organization_group', 'group']]) {
      assert.equal(sql(`SELECT invoicing_address_line1 FROM public.${table};`), `${owner} street`);
      assert.equal(sql(`SELECT invoicing_country FROM public.${table};`), 'United Kingdom');
      assert.equal(sql(`SELECT invoicing_city IS NULL FROM public.${table};`), 't');
    }
    assert.equal(sql("SELECT invoicing_address FROM public.organization WHERE id='org';"), legacy);
    assert.equal(sql('SELECT snapshot FROM public.saved_invoice;'), invoice);
    assert.equal(sql("SELECT first_name || ':' || organization_id FROM public.member;"), 'Original member:org');
    assert.equal(sql('SELECT name FROM public.organization_group;'), 'Original group');
  } finally {
    try {
      if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    } finally {
      await h.cleanup();
    }
  }
});
