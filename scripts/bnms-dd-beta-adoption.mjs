import { buildAgreementSnapshot } from '../api/_lib/gocardlessDirectDebit.js';
import { buildIdempotencyKey } from '../api/_lib/gocardless.js';
import { fingerprint } from './bnms-dd-pilot-history.mjs';
import { TENANT_ID, MEMBER_ID } from './bnms-dd-pilot.mjs';
export const START='2026-10-01', END='2027-09-30';
export const SOURCE_HASH='51193a1eab52e76bbc066ebc57f95168b6247cf1462a9d73906c451942e782df';
const fail=m=>{throw Error(m);};
export function betaManifest(report) {
  if(report.tenantId!==TENANT_ID||report.candidates?.length!==10)fail('Exactly ten reviewed BNMS candidates required');
  for(const key of ['memberId','mandateId','customerId']) {
    if(new Set(report.candidates.map(c=>c.identity[key])).size!==10)fail('Duplicate candidate identity');
  }
  const payments=new Set();
  const members=report.candidates.map(c=>{
    const i=c.identity,s=c.applicableStructures?.[0];
    if(i.memberId===MEMBER_ID||c.member.id!==i.memberId||c.member.tenant_id!==TENANT_ID
      ||c.applicableStructures.length!==1||s.tenant_id!==TENANT_ID||!s.is_active||!s.dd_enabled
      ||s.structure_scope_type!=='member'||s.currency!=='GBP'||s.pricing_model!=='flat'
      ||s.start_mode!=='immediate'||s.dd_invoicing_mode!=='per_instalment'
      ||(s.effective_from&&s.effective_from.slice(0,10)>START)||(s.effective_to&&s.effective_to.slice(0,10)<START)
      ||c.preferences.filter(p=>p.name==='member_class').length!==1
      ||c.preferences.find(p=>p.name==='member_class').value!==s.structure_match_value
      ||c.mandate.status!=='active'||c.mandate.id!==i.mandateId||c.mandate.links?.customer!==i.customerId
      ||c.mandate.links?.creditor!=='CR0000B50W1Y2R'||c.subscriptions.length
      ||Object.values(c.existing).some(a=>a.length))fail('Reviewed candidate/structure conflict');
    const amount=Math.round(Number(s.dd_monthly_amount)*100);
    if(!Number.isSafeInteger(amount)||amount<=0)fail('Invalid current quote');
    const history=c.payments.map(p=>{
      if(p.status!=='paid_out'||p.links?.mandate!==i.mandateId||p.currency!=='GBP'
        ||!Number.isSafeInteger(p.amount)||p.amount<=0||!p.charge_date||p.charge_date>=START
        ||payments.has(p.id))fail('Non-settled or duplicate historical provider evidence');
      payments.add(p.id);
      return {provider_payment_id:p.id,charge_date:p.charge_date,amount_minor:p.amount,currency:p.currency,evidence:p};
    }).sort((a,b)=>a.provider_payment_id.localeCompare(b.provider_payment_id));
    if(!history.length)fail('Settled provider history required');
    const dd=buildAgreementSnapshot({acceptedAt:null,billingRequestMode:'migration_existing_mandate',
      offer:{collectionPolicy:{version:1,end_policy:'continue',pricing_policy:'dynamic'},
        monthlyAmount:amount/100,monthlyAmountMinor:amount,instalmentCount:12,planTotal:null,
        currency:'GBP',firstCollectionRule:'nominated_day',collectionDay:1,activationRule:'first_payment',
        graceDays:s.dd_grace_days,termsVersion:s.dd_terms_version,invoicingMode:'per_instalment',
        monthlyPostGraceCollectionPolicy:s.monthly_post_grace_collection_policy},
      simResult:{config:s,membershipYear:{start:START,end:END,label:`rolling:${START}`},
        annualCost:Number(s.flat_cost),finalCost:null,vatRatePercent:0,tierLabel:'Flat Rate'}});
    return {identity:i,structure:s,monthlyQuoteMinor:amount,dd,history,
      originalCurrentEntitlement:null,legacyAutomaticCollectionDisabled:null,accountingReconciled:false};
  });
  if(members.filter(m=>m.identity.group==='spreadsheet').length!==5
    ||members.filter(m=>m.identity.group==='direct_match').length!==5)fail('Reviewed five/five split required');
  return {version:1,tenantId:TENANT_ID,sourceSha256:SOURCE_HASH,
    approval:{source:'explicit-user-beta-same-future-terms',start:START,end:END,day:1,
      pricing:'current_membership_class_dynamic',endPolicy:'continue',activation:'first_payment',
      collectionHeld:true,releaseApproved:false},members};
}
const allowed=new Set(['bnms_dd_beta_batch','bnms_dd_beta_adoption','bnms_dd_beta_provider_history',
  'gocardless_customers','gocardless_mandates','membership_billing_agreements','membership_payment_plans','member_membership_history']);
