import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('event email delivery ledger: ordering, dedupe, stats and grants', async () => {
  const h = await createLocalPostgresHarness('event-email-delivery-');
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const sql = text => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At'], text);
  const T = '11111111-1111-4111-8111-111111111111', E = '22222222-2222-4222-8222-222222222222';
  const S = '33333333-3333-4333-8333-333333333333';
  const row = n => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
  const attendee = id => `R${id.slice(-1)}@Example.invalid `; // case/space-insensitive match
  const apply = (id, msg, kind, at, provider, reason = null, to = attendee(id), key = 'applied') => sql(`SELECT public.apply_event_email_delivery_event('${id}',${msg ? `'${msg}'` : 'NULL'},'${kind}','${kind}','${at}',${reason ? `'${reason}'` : 'NULL'},${provider ? `'${provider}'` : 'NULL'},${to ? `'${to}'` : 'NULL'})->>'${key}'`);
  const state = id => sql(`SELECT status||'|'||coalesce(failure_source,'')||'|'||open_count||'|'||(delivered_at IS NOT NULL)||'|'||coalesce(mailgun_message_id,'') FROM event_email_delivery WHERE id='${id}'`);
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']); started = true;
    sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    const migration = readFileSync('supabase/migrations/202702010001_event_email_delivery.sql', 'utf8');
    sql(migration); sql(migration); // replay-safe
    for (let n = 1; n <= 6; n++) {
      sql(`INSERT INTO event_email_delivery(id,tenant_id,event_id,event_email_id,email_type,recipient_email) VALUES('${row(n)}','${T}','${E}','${S}','reminder','r${n}@example.invalid')`);
    }
    // 1: accepted, then delivered, then a late temporary failure must not regress it.
    assert.equal(sql(`SELECT public.record_event_email_send_result('${row(1)}',true,'<m1>','mg.example',NULL,now())`), 't');
    assert.equal(apply(row(1), 'm1', 'delivered', '2027-02-01T10:00:00Z', 'p1'), 'true');
    assert.equal(apply(row(1), 'm1', 'soft_bounce', '2027-02-01T09:00:00Z', 'p2', 'mailbox busy'), 'true');
    assert.equal(state(row(1)), 'delivered||0|true|m1');
    // Duplicate opens (webhook + recovery) count once; a different message id never matches.
    assert.equal(apply(row(1), 'm1', 'opened', '2027-02-01T11:00:00Z', 'p3'), 'true');
    assert.equal(apply(row(1), 'm1', 'opened', '2027-02-01T11:00:00Z', 'p3'), 'false');
    assert.equal(apply(row(1), 'other', 'opened', '2027-02-01T11:00:00Z', 'p9', null, undefined, 'matched'), 'false');
    // CC copies share the ledger variable: their delivery, opens and bounces never touch the attendee row.
    assert.equal(apply(row(1), 'm1', 'opened', '2027-02-01T11:05:00Z', 'cc1', null, 'cc@example.invalid', 'reason'), 'recipient_mismatch');
    assert.equal(apply(row(1), 'm1', 'hard_bounce', '2027-02-01T11:06:00Z', 'cc2', 'No such user', 'cc@example.invalid', 'matched'), 'false');
    assert.equal(apply(row(1), 'm1', 'opened', '2027-02-01T11:07:00Z', 'cc3', null, null, 'matched'), 'false');
    assert.equal(state(row(1)), 'delivered||1|true|m1');
    // 2: webhook open arrives before acceptance is recorded; open is delivery evidence.
    assert.equal(apply(row(2), 'm2', 'opened', '2027-02-01T10:00:00Z', 'p4'), 'true');
    assert.equal(sql(`SELECT public.record_event_email_send_result('${row(2)}',true,'m2','mg.example',NULL,now())`), 't');
    assert.equal(state(row(2)), 'delivered||1|true|m2');
    // 3: permanent bounce after acceptance.
    sql(`SELECT public.record_event_email_send_result('${row(3)}',true,'m3',NULL,NULL,now())`);
    apply(row(3), 'm3', 'hard_bounce', '2027-02-01T10:00:00Z', 'p5', 'No such user');
    assert.equal(state(row(3)), 'failed|provider|0|false|m3');
    assert.equal(sql(`SELECT failure_reason FROM event_email_delivery WHERE id='${row(3)}'`), 'No such user');
    // 4: rejected send. 5: thrown send later proven delivered by the provider.
    sql(`SELECT public.record_event_email_send_result('${row(4)}',false,NULL,NULL,'Domain not found',now())`);
    assert.equal(state(row(4)), 'failed|send|0|false|');
    sql(`SELECT public.record_event_email_send_result('${row(5)}',false,NULL,NULL,'timeout',now())`);
    apply(row(5), 'm5', 'delivered', '2027-02-01T10:00:00Z', 'p6');
    assert.equal(state(row(5)), 'delivered||0|true|m5');
    // 6: accepted, awaiting confirmation; a temporary failure keeps it awaiting.
    sql(`SELECT public.record_event_email_send_result('${row(6)}',true,'m6',NULL,NULL,now())`);
    apply(row(6), 'm6', 'soft_bounce', '2027-02-01T10:00:00Z', 'p7', 'greylisted');
    assert.equal(state(row(6)), 'accepted||0|false|m6');
    assert.equal(apply(row(6), 'm6', 'delivered', '2027-02-01T10:01:00Z', 'cc4', null, 'cc@example.invalid', 'matched'), 'false');
    assert.equal(state(row(6)), 'accepted||0|false|m6');

    assert.equal(sql(`SELECT total||','||sent||','||delivered||','||awaiting||','||opened||','||failed FROM public.event_email_delivery_stats('${T}','${E}')`), '6,5,3,1,2,2');
    assert.equal(sql(`SELECT count(*) FROM public.event_email_delivery_stats('${S}','${E}')`), '0');
    assert.equal(sql('SELECT count(*) FROM event_email_delivery_tracking'), '1');
    assert.equal(sql(`SELECT count(*) FROM event_email_delivery_event WHERE provider_event_id LIKE 'cc%'`), '0');

    assert.equal(sql(`SELECT has_table_privilege('anon','event_email_delivery','SELECT') OR has_table_privilege('authenticated','event_email_delivery','SELECT')
      OR has_function_privilege('authenticated','public.event_email_delivery_stats(uuid,uuid)','EXECUTE')`), 'f');
    assert.equal(sql(`SELECT has_table_privilege('service_role','event_email_delivery','INSERT') AND NOT has_table_privilege('service_role','event_email_delivery','UPDATE')
      AND has_function_privilege('service_role','public.apply_event_email_delivery_event(uuid,text,text,text,timestamptz,text,text,text)','EXECUTE')`), 't');
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop'], { encoding: 'utf8' });
    await h.cleanup();
  }
});
