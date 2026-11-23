import assert from 'node:assert/strict';
export async function exerciseFunnelDiscovery({db,uuid,tenant,sql}) {
  await db.query(await sql('202701230012_event_funnel_discovery.sql'));
  const version=(await db.query('SELECT version_id FROM event_funnel_entry WHERE tenant_id=$1 LIMIT 1',[tenant])).rows[0].version_id;
  const hidden=uuid(600),visible=uuid(601),complex=uuid(602);
  await db.query('INSERT INTO event(id,tenant_id) VALUES($1,$3),($2,$3)',[hidden,visible,tenant]);
  await db.query('INSERT INTO complex_event(id,tenant_id) VALUES($1,$2)',[complex,tenant]);
  for(const [kind,id,node] of [['simple',hidden,'fixture-hidden-simple'],['complex',complex,'fixture-hidden-complex']]) {
    await db.query(`INSERT INTO event_funnel_offer_policy(tenant_id,version_id,node_id,event_kind,event_id,ticket_ids,unlisted,funnel_only,prerequisites)
      VALUES($1,$2,$3,$4,$5,'[]',true,false,'[]')`,[tenant,version,node,kind,id]);
  }
  const result=await db.query(`SELECT e.id,count(*) OVER() AS total FROM event e WHERE e.id=ANY($1)
    AND event_funnel_discoverable(e) ORDER BY e.id LIMIT 1`,[[hidden,visible]]);
  assert.equal(result.rows[0].id,visible);assert.equal(result.rows[0].total,'1');
  assert.equal((await db.query('SELECT event_funnel_discoverable(e) listed FROM complex_event e WHERE e.id=$1',[complex])).rows[0].listed,false);
  await db.query('BEGIN');
  await db.query('DELETE FROM event_funnel_entry WHERE tenant_id=$1 AND version_id=$2',[tenant,version]);
  assert.equal((await db.query('SELECT event_funnel_discoverable(e) listed FROM complex_event e WHERE e.id=$1',[complex])).rows[0].listed,true);
  await db.query('ROLLBACK');
  // Unlisted rows remain real events: direct lookup and status are unaffected.
  assert.equal((await db.query('SELECT id FROM event WHERE id=$1',[hidden])).rows[0].id,hidden);
  await db.query(`UPDATE event_funnel_offer_policy SET unlisted=false WHERE tenant_id=$1 AND node_id='fixture-hidden-simple'`,[tenant]);
  assert.equal((await db.query('SELECT event_funnel_discoverable(e) listed FROM event e WHERE e.id=$1',[hidden])).rows[0].listed,true);
  await db.query('SET ROLE authenticated');
  await assert.rejects(db.query('SELECT event_funnel_discovery_ready()'),{code:'42501'});
  await db.query('RESET ROLE');
}
