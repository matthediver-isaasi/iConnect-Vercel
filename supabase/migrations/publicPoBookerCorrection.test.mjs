import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';

test('booker correction preserves history, fences approval and freezes delivery identity', {timeout:60000},async()=>{
 const h=await createLocalPostgresHarness('po-correction-');
 const run=(cmd,args,input,fail=false)=>{
  const r=spawnSync(cmd,args,{input,encoding:'utf8'});
  if(fail)assert.notEqual(r.status,0,'unsafe SQL must fail');
  else assert.equal(r.status,0,r.stderr||r.stdout);
  return r.stdout.trim();
 };
 const sql=(input,fail=false)=>run('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'],input,fail);
 const migration=name=>sql(readFileSync(new URL(name,import.meta.url),'utf8'));
 let started=false;
 try{
  run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
  started=true;
  sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
   CREATE TABLE member(id uuid,tenant_id uuid,email text,first_name text,last_name text);
   CREATE TABLE role(id uuid,tenant_id uuid,requires_effective_from_date boolean,max_members integer);
   CREATE TABLE event(id uuid); CREATE TABLE complex_event(id uuid);
   CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,booking_group_reference text,created_at timestamptz DEFAULT now(),
    payment_method text,status text,total_cost numeric,discount_code_amount numeric DEFAULT 0,currency text,
    member_id uuid,organization_id uuid,stripe_payment_intent_id text,xero_invoice_id text,xero_invoice_number text,
    accounting_invoice_id text,accounting_invoice_number text,accounting_provider text,voucher_id uuid,
    voucher_amount numeric DEFAULT 0,training_fund_amount numeric DEFAULT 0,account_amount numeric DEFAULT 0,
    total_paid numeric DEFAULT 0,po_to_follow boolean DEFAULT false,payment_status text DEFAULT 'pending');
   CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
   ALTER TABLE complex_event_booking ADD COLUMN ticket_price numeric;
   CREATE FUNCTION event_invoice_recovery_enqueue(uuid,text,text,jsonb,boolean) RETURNS TABLE(status text)
    LANGUAGE sql AS $$ SELECT 'pending'::text $$;
   CREATE FUNCTION accounting_event_capture(uuid,text,text,text,text,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
    /* OR coalesce((j->>''created_at'')::timestamptz,''-infinity'')<now()-interval ''1 hour'' */
    RETURN '{}'::jsonb; END $$;`);
  migration('./202607200001_public_invoice_po.sql');
  migration('./202612090003_public_invoice_po_billing.sql');
  migration('./202612090007_public_po_approval_guard.sql');
  migration('./202612090008_public_po_invoice_email.sql');
  migration('./202612090004_public_invoice_booker_member.sql');
  migration('./202701050001_public_po_booker_correction.sql');
  migration('./202701050002_public_po_corrected_member_guard.sql');
  const t='00000000-0000-0000-0000-000000000001',m='00000000-0000-0000-0000-000000000002',b='00000000-0000-0000-0000-000000000003',e='00000000-0000-0000-0000-000000000004';
  sql(`INSERT INTO member VALUES('${m}','${t}','corrected@example.invalid','Original','Booker');
   INSERT INTO booking(id,tenant_id,event_id,booking_group_reference,payment_method,status,total_cost,currency,purchaser_context)
   VALUES('${b}','${t}','${e}','group','public_invoice_po','confirmed',200,'GBP',
    '{"classification":"public_non_member","details":{"email":"old@example.invalid","first_name":"Original","last_name":"Booker"}}');`);
  const original=sql(`SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM booking b`);
  const correction=(member=m,email='corrected@example.invalid',expected=original)=>`SELECT correct_public_po_booker('${t}','booking','group','${member}','${email}','owner-approved support','Explicitly approved contact correction','${expected}')`;
  sql(correction(m,'wrong@example.invalid'),true);
  sql(correction(e),true);
  sql(correction(m,'corrected@example.invalid','[]'),true);
  sql(`SET ROLE authenticated; ${correction()}`,true);
  const id=sql(`SET ROLE service_role; ${correction()}`).split('\n').at(-1);
  assert.equal(sql(correction()),id);
  for(const email of ['old@example.invalid','corrected@example.invalid']){
   const blocked=spawnSync('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'],{
    input:`SET ROLE service_role; SELECT create_public_invoice_booker('${t}','${b}',false,'Original','Booker','${email}',null,null,'${m}',null,null);`,encoding:'utf8'});
   assert.notEqual(blocked.status,0);
   assert.match(blocked.stderr,/approved booker correction already links an existing member/);
  }
  assert.equal(sql('SELECT count(*) FROM member'),'1');
  assert.equal(sql(`SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM booking b`),original);
  sql(`SET ROLE service_role; DELETE FROM public_po_booker_correction`,true);
  sql(`SET ROLE service_role; UPDATE public_po_booker_correction SET reason='rewritten'`,true);
  sql(`UPDATE booking SET purchaser_context='{}'`,true);
  const snapshot={paymentMethod:'invoice',settlement:null,amount:200,currency:'GBP',
   contact:{email:'corrected@example.invalid',provenance:{kind:'member',id:m}},publicPoBookerCorrectionId:id};
  const bill=(snap=snapshot)=>`SELECT public_invoice_po_bill('${t}','booking','group','${m}','admin','${original}',200,'GBP','xero','${JSON.stringify(snap)}')`;
  sql(bill({...snapshot,publicPoBookerCorrectionId:null}),true);
  sql(bill({...snapshot,contact:{...snapshot.contact,email:'old@example.invalid'}}),true);
  sql(`SET ROLE service_role; ${bill()}`);
  assert.equal(sql(`SELECT billing_contact->>'email' FROM public_invoice_po_billing`),'corrected@example.invalid');
  assert.equal(sql(`SELECT purchaser_context->'details'->>'email' FROM booking`),'old@example.invalid');
  assert.equal(sql(`SELECT original_records FROM public_invoice_po_billing`),original);
  sql(bill()); // Durable idempotency, no second approval.
  assert.equal(sql(`SELECT count(*) FROM public_invoice_po_billing`),'1');
  sql(correction(),true);
  sql(`SET ROLE service_role; UPDATE public_invoice_po_billing SET billing_contact='{}'`,true);
  sql(`SET ROLE service_role; UPDATE public_invoice_po_billing SET email_status='preparing'`,true);
  sql(`SET ROLE service_role; UPDATE public_invoice_po_billing SET email_status='preparing',email_delivery_recipient='wrong@example.invalid'`,true);
  sql(`SET ROLE service_role; UPDATE public_invoice_po_billing SET email_status='preparing',email_delivery_recipient='corrected@example.invalid'`);
  sql(`SET ROLE service_role; UPDATE public_invoice_po_billing SET email_status='pending'`);
  assert.equal(sql(`SELECT email_delivery_recipient IS NULL FROM public_invoice_po_billing`),'t');
  sql(`SET ROLE service_role; UPDATE public_invoice_po_billing SET email_status='preparing'`,true);
  sql(`UPDATE booking SET purchaser_context='{}'`,true);
  // Exercise complex events and QBO independently; a correction is never inferred.
  sql(`INSERT INTO complex_event_booking(id,tenant_id,event_id,booking_group_reference,payment_method,status,ticket_price,currency,purchaser_context)
   VALUES('${b}','${t}','${e}','complex-group','public_invoice_po','confirmed',200,'GBP',
    '{"classification":"public_non_member","details":{"email":"old@example.invalid"}}');`);
  const complexOriginal=sql(`SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM complex_event_booking b`);
  const complexCorrection=`SELECT correct_public_po_booker('${t}','complex_event_booking','complex-group','${m}',
   'corrected@example.invalid','owner-approved support','Approved correction','${complexOriginal}')`;
  const complexId=sql(complexCorrection);
  const blockedComplex=spawnSync('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'],{
   input:`SET ROLE service_role; SELECT create_public_invoice_booker('${t}','${b}',true,'Original','Booker','old@example.invalid',null,null,'${m}',null,null);`,encoding:'utf8'});
  assert.notEqual(blockedComplex.status,0);
  assert.match(blockedComplex.stderr,/approved booker correction already links an existing member/);
  const qbo={invoice:{paymentMethod:'invoice',amount:200,currency:'GBP',
   contact:{email:'corrected@example.invalid',provenance:{kind:'member',id:m}}},
   payment:null,approvalProvider:{connectionId:'fixture',realmId:'fixture'},publicPoBookerCorrectionId:complexId};
  sql(`SELECT public_invoice_po_bill('${t}','complex_event_booking','complex-group','${m}','admin',
   '${complexOriginal}',200,'GBP','quickbooks','${JSON.stringify(qbo)}')`);
  assert.equal(sql(`SELECT billing_contact->>'email' FROM public_invoice_po_billing WHERE source='complex_event_booking'`),'corrected@example.invalid');
  assert.equal(sql(`SELECT purchaser_context->'details'->>'email' FROM complex_event_booking`),'old@example.invalid');
  // Uncorrected bookings retain their original email and still approve normally.
  sql(`INSERT INTO booking(id,tenant_id,event_id,booking_group_reference,payment_method,status,total_cost,currency,purchaser_context)
   VALUES('${e}','${t}','${e}','uncorrected','public_invoice_po','confirmed',200,'GBP',
    '{"classification":"public_non_member","details":{"email":"corrected@example.invalid"}}');`);
  const uncorrected=sql(`SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM booking b WHERE booking_group_reference='uncorrected'`);
  sql(`SELECT public_invoice_po_bill('${t}','booking','uncorrected','${m}','admin','${uncorrected}',200,'GBP','xero',
   '${JSON.stringify({...snapshot,publicPoBookerCorrectionId:null})}')`);
  assert.equal(sql(`SELECT booker_correction_id IS NULL FROM public_invoice_po_billing WHERE booking_group_reference='uncorrected'`),'t');
 }finally{
  if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});
