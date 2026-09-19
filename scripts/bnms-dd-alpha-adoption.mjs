import { buildAgreementSnapshot } from '../api/_lib/gocardlessDirectDebit.js';
import { buildIdempotencyKey } from '../api/_lib/gocardless.js';
import { hash, reconcileHistoricalInvoices, assertHistoricalInvoicesComplete, XERO_TENANT_ID } from './bnms-dd-beta-invoices.mjs';
import { TENANT_ID, WORKBOOK_SHA256 } from './bnms-dd-pilot.mjs';
import { classifyPopulation, stableId, FROM, START, END } from './bnms-dd-alpha-review.mjs';
const fail=m=>{throw Error(m);};
export function alphaManifest(source,accounting,{entitlements=[]}={}){
  if(source.tenantId!==TENANT_ID||source.xeroTenantId!==XERO_TENANT_ID
    ||source.workbookSha256!==WORKBOOK_SHA256||source.completeAccountDiscovery!==true)fail('Complete pinned source required');
  for(const resource of ['mandates','customers','payments','subscriptions']){
    const rows=source.provider[resource];
    if(!Array.isArray(rows)||rows.some(r=>!r.id)||new Set(rows.map(r=>r.id)).size!==rows.length)fail('Provider source identity collision');
  }
  const entries=classifyPopulation(source),members=[],exceptions=[];
  for(const e of entries){
    if(e.disposition==='excluded_pilot_beta')continue;
    // The explicit future-held approval does not authorize reconstructing prior
    // entitlement. Its absence is not a blocker to a separate unpaid future term.
    // Do not consume legacy expiry fields or caller-supplied prior date guesses.
    const entitlement={verified:false,start:null,end:null,unchanged:true};
    const unsafeIdentity=['IDENTITY_MISSING_OR_AMBIGUOUS','MEMBER_IDENTITY_OR_STATE_CONFLICT',
      'MULTIPLE_MANDATES_OR_MEMBER_IDENTITIES','MANDATE_NOT_ACTIVE','CREDITOR_NOT_PINNED','DISCOVERY_OWNER_CONFLICT'];
    if(!e.historical?.length||e.reasons.some(r=>unsafeIdentity.includes(r))){
      exceptions.push({identity:e.identity,mandateId:e.mandateId,reasons:e.reasons});continue;
    }
    const history=e.historical.map(p=>({id:stableId('payment',p.id),tenant_id:TENANT_ID,member_id:e.member.id,
      provider_payment_id:p.id,charge_date:p.charge_date,amount_minor:p.amount,currency:p.currency,
      provider_status:'paid_out',evidence:p})).sort((a,b)=>a.id.localeCompare(b.id));
    let links;
    try{
      links=reconcileHistoricalInvoices({tenantId:TENANT_ID,xeroTenantId:XERO_TENANT_ID,
        rows:history.map(h=>({...h,mandate_id:e.mandate.id,customer_id:e.customer.id,email:e.member.email})),
        provider:[{mandate:e.mandate,customer:e.customer,payments:e.historical}],...accounting});
    }catch(error){exceptions.push({identity:e.identity,mandateId:e.mandateId,
      reasons:[...e.reasons,`INVOICE_RECONCILIATION: ${error.message}`]});continue;}
    assertHistoricalInvoicesComplete(history,links);
    if(e.reasons.length){exceptions.push({identity:e.identity,mandateId:e.mandateId,reasons:e.reasons,
      invoiceReconciliation:'complete',historicalPayments:history.length});continue;}
    const s=e.structure,amount=Math.round(Number(s.dd_monthly_amount)*100);
    if(!Number.isSafeInteger(amount)||amount<=0)fail('Invalid current class quote');
    const dd=buildAgreementSnapshot({acceptedAt:null,billingRequestMode:'migration_existing_mandate',
      offer:{collectionPolicy:{version:1,end_policy:'continue',pricing_policy:'dynamic'},monthlyAmount:amount/100,
        monthlyAmountMinor:amount,instalmentCount:12,planTotal:null,currency:'GBP',firstCollectionRule:'nominated_day',
        collectionDay:1,activationRule:'first_payment',graceDays:s.dd_grace_days,termsVersion:s.dd_terms_version,
        invoicingMode:'per_instalment',monthlyPostGraceCollectionPolicy:s.monthly_post_grace_collection_policy},
      simResult:{config:s,membershipYear:{start:START,end:END,label:`rolling:${START}`},
        annualCost:Number(s.flat_cost),finalCost:null,vatRatePercent:0,tierLabel:'Flat Rate'}});
    members.push({identity:e.identity,sourceMember:e.member,sourcePreferences:e.preferences,structure:s,
      customer:e.customer,mandate:e.mandate,subscriptions:e.subscriptions,payments:e.payments,
      currentPriorEntitlement:entitlement,dd,monthlyQuoteMinor:amount,history,links,
      ids:Object.fromEntries(['adoption','agreement','plan','membership'].map(k=>[k,stableId(k,e.member.id)]))});
  }
  if(members.length){
    assertHistoricalInvoicesComplete(members.flatMap(m=>m.history),members.flatMap(m=>m.links));
    for(const m of members)if(members.some(o=>o.identity.memberId!==m.identity.memberId
      &&o.links.some(l=>m.links.some(x=>x.xero_contact_id===l.xero_contact_id))))fail('Cross-member Xero contact');
  }
  return {version:1,tenantId:TENANT_ID,sourceSha256:hash(source),accountingSha256:hash(accounting),
    entitlementSha256:hash(entitlements),observedAt:source.observedAt,
    approval:{from:FROM,start:START,end:END,day:1,pricing:'current_membership_class_dynamic',
      endPolicy:'continue',activation:'first_payment',collectionHeld:true,releaseApproved:false,
      scope:'explicit_user_approved_future_held_term_only',priorEntitlementUnchanged:true},
    members,exceptions,excludedPilotBeta:entries.filter(e=>e.disposition==='excluded_pilot_beta').length};
}
const tables=new Set(['gocardless_customers','gocardless_mandates','membership_billing_agreements',
  'membership_payment_plans','member_membership_history','bnms_dd_alpha_adoption',
  'bnms_dd_alpha_provider_history','bnms_dd_alpha_invoice_link']);
