import assert from 'node:assert/strict';

export async function exerciseFunnelVoucherOrders({db,uuid,tenant,member,sql}) {
  await db.query(await sql('202701230009_event_funnel_voucher_reservations.sql'));
  await db.query('ALTER TABLE booking ADD voucher_amount numeric');
  const version=(await db.query('SELECT version_id FROM event_funnel_entry WHERE tenant_id=$1',[tenant])).rows[0].version_id;
  const graph=(await db.query('SELECT graph FROM event_funnel_version WHERE id=$1',[version])).rows[0].graph;
  const source=graph.nodes.find(node=>node.id===graph.entry),session=uuid(310),booking=uuid(311),voucher=uuid(300),organization=uuid(200);
  await db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)',[tenant,session,version,member]);
  const purchaser={first_name:'Voucher',last_name:'Fixture',email:'voucher@example.test'};
  const price={version:1,unitMinor:500,currency:'GBP',purchaser,paymentMethods:['card','account']};
  await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,'{"version":1,"decisions":{},"checkoutNow":true}')`,
    [tenant,session,member,JSON.stringify([{nodeId:source.id,ticketId:'A',quantity:1,priceSnapshot:price}])]);
  const terms={version:1,voucherAttributionVersion:1,submissionAccepted:true,purchaser,invoiceMode:graph.invoiceMode,currency:'GBP',
    paymentMethod:'free',payableMinor:0,trainingFundMinor:200,voucherMinor:300,
    voucherAllocations:[{voucherId:voucher,amountMinor:300,lines:[{nodeId:source.id,ticketId:'A',amountMinor:300}]}],
    lines:[{nodeId:source.id,ticketId:'A',eventId:source.event.id,eventKind:'simple',quantity:1,places:1,
      priceSnapshot:price,amountMinor:500,payableMinor:0,trainingFundMinor:200,voucherMinor:300,
      registrations:[{id:booking,places:1,grossMinor:500,payableMinor:0,trainingFundMinor:200,voucherMinor:300,
        voucherContributions:[{voucherId:voucher,amountMinor:300}],
        row:{id:booking,tenant_id:tenant,event_id:source.event.id,member_id:member,organization_id:organization,
          ticket_class_id:'A',status:'confirmed',payment_method:'voucher',training_fund_amount:2,voucher_amount:3}}]}]};
  const prepare=()=>db.query('SELECT event_funnel_prepare_order($1,$2,$3,NULL,2,$4) r',[tenant,session,member,terms]);
  // A competing ordinary purchase reduces the available balance after quote.
  await db.query(`SELECT voucher_credit_reserve($1,'ordinary-competitor',$2,$2,$3,1800,'GBP',true,false)`,
    [tenant,member,[voucher]]);
  const before=(await db.query('SELECT expires_at FROM event_funnel_session WHERE id=$1',[session])).rows[0].expires_at;
  await assert.rejects(prepare(),{code:'PT409'});
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_order WHERE session_id=$1',[session])).rows[0].n,0);
  assert.equal(Number((await db.query('SELECT training_fund_balance FROM organization WHERE id=$1',[organization])).rows[0].training_fund_balance),3);
  assert.equal((await db.query('SELECT sum(amount_minor)::int n FROM event_funnel_training_reservation WHERE state=$1',['held'])).rows[0].n,null);
  assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[voucher])).rows[0].value),2);
  assert.equal((await db.query('SELECT expires_at FROM event_funnel_session WHERE id=$1',[session])).rows[0].expires_at.toISOString(),before.toISOString());
  await db.query(`SELECT voucher_credit_transition($1,'ordinary-competitor','release','not_started')`,[tenant]);
  const prepared=(await prepare()).rows[0].r;
  assert.equal(prepared.payable_minor,0);
  assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[voucher])).rows[0].value),17);
  assert.equal(Number((await db.query('SELECT training_fund_balance FROM organization WHERE id=$1',[organization])).rows[0].training_fund_balance),3);
  const finish=()=>db.query(`SELECT event_funnel_finalize_order($1,$2,'{"method":"free"}') r`,[tenant,prepared.id]);
  assert.equal((await finish()).rows[0].r.state,'confirmed');await finish();
  assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[voucher])).rows[0].value),17);
  assert.equal(Number((await db.query('SELECT training_fund_balance FROM organization WHERE id=$1',[organization])).rows[0].training_fund_balance),1);
  assert.deepEqual((await db.query('SELECT training_fund_minor,voucher_minor,payable_minor FROM event_funnel_order_booking WHERE order_id=$1',[prepared.id])).rows[0],
    {training_fund_minor:'200',voucher_minor:'300',payable_minor:'0'});
  const reservation=(await db.query('SELECT * FROM event_funnel_voucher_reservation WHERE order_id=$1',[prepared.id])).rows[0];
  assert.equal(reservation.state,'committed');
  assert.equal((await db.query(`SELECT count(*)::int n FROM voucher_transaction WHERE booking_reference=$1 AND type='booking_usage'`,
    [reservation.purchase_key])).rows[0].n,1);
  const cancellationSession=uuid(312);
  await db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)',[tenant,cancellationSession,version,member]);
  await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,'{"version":1,"decisions":{},"checkoutNow":true}')`,
    [tenant,cancellationSession,member,JSON.stringify([{nodeId:source.id,ticketId:'A',quantity:1,priceSnapshot:price}])]);
  const cancelTerms=structuredClone(terms);
  Object.assign(cancelTerms,{paymentMethod:'card',payableMinor:300,trainingFundMinor:0,voucherMinor:200,
    paymentAuthority:{mode:'test',accountFingerprint:'fixture'}});
  cancelTerms.voucherAllocations[0].amountMinor=200;cancelTerms.voucherAllocations[0].lines[0].amountMinor=200;
  Object.assign(cancelTerms.lines[0],{payableMinor:300,trainingFundMinor:0,voucherMinor:200});
  Object.assign(cancelTerms.lines[0].registrations[0],{id:uuid(313),payableMinor:300,trainingFundMinor:0,voucherMinor:200});
  cancelTerms.lines[0].registrations[0].voucherContributions[0].amountMinor=200;
  Object.assign(cancelTerms.lines[0].registrations[0].row,{id:uuid(313),payment_method:'card',training_fund_amount:0,voucher_amount:2});
  const pending=(await db.query('SELECT event_funnel_prepare_order($1,$2,$3,NULL,2,$4) r',[tenant,cancellationSession,member,cancelTerms])).rows[0].r;
  assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[voucher])).rows[0].value),15);
  await db.query(`SELECT event_funnel_release_order($1,$2,'{"outcome":"not_started"}')`,[tenant,pending.id]);
  assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[voucher])).rows[0].value),17);
  assert.equal((await db.query('SELECT state FROM event_funnel_voucher_reservation WHERE order_id=$1',[pending.id])).rows[0].state,'released');
  assert.equal((await db.query('SELECT state FROM event_funnel_session WHERE id=$1',[cancellationSession])).rows[0].state,'held');
}
