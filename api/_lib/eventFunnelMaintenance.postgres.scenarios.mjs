import assert from 'node:assert/strict';

export async function exerciseFunnelMaintenance({db,uuid,tenant,member,sql}) {
  await db.query(await sql('202701230011_event_funnel_maintenance.sql'));
  const version=(await db.query('SELECT id FROM event_funnel_version WHERE tenant_id=$1 LIMIT 1',[tenant])).rows[0].id;
  const abandoned=uuid(500),cancelled=uuid(501),uncertain=uuid(502),retained=uuid(503);
  for(const [session,state] of [[abandoned,'held'],[cancelled,'cancelled'],[uncertain,'payment_uncertain'],[retained,'held']]) {
    await db.query(`INSERT INTO event_funnel_session(id,tenant_id,version_id,member_id,state,created_at,access_expires_at,retain_until,first_reserved_at,expires_at)
      VALUES($1,$2,$3,$4,$5,now()-interval '20 days',now()-interval '10 days',
        CASE WHEN $1::uuid=$6::uuid THEN now()+interval '1 day' ELSE now()-interval '5 days' END,
        now()-interval '19 days',now()-interval '18 days')`,[session,tenant,version,member,state,retained]);
    await db.query(`INSERT INTO event_funnel_draft(tenant_id,session_id,node_id,answers) VALUES($1,$2,'source','{"fixture":true}')`,[tenant,session]);
  }
  for(const [session,state] of [[cancelled,'cancelled'],[uncertain,'payment_uncertain']]) {
    await db.query(`INSERT INTO event_funnel_order(tenant_id,session_id,session_revision,version_id,payment_method,currency,payable_minor,snapshot,state)
      VALUES($1,$2,1,$3,'card','GBP',100,'{"version":1}',$4)`,[tenant,session,version,state]);
  }
  const result=(await db.query('SELECT event_funnel_maintenance() r')).rows[0].r;
  assert.ok(result.expired>=2);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_session WHERE id=$1',[abandoned])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_session WHERE id=$1',[cancelled])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_draft WHERE session_id=$1',[cancelled])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_draft WHERE session_id=$1',[uncertain])).rows[0].n,1);
  assert.equal((await db.query('SELECT state FROM event_funnel_session WHERE id=$1',[uncertain])).rows[0].state,'payment_uncertain');
  assert.equal((await db.query('SELECT state FROM event_funnel_session WHERE id=$1',[retained])).rows[0].state,'expired');
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_draft WHERE session_id=$1',[retained])).rows[0].n,1);
  await db.query('SELECT event_funnel_purge_drafts()');
  await db.query('SET ROLE authenticated');
  await assert.rejects(db.query('SELECT event_funnel_maintenance()'),{code:'42501'});
  await db.query('RESET ROLE');
}
