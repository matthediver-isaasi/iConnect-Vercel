import assert from 'node:assert/strict';
import {deliverFunnelInvoices,funnelInvoiceRecoveryDatabase} from './eventFunnelInvoiceDelivery.js';
import {processEventInvoiceRecovery} from './eventInvoiceRecovery.js';

export async function exerciseFunnelInvoiceDelivery({db,connect,sql}) {
  // Use the actual shared connection lease table definition, not an alternate
  // test-only lock contract. The complete accounting baseline remains a rollout gate.
  const baseline=await sql('202611300001_event_invoice_recovery.sql');
  const start=baseline.indexOf('CREATE TABLE IF NOT EXISTS public.event_invoice_recovery_connection (');
  assert.ok(start>=0);
  await db.query(baseline.slice(start,baseline.indexOf(');',start)+2));
  await db.query(await sql('202701230016_event_funnel_invoice_delivery.sql'));
  const preparedRow=(await db.query('SELECT * FROM event_funnel_invoice_preparation LIMIT 1')).rows[0];
  assert.ok(preparedRow);
  const prepared=preparedRow.prepared, payable=prepared.find(item=>item.amountMinor>0);
  assert.ok(payable);
  // Synthetic provider-ready evidence in this disposable database only.
  // Original preparation/read/immutability checks run in the preceding scenario.
  const snapshot={version:1,bookingContractVersion:2,contact:{name:'Fixture buyer'},
    taxResolution:{version:1,kind:'future_checkout_provider_tax',capturedAt:'2026-11-23T12:00:00Z'},
    currency:payable.currency,amount:payable.amountMinor/100,paymentMethod:'stripe',
    provider:{connectionId:'fixture-connection',xeroTenantId:'fixture-company'},
    settlement:{paymentIntentId:'pi_fixture',livemode:true,status:'succeeded',amount:payable.amountMinor/100,
      currency:payable.currency,paidAt:'2026-11-23T12:00:00Z',accountCode:'090'},
    invoice:{Type:'ACCREC',Status:'AUTHORISED',Contact:{Name:'Fixture buyer'},CurrencyCode:payable.currency,
      Date:'2026-11-23',DueDate:'2026-12-23',LineAmountTypes:'Inclusive',
      LineItems:[{Description:'Original event allocation',Quantity:1,UnitAmount:payable.amountMinor/100,
        AccountCode:'200',TaxType:'NONE',TaxAmount:0}]}};
  payable.provider='xero';payable.status='pending';payable.snapshot=snapshot;
  await db.query('UPDATE event_funnel_invoice_preparation SET prepared=$1 WHERE tenant_id=$2 AND order_id=$3',
    [JSON.stringify(prepared),preparedRow.tenant_id,preparedRow.order_id]);
  const token=(await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=gen_random_uuid(),
    lease_until=now()+interval '2 minutes' WHERE tenant_id=$1 AND order_id=$2 AND kind='invoices' RETURNING lease_token`,
  [preparedRow.tenant_id,preparedRow.order_id])).rows[0].lease_token;
  const job={tenant_id:preparedRow.tenant_id,order_id:preparedRow.order_id,lease_token:token};
  const adapter=client=>({rpc:async(name,args)=>{
    try {
      let values;
      if(name==='event_funnel_invoice_operation') values=[args.p_action,JSON.stringify(args.p_args)];
      else if(['event_funnel_invoice_input','event_funnel_invoice_enqueue'].includes(name)) values=[args.p_tenant,args.p_order,args.p_token];
      // Installed later in this database; PostgREST reports it as absent here.
      else if(name==='event_funnel_invoice_email_operation') return {data:null,error:{code:'PGRST202'}};
      else throw new Error(`Unexpected RPC ${name}`);
      return {data:(await client.query(`SELECT ${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) r`,values)).rows[0].r};
    } catch(error) {return {error};}
  }});
  const client=adapter(db);
  await db.query('SET ROLE service_role');
  const seeded=await client.rpc('event_funnel_invoice_enqueue',{p_tenant:job.tenant_id,p_order:job.order_id,p_token:token});
  assert.ifError(seeded.error);
  const claimed=await client.rpc('event_funnel_invoice_operation',{p_action:'claim',p_args:{
    p_tenant_id:job.tenant_id,p_source:'event_funnel',p_group:payable.key}});
  assert.ifError(claimed.error);assert.ok(claimed.data.id);
  const competitor=await connect();await competitor.query('SET ROLE service_role');
  assert.equal((await adapter(competitor).rpc('event_funnel_invoice_operation',{p_action:'claim',p_args:{
    p_tenant_id:job.tenant_id,p_source:'event_funnel',p_group:payable.key}})).data,null);
  const guardArgs={p_id:claimed.data.id,p_token:claimed.data.lease_token};
  assert.equal((await client.rpc('event_funnel_invoice_operation',{p_action:'guard',p_args:{
    ...guardArgs,p_token:'00000000-0000-4000-8000-000000000099'}})).data,false);
  assert.equal((await client.rpc('event_funnel_invoice_operation',{p_action:'finish',
    p_args:{...guardArgs,p_status:'retry',p_next:'2000-01-01T00:00:00Z'}})).data,true);
  let invoices=[],payments=[],invoiceWrites=0,paymentWrites=0,loseResponse=true;
  const factory=async({guard,row})=>({
    resolveTaxIntent:async()=>({...structuredClone(row.snapshot),
      resolvedTaxEvidence:{version:1,provider:row.snapshot.provider,observedAt:'2026-11-23T12:01:00Z',lines:[]}}),
    findInvoices:async()=>invoices,findPayments:async()=>payments,
    createInvoice:async()=>{
      await guard();invoiceWrites++;
      invoices=[{InvoiceID:'invoice-original',InvoiceNumber:'INV-1',Status:'AUTHORISED',AmountPaid:0,AmountDue:row.snapshot.amount}];
      if(loseResponse) {loseResponse=false;throw new Error('Ambiguous response after provider accepted invoice');}
      return invoices[0];
    },
    validateInvoice:invoice=>assert.equal(invoice.InvoiceID,'invoice-original'),
    createPayment:async invoice=>{
      await guard();paymentWrites++;
      payments=[{PaymentID:'payment-original',InvoiceID:invoice.InvoiceID,Amount:row.snapshot.settlement.amount}];
      return payments[0];
    },
    validatePayment:(payment,invoice)=>{
      assert.equal(payment.InvoiceID,invoice.InvoiceID);assert.equal(payment.Amount,payable.amountMinor/100);
    },
  });
  const first=await deliverFunnelInvoices({db:client,job,providerFactory:factory});
  assert.equal(first.status,'retry');assert.equal(invoiceWrites,1);assert.equal(paymentWrites,0);
  await db.query('RESET ROLE');
  await db.query(`UPDATE event_funnel_invoice_work SET next_attempt_at=now() WHERE tenant_id=$1 AND order_id=$2`,
    [job.tenant_id,job.order_id]);
  await db.query('SET ROLE service_role');
  const second=await deliverFunnelInvoices({db:client,job,providerFactory:factory});
  assert.equal(second.status,'delivered');assert.equal(invoiceWrites,1);assert.equal(paymentWrites,1);
  assert.equal((await deliverFunnelInvoices({db:client,job,providerFactory:factory})).status,'delivered');
  assert.equal(paymentWrites,1);
  await assert.rejects(db.query('SELECT * FROM event_funnel_invoice_work'),{code:'42501'});
  await db.query('RESET ROLE');
  const links=(await db.query('SELECT * FROM event_funnel_invoice_booking WHERE tenant_id=$1',[job.tenant_id])).rows;
  assert.equal(links.length,payable.events.flatMap(e=>e.bookingIds).length);
  assert.equal(links.reduce((sum,row)=>sum+Number(row.amount_minor),0),payable.amountMinor);
  const owned=payable.events[0];
  await db.query('SET ROLE service_role');
  assert.equal((await db.query('SELECT event_funnel_legacy_reversal_allowed($1,$2,$3) allowed',
    [job.tenant_id,owned.bookingSource,owned.bookingIds])).rows[0].allowed,false);
  assert.equal((await db.query('SELECT event_funnel_legacy_reversal_allowed($1,$2,$3) allowed',
    ['00000000-0000-4000-8000-000000000099',owned.bookingSource,owned.bookingIds])).rows[0].allowed,true);
  await db.query('RESET ROLE');
  await assert.rejects(db.query(`UPDATE ${owned.bookingSource} SET status='cancelled' WHERE id=$1`,[owned.bookingIds[0]]),{code:'PT409'});
  await assert.rejects(db.query(`DELETE FROM ${owned.bookingSource} WHERE id=$1`,[owned.bookingIds[0]]),{code:'PT409'});
  // Ordinary rows remain mutable; this trigger is not a global cancellation ban.
  await db.query(`UPDATE booking SET status=status WHERE id NOT IN
    (SELECT booking_id FROM event_funnel_order_booking WHERE booking_source='booking')`);
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query(`SELECT event_funnel_invoice_operation('guard','{}')`),{code:'42501'});
    await db.query('RESET ROLE');
  }
  // Unknown provider acceptance followed by no matching invoice never issues
  // a replacement. Exercise the actual shared algorithm against the journal.
  await db.query(`DELETE FROM event_funnel_invoice_booking WHERE invoice_work_id=$1`,[claimed.data.id]);
  await db.query(`UPDATE event_funnel_invoice_work SET status='retry',next_attempt_at=now(),invoice_id=NULL,payment_id=NULL,
    invoice_write_started_at=now() WHERE id=$1`,[claimed.data.id]);
  invoices=[];payments=[];
  const ambiguous=await processEventInvoiceRecovery({db:funnelInvoiceRecoveryDatabase(client),tenantId:job.tenant_id,
    source:'event_funnel',bookingGroupReference:payable.key,providerFactory:factory});
  assert.equal(ambiguous.status,'needs_review');assert.equal(invoiceWrites,1);assert.equal(paymentWrites,1);
}
