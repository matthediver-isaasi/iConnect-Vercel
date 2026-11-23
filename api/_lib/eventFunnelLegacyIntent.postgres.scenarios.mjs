import assert from 'node:assert/strict';
export async function exerciseFunnelLegacyIntent({db,connect,uuid,tenant,sql}) {
  await db.query(await sql('202701230014_event_funnel_legacy_intents.sql'));
  const parameters={amount:1000,currency:'gbp',metadata:{tenant_id:tenant,event_id:uuid(601)}};
  const prepare=(id,event=601,params=parameters)=>db.query(
    `SELECT event_funnel_prepare_legacy_intent($1,$2,'simple',$3,'["default"]',$4) value`,
    [tenant,uuid(id),uuid(event),params]);
  const first=(await prepare(700)).rows[0].value;
  assert.equal(first.provider_request.metadata.event_funnel_legacy_authority_id,uuid(700));
  assert.deepEqual((await prepare(700)).rows[0].value,first);
  await assert.rejects(prepare(700,601,{...parameters,amount:2000}),{code:'PT409'});
  await assert.rejects(db.query(`SELECT event_funnel_prepare_legacy_intent($1,$2,'simple',$3,'["A"]',$4)`,
    [tenant,uuid(701),uuid(600),{...parameters,metadata:{tenant_id:tenant,event_id:uuid(600)}}]),{code:'PT403'});
  await db.query(`SELECT event_funnel_bind_legacy_intent($1,$2,$3,'pi_fixture')`,[tenant,uuid(700),first.request_hash]);
  await db.query(`SELECT event_funnel_bind_legacy_intent($1,$2,$3,'pi_fixture')`,[tenant,uuid(700),first.request_hash]);
  await assert.rejects(db.query(`SELECT event_funnel_bind_legacy_intent($1,$2,$3,'pi_changed')`,
    [tenant,uuid(700),first.request_hash]),{code:'PT409'});
  await prepare(702);
  const publisher=await connect(),buyer=await connect();
  await publisher.query('BEGIN');
  let attempted;
  try {
    await publisher.query(`SELECT event_funnel_lock_event($1,'simple',$2)`,[tenant,uuid(601)]);
    await publisher.query(`INSERT INTO event_funnel_offer_policy(tenant_id,version_id,node_id,event_kind,event_id,ticket_ids,unlisted,funnel_only,prerequisites)
      SELECT $1,version_id,'fixture-legacy','simple',$2,'["default"]',false,true,'["source"]'
      FROM event_funnel_entry WHERE tenant_id=$1 LIMIT 1`,[tenant,uuid(601)]);
    attempted=buyer.query(`SELECT event_funnel_prepare_legacy_intent($1,$2,'simple',$3,'["default"]',$4)`,
      [tenant,uuid(703),uuid(601),parameters]).then(()=>null,error=>error);
    let blocked=false;
    for(let i=0;i<100&&!blocked;i++) {
      blocked=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0
        AND query LIKE 'SELECT event_funnel_prepare_legacy_intent%') blocked`)).rows[0].blocked;
      if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(blocked,true);
    await publisher.query('COMMIT');
    assert.equal((await attempted)?.code,'PT403');
    assert.equal((await prepare(700)).rows[0].value.payment_intent_id,'pi_fixture');
  } finally {
    await publisher.query('ROLLBACK');
    if(attempted)await attempted;
    await db.query(`DELETE FROM event_funnel_offer_policy WHERE tenant_id=$1 AND node_id='fixture-legacy'`,[tenant]);
  }
  await db.query(`UPDATE event_funnel_legacy_intent SET created_at=now()-interval '31 days' WHERE tenant_id=$1`,[tenant]);
  assert.equal((await db.query('SELECT event_funnel_prune_legacy_intents() n')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_legacy_intent')).rows[0].n,1);
  await db.query('SET ROLE authenticated');
  await assert.rejects(db.query('SELECT * FROM event_funnel_legacy_intent'),{code:'42501'});
  await db.query('RESET ROLE');
}
