import assert from 'node:assert/strict';
export async function exerciseFunnelPurchasePolicy({db,connect,uuid,tenant,sql}) {
  // Minimal existing-contract boundary fixture; full historical migration
  // rehearsal remains a separate activation gate.
  await db.query(`CREATE TABLE unified_booking_contract(id uuid PRIMARY KEY,tenant_id uuid,source text,event_id uuid,snapshot jsonb)`);
  await db.query(`CREATE TABLE event_invoice_address_policy(id uuid PRIMARY KEY,tenant_id uuid,source text,event_id uuid,snapshot jsonb)`);
  await db.query(await sql('202701230013_event_funnel_purchase_policy.sql'));
  const insert=(id,tickets)=>db.query(`INSERT INTO unified_booking_contract VALUES($1,$2,'booking',$3,$4)`,
    [uuid(id),tenant,uuid(600),{request:{ticketIds:tickets}}]);
  await insert(610,['A']);
  await db.query(`UPDATE event_funnel_offer_policy SET funnel_only=true,ticket_ids='["A"]',prerequisites='["source"]'
    WHERE tenant_id=$1 AND node_id='fixture-hidden-simple'`,[tenant]);
  await assert.rejects(insert(611,['A']),{code:'PT403'});
  await assert.rejects(insert(612,[]),{code:'PT403'});
  await insert(613,['B']);
  const invoiceInsert=(id,ticket)=>db.query(`INSERT INTO event_invoice_address_policy VALUES($1,$2,'simple',$3,$4)`,
    [uuid(id),tenant,uuid(600),{request:{charge:{metadata:{ticket_class_id:ticket}}}}]);
  const guestInsert=(id,ticket)=>db.query(`INSERT INTO public_ticket_member_purchase(id,tenant_id,event_kind,event_id,snapshot)
    VALUES($1,$2,'simple',$3,$4) ON CONFLICT(id) DO NOTHING`,
    [uuid(id),tenant,uuid(600),{ticket_policies:[{ticket_id:ticket}]}]);
  await assert.rejects(invoiceInsert(620,'A'),{code:'PT403'});
  await assert.rejects(guestInsert(621,'A'),{code:'PT403'});
  await invoiceInsert(622,'B');
  await guestInsert(623,'B');
  const publisher=await connect(),buyer=await connect();
  await publisher.query('BEGIN');
  let attempted;
  try {
    await publisher.query(`SELECT event_funnel_lock_event($1,'simple',$2)`,[tenant,uuid(600)]);
    await publisher.query(`UPDATE event_funnel_offer_policy SET ticket_ids='["A","B"]'
      WHERE tenant_id=$1 AND node_id='fixture-hidden-simple'`,[tenant]);
    attempted=buyer.query(`INSERT INTO unified_booking_contract VALUES($1,$2,'booking',$3,$4)`,
      [uuid(614),tenant,uuid(600),{request:{ticketIds:['B']}}]).then(()=>null,error=>error);
    let blocked=false;
    for(let i=0;i<100&&!blocked;i++) {
      blocked=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE 'INSERT INTO unified_booking_contract%') blocked`)).rows[0].blocked;
      if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(blocked,true,'contract preparation waits for publication authority');
    await publisher.query('COMMIT');
    assert.equal((await attempted)?.code,'PT403','the waiting checkout sees the newly published restriction');
    await guestInsert(623,'B');
    await assert.rejects(guestInsert(623,'A'),{code:'PT403'});
    await assert.rejects(invoiceInsert(622,'B'),{code:'23505'});
  } finally {
    await publisher.query('ROLLBACK');
    if(attempted)await attempted;
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM unified_booking_contract')).rows[0].n,2);
  await db.query(`UPDATE event_funnel_offer_policy SET funnel_only=true,ticket_ids='["A"]',prerequisites='["source"]'
    WHERE tenant_id=$1 AND node_id='fixture-hidden-complex'`,[tenant]);
  await assert.rejects(db.query(`INSERT INTO event_invoice_address_policy VALUES($1,$2,'complex',$3,$4)`,
    [uuid(630),tenant,uuid(602),{request:{charge:{items:[{ticket_class_id:'A'}]}}}]),{code:'PT403'});
  await db.query(`INSERT INTO event_invoice_address_policy VALUES($1,$2,'complex',$3,$4)`,
    [uuid(631),tenant,uuid(602),{request:{charge:{items:[{ticket_class_id:'B'}]}}}]);
  assert.equal((await db.query('SELECT event_funnel_readiness() r')).rows[0].r.purchasePolicyInstalled,true);
  await db.query('SET ROLE authenticated');
  await assert.rejects(db.query(`SELECT event_funnel_standalone_offer_allowed($1,'simple',$2,'["A"]')`,[tenant,uuid(600)]),{code:'42501'});
  await db.query('RESET ROLE');
}
