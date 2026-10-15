import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {connectDestination} from './lib/member-index-destination.mjs';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',event='20bae95f-3b24-45f8-bd6b-b984cdbee3cf';
const root='generated-artifacts/bnms-event-tax-recovery';
const migration='supabase/migrations/202612310003_event_invoice_payment_link_repair.sql';
const ids=JSON.parse(await readFile(`${root}/apply.json`,'utf8')).corrected.map(x=>x.row.id).sort();
assert.equal(ids.length,10);assert.equal(new Set(ids).size,10);
const apply=process.argv.includes('--apply');
assert(process.argv.slice(2).every(x=>x==='--apply'));
const c=await connectDestination(),q=(s,p=[])=>c.query(s,p);
try{
 await q('begin isolation level serializable');
 await q("set local statement_timeout='30s'; set local lock_timeout='10s'");
 await q('lock table event_invoice_recovery in share row exclusive mode');
 const rows=(await q('select to_jsonb(r) row from event_invoice_recovery r where id=any($1::uuid[]) order by id for update',[ids])).rows.map(x=>x.row);
 assert.equal(rows.length,10);
 const installed=(await q("select to_regclass('public.event_invoice_payment_link_repair_audit') present")).rows[0].present;
 if(installed){
   const audits=(await q('select * from event_invoice_payment_link_repair_audit where operation_id=any($1::uuid[])',[ids])).rows;
   assert.equal(audits.length,10);
   for(const r of rows){
     const a=audits.find(x=>x.operation_id===r.id);
     assert.equal(r.settlement_payment_intent_id,a.corrected_record.settlement_payment_intent_id);
     assert.deepEqual(r.snapshot,a.corrected_record.snapshot);
   }
   await q('rollback');
   console.log(JSON.stringify({replay:true,writes:0,statuses:rows.map(r=>({id:r.id,status:r.status,reason:r.reason_code,invoice:r.invoice_number}))}));
 }else{
   const beforeGuard=(await q("select pg_get_functiondef('public.event_invoice_recovery_immutable()'::regprocedure) body")).rows[0].body;
   const expected=await readFile('supabase/migrations/202612310001_event_invoice_tax_correction_audit.sql','utf8');
   const body=expected.split('LANGUAGE plpgsql SET search_path=public AS $$')[2]?.split('$$;')[0];
   assert(body && beforeGuard.includes(body.trim()),'Immutable guard changed; re-review');
   const corrections=[];
   for(const r of rows){
     assert.equal(r.tenant_id,tenant);assert.equal(r.source,'booking');
     assert.equal(r.status,'needs_review');assert.equal(r.reason_code,'booking_or_lease_changed');assert.equal(r.attempts,1);
     for(const k of ['settlement_payment_intent_id','invoice_id','payment_id','invoice_write_started_at','payment_write_started_at','lease_token','lease_expires_at'])assert.equal(r[k],null,k);
     const s=r.snapshot;assert.equal(s.paymentMethod,'stripe');assert.equal(s.settlement.livemode,true);
     assert.equal(s.settlement.status,'succeeded');assert.equal(s.settlement.captured,true);
     assert.match(s.settlement.paymentIntentId,/^pi_/);
     const tax=(await q('select corrected_snapshot from event_invoice_tax_correction_audit where operation_id=$1',[r.id])).rows[0];
     assert.deepEqual(s,tax.corrected_snapshot);
     const bookings=(await q('select to_jsonb(b) row from booking b where tenant_id=$1 and booking_group_reference=$2 for update',[tenant,r.booking_group_reference])).rows.map(x=>x.row);
     assert(bookings.length);
     for(const b of bookings){
       assert.equal(b.event_id,event);assert.equal(b.status,'confirmed');
       assert(['card','stripe','mixed'].includes(b.payment_method));
       assert(!b.xero_invoice_id&&!b.accounting_invoice_id);
       assert(!b.stripe_payment_intent_id||b.stripe_payment_intent_id===s.settlement.paymentIntentId);
     }
     assert(bookings.some(b=>b.stripe_payment_intent_id===s.settlement.paymentIntentId));
     assert.equal((await q(`select count(*)::int n from event_invoice_recovery where id<>$1 and tenant_id=$2 and
       (settlement_payment_intent_id=$3 or snapshot#>>'{settlement,paymentIntentId}'=$3)`,[r.id,tenant,s.settlement.paymentIntentId])).rows[0].n,0);
     const after=(await q(`select to_jsonb(x) row from jsonb_populate_record(NULL::event_invoice_recovery,
       $1::jsonb||jsonb_build_object('settlement_payment_intent_id',$2::text,'status','pending','reason_code',null,'next_attempt_at',now(),'updated_at',now())) x`,[JSON.stringify(r),s.settlement.paymentIntentId])).rows[0].row;
     corrections.push({before:r,after});
   }
   await q(await readFile(migration,'utf8'));
   assert.equal((await q(`select has_table_privilege('service_role','event_invoice_payment_link_repair_audit','INSERT') can_write`)).rows[0].can_write,false);
   for(const {before,after} of corrections){
     await q(`insert into event_invoice_payment_link_repair_audit(operation_id,original_record,corrected_record,authority) values($1,$2,$3,$4)`,
       [before.id,JSON.stringify(before),JSON.stringify(after),'Owner approved repair and requeue of ten Neuro Imaging Congress invoices; preserve verified VAT-inclusive evidence and existing Stripe receipts; no new charges.']);
     await q(`update event_invoice_recovery set settlement_payment_intent_id=$2,status='pending',reason_code=null,next_attempt_at=$3,updated_at=$4 where id=$1`,
       [before.id,after.settlement_payment_intent_id,after.next_attempt_at,after.updated_at]);
     const actual=(await q('select to_jsonb(r) row from event_invoice_recovery r where id=$1',[before.id])).rows[0].row;
     assert.deepEqual(actual,after);
   }
   // Even with approval rows present, changing price/other immutable data fails.
   await q('savepoint negative_check');
   let blocked=false;
   try{await q(`update event_invoice_recovery set snapshot=jsonb_set(snapshot,'{amount}','999999') where id=$1`,[ids[0]]);}
   catch{blocked=true;}
   await q('rollback to savepoint negative_check');assert(blocked);
   // Exercise the real claim and safety guard, then discard every claim.
   // No provider factory or invoice writer is invoked.
   for(const {after} of corrections){
     await q('savepoint guard_check');
     const claimed=(await q('select * from event_invoice_recovery_claim($1,$2,$3,true)',
       [tenant,'booking',after.booking_group_reference])).rows[0];
     assert.equal(claimed?.id,after.id,'Connection unavailable; retry after worker/cooldown finishes');
     assert.equal((await q('select event_invoice_recovery_guard($1,$2) safe',
       [claimed.id,claimed.lease_token])).rows[0].safe,true,'Repaired invoice must pass the actual worker guard');
     await q('rollback to savepoint guard_check');
   }
   const file=`${root}/payment-links-${apply?'apply':'dry-run'}.json`;
   const evidence={migration,committed:false,corrections};
   await writeFile(file,JSON.stringify(evidence,null,2),{mode:0o600});
   await q(apply?'commit':'rollback');
   evidence.committed=apply;await writeFile(file,JSON.stringify(evidence,null,2),{mode:0o600});
   console.log(JSON.stringify({committed:apply,repaired:10,status:'pending',providerCalls:0,financialSnapshotsUnchanged:true}));
 }
}catch(e){await q('rollback').catch(()=>{});throw e;}finally{await c.end();}
