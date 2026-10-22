import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('private event invoice policy: immutable, tenant-bound, browser inaccessible and migration idempotent', { timeout: 45000 }, async () => {
  const h = await createLocalPostgresHarness('event-address-policy-');
  const run = (command, args, input, fails = false) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    if (fails) assert.notEqual(result.status, 0, 'operation must fail');
    else assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const sql = (text, fails = false) => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], text, fails);
  const tenant = '10000000-0000-0000-0000-000000000001';
  const member = '20000000-0000-0000-0000-000000000001';
  const event = '30000000-0000-0000-0000-000000000001';
  const id = '40000000-0000-0000-0000-000000000001';
  const snapshot = { version: 1, tenantId: tenant, memberId: member, eventId: event, source: 'simple' };
  const insert = (value = snapshot) => `INSERT INTO event_invoice_address_policy (id,tenant_id,member_id,event_id,source,snapshot)
    VALUES ('${id}','${tenant}','${member}','${event}','simple','${JSON.stringify(value)}');`;
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE member(id uuid,tenant_id uuid); CREATE TABLE event(id uuid,tenant_id uuid);
      CREATE TABLE complex_event(id uuid,tenant_id uuid);
      INSERT INTO member VALUES ('${member}','${tenant}'); INSERT INTO event VALUES ('${event}','${tenant}');
      GRANT SELECT ON member,event,complex_event TO service_role;`);
    const migration = readFileSync(new URL('./202612310026_event_invoice_address_policy.sql', import.meta.url), 'utf8');
    sql(migration); sql(migration);
    assert.equal(sql(`SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='event_invoice_address_policy'::regclass`), 't');
    for (const role of ['anon', 'authenticated']) {
      sql(`SET ROLE ${role}; SELECT * FROM event_invoice_address_policy`, true);
      sql(`SET ROLE ${role}; ${insert()}`, true);
    }
    sql(`SET ROLE service_role; ${insert({ ...snapshot, tenantId: member })}`, true);
    sql(`SET ROLE service_role; ${insert({ ...snapshot, source: 'complex' })}`, true);
    sql(`SET ROLE service_role; ${insert()}`);
    assert.equal(sql(`SET ROLE service_role; SELECT count(*) FROM event_invoice_address_policy`).split('\n').at(-1), '1');
    sql(`SET ROLE service_role; UPDATE event_invoice_address_policy SET snapshot='{}'`, true);
    sql(`SET ROLE service_role; DELETE FROM event_invoice_address_policy`, true);
    sql(`UPDATE event_invoice_address_policy SET snapshot='{}'`, true);
    sql(`DELETE FROM event_invoice_address_policy`, true);
    assert.equal(sql(`SELECT snapshot->>'memberId' FROM event_invoice_address_policy`), member);
    for (const table of ['event_invoice_payment_request', 'event_invoice_payment_binding']) {
      assert.equal(sql(`SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='${table}'::regclass`), 't');
      for (const role of ['anon', 'authenticated']) {
        sql(`SET ROLE ${role}; SELECT * FROM ${table}`, true);
        assert.equal(sql(`SELECT has_table_privilege('${role}','${table}','INSERT')`), 'f');
      }
    }
    const bind = `INSERT INTO event_invoice_payment_binding(policy_id,tenant_id,payment_intent_id) VALUES('${id}','${tenant}','pi_original');`;
    sql(`SET ROLE service_role; ${bind}`, true);
    const parameters = { amount: 1000, currency: 'gbp', metadata: { tenant_id: tenant, event_id: event,
      event_invoice_member_id: member, event_invoice_policy_id: id } };
    const paymentRequest = values => `INSERT INTO event_invoice_payment_request(policy_id,tenant_id,parameters)
      VALUES('${id}','${tenant}','${JSON.stringify(values)}');`;
    sql(`SET ROLE service_role; ${paymentRequest({})}`, true);
    sql(`SET ROLE service_role; ${paymentRequest(parameters)}`);
    sql(`SET ROLE service_role; ${bind}`);
    for (const table of ['event_invoice_payment_request', 'event_invoice_payment_binding']) {
      sql(`SET ROLE service_role; DELETE FROM ${table}`, true);
      sql(`DELETE FROM ${table}`, true);
      sql(`SET ROLE service_role; UPDATE ${table} SET tenant_id='${member}'`, true);
      sql(`UPDATE ${table} SET tenant_id='${member}'`, true);
    }
    sql(`SET ROLE service_role; ${bind}`, true);
    assert.equal(sql(`SELECT payment_intent_id FROM event_invoice_payment_binding`), 'pi_original');
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
