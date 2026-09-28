import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('certificate policy replacement is atomic and validates tenant, ticket, template and dates', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('cpd-certificate-config-');
  const run = (cmd, args, input, fails = false) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (fails) assert.notEqual(result.status, 0, 'unsafe replacement must fail');
    else assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const sql = (input, fails = false) => run('psql', [
    '-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres',
    '-X', '-v', 'ON_ERROR_STOP=1', '-At',
  ], input, fails);
  let started = false;
  const tenant = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const event = '33333333-3333-4333-8333-333333333333';
  const template = '44444444-4444-4444-8444-444444444444';
  const inactive = '55555555-5555-4555-8555-555555555555';
  const complexEvent = '66666666-6666-4666-8666-666666666666';
  const complexTicket = '77777777-7777-4777-8777-777777777777';
  const config = {
    eventRule: { template_id: template, date_mode: 'event', start_date: null, end_date: null },
    ticketRules: {
      member: { template_mode: 'none', template_id: null, date_mode: 'custom', start_date: '2026-10-01', end_date: '2026-10-03' },
    },
  };
  const call = (value, tenantId = tenant) => `SELECT public.replace_event_cpd_certificate_config('${tenantId}','event','${event}','${JSON.stringify(value)}'::jsonb);`;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT 'service_role'::text$$;
      CREATE TABLE public.tenant(id uuid PRIMARY KEY);
      CREATE TABLE public.event(id uuid PRIMARY KEY,tenant_id uuid,pricing_config jsonb);
      CREATE TABLE public.complex_event(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE public.complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,name text);
      CREATE TABLE public.cpd_certificate_template(id uuid PRIMARY KEY,tenant_id uuid,status text,source_path text);
      INSERT INTO tenant VALUES ('${tenant}'),('${other}');
      INSERT INTO event VALUES ('${event}','${tenant}','{"ticket_classes":[{"id":"member","name":"Member"}]}');
      INSERT INTO complex_event VALUES ('${complexEvent}','${tenant}');
      INSERT INTO complex_event_ticket_class VALUES ('${complexTicket}','${tenant}','${complexEvent}','VIP');
      INSERT INTO cpd_certificate_template VALUES
        ('${template}','${tenant}','active','private.pdf'),
        ('${inactive}','${tenant}','archived','private.pdf');
    `);
    const migration = readFileSync(new URL('./20261119_event_cpd_certificate_config.sql', import.meta.url), 'utf8');
    sql(migration);
    sql(migration); // Retrying the reviewed migration must be safe.
    assert.equal(sql(`SELECT has_table_privilege('service_role','event_cpd_certificate_config','SELECT');`).trim(), 't');
    assert.equal(sql(`SELECT has_table_privilege('service_role','event_cpd_certificate_config','INSERT,UPDATE,DELETE');`).trim(), 'f');
    sql(call(config));
    assert.equal(sql(`SELECT config->'ticketRules'->'member'->>'start_date' FROM event_cpd_certificate_config;`).trim(), '2026-10-01');
    sql(call(config, other), true);
    sql(call({ ...config, eventRule: { ...config.eventRule, template_id: inactive } }), true);
    sql(call({ ...config, eventRule: { ...config.eventRule, template_id: null },
      ticketRules: { stolen: config.ticketRules.member } }), true);
    sql(call({ ...config, ticketRules: { member: { ...config.ticketRules.member, end_date: '2026-09-30' } } }), true);
    sql(call({ ...config, ticketRules: { member: { ...config.ticketRules.member, start_date: '2026-02-30' } } }), true);
    assert.equal(sql(`SELECT config->'eventRule'->>'template_id' FROM event_cpd_certificate_config;`).trim(), template);
    assert.equal(sql(`SELECT count(*) FROM event_cpd_certificate_config;`).trim(), '1');
    const complexConfig = { ...config, ticketRules: { [complexTicket]: config.ticketRules.member } };
    sql(`SELECT public.replace_event_cpd_certificate_config('${tenant}','complex_event','${complexEvent}','${JSON.stringify(complexConfig)}'::jsonb);`);
    sql(`SELECT public.replace_event_cpd_certificate_config('${tenant}','complex_event','${complexEvent}','${JSON.stringify(config)}'::jsonb);`, true);
    assert.equal(sql(`SELECT count(*) FROM event_cpd_certificate_config;`).trim(), '2');
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});