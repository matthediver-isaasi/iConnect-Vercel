import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelIssuedInvoice({db,sql}) {
  await db.query(await sql('202701230031_event_funnel_issued_invoice.sql'));
  const order=(await db.query(`SELECT * FROM event_funnel_order WHERE state='confirmed' AND payable_minor>0 LIMIT 1`)).rows[0];
  assert.ok(order);const token=randomUUID(),id=randomUUID(),amount=Number(order.payable_minor)/100;
  const snapshot={currency:order.currency,amount,invoice:{LineItems:[{
    Description:'Issued evidence fixture',Quantity:1,UnitAmount:amount,AccountCode:'200',TaxType:'OUTPUT2',
    TaxAmount:Number((amount/6).toFixed(2)),
  }]}};
  // New attributed work is introduced only after its migration. Earlier
  // scenarios deliberately verify delivery of the original pre-upgrade format.
  snapshot.eventFunnel={lineAllocations:snapshot.invoice.LineItems.map((_,index)=>({index}))};
  const row=(await db.query(`INSERT INTO event_funnel_invoice_work
    (id,tenant_id,order_id,allocation_key,provider,snapshot,status,lease_token,lease_expires_at,invoice_id)
    VALUES($1,$2,$3,$4,'xero',$5,'processing',$6,now()+interval '2 minutes',$7) RETURNING *`,
    [id,order.tenant_id,order.id,`evidence-${id}`,snapshot,token,'fixture-issued-invoice'])).rows[0];
  const lines=row.snapshot.invoice.LineItems.map((line,index)=>({...line,LineItemID:`line-${index}`,
    LineAmount:Number((line.Quantity*line.UnitAmount).toFixed(2)),TaxType:line.TaxType||'OUTPUT2',
    TaxAmount:line.TaxAmount??Number((line.Quantity*line.UnitAmount/6).toFixed(2))}));
  const evidence={InvoiceID:row.invoice_id,Contact:{ContactID:'original-contact'},CurrencyCode:row.snapshot.currency,
    LineAmountTypes:'Inclusive',Total:row.snapshot.amount,TotalTax:Number(lines.reduce((n,l)=>n+l.TaxAmount,0).toFixed(2)),LineItems:lines};
  const save=(value=evidence,lease=token)=>db.query('SELECT event_funnel_invoice_evidence($1,$2,$3,$4,$5) ok',
    [row.tenant_id,row.order_id,row.id,lease,value]);
  await db.query('SET ROLE service_role');
  assert.equal((await save(evidence,randomUUID())).rows[0].ok,false);
  await assert.rejects(save({...evidence,Total:evidence.Total+1}),{code:'PT409'});
  assert.equal((await save()).rows[0].ok,true);assert.equal((await save()).rows[0].ok,true);
  assert.equal((await save({...evidence,Contact:{ContactID:'different'}})).rows[0].ok,false);
  await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);await assert.rejects(save(),{code:'42501'});await db.query('RESET ROLE');
  }
}
