import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';
import { TENANT, hash } from './lib/bnms-invoice-date-repair.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
import { shapePersistedCommitment } from '../api/membership/member-membership.js';
import { getMembershipPricingPresentation } from '../client/src/components/membership/membershipPricingPresentation.js';
import { offlineDatabase } from './lib/renewal-audit-snapshot.mjs';
import { loadFormMembershipRenewalContext } from '../api/_lib/formMembershipRenewalContext.js';
const root='generated-artifacts/bnms-invoice-date-repair';
const mode=process.argv[2]; assert(['dry-run','apply','verify'].includes(mode));
const original=JSON.parse(await fs.readFile(`${root}/plan.json`,'utf8'));
const snapshot=JSON.parse(await fs.readFile('generated-artifacts/bnms-all-renewal/snapshot.json','utf8'));
const today=new Date().toISOString().slice(0,10);
const db=await connectDestination(), results=[], held=[];
const dry=mode==='apply'?JSON.parse(await fs.readFile(`${root}/priced-dry-run.json`,'utf8')):null;
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  if(mode!=='verify') await db.query(`CREATE TABLE IF NOT EXISTS public.bnms_priced_reconstruction_audit (
    history_id uuid primary key references member_membership_history(id),
    tenant_id uuid not null check(tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
    member_id uuid not null, before_record jsonb not null, after_record jsonb not null,
    created_at timestamptz not null default now());
    ALTER TABLE public.bnms_priced_reconstruction_audit ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.bnms_priced_reconstruction_audit FROM PUBLIC,anon,authenticated,service_role;
    GRANT SELECT ON public.bnms_priced_reconstruction_audit TO service_role;`);
  for(const member of original.plan.filter(p=>p.state==='candidate')){
    await db.query('SAVEPOINT one_member');
    try {
      const owner=(await db.query('select to_jsonb(m) row from member m where tenant_id=$1 and id=$2 for update',[TENANT,member.memberId])).rows[0].row;
      assert(!owner.email.startsWith('deleted_')&&!owner.membership_paused&&!owner.membership_cancelled);
      const prefs=(await db.query(`select v.value from member_preference_value v join preference_field f on f.id=v.field_id
        where v.member_id=$1 and f.tenant_id=$2 and f.name='member_class'`,[owner.id,TENANT])).rows;
      assert.equal(prefs.length,1);
      const repaired=[];
      for(const planned of member.repairs){
        assert.equal(prefs[0].value,planned.memberClass);
        const old=(await db.query('select to_jsonb(h) row from member_membership_history h where id=$1 for update',[planned.historyId])).rows[0].row;
        const config=(await db.query('select to_jsonb(c) row from membership_tier_config c where id=$1 and tenant_id=$2 for share',[old.config_id,TENANT])).rows[0].row;
        assert.equal(config.structure_match_value,prefs[0].value);assert.equal(config.pricing_model,'flat');
        assert.equal(config.start_mode,'immediate');assert.equal(config.billing_period,'annual');
        assert.equal(config.currency,'GBP');assert(config.is_active);
        assert.equal(JSON.parse(config.flat_vat_rate).taxType,'ZERORATEDOUTPUT');
        assert(Number.isFinite(config.flat_cost)&&config.flat_cost>0);
        const invoice=(await db.query('select to_jsonb(i) row from historical_member_invoice i where id=$1 and tenant_id=$2 for share',[planned.invoice.id,TENANT])).rows[0].row;
        assert.equal(invoice.member_id,owner.id);assert.equal(invoice.accounting_payment_status,'paid');
        assert.equal(invoice.xero_document_id,old.accounting_invoice_id);
        const existing=(await db.query('select * from bnms_priced_reconstruction_audit where history_id=$1',[old.id])).rows[0];
        let actual;
        if(existing) {
          assert.equal(mode,'verify','Already completed; use verify');
          assert.deepEqual(old,existing.after_record);actual=old;
        } else {
          assert.notEqual(mode,'verify');
          assert.equal(old.term_key,null);assert.equal(old.commitment_snapshot,null);
          const firstAudit=(await db.query('select corrected_record from bnms_invoice_date_reconstruction_audit where history_id=$1',[old.id])).rows[0];
          assert.deepEqual(old,firstAudit.corrected_record,'Record changed since prior repair');
          const amounts={annual_cost:config.flat_cost,final_cost:config.flat_cost,vat_amount:0,total_with_vat:config.flat_cost,currency:'GBP'};
          const term=buildRollingCommitment({config,startDate:invoice.invoice_date,paymentMethod:'upfront',paymentFrequency:'upfront',amounts,
            pricingSnapshot:{tier_label:'Flat Rate',authority:'owner_approved_structure_derived_reconstruction_not_invoice_allocation'}});
          const patch={...term,...amounts,billing_period:config.billing_period,tier_label:'Flat Rate',
            field_value:config.structure_match_value,membership_year:term.term_key,vat_rate_percent:0,
            status:term.term_end_date<today?'expired':'active',
            notes:JSON.stringify({source:'bnms_structure_priced_invoice_date_reconstruction',version:1,originalNotes:old.notes,
              priceAuthority:'owner_approved_member_class_matching_structure',termAuthority:'owner_approved_invoice_date_plus_structure_duration',
              invoiceEvidenceId:invoice.id,invoiceAmountNotAllocated:true,providerWrites:0,futureCollectionConsent:false})};
          const expected={...old,...patch};
          if(mode==='apply')assert.deepEqual(dry.results.find(r=>r.historyId===old.id)?.expected,expected,'Dry-run plan changed');
          await db.query('insert into bnms_priced_reconstruction_audit(history_id,tenant_id,member_id,before_record,after_record) values($1,$2,$3,$4,$5)',
            [old.id,TENANT,owner.id,JSON.stringify(old),JSON.stringify(expected)]);
          const keys=Object.keys(patch);
          actual=(await db.query(`update member_membership_history set ${keys.map((k,i)=>`"${k}"=$${i+1}`).join(',')}
            where id=$${keys.length+1} returning to_jsonb(member_membership_history) row`,
            [...keys.map(k=>patch[k]&&typeof patch[k]==='object'?JSON.stringify(patch[k]):patch[k]),old.id])).rows[0].row;
          assert.deepEqual(actual,expected);
        }
        const display=shapePersistedCommitment(actual);
        assert(display);assert.equal(display.startDate,actual.term_start_date);assert.equal(display.endDate,actual.term_end_date);
        assert.equal(display.structureName,config.name);
        const prices=getMembershipPricingPresentation(actual);
        for(const key of ['agreed','net','gross'])assert.equal(prices[key].amount,config.flat_cost,key);
        assert.equal(actual.term_duration_months,12);assert(actual.membership_renewal_date);
        repaired.push({memberId:owner.id,historyId:actual.id,invoice:invoice.invoice_number,structure:config.name,
          start:actual.term_start_date,end:actual.term_end_date,renewal:actual.membership_renewal_date,
          amount:config.flat_cost,display,prices,expected:actual});
      }
      const histories=(await db.query('select to_jsonb(h) row from member_membership_history h where tenant_id=$1 and member_id=$2',[TENANT,owner.id])).rows.map(r=>r.row);
      const tables={...snapshot.tables,member_membership_history:[...snapshot.tables.member_membership_history.filter(h=>h.member_id!==owner.id),...histories]};
      const stop=new Error('PRICING_BOUNDARY');
      let renewal;
      try {renewal=(await loadFormMembershipRenewalContext(offlineDatabase(tables,{
        membership_successor_elections_enabled:{data:tables.membership_successor_tenant_rollout.find(r=>r.tenant_id===TENANT)?.enabled===true},
        post_grace_checkout_ready:{data:snapshot.grants.length===3&&snapshot.grants.every(g=>g.executable)},
      }),{tenantId:TENANT,memberId:owner.id,now:new Date(),simulate:async()=>{throw stop;}})).renewal;}
      catch(e){if(e!==stop)throw e;renewal={state:'admitted_to_pricing_not_run'};}
      assert.notEqual(renewal.state,'review_required',JSON.stringify(renewal));
      assert.deepEqual((await db.query('select to_jsonb(m) row from member m where id=$1',[owner.id])).rows[0].row,owner);
      for(const r of repaired)results.push({...r,renewalAssessment:renewal});
      await db.query('RELEASE SAVEPOINT one_member');
    }catch(e){await db.query('ROLLBACK TO SAVEPOINT one_member');held.push({memberId:member.memberId,reason:e.message});}
  }
  if(mode==='apply')assert.equal(results.length,dry.results.length);
  if(results.length) {
    await db.query('SAVEPOINT protected');
    let rejected=false;
    try{await db.query('update member_membership_history set final_cost=final_cost+1 where id=$1',[results[0].historyId]);}
    catch(e){rejected=/immutable/.test(e.message);}
    await db.query('ROLLBACK TO SAVEPOINT protected');assert(rejected,'Price guard must remain enforced');
  }
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  await fs.writeFile(`${root}/priced-${mode}.json`,JSON.stringify({results,held},null,2),{mode:0o600});
  console.log(JSON.stringify({mode,completed:results.length,held,first:results[0]&&{
    structure:results[0].structure,start:results[0].start,end:results[0].end,amount:results[0].amount,
    renewal:results[0].renewal,renewalAssessment:results[0].renewalAssessment}},null,2));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
