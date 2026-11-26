import assert from 'node:assert/strict';
export async function exerciseFunnelTicketRouting({ db, connect, uuid, tenant, member, sql }) {
  const legacy = (await db.query(`SELECT id,version_id,expires_at FROM event_funnel_session ORDER BY id LIMIT 1`)).rows[0];
  const legacyEvent = uuid(9600), legacyDefinition = uuid(9601), legacySession = uuid(9602);
  await db.query(`INSERT INTO event(id,tenant_id,pricing_config,available_seats,is_unlimited_registration)
    VALUES($1,$2,'{"ticket_classes":[{"id":"X","available_count":20},{"id":"Y","available_count":20}]}',0,true)`, [legacyEvent, tenant]);
  const legacyGraph = { version: 1, tenantId: tenant, entry: 'source', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    { id: 'source', type: 'source', event: { kind: 'simple', id: legacyEvent, tenantId: tenant },
      ticketIds: ['X','Y'], requires: [], accept: 'checkout' }, { id: 'checkout', type: 'checkout' },
  ] };
  await db.query(`SELECT event_funnel_save_definition($1,$2,'fixture',0,'Legacy multiclass',$3,'{"positions":{}}')`, [tenant, legacyDefinition, legacyGraph]);
  const legacyVersion = (await db.query(`INSERT INTO event_funnel_version(tenant_id,definition_id,definition_revision,graph,commercial_snapshot)
    VALUES($1,$2,1,$3,'{}') RETURNING id`, [tenant, legacyDefinition, legacyGraph])).rows[0].id;
  await db.query(`INSERT INTO event_funnel_session(id,tenant_id,version_id,member_id,access_expires_at,retain_until)
    VALUES($1,$2,$3,$4,now()+interval '1 day',now()+interval '7 days')`, [legacySession, tenant, legacyVersion, member]);
  const legacyLines = JSON.stringify(['X','Y'].map(ticketId => ({ nodeId: 'source', ticketId, quantity: 2, priceSnapshot: { unitMinor: 0 } })));
  const legacyApply = revision => db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,$4,$5,
    '{"version":1,"decisions":{},"checkoutNow":false}') r`, [tenant, legacySession, member, revision, legacyLines]);
  const beforeLegacy = (await legacyApply(1)).rows[0].r;
  await db.query(await sql('202702050001_event_funnel_ticket_routing.sql'));
  const afterLegacy = (await legacyApply(2)).rows[0].r;
  assert.equal(afterLegacy.holds.length, 2);
  assert.equal(afterLegacy.session.version_id, legacyVersion);
  assert.equal(afterLegacy.session.expires_at, beforeLegacy.session.expires_at);
  // Disposable fixture activation only. Never applies to configured databases.
  await db.query(`CREATE OR REPLACE FUNCTION event_funnel_readiness() RETURNS jsonb LANGUAGE sql AS
    $$ SELECT '{"version":1,"purchasing":true}'::jsonb $$`);
  const event = uuid(9500);
  const classes = Array.from({ length: 25 }, (_, i) => ({ id: `day-${i}`, name: `Day ${i}`, available_count: 10 }));
  await db.query(`INSERT INTO event(id,tenant_id,pricing_config,available_seats,is_unlimited_registration)
    VALUES($1,$2,$3,0,true)`, [event, tenant, { ticket_classes: classes }]);
  const graph = ticketIds => ({ version: 1, entryMode: 'ticket_single', tenantId: tenant,
    entry: 'source', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
      { id: 'source', type: 'source', selectionMode: 'single', event: { kind: 'simple', id: event, tenantId: tenant }, ticketIds, requires: [], accept: 'checkout' },
      { id: 'checkout', type: 'checkout' },
    ] });
  const save = (client, id, tickets, revision = 0) => client.query(
    `SELECT event_funnel_save_definition($1,$2,'fixture',$3,'Ticket route',$4,'{"positions":{}}')`, [tenant, id, revision, graph(tickets)]);
  const publish = (client, id, revision = 1) => client.query(
    `SELECT event_funnel_publish($1,$2,$3,'fixture','{"version":1}') r`, [tenant, id, revision]);
  const resolve = async (ticket, scope = tenant) => (await db.query(
    `SELECT event_funnel_resolve_entry($1,'simple',$2,$3) r`, [scope, event, ticket])).rows[0].r;
  assert.equal((await resolve('day-0')).reason, 'disabled');
  const versions = [];
  for (let i = 0; i < 21; i++) {
    const id = uuid(9510 + i);
    await save(db, id, [`day-${i}`]);
    versions.push((await publish(db, id)).rows[0].r.versionId);
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_ticket_entry WHERE event_id=$1', [event])).rows[0].n, 21);
  await db.query(`SELECT event_funnel_set_enabled($1,'simple',$2,true,0,'fixture')`, [tenant, event]);
  assert.equal((await resolve(null)).routing, 'ticket');
  for (let i = 0; i < 21; i++) assert.equal((await resolve(`day-${i}`)).versionId, versions[i]);
  assert.equal((await resolve('day-23')).outcome, 'normal');
  await assert.rejects(resolve('day-0', uuid(9999)), { code: 'PT404' });
  await assert.rejects(db.query(`SELECT event_funnel_find_entry($1,'simple',$2)`, [tenant, event]), { code: 'PT409' });
  const group = uuid(9540), peer = await connect();
  await save(db, group, ['day-21', 'day-22']);
  await publish(db, group);
  assert.equal((await resolve('day-21')).versionId, (await resolve('day-22')).versionId);
  const a = uuid(9541), b = uuid(9542);
  await save(db, a, ['day-23']); await save(db, b, ['day-23']);
  const race = await Promise.allSettled([publish(db, a), publish(peer, b)]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(race.find(result => result.status === 'rejected').reason.message, /Day 23/);
  const start = (id, ticket) => db.query(`SELECT event_funnel_start_routed($1,$2,'simple',$3,$4,$5,NULL) r`,
    [tenant, id, event, ticket, member]);
  const session = uuid(9550);
  await start(session, 'day-0'); await start(session, 'day-0');
  await assert.rejects(start(session, 'day-1'), { code: 'PT409' });
  const lines = (ticket, qty = 1) => [{ nodeId: 'source', ticketId: ticket, quantity: qty, priceSnapshot: { unitMinor: 0 } }];
  const apply = value => db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,
    '{"version":1,"decisions":{},"checkoutNow":false}')`, [tenant, session, member, JSON.stringify(value)]);
  await assert.rejects(apply([...lines('day-0'), ...lines('day-1')]), { code: '22023' });
  await assert.rejects(apply(lines('day-1')), { code: '22023' });
  await apply(lines('day-0', 3));
  const deadline = (await db.query('SELECT expires_at FROM event_funnel_session WHERE id=$1', [session])).rows[0].expires_at;
  const replacement = uuid(9551);
  const switchSource = (quantity, revision = 2) => db.query(`SELECT event_funnel_switch_source(
    $1,$2,$3,NULL,$4,$5,NULL,'simple',$6,'day-1',$7,$8,'{}') r`,
    [tenant, session, member, revision, replacement, event, versions[1], JSON.stringify(lines('day-1', quantity))]);
  await assert.rejects(switchSource(100), { code: '23514' });
  assert.equal((await db.query('SELECT sum(quantity)::int n FROM event_funnel_hold WHERE session_id=$1', [session])).rows[0].n, 3);
  await switchSource(2);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_hold WHERE session_id=$1', [session])).rows[0].n, 0);
  const switched = (await db.query('SELECT version_id,expires_at FROM event_funnel_session WHERE id=$1', [replacement])).rows[0];
  assert.equal(switched.version_id, versions[1]); assert.equal(+switched.expires_at, +deadline);
  assert.equal((await switchSource(2)).rows[0].r.sessionId, replacement);
  const replay = (await db.query(`SELECT event_funnel_replay_source_switch($1,$2,$3,$4,NULL,'simple',$5,'day-1') r`,
    [tenant, replacement, session, member, event])).rows[0].r;
  assert.equal(replay.found, true);
  // Publication replacement removes obsolete class ownership, not old versions.
  await save(db, uuid(9510), ['day-24'], 1);
  await publish(db, uuid(9510), 2);
  assert.equal((await resolve('day-0')).reason, 'no_match');
  const normalId = uuid(9552);
  const normal = (await db.query(`SELECT event_funnel_switch_source(
    $1,$2,$3,NULL,2,$4,NULL,'simple',$5,'day-0',NULL,'[]','{}') r`,
    [tenant, replacement, member, normalId, event])).rows[0].r;
  assert.equal(normal.outcome, 'normal');
  assert.equal(+new Date(normal.expiresAt), +deadline);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_hold WHERE session_id=$1', [replacement])).rows[0].n, 0);
  const standalone = tickets => db.query(`SELECT event_funnel_standalone_offer_allowed($1,'simple',$2,$3) r`,
    [tenant, event, JSON.stringify(tickets)]);
  assert.equal((await standalone(['day-0'])).rows[0].r, true);
  assert.equal((await standalone(['day-1'])).rows[0].r, false);
  assert.equal((await standalone(['day-0', 'day-1'])).rows[0].r, false);
  await db.query(`CREATE OR REPLACE FUNCTION event_funnel_readiness() RETURNS jsonb LANGUAGE sql AS
    $$ SELECT '{"version":1,"purchasing":false}'::jsonb $$`);
  await assert.rejects(resolve('day-0'), { code: 'PT409' });
  await assert.rejects(standalone(['day-0']), { code: 'PT409' });
  await db.query(`SELECT event_funnel_set_enabled($1,'simple',$2,false,1,'fixture')`, [tenant, event]);
  assert.equal((await resolve('day-1')).reason, 'disabled');
  assert.equal((await standalone(['day-0', 'day-1'])).rows[0].r, true);
  assert.equal((await db.query('SELECT version_id FROM event_funnel_session WHERE id=$1', [replacement])).rows[0].version_id, versions[1]);
  if (legacy) {
    const retained = (await db.query('SELECT version_id,expires_at FROM event_funnel_session WHERE id=$1', [legacy.id])).rows[0];
    assert.equal(retained.version_id, legacy.version_id);
    assert.equal(+retained.expires_at, +legacy.expires_at);
  }
  // Complex events use the same event-kind scoped key, not the simple ID.
  const complex = uuid(9560), ticket = uuid(9561), def = uuid(9562);
  await db.query(`CREATE OR REPLACE FUNCTION event_funnel_readiness() RETURNS jsonb LANGUAGE sql AS
    $$ SELECT '{"version":1,"purchasing":true}'::jsonb $$`);
  await db.query('INSERT INTO complex_event(id,tenant_id,available_seats) VALUES($1,$2,0)', [complex, tenant]);
  await db.query('INSERT INTO complex_event_ticket_class(id,tenant_id,complex_event_id,available_count,is_unlimited_tickets) VALUES($1,$2,$3,30,false)',
    [ticket, tenant, complex]);
  const complexGraph = graph([ticket]); complexGraph.nodes[0].event = { kind: 'complex', id: complex, tenantId: tenant };
  await db.query(`SELECT event_funnel_save_definition($1,$2,'fixture',0,'Complex route',$3,'{"positions":{}}')`, [tenant, def, complexGraph]);
  await publish(db, def);
  await db.query(`SELECT event_funnel_set_enabled($1,'complex',$2,true,0,'fixture')`, [tenant, complex]);
  assert.equal((await db.query(`SELECT event_funnel_resolve_entry($1,'complex',$2,$3) r`, [tenant, complex, ticket])).rows[0].r.active, true);
  const lockOwner = await connect();
  await lockOwner.query('BEGIN');
  await lockOwner.query(`SELECT event_funnel_set_enabled($1,'simple',$2,true,2,'fixture')`, [tenant, event]);
  await peer.query(`SET lock_timeout='100ms'`);
  await assert.rejects(publish(peer, uuid(9510), 2), { code: '55P03' });
  await lockOwner.query('ROLLBACK');
  await peer.query(`RESET lock_timeout`);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM event_funnel_ticket_entry'), { code: '42501' });
    if (role !== 'service_role') await assert.rejects(resolve('day-0'), { code: '42501' });
    await db.query('RESET ROLE');
  }
}