async function insert(c,t,row) {
  if(!allowed.has(t))fail('Unsafe insert');
  const keys=Object.keys(row);
  return (await c.query(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,Object.values(row))).rows[0];
}
export async function adoptBeta(c,manifest,{apply=false,reviewSha256,verifiedDestination=false}={}) {
  const hash=fingerprint(manifest);
  if(apply&&(!verifiedDestination||reviewSha256!==hash))fail('Exact reviewed manifest and pinned destination required');
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-beta-held'))");
    await c.query(`LOCK TABLE member,preference_field,member_preference_value,membership_tier_config,
      membership_billing_agreements,membership_payment_plans,member_membership_history,gocardless_customers,
      gocardless_mandates,gocardless_payments,gocardless_collection_reservations IN SHARE ROW EXCLUSIVE MODE`);
    const rows=async(sql,args=[])=>(await c.query(sql,args)).rows;
    const ready=(await rows("SELECT to_regclass('public.bnms_dd_beta_batch') IS NOT NULL AS ready"))[0].ready;
    if(apply&&!ready)fail('Beta schema required');
    if(ready){
      const guards=await rows(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A')
        AND (tgrelid='gocardless_payments'::regclass AND tgname='bnms_dd_beta_no_historical_replay'
          OR tgrelid='membership_payment_plans'::regclass AND tgname='bnms_dd_beta_plan_hold'
          OR tgrelid='gocardless_collection_reservations'::regclass AND tgname='bnms_dd_beta_reservation_hold'
          OR tgrelid='membership_billing_agreements'::regclass AND tgname='bnms_dd_beta_agreement_hold'
          OR tgrelid='member_membership_history'::regclass AND tgname='bnms_dd_beta_history_hold')`);
      if(guards.length!==5)fail('Beta historical and collection guards must be enabled');
    }
    const prior=ready?await rows('SELECT * FROM bnms_dd_beta_batch WHERE evidence_sha256=$1',[hash]):[];
    if(prior.length) {
      const saved=await rows('SELECT * FROM bnms_dd_beta_adoption WHERE batch_id=$1',[prior[0].id]);
      if(saved.length!==10||fingerprint(prior[0].evidence)!==hash)fail('Incomplete or changed batch provenance');
      for(const m of manifest.members) {
        const a=saved.find(a=>a.member_id===m.identity.memberId);
        if(!a||fingerprint(a.evidence)!==fingerprint(m))fail('Replay member provenance mismatch');
        const linked=await rows(`SELECT p.id FROM membership_billing_agreements a
          JOIN membership_payment_plans p ON p.billing_agreement_id=a.id
          JOIN member_membership_history h ON h.billing_agreement_id=a.id
          WHERE a.id=$1 AND p.id=$2 AND h.id=$3 AND a.member_id=$4 AND p.member_id=$4 AND h.member_id=$4
          AND a.tenant_id=$5 AND p.tenant_id=$5 AND h.tenant_id=$5
          AND p.collection_stopped_at IS NOT NULL AND p.metadata->>'bnms_release_required'='true'
          AND p.status='first_payment_pending' AND a.status='first_payment_pending'
          AND h.status='pending_payment_setup' AND h.payment_status='unpaid'`,
          [a.agreement_id,a.plan_id,a.history_id,a.member_id,TENANT_ID]);
        const history=await rows('SELECT evidence FROM bnms_dd_beta_provider_history WHERE adoption_id=$1 ORDER BY provider_payment_id',[a.id]);
        if(linked.length!==1||fingerprint(history.map(r=>r.evidence))!==fingerprint(m.history.map(h=>h.evidence)))fail('Replay canonical/history drift');
      }
      await c.query('ROLLBACK');return {mode:'held_beta_replay',hash,writes:0};
    }
    let mirrors=0;
    const ownership=[];
    for(const m of manifest.members) {
      const i=m.identity;
      const member=await rows('SELECT * FROM member WHERE id=$1 AND tenant_id=$2',[i.memberId,TENANT_ID]);
      if(member.length!==1||member[0].membership_paused||['cancelled','deleted','paused'].includes(member[0].status)
        ||String(member[0].email).trim().toLowerCase()!==i.email)fail('Current member identity/state drift');
      const config=await rows('SELECT * FROM membership_tier_config WHERE id=$1 AND tenant_id=$2',[m.structure.id,TENANT_ID]);
      if(config.length!==1||fingerprint(JSON.parse(JSON.stringify(config[0])))!==fingerprint(m.structure))fail('Structure drift');
      const scopes=await rows(`SELECT id FROM membership_tier_config WHERE tenant_id=$1 AND is_active=true AND dd_enabled=true
        AND structure_scope_type='member' AND structure_field_id=$2 AND lower(trim(structure_match_value))=lower(trim($3))
        AND start_mode='immediate' AND (effective_from IS NULL OR effective_from <= $4)
        AND (effective_to IS NULL OR effective_to >= $4)`,[TENANT_ID,m.structure.structure_field_id,m.structure.structure_match_value,START]);
      if(scopes.length!==1||scopes[0].id!==m.structure.id)fail('Future effective purchased scope ambiguous');
      const classes=await rows(`SELECT v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
        WHERE v.member_id=$1 AND f.tenant_id=$2 AND f.name='member_class' AND f.entity_scope='member' AND f.is_active=true`,[i.memberId,TENANT_ID]);
      if(classes.length!==1||classes[0].value!==m.structure.structure_match_value)fail('Class drift');
      for(const table of ['membership_billing_agreements','membership_payment_plans','member_membership_history']) {
        if((await rows(`SELECT id FROM ${table} WHERE member_id=$1`,[i.memberId])).length)fail('Existing canonical member record');
      }
      if((await rows(`SELECT id FROM membership_billing_agreements WHERE gocardless_mandate_id=$1 OR gocardless_customer_id=$2
        UNION ALL SELECT id FROM membership_payment_plans WHERE gocardless_mandate_id=$1`,[i.mandateId,i.customerId])).length)fail('Canonical mandate/customer already attached');
      const customers=await rows('SELECT * FROM gocardless_customers WHERE gocardless_customer_id=$1 OR member_id=$2',[i.customerId,i.memberId]);
      const mandates=await rows('SELECT * FROM gocardless_mandates WHERE gocardless_mandate_id=$1 OR gocardless_customer_id=$2',[i.mandateId,i.customerId]);
      if(customers.length>1||mandates.length>1||customers.some(r=>r.tenant_id!==TENANT_ID||r.member_id!==i.memberId||r.organization_id||r.environment!=='live'||r.gocardless_customer_id!==i.customerId)
        ||mandates.some(r=>r.tenant_id!==TENANT_ID||r.gocardless_customer_id!==i.customerId||r.environment!=='live'||r.gocardless_mandate_id!==i.mandateId||r.status!=='active'))fail('Provider mirror ownership collision');
      const paymentIds=m.history.map(h=>h.provider_payment_id);
      if((await rows(`SELECT id FROM gocardless_payments WHERE gocardless_payment_id=ANY($1::text[]) OR gocardless_mandate_id=$2`,[paymentIds,i.mandateId])).length)fail('Mutable provider payments already exist');
      if((await rows('SELECT id FROM bnms_dd_historical_payment WHERE provider_payment_id=ANY($1::text[])',[paymentIds])).length)fail('Pilot historical collision');
      if((await rows(`SELECT id FROM gocardless_mandate_discovery_row WHERE environment='live'
        AND (gocardless_mandate_id=$1 OR gocardless_customer_id=$2) AND matched_member_id IS NOT NULL
        AND (matched_member_id<>$3 OR tenant_id<>$4)`,[i.mandateId,i.customerId,i.memberId,TENANT_ID])).length)fail('Discovery owner collision');
      if((await rows('SELECT id FROM gocardless_collection_reservations WHERE gocardless_payment_id=ANY($1::text[])',[paymentIds])).length)fail('Historical payment reservation collision');
      if(ready&&(await rows(`SELECT id FROM bnms_dd_beta_adoption WHERE member_id=$1 OR mandate_id=$2 OR customer_id=$3
        UNION ALL SELECT id FROM bnms_dd_beta_provider_history WHERE provider_payment_id=ANY($4::text[])`,
        [i.memberId,i.mandateId,i.customerId,paymentIds])).length)fail('Existing beta identity/evidence differs');
      mirrors+=Number(!customers.length)+Number(!mandates.length);
      ownership.push({memberId:i.memberId,customerExists:!!customers.length,mandateExists:!!mandates.length,
        canonicalCollisions:0,paymentCollisions:0,providerMirrorConflicts:0});
    }
    const count=manifest.members.reduce((n,m)=>n+m.history.length,0);
    if(!apply){await c.query('ROLLBACK');return {mode:'held_beta_dry_run',hash,writes:0,plannedRows:41+mirrors+count,
      historicalRows:count,mirrorRows:mirrors,migrationRequired:!ready,ownership,manifest};}
    const batch=await insert(c,'bnms_dd_beta_batch',{tenant_id:TENANT_ID,evidence_sha256:hash,evidence:manifest});
    for(const m of manifest.members) {
      const i=m.identity,o=ownership.find(o=>o.memberId===i.memberId),dd=m.dd,term=dd.commitment;
      if(!o.customerExists)await insert(c,'gocardless_customers',{tenant_id:TENANT_ID,member_id:i.memberId,gocardless_customer_id:i.customerId,environment:'live',metadata:{source:'bnms_beta_held'}});
      if(!o.mandateExists)await insert(c,'gocardless_mandates',{tenant_id:TENANT_ID,gocardless_customer_id:i.customerId,gocardless_mandate_id:i.mandateId,status:'active',environment:'live',metadata:{source:'bnms_beta_held'}});
      const agreement=await insert(c,'membership_billing_agreements',{...term,tenant_id:TENANT_ID,member_id:i.memberId,
        agreement_type:'member',provider:'gocardless',gocardless_customer_id:i.customerId,gocardless_mandate_id:i.mandateId,
        status:'first_payment_pending',environment:'live',needs_attention:true,attention_reason:'Beta held: accounting and legacy handover unverified; separate reviewed release required',
        idempotency_key:buildIdempotencyKey('bnms-beta-adoption',TENANT_ID,i.memberId,START),
        metadata:{dd,commitment:term,bnms_beta_approval:manifest.approval}});
      const plan=await insert(c,'membership_payment_plans',{tenant_id:TENANT_ID,member_id:i.memberId,billing_agreement_id:agreement.id,
        provider:'gocardless',gocardless_mandate_id:i.mandateId,amount_minor:m.monthlyQuoteMinor,currency:'GBP',interval_unit:'monthly',
        day_of_month:1,status:'first_payment_pending',membership_year:dd.membership_year,start_date:START,instalments_total:12,
        environment:'live',dynamic_next_collection_date:START,collection_stopped_at:new Date().toISOString(),
        idempotency_key:buildIdempotencyKey('dd-dynamic-plan',TENANT_ID,agreement.id,term.term_key),
        metadata:{collection_mode:'dynamic',dynamic_first_date:START,agreement_id:agreement.id,bnms_release_required:true,bnms_beta_held:true}});
      const history=await insert(c,'member_membership_history',{...term,tenant_id:TENANT_ID,member_id:i.memberId,
        membership_year:dd.membership_year,config_id:m.structure.id,tier_label:'Flat Rate',currency:'GBP',
        annual_cost:term.commitment_snapshot.amounts.annual_cost,final_cost:null,vat_amount:null,total_with_vat:null,
        billing_period:'monthly_direct_debit',payment_method:'direct_debit',status:'pending_payment_setup',payment_status:'unpaid',
        billing_agreement_id:agreement.id,notes:'Beta held managed future period. Original/current entitlement unknown. Provider historical evidence is not invoice reconciliation.'});
      const adoption=await insert(c,'bnms_dd_beta_adoption',{batch_id:batch.id,tenant_id:TENANT_ID,member_id:i.memberId,
        mandate_id:i.mandateId,customer_id:i.customerId,agreement_id:agreement.id,plan_id:plan.id,history_id:history.id,evidence:m});
      for(const h of m.history)await insert(c,'bnms_dd_beta_provider_history',{adoption_id:adoption.id,tenant_id:TENANT_ID,member_id:i.memberId,
        provider_payment_id:h.provider_payment_id,charge_date:h.charge_date,amount_minor:h.amount_minor,currency:'GBP',provider_status:'paid_out',evidence:h.evidence});
    }
    await c.query('COMMIT');return {mode:'held_beta_applied',hash,writes:41+mirrors+count,providerWrites:0,collectionReleased:false};
  }catch(e){await c.query('ROLLBACK');throw e;}
}