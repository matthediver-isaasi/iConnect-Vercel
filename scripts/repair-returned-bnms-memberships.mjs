import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {connectDestination} from './lib/member-index-destination.mjs';
import {buildRollingCommitment} from '../api/_lib/rollingMembershipCommitment.js';
import {shapePersistedCommitment} from '../api/membership/member-membership.js';
const root='generated-artifacts/bnms-returned-membership-review',mode=process.argv[2];
assert(['rehearse','apply'].includes(mode));
const evidence=JSON.parse(await fs.readFile(`${root}/evidence.json`,'utf8'));
const prior=mode==='apply'?JSON.parse(await fs.readFile(`${root}/rehearse.json`,'utf8')):null;
const workbookHash=createHash('sha256').update(await fs.readFile('attached_assets/BNMS-complete-priced-membership-commitments_SB_updated_1794387451905.xlsx')).digest('hex');
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',db=await connectDestination(),results=[],held=[];
try{
 await db.query('begin isolation level serializable');
 await db.query("set local lock_timeout='5s';set local statement_timeout='30s'");
 await db.query(`create table if not exists public.bnms_returned_membership_repair_audit(
 history_id uuid primary key references member_membership_history(id),tenant_id uuid not null,
 member_id uuid not null,workbook_hash text not null,before_record jsonb not null,after_record jsonb not null,
 created_at timestamptz not null default now());
 alter table public.bnms_returned_membership_repair_audit enable row level security;
 revoke all on public.bnms_returned_membership_repair_audit from public,anon,authenticated,service_role;
 grant select on public.bnms_returned_membership_repair_audit to service_role;`);
 for(const r of evidence){
  if(process.argv[3] && !process.argv[3].split(',').includes(r.id))continue;
  await db.query('savepoint member_repair');
  try{
   const invoices=r.invoices.filter(i=>(r.note.includes(i.invoice_number)||
    (r.note.includes('legacy on their membership for previous year')&&/^Trainee Membership UK$/.test(i.description)))
    &&(i.accounting_payment_status==='paid'||(i.status==='paid'&&!i.accounting_payment_status&&r.note.includes(i.invoice_number))));
   assert.equal(invoices.length,1,'No uniquely identified paid invoice');
   const legacy=r.histories.filter(h=>!h.term_start_date&&!h.term_key&&!h.commitment_snapshot);
   assert.equal(legacy.length,1,'No unique incomplete legacy term');
   for(const [table,old]of Object.entries(r.related)){
    assert.equal(old.length,0,'Existing financial authority');
    assert.equal((await db.query(`select id from ${table} where tenant_id=$1 and member_id=$2 for share`,[tenant,r.id])).rowCount,0);
   }
   const owner=(await db.query('select to_jsonb(m) row from member m where tenant_id=$1 and id=$2 for update',[tenant,r.id])).rows[0]?.row;
   assert.deepEqual(owner,r.member);assert(!owner.is_deleted&&!owner.email?.startsWith('deleted_')&&!owner.membership_paused&&!owner.membership_cancelled);
   const old=(await db.query('select to_jsonb(h) row from member_membership_history h where id=$1 and tenant_id=$2 for update',[legacy[0].id,tenant])).rows[0]?.row;
   assert.deepEqual(old,legacy[0]);assert(!old.term_key&&!old.commitment_snapshot&&!old.renewal_policy_snapshot);
   assert.equal(old.payment_status,'paid');
   const prefs=(await db.query("select f.name,v.value from member_preference_value v join preference_field f on f.id=v.field_id where f.tenant_id=$1 and v.member_id=$2 and f.name='member_class'",[tenant,r.id])).rows;
   assert.deepEqual(prefs,r.prefs);assert.equal(prefs.length,1);
   const configs=(await db.query("select to_jsonb(c) row from membership_tier_config c where tenant_id=$1 and structure_scope_type='member' and structure_match_value=$2 and is_active and (effective_from is null or effective_from<=current_date) and (effective_to is null or effective_to>=current_date) for share",[tenant,prefs[0].value])).rows;
   assert.equal(configs.length,1,'Schedule ambiguous');const config=configs[0].row;
   assert.equal(config.pricing_model,'flat');assert.equal(config.billing_period,'annual');assert.equal(config.start_mode,'immediate');
   assert(config.flat_cost>0);assert.equal(JSON.parse(config.flat_vat_rate).taxType,'ZERORATEDOUTPUT');
   const invoice=(await db.query('select to_jsonb(i) row from historical_member_invoice i where tenant_id=$1 and id=$2 for share',[tenant,invoices[0].id])).rows[0].row;
   for(const k of ['id','member_id','tenant_id','invoice_number','invoice_date','description','amount_minor','status','accounting_payment_status','accounting_status','xero_document_id'])
    assert.deepEqual(invoice[k],invoices[0][k],`Invoice authority changed: ${k}`);
   assert(invoice.xero_document_id || (invoice.status==='paid' && r.note.includes(invoice.invoice_number)));
   const amounts={annual_cost:config.flat_cost,final_cost:config.flat_cost,vat_amount:0,total_with_vat:config.flat_cost,currency:config.currency};
   const term=buildRollingCommitment({config,startDate:invoice.invoice_date,paymentMethod:'upfront',paymentFrequency:'upfront',amounts,
    pricingSnapshot:{tier_label:'Flat Rate',authority:'owner_returned_workbook_structure_price_not_invoice_allocation'}});
   const patch={...term,...amounts,config_id:config.id,field_value:config.structure_match_value,tier_label:'Flat Rate',
    billing_period:config.billing_period,membership_year:term.term_key,vat_rate_percent:0,payment_method:'upfront',
    status:term.term_end_date<new Date().toISOString().slice(0,10)?'expired':'active',accounting_provider:'xero',
    accounting_invoice_id:invoice.xero_document_id,accounting_invoice_number:invoice.invoice_number,
    xero_invoice_id:invoice.xero_document_id,xero_invoice_number:invoice.invoice_number,
    notes:JSON.stringify({source:'owner_returned_membership_workbook',workbookHash,originalNotes:old.notes,originalPaymentMethod:old.payment_method,
      invoiceId:invoice.id,externalInvoiceIdentityVerified:!!invoice.xero_document_id,
      invoiceAuthority:invoice.xero_document_id?'retained_paid_invoice':'owner_identified_imported_paid_invoice',
      priceAuthority:'member_class_matching_structure',termAuthority:'invoice_date_plus_structure_duration',
      noNewCollectionConsent:true,providerWrites:0})};
   const expected={...old,...patch};
   if(prior)assert.deepEqual(prior.results.find(p=>p.id===r.id)?.expected,expected,'Rehearsal changed');
   await db.query('insert into bnms_returned_membership_repair_audit values($1,$2,$3,$4,$5,$6,now())',
    [old.id,tenant,r.id,workbookHash,JSON.stringify(old),JSON.stringify(expected)]);
   const keys=Object.keys(patch);
   const actual=(await db.query(`update member_membership_history set ${keys.map((k,i)=>`"${k}"=$${i+1}`).join(',')} where id=$${keys.length+1} returning to_jsonb(member_membership_history) row`,
    [...keys.map(k=>patch[k]&&typeof patch[k]==='object'?JSON.stringify(patch[k]):patch[k]),old.id])).rows[0].row;
   assert.deepEqual(actual,expected);const display=shapePersistedCommitment(actual);assert.equal(display.structureName,config.name);
   assert.equal(display.startDate,term.term_start_date);assert.equal(display.endDate,term.term_end_date);assert(actual.membership_renewal_date);
   assert.deepEqual((await db.query('select to_jsonb(m) row from member m where id=$1',[r.id])).rows[0].row,owner);
   for(const other of r.histories.filter(h=>h.id!==old.id))
    assert.deepEqual((await db.query('select to_jsonb(h) row from member_membership_history h where id=$1',[other.id])).rows[0].row,other);
   results.push({id:r.id,name:r.name,invoice:invoice.invoice_number,start:term.term_start_date,end:term.term_end_date,structure:config.name,expected});
   await db.query('release savepoint member_repair');
  }catch(e){await db.query('rollback to savepoint member_repair');held.push({id:r.id,name:r.name,reason:e.message});}
 }
 if(prior){assert.equal(results.length,prior.results.length);assert(results.length>0);}
 await fs.writeFile(`${root}/${mode}.json`,JSON.stringify({workbookHash,results,held},null,2),{mode:0o600});
 await db.query(mode==='apply'?'commit':'rollback');
 console.log(JSON.stringify({mode,repaired:results.length,held},null,2));
}catch(e){await db.query('rollback');throw e}finally{await db.end();}
