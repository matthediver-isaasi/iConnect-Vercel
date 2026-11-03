// Owner-approved repair. Uses retained private import receipt as the exact scope.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {connectDestination} from './lib/member-index-destination.mjs';
import {normalizeGroupPricePaid,normalizeGroupPayment} from '../api/reports/_pricePaid.js';

const apply=process.argv.includes('--apply');
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',event='4a21aa95-0c72-4317-a8eb-638ec73c96b0';
const oldGroup='MRT-20261103-1b20eb9bc052';
const dir='private/mrt-attendee-validation';
const ids=JSON.parse(fs.readFileSync(`${dir}/apply.json`)).added.map(r=>r.id);
assert.equal(ids.length,46);assert.equal(new Set(ids).size,46);
const db=await connectDestination();
try{
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='8s'");
  await db.query("SET LOCAL statement_timeout='45s'");
  const eventRow=(await db.query('SELECT * FROM event WHERE id=$1 AND tenant_id=$2 FOR SHARE',[event,tenant])).rows[0];
  const pricing=typeof eventRow.pricing_config==='string'?JSON.parse(eventRow.pricing_config):eventRow.pricing_config;
  const ticket=pricing.ticket_classes.find(t=>t.id==='ticket-1779980487486-02ahz');
  assert.equal(Number(ticket.price),0);
  const before=(await db.query('SELECT to_jsonb(b) data FROM booking b WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND event_id=$3 ORDER BY id FOR UPDATE',[ids,tenant,event])).rows.map(r=>r.data);
  assert.equal(before.length,46);
  assert.equal(new Set(before.map(r=>r.attendee_email.toLowerCase())).size,46);
  assert.equal(new Set(before.map(r=>r.booking_reference)).size,46);
  // Refuse a repair that would invalidate an existing certificate survey grant.
  assert.equal(Number((await db.query("SELECT count(*) n FROM certificate_survey_entitlement WHERE booking_id=ANY($1::uuid[]) AND booking_source='standard'",[ids])).rows[0].n),0);
  const relatedTables=(await db.query(`SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='booking_id' ORDER BY table_name`)).rows.map(r=>r.table_name);
  async function related(){
    const out={};
    for(const table of relatedTables){
      assert.match(table,/^[a-z_0-9]+$/);
      out[table]=(await db.query(`SELECT to_jsonb(t) data FROM "${table}" t WHERE booking_id::text=ANY($1::text[]) ORDER BY to_jsonb(t)::text`,[ids])).rows.map(r=>r.data);
    }
    return out;
  }
  const linkedBefore=await related();
  const rowsToRepair=before.filter(r=>r.booking_group_reference===oldGroup);
  assert.ok(rowsToRepair.length===0||rowsToRepair.length===46);
  for(const row of before){
    assert.equal(row.ticket_class_id,ticket.id);assert.equal(Number(row.ticket_price),0);assert.equal(Number(row.total_cost),0);
    assert.equal(row.status,'confirmed');assert.ok(row.booking_reference.startsWith('MRT-20261103-'));
    assert.equal(row.payment_method,rowsToRepair.length?'admin_import':'free');
    assert.equal(row.booking_group_reference,rowsToRepair.length?oldGroup:null);
    assert.equal(row.purchaser_context,null);
    assert.equal(row.stripe_payment_intent_id,null);assert.equal(row.accounting_invoice_id,null);
  }
  if(apply&&rowsToRepair.length)fs.writeFileSync(`${dir}/repair-before-${Date.now()}.json`,JSON.stringify({before,related:linkedBefore,authority:'Owner approved independent free Standard Ticket registrations; no new financial/provider actions',ticket}),{flag:'wx',mode:0o600});
  if(rowsToRepair.length){
    const result=await db.query(`UPDATE booking SET booking_group_reference=NULL,payment_method='free'
      WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND event_id=$3 AND booking_group_reference=$4 AND payment_method='admin_import'`,[ids,tenant,event,oldGroup]);
    assert.equal(result.rowCount,46);
  }
  const after=(await db.query('SELECT to_jsonb(b) data FROM booking b WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows.map(r=>r.data);
  for(let i=0;i<before.length;i++){
    const expected={...before[i],booking_group_reference:null,payment_method:'free',
      survey_invitation_revision:before[i].survey_invitation_revision+(rowsToRepair.length?1:0)};
    assert.deepEqual(after[i],expected,'Only approved grouping/method fields and normal revision trigger may change');
    const financialRow={...after[i],_report_booking_source:'standard'};
    assert.equal(normalizeGroupPricePaid([financialRow])[0].price_paid,0);
    assert.equal(normalizeGroupPayment([financialRow]).ticketTotal,0);
  }
  assert.deepEqual(await related(),linkedBefore,'Linked reminders, attendance, rewards and other records must not change');
  await db.query(apply?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({mode:apply?'apply':'dry-run rollback',changed:rowsToRepair.length,
    independentBookings:after.length,linkedRecordsUnchanged:true,verifiedFreeTicket:true,
    zoomRegistrationsPreserved:before.filter(r=>r.zoom_registrant_id).length}));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