async function insert(c,table,row){
  if(!tables.has(table))fail('Unsafe alpha table');
  const keys=Object.keys(row);
  return (await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,n)=>`$${n+1}`).join(',')}) RETURNING *`,Object.values(row))).rows[0];
}
export async function alphaCatalogHash(c){
  const {rows}=await c.query(`SELECT * FROM (
    SELECT 'column' AS kind,c.relname||'.'||a.attname AS name,
      jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid))::text AS definition
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'bnms_dd_alpha_%' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'table',relname,jsonb_build_object('rls',relrowsecurity,'force',relforcerowsecurity,'acl',relacl)::text
      FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'bnms_dd_alpha_%' AND relkind='r'
    UNION ALL SELECT 'constraint',conname,pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'bnms_dd_alpha_%')
    UNION ALL SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'bnms_dd_alpha_%'
    UNION ALL SELECT 'function',proname,pg_get_functiondef(oid) FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND (proname LIKE 'bnms_dd_alpha_%' OR proname='bnms_dd_reject_history_mutation')
    UNION ALL SELECT 'trigger',c.relname||'.'||tgname,tgenabled::text||':'||pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal
      AND c.relnamespace='public'::regnamespace AND (tgname LIKE 'bnms_dd_alpha_%' OR c.relname LIKE 'bnms_dd_alpha_%')
    UNION ALL SELECT 'policy',tablename||'.'||policyname,row_to_json(p)::text FROM pg_policies p WHERE schemaname='public' AND tablename LIKE 'bnms_dd_alpha_%'
    ) catalog ORDER BY kind,name`);
  return hash(rows);
}
export async function verifyAlphaSchema(c,sqlSha256){
  const text=(await c.query("SELECT obj_description('public.bnms_dd_alpha_adoption'::regclass,'pg_class') AS revision")).rows[0]?.revision;
  let revision;try{revision=JSON.parse(text);}catch{fail('Alpha schema revision missing');}
  if(revision.sqlSha256!==sqlSha256||revision.catalogSha256!==await alphaCatalogHash(c))fail('Alpha schema drift');
}
export async function applyAlphaSchema(c,sql,reviewSha256,{verifiedDestination=false}={}){
  const {sqlHash}=await import('./bnms-dd-beta-invoices.mjs');
  if(!verifiedDestination||sqlHash(sql)!==reviewSha256)fail('Pinned destination and reviewed schema hash required');
  await c.query('BEGIN');
  try{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-alpha-held'))");
    const ready=(await c.query("SELECT to_regclass('public.bnms_dd_alpha_adoption') IS NOT NULL AS ready")).rows[0].ready;
    if(ready){await verifyAlphaSchema(c,reviewSha256);await c.query('ROLLBACK');return {writes:0,mode:'schema_replay'};}
    await c.query(sql);
    const revision=JSON.stringify({sqlSha256:reviewSha256,catalogSha256:await alphaCatalogHash(c)});
    await c.query(`COMMENT ON TABLE public.bnms_dd_alpha_adoption IS '${revision}'`);
    await c.query('COMMIT');return {mode:'schema_applied',sqlSha256:reviewSha256};
  }catch(e){await c.query('ROLLBACK');throw e;}
}
export async function adoptAlpha(c,manifest,{apply=false,reviewSha256,verifiedDestination=false,
  source,accounting,entitlements=[],schemaSha256,verifyLiveMember,batchSize=10,
  offset=0,limit=manifest.members.length,onProgress=async()=>{}}={}){
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>25)fail('Bounded alpha batch size 1–25 required');
  if(!Number.isInteger(offset)||offset<0||offset>manifest.members.length
    ||!Number.isInteger(limit)||limit<0||limit>manifest.members.length)fail('Invalid reviewed manifest range');
  const digest=hash(manifest);
  if(!source||!accounting||hash(alphaManifest(source,accounting,{entitlements}))!==digest)fail('Reconstructed reviewed evidence required');
  if(apply&&(!verifiedDestination||reviewSha256!==digest||typeof verifyLiveMember!=='function'))
    fail('Exact review, pinned destination and fresh live checks required');
  const results=[];
  const selected=manifest.members.slice(offset,offset+limit);
  for(let batchOffset=0;batchOffset<selected.length;batchOffset+=batchSize){
    for(const m of selected.slice(batchOffset,batchOffset+batchSize)){
      if(verifyLiveMember)await verifyLiveMember(m);
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try{
        await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-alpha-held'))");
        await c.query(`LOCK TABLE member,preference_field,member_preference_value,membership_tier_config,
          membership_billing_agreements,membership_payment_plans,member_membership_history,gocardless_customers,
          gocardless_mandates,gocardless_payments,gocardless_collection_reservations IN SHARE ROW EXCLUSIVE MODE`);
        const rows=async(sql,args=[])=>(await c.query(sql,args)).rows;
        const ready=(await rows("SELECT to_regclass('public.bnms_dd_alpha_adoption') IS NOT NULL AS ready"))[0].ready;
        if(ready)await verifyAlphaSchema(c,schemaSha256);
        if(apply&&!ready)fail('Reviewed alpha schema required');
        const i=m.identity;
        const saved=ready?await rows('SELECT * FROM bnms_dd_alpha_adoption WHERE member_id=$1',[i.memberId]):[];
        if(saved.length){
          const a=saved[0];
          if(hash(a.evidence)!==hash(m)||a.evidence_sha256!==hash(m)||a.manifest_sha256!==digest)fail('Replay provenance mismatch');
          const canonical=await rows(`SELECT p.id FROM membership_payment_plans p JOIN membership_billing_agreements g ON g.id=p.billing_agreement_id
            JOIN member_membership_history h ON h.billing_agreement_id=g.id WHERE p.id=$1 AND g.id=$2 AND h.id=$3
            AND p.member_id=$4 AND g.member_id=$4 AND h.member_id=$4
            AND p.tenant_id=$5 AND g.tenant_id=$5 AND h.tenant_id=$5
            AND p.collection_stopped_at IS NOT NULL AND p.metadata->>'bnms_release_required'='true'
            AND p.status='first_payment_pending' AND g.status='first_payment_pending'
            AND h.status='pending_payment_setup' AND h.payment_status='unpaid'`,
          [a.plan_id,a.agreement_id,a.history_id,i.memberId,TENANT_ID]);
          const history=await rows('SELECT * FROM bnms_dd_alpha_provider_history WHERE adoption_id=$1 ORDER BY id',[a.id]);
          const links=await rows('SELECT l.* FROM bnms_dd_alpha_invoice_link l JOIN bnms_dd_alpha_provider_history h ON h.id=l.history_id WHERE h.adoption_id=$1 ORDER BY l.history_id',[a.id]);
          assertHistoricalInvoicesComplete(history,links);
          if(canonical.length!==1||hash(history.map(h=>h.evidence))!==hash(m.history.map(h=>h.evidence))
            ||hash(links)!==hash(m.links))fail('Replay held state/history drift');
          await c.query('ROLLBACK');results.push({memberId:i.memberId,mode:'replay',writes:0});continue;
        }
        const member=await rows('SELECT * FROM member WHERE id=$1 AND tenant_id=$2',[i.memberId,TENANT_ID]);
        if(member.length!==1||hash(JSON.parse(JSON.stringify(member[0])))!==hash(m.sourceMember))fail('Live member drift');
        const config=await rows('SELECT * FROM membership_tier_config WHERE id=$1 AND tenant_id=$2',[m.structure.id,TENANT_ID]);
        if(config.length!==1||hash(JSON.parse(JSON.stringify(config[0])))!==hash(m.structure))fail('Live pricing drift');
        const preferences=await rows(`SELECT v.member_id,f.id AS field_id,f.name,v.value FROM member_preference_value v
          JOIN preference_field f ON f.id=v.field_id WHERE v.member_id=$1 AND f.tenant_id=$2 AND f.entity_scope='member' AND f.is_active=true`,
        [i.memberId,TENANT_ID]);
        const sort=a=>[...a].sort((a,b)=>a.field_id.localeCompare(b.field_id));
        if(hash(sort(preferences))!==hash(sort(m.sourcePreferences)))fail('Live class/preference drift');
        const activeScopes=await rows(`SELECT id FROM membership_tier_config WHERE tenant_id=$1 AND is_active=true AND dd_enabled=true
          AND structure_scope_type='member' AND lower(trim(structure_match_value))=lower(trim($2))
          AND (effective_from IS NULL OR effective_from<=$3) AND (effective_to IS NULL OR effective_to>=$3)`,
        [TENANT_ID,m.structure.structure_match_value,START]);
        if(activeScopes.length!==1||activeScopes[0].id!==m.structure.id)fail('Live effective scope ambiguous');
        for(const table of ['membership_billing_agreements','membership_payment_plans','member_membership_history']){
          if((await rows(`SELECT id FROM ${table} WHERE member_id=$1`,[i.memberId])).length)fail('Existing canonical identity');
        }
        if((await rows(`SELECT id FROM bnms_dd_beta_adoption WHERE member_id=$1 OR mandate_id=$2 OR customer_id=$3
          UNION ALL SELECT id FROM membership_billing_agreements WHERE gocardless_mandate_id=$2 OR gocardless_customer_id=$3
          UNION ALL SELECT id FROM membership_payment_plans WHERE gocardless_mandate_id=$2`,
        [i.memberId,i.mandateId,i.customerId])).length)fail('Pilot/beta or canonical provider identity collision');
        const paymentIds=m.history.map(h=>h.provider_payment_id),invoiceIds=m.links.map(l=>l.xero_invoice_id);
        if((await rows(`SELECT id FROM gocardless_payments WHERE gocardless_payment_id=ANY($1::text[]) OR gocardless_mandate_id=$2
          UNION ALL SELECT id FROM bnms_dd_historical_payment WHERE provider_payment_id=ANY($1::text[])
          UNION ALL SELECT id FROM bnms_dd_beta_provider_history WHERE provider_payment_id=ANY($1::text[])
          UNION ALL SELECT id FROM gocardless_collection_reservations WHERE gocardless_payment_id=ANY($1::text[])`,
        [paymentIds,i.mandateId])).length)fail('Historical provider identity collision');
        if((await rows(`SELECT id FROM member_membership_history WHERE xero_invoice_id::text=ANY($1::text[]) OR accounting_invoice_id::text=ANY($1::text[])
          UNION ALL SELECT id FROM bnms_dd_historical_payment WHERE xero_invoice_id::text=ANY($1::text[])
          UNION ALL SELECT history_id AS id FROM bnms_dd_beta_invoice_link WHERE xero_invoice_id::text=ANY($1::text[])`,[invoiceIds])).length)
          fail('Existing invoice association');
        const customers=await rows('SELECT * FROM gocardless_customers WHERE gocardless_customer_id=$1 OR member_id=$2',[i.customerId,i.memberId]);
        const mandates=await rows('SELECT * FROM gocardless_mandates WHERE gocardless_mandate_id=$1 OR gocardless_customer_id=$2',[i.mandateId,i.customerId]);
        if(customers.length>1||mandates.length>1||customers.some(r=>r.tenant_id!==TENANT_ID||r.member_id!==i.memberId
          ||r.organization_id||r.environment!=='live'||r.gocardless_customer_id!==i.customerId)
          ||mandates.some(r=>r.tenant_id!==TENANT_ID||r.environment!=='live'||r.status!=='active'
          ||r.gocardless_mandate_id!==i.mandateId||r.gocardless_customer_id!==i.customerId))fail('Provider mirror owner collision');
        const planned=4+m.history.length+m.links.length+Number(!customers.length)+Number(!mandates.length);
        if(!apply){await c.query('ROLLBACK');results.push({memberId:i.memberId,mode:'dry_run',writes:0,plannedRows:planned,migrationRequired:!ready});continue;}
        const dd=m.dd,term=dd.commitment;
        if(!customers.length)await insert(c,'gocardless_customers',{tenant_id:TENANT_ID,member_id:i.memberId,gocardless_customer_id:i.customerId,environment:'live',metadata:{source:'bnms_alpha_held'}});
        if(!mandates.length)await insert(c,'gocardless_mandates',{tenant_id:TENANT_ID,gocardless_customer_id:i.customerId,gocardless_mandate_id:i.mandateId,status:'active',environment:'live',metadata:{source:'bnms_alpha_held'}});
        await insert(c,'membership_billing_agreements',{...term,id:m.ids.agreement,tenant_id:TENANT_ID,member_id:i.memberId,
          agreement_type:'member',provider:'gocardless',gocardless_customer_id:i.customerId,gocardless_mandate_id:i.mandateId,
          status:'first_payment_pending',environment:'live',needs_attention:true,attention_reason:'Alpha held: legacy collector handover and separate release approval required',
          idempotency_key:buildIdempotencyKey('bnms-alpha-adoption',TENANT_ID,i.memberId,START),
          metadata:{dd,commitment:term,bnms_alpha_approval:manifest.approval}});
        await insert(c,'membership_payment_plans',{id:m.ids.plan,tenant_id:TENANT_ID,member_id:i.memberId,billing_agreement_id:m.ids.agreement,
          provider:'gocardless',gocardless_mandate_id:i.mandateId,amount_minor:m.monthlyQuoteMinor,currency:'GBP',interval_unit:'monthly',
          day_of_month:1,status:'first_payment_pending',membership_year:dd.membership_year,start_date:START,instalments_total:12,
          environment:'live',dynamic_next_collection_date:START,collection_stopped_at:new Date().toISOString(),
          idempotency_key:buildIdempotencyKey('dd-dynamic-plan',TENANT_ID,m.ids.agreement,term.term_key),
          metadata:{collection_mode:'dynamic',dynamic_first_date:START,agreement_id:m.ids.agreement,bnms_release_required:true,bnms_alpha_held:true}});
        await insert(c,'member_membership_history',{...term,id:m.ids.membership,tenant_id:TENANT_ID,member_id:i.memberId,
          membership_year:dd.membership_year,config_id:m.structure.id,tier_label:'Flat Rate',currency:'GBP',
          annual_cost:term.commitment_snapshot.amounts.annual_cost,final_cost:null,vat_amount:null,total_with_vat:null,
          billing_period:'monthly_direct_debit',payment_method:'direct_debit',status:'pending_payment_setup',payment_status:'unpaid',
          billing_agreement_id:m.ids.agreement,notes:'Alpha held future term. Historical invoices are separate immutable evidence, not first-payment activation.'});
        await insert(c,'bnms_dd_alpha_adoption',{id:m.ids.adoption,tenant_id:TENANT_ID,member_id:i.memberId,
          mandate_id:i.mandateId,customer_id:i.customerId,agreement_id:m.ids.agreement,plan_id:m.ids.plan,history_id:m.ids.membership,
          evidence_sha256:hash(m),manifest_sha256:digest,evidence:m});
        for(const h of m.history)await insert(c,'bnms_dd_alpha_provider_history',{...h,adoption_id:m.ids.adoption});
        for(const l of m.links)await insert(c,'bnms_dd_alpha_invoice_link',l);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await c.query('COMMIT');results.push({memberId:i.memberId,mode:'held_alpha_applied',writes:planned});
      }catch(error){await c.query('ROLLBACK');await onProgress({manifestSha256:digest,results,failedMemberId:m.identity.memberId,error:error.message});throw error;}
    }
    await onProgress({manifestSha256:digest,results});
  }
  return {mode:apply?'held_alpha_import':'held_alpha_dry_run',manifestSha256:digest,results,
    range:{offset,count:selected.length,total:manifest.members.length},
    writes:results.reduce((n,r)=>n+r.writes,0),collectionReleased:false,providerWrites:0,
    blocked:manifest.exceptions.length,readyToImport:manifest.members.length>0};
}