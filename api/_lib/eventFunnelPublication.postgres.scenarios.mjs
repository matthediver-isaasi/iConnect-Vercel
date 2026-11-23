import assert from 'node:assert/strict';

export async function exerciseFunnelPublication({ db, connect, uuid, tenant, member, sql }) {
  await db.query(await sql('202701230005_event_funnel_publication.sql'));
  const source = uuid(60), other = uuid(61), definition = uuid(62), duplicate = uuid(63), session = uuid(64);
  await db.query(`INSERT INTO event(id,tenant_id,available_seats,is_unlimited_registration,pricing_config)
    VALUES($1,$3,4,false,'{"ticket_classes":[{"id":"A","price":5,"available_count":4}]}'),
          ($2,$3,0,true,NULL)`, [source, other, tenant]);
  const graph = { version: 1, tenantId: tenant, entry: 'source', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    { id: 'source', type: 'source', event: { id: source, kind: 'simple', tenantId: tenant }, ticketIds: ['A'], requires: [], accept: 'other' },
    { id: 'other', type: 'event', event: { id: other, kind: 'simple', tenantId: tenant }, ticketIds: ['default'],
      requires: ['source'], unlisted: true, funnelOnly: true, accept: 'checkout', skip: 'checkout' },
    { id: 'checkout', type: 'checkout' },
  ] };
  const save = (id, revision, value = graph) => db.query(
    `SELECT event_funnel_save_definition($1,$2,'fixture',$3,'Publication fixture',$4,'{"positions":{}}')`,
    [tenant, id, revision, value]);
  await save(definition, 0);
  await assert.rejects(db.query(`SELECT event_funnel_publish($1,$2,1,'fixture','{"version":1}')`, [tenant, definition]), { code: 'PT409' });
  assert.deepEqual((await db.query(`SELECT event_funnel_find_entry($1,'simple',$2) r`, [tenant, source])).rows[0].r, { active: false });
  // Fixture-only activation, never performed against a configured database.
  await db.query(`CREATE OR REPLACE FUNCTION event_funnel_readiness() RETURNS jsonb LANGUAGE sql AS
    $$ SELECT '{"version":1,"authoring":true,"purchasing":true}'::jsonb
      || jsonb_build_object('purchasePolicyInstalled',
        to_regprocedure('public.event_funnel_standalone_offer_allowed(uuid,text,uuid,jsonb)') IS NOT NULL)
      || jsonb_build_object('legacyIntentAuthorityInstalled',
        to_regprocedure('public.event_funnel_prepare_legacy_intent(uuid,uuid,text,uuid,jsonb,jsonb)') IS NOT NULL) $$`);
  const publish = (client, id, revision) => client.query(`SELECT event_funnel_publish($1,$2,$3,'fixture','{"version":1}') r`, [tenant, id, revision]);
  const first = (await publish(db, definition, 1)).rows[0].r;
  assert.equal(first.published, true);
  assert.deepEqual((await publish(db, definition, 1)).rows[0].r, first);
  assert.equal((await db.query(`SELECT event_funnel_find_entry($1,'simple',$2) r`, [tenant, source])).rows[0].r.versionId, first.versionId);
  await save(duplicate, 0);
  await assert.rejects(publish(db, duplicate, 1), { code: 'PT409' });
  const policy = (await db.query(`SELECT event_funnel_offer_policies($1,'simple',$2) r`, [tenant, [source, other]])).rows[0].r;
  assert.equal(policy.find(row => row.eventId === other).funnelOnly, true);
  assert.equal(policy.find(row => row.eventId === other).unlisted, true);
  await db.query(`SELECT event_funnel_create_session($1,$2,$3,$4,NULL)`, [tenant, session, first.versionId, member]);
  const initial = (await db.query(`SELECT event_funnel_read_session($1,$2,$3,NULL) r`, [tenant, session, member])).rows[0].r;
  const line = (nodeId, ticketId, quantity) => ({ nodeId, ticketId, quantity, priceSnapshot: { version: 1, unitMinor: 500 } });
  await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,$4,$5,$6)`, [
    tenant, session, member, initial.session.revision, JSON.stringify([line('source', 'A', 2), line('other', 'default', 10)]),
    { version: 1, decisions: {}, checkoutNow: false },
  ]);
  const availability = (await db.query(`SELECT event_funnel_offer_capacity($1,$2,$3,NULL,'source') r`, [tenant, session, member])).rows[0].r;
  assert.equal(availability.eventRemaining, 4);
  assert.equal(availability.tickets[0].remaining, 4);
  const unlimited = (await db.query(`SELECT event_funnel_offer_capacity($1,$2,$3,NULL,'other') r`, [tenant, session, member])).rows[0].r;
  assert.equal(unlimited.eventRemaining, null);
  await assert.rejects(db.query(`SELECT event_funnel_offer_capacity($1,$2,$3,NULL,'checkout')`, [tenant, session, member]), { code: 'PT404' });
  const changed = structuredClone(graph);
  changed.reservationSeconds = 300;
  changed.nodes[1].unlisted = false;
  await save(definition, 1, changed);
  const peer = await connect();
  const concurrent = await Promise.all([publish(db, definition, 2), publish(peer, definition, 2)]);
  assert.equal(concurrent[0].rows[0].r.versionId, concurrent[1].rows[0].r.versionId);
  assert.notEqual(concurrent[0].rows[0].r.versionId, first.versionId);
  const old = (await db.query(`SELECT event_funnel_read_session($1,$2,$3,NULL) r`, [tenant, session, member])).rows[0].r;
  assert.equal(old.graph.reservationSeconds, 900);
  assert.equal(old.session.version_id, first.versionId);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_entry WHERE tenant_id=$1', [tenant])).rows[0].n, 1);
  for (const role of ['anon', 'authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(publish(db, definition, 2), { code: '42501' });
    await assert.rejects(db.query('SELECT * FROM event_funnel_entry'), { code: '42501' });
    await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query(`UPDATE event_funnel_entry SET source_node_id='forged'`), { code: '42501' });
  await db.query('RESET ROLE');
}
