import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('funnel authoring is tenant-protected, revision-fenced, immutable and disabled for purchasing', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('event-funnel-');
  const clients = [];
  let started = false;
  const run = (command, args) => execFileSync(command, args, { stdio: 'pipe' });
  const connect = async () => {
    const client = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    clients.push(client); await client.connect(); return client;
  };
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tenant = uuid(1), otherTenant = uuid(2), event = uuid(3), definition = uuid(4);
  const graph = { version: 1, tenantId: tenant, entry: 'source', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    { id: 'source', type: 'source', event: { id: event, kind: 'simple', tenantId: tenant }, ticketIds: ['standard'], requires: [], accept: 'checkout' },
    { id: 'checkout', type: 'checkout' },
  ] };
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    const db = await connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.event(id uuid PRIMARY KEY,tenant_id uuid,pricing_config jsonb);
      CREATE TABLE public.member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE public.complex_event(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE public.complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid);`);
    await db.query(await readFile(new URL('../../supabase/migrations/202701230001_event_funnel_definitions.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('../../supabase/migrations/202701230002_event_funnel_sessions.sql', import.meta.url), 'utf8'));
    await db.query(`INSERT INTO event VALUES($1,$2,'{"ticket_classes":[{"id":"standard"}]}')`, [event, tenant]);
    const save = (client, revision, g = graph, scope = tenant, def = definition) => client.query(
      `SELECT event_funnel_save_definition($1,$2,'user:admin',$3,'Admissions',$4,'{"positions":{}}') result`,
      [scope, def, revision, g],
    );
    const a = await connect(), b = await connect();
    const created = await Promise.allSettled([save(a, 0), save(b, 0)]);
    assert.equal(created.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(created.find(result => result.status === 'rejected').reason.code, 'PT409');
    const edited = await Promise.allSettled([save(a, 1), save(b, 1)]);
    assert.equal(edited.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(edited.find(result => result.status === 'rejected').reason.code, 'PT409');
    await assert.rejects(save(db, 2, graph, otherTenant), { code: '22023' });
    const crossTenantGraph = structuredClone(graph);
    crossTenantGraph.tenantId = otherTenant;
    crossTenantGraph.nodes[0].event.tenantId = otherTenant;
    await assert.rejects(save(db, 0, crossTenantGraph, otherTenant, uuid(5)), { code: '22023' });
    const badTicket = structuredClone(graph); badTicket.nodes[0].ticketIds = ['forged'];
    await assert.rejects(save(db, 2, badTicket), { code: '22023' });
    assert.equal((await db.query('SELECT revision FROM event_funnel_definition')).rows[0].revision, 2);
    await db.query(`INSERT INTO event_funnel_version(tenant_id,definition_id,definition_revision,graph,commercial_snapshot)
      VALUES($1,$2,2,$3,'{}')`, [tenant, definition, graph]);
    await assert.rejects(db.query(`UPDATE event_funnel_version SET graph='{}'`), { code: '23514' });
    await assert.rejects(db.query('DELETE FROM event_funnel_version'), { code: '23514' });
    const version = (await db.query('SELECT id FROM event_funnel_version')).rows[0].id;
    const sessionId = uuid(10), memberId = uuid(11), guestSession = uuid(12), capability = 'a'.repeat(64);
    await db.query('INSERT INTO member VALUES($1,$2)', [memberId, tenant]);
    await assert.rejects(db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)', [tenant,sessionId,version,memberId]), { code: 'PT409' });
    // Isolated fixture sessions exercise the private store without pretending
    // readiness or publishing is available. No customer session can start yet.
    await db.query(`INSERT INTO event_funnel_session(id,tenant_id,version_id,member_id,guest_capability_hash,access_expires_at,retain_until)
      VALUES($1,$3,$4,$5,NULL,now()+interval '1 day',now()+interval '7 days'),
        ($2,$3,$4,NULL,$6,now()+interval '1 day',now()+interval '7 days')`,
    [sessionId,guestSession,tenant,version,memberId,capability]);
    const readSession = (session, member, token, scope=tenant) => db.query('SELECT event_funnel_read_session($1,$2,$3,$4) result',[scope,session,member,token]);
    assert.equal((await readSession(sessionId,memberId,null)).rows[0].result.session.guest_capability_hash, undefined);
    assert.equal((await readSession(guestSession,null,capability)).rows[0].result.session.guest_capability_hash, undefined);
    for (const args of [[sessionId,uuid(99),null], [sessionId,null,capability], [guestSession,memberId,capability],
      [guestSession,null,'b'.repeat(64)], [sessionId,memberId,null,otherTenant]]) {
      await assert.rejects(readSession(...args), { code:'PT404' });
    }
    const saveAnswers = (client, revision, answers={first_name:'Fixture'}) => client.query(
      'SELECT event_funnel_save_answers($1,$2,$3,NULL,$4,\'source\',$5) result', [tenant,sessionId,memberId,revision,answers]);
    const parallelAnswers = await Promise.allSettled([saveAnswers(a,1),saveAnswers(b,1)]);
    assert.equal(parallelAnswers.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(parallelAnswers.find(result=>result.status==='rejected').reason.code,'PT409');
    await db.query(`UPDATE event_funnel_session SET state='held',first_reserved_at=clock_timestamp(),
      expires_at=clock_timestamp()+interval '15 minutes' WHERE id=$1`,[sessionId]);
    const deadline = (await readSession(sessionId,memberId,null)).rows[0].result.session.expires_at;
    await saveAnswers(db,2);
    assert.equal((await readSession(sessionId,memberId,null)).rows[0].result.session.expires_at,deadline);
    await assert.rejects(db.query(`UPDATE event_funnel_session SET expires_at=expires_at+interval '1 minute' WHERE id=$1`,[sessionId]),{code:'23514'});
    await assert.rejects(db.query('UPDATE event_funnel_session SET member_id=$1 WHERE id=$2',[uuid(99),sessionId]),{code:'23514'});
    await db.query(`UPDATE event_funnel_session SET state='payable' WHERE id=$1`,[sessionId]);
    await assert.rejects(saveAnswers(db,3),{code:'PT409'});
    const stale = uuid(13), uncertain = uuid(14);
    await db.query(`INSERT INTO event_funnel_session(id,tenant_id,version_id,member_id,state,created_at,access_expires_at,retain_until)
      VALUES($1,$3,$4,$5,'expired',now()-interval '9 days',now()-interval '8 days',now()-interval '1 day'),
      ($2,$3,$4,$5,'payment_uncertain',now()-interval '9 days',now()-interval '8 days',now()-interval '1 day')`,
    [stale,uncertain,tenant,version,memberId]);
    assert.equal((await db.query('SELECT event_funnel_purge_drafts() n')).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*) FROM event_funnel_session WHERE id=$1',[uncertain])).rows[0].count,'1');
    await db.query('SET ROLE service_role');
    assert.equal((await db.query('SELECT count(*) FROM event_funnel_definition')).rows[0].count, '1');
    assert.equal((await db.query('SELECT event_funnel_readiness() result')).rows[0].result.purchasing, false);
    await assert.rejects(db.query(`UPDATE event_funnel_definition SET graph='{}'`), { code: '42501' });
    await assert.rejects(db.query('SELECT * FROM event_funnel_session'), { code: '42501' });
    await assert.rejects(db.query('SELECT event_funnel_owned_session($1,$2,$3,NULL)',[tenant,sessionId,memberId]),{code:'42501'});
    assert.equal((await readSession(sessionId,memberId,null)).rows[0].result.session.state,'payable');
    for (let i = 0; i < 60; i++) assert.equal((await db.query(`SELECT event_funnel_consume_limit($1,'actor') allowed`, [tenant])).rows[0].allowed, true);
    assert.equal((await db.query(`SELECT event_funnel_consume_limit($1,'actor') allowed`, [tenant])).rows[0].allowed, false);
    await db.query('RESET ROLE');
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM event_funnel_definition'), { code: '42501' });
      await assert.rejects(save(db, 2), { code: '42501' });
      await assert.rejects(db.query('SELECT event_funnel_readiness()'), { code: '42501' });
      await db.query('RESET ROLE');
    }
  } finally {
    await Promise.all(clients.map(client => client.end()));
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
