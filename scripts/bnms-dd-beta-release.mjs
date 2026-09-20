// No provider mutations. Reviewed per-member arming of the exact held beta batch.
import { readFile } from 'node:fs/promises';
import { fingerprint } from './bnms-dd-pilot-history.mjs';
import { TENANT_ID, BATCH_HASH, XERO_TENANT_ID, assertHistoricalInvoicesComplete } from './bnms-dd-beta-invoices.mjs';
import { alphaProviderReader } from './bnms-dd-alpha-review.mjs';
import { readAllProviderPages } from './bnms-dd-pilot.mjs';
import { getTenantGocardlessCredentials } from '../api/_lib/gocardlessCredentials.js';
import { resolveDynamicCollectionPrice } from '../api/_lib/gocardlessDynamicCollections.js';
import { BNMS_BETA_BANK, betaAccountingMapping, assertBnmsBetaAccountingContext } from '../api/_lib/bnmsBetaAccounting.js';
export const PROCESSING_START='2026-09-30T23:00:00Z';
export const MAX_EVIDENCE_AGE_MS=15*60*1000;
export const MAX_HANDOVER_AGE_MS=24*60*60*1000;
export const MIGRATION=new URL('../supabase/migrations/20261115_bnms_dd_beta_scheduled_release.sql',import.meta.url);
const fail=m=>{throw Error(m);};
const checked=async(q,label)=>{const r=await q;if(r.error)fail(`${label}: ${r.error.code}`);return r.data;};
const sort=a=>[...a].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
const withoutAudit=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!['updated_at','created_at'].includes(k)));
export const stateHash=s=>fingerprint(Object.fromEntries(Object.entries(s).map(([k,v])=>[k,sort(v).map(withoutAudit)])));
async function rows(db,table,filter=q=>q){
  const all=[];
  for(let offset=0;offset<10000;offset+=500){
    const page=await checked(filter(db.from(table).select('*')).order('id').range(offset,offset+499),table);
    all.push(...page);if(page.length<500)return all;
  }fail(`${table}: incomplete pagination`);
}
export function validateBetaScope(batch,adoptions){
  if(batch?.tenant_id!==TENANT_ID||batch.evidence_sha256!==BATCH_HASH
    ||fingerprint(batch.evidence)!==BATCH_HASH||adoptions.length!==10)fail('Exact immutable ten-member beta batch required');
  for(const key of ['member_id','mandate_id','customer_id','plan_id','agreement_id','history_id']){
    if(new Set(adoptions.map(a=>a[key])).size!==10)fail(`Beta duplicate ${key}`);
  }
  for(const a of adoptions){
    const saved=batch.evidence.members.find(m=>m.identity.memberId===a.member_id);
    if(a.tenant_id!==TENANT_ID||a.batch_id!==batch.id||!saved||fingerprint(saved)!==fingerprint(a.evidence)
      ||saved.identity.mandateId!==a.mandate_id||saved.identity.customerId!==a.customer_id)fail('Beta adoption provenance drift');
  }
}
export function validateBetaHandover(handover,memberIds){
  if(handover?.tenantId!==TENANT_ID||handover.batchHash!==BATCH_HASH
    ||handover.automaticLegacyCollectionsDisabled!==true
    ||typeof handover.confirmedBy!=='string'||!handover.confirmedBy.trim()
    ||typeof handover.evidenceReference!=='string'||!handover.evidenceReference.trim()
    ||!Number.isFinite(Date.parse(handover.confirmedAt))
    ||!Array.isArray(handover.memberIds)||fingerprint([...handover.memberIds].sort())!==fingerprint([...memberIds].sort()))fail('Explicit exact-beta legacy collector handover evidence required');
}
export function assertBetaEvidenceFresh(report,instant){
  const timestamp=instant.getTime(),start=Date.parse(report.observedAt),end=Date.parse(report.completedAt);
  const attested=Date.parse(report.handover?.confirmedAt);
  if(!Number.isFinite(timestamp)||!Number.isFinite(start)||!Number.isFinite(end)
    ||start>timestamp||end<start||end>timestamp||timestamp-start>MAX_EVIDENCE_AGE_MS)fail('Oldest readiness evidence must be within 15 minutes, including reads and transaction time');
  if(!Number.isFinite(attested)||attested>timestamp||timestamp-attested>MAX_HANDOVER_AGE_MS)fail('Legacy handover must be reattested within 24 hours of arming');
}
export async function readBetaReleaseEvidence(db,{transport=fetch,now=()=>new Date(),handover=null}={}){
  // Capture BEFORE the first database/provider request, not after a long scan.
  const observedAt=now().toISOString();
  const batch=await checked(db.from('bnms_dd_beta_batch').select('*').eq('tenant_id',TENANT_ID).eq('evidence_sha256',BATCH_HASH).single(),'batch');
  const adoptions=await rows(db,'bnms_dd_beta_adoption',q=>q.eq('tenant_id',TENANT_ID).eq('batch_id',batch.id));
  validateBetaScope(batch,adoptions);
  const ids=adoptions.map(a=>a.member_id),planIds=adoptions.map(a=>a.plan_id);
  const historical=await rows(db,'bnms_dd_beta_provider_history',q=>q.eq('tenant_id',TENANT_ID).in('member_id',ids));
  const links=await rows(db,'bnms_dd_beta_invoice_link',q=>q.eq('tenant_id',TENANT_ID).in('member_id',ids));
  assertHistoricalInvoicesComplete(historical,links);
  const state={};
  for(const table of ['membership_billing_agreements','membership_payment_plans','member_membership_history']){
    state[table]=await rows(db,table,q=>q.eq('tenant_id',TENANT_ID).in('member_id',ids));
  }
  state.member=await rows(db,'member',q=>q.eq('tenant_id',TENANT_ID).in('id',ids));
  state.membership_tier_config=await rows(db,'membership_tier_config',q=>q.eq('tenant_id',TENANT_ID));
  const fields=await rows(db,'preference_field',q=>q.eq('tenant_id',TENANT_ID).eq('name','member_class').eq('entity_scope','member').eq('is_active',true));
  if(fields.length!==1)fail('Member class field is ambiguous');
  state.member_preference_value=await rows(db,'member_preference_value',q=>q.in('member_id',ids));
  state.preference_field=fields;
  state.membership_tier_vat_override=await rows(db,'membership_tier_vat_override',q=>q.eq('tenant_id',TENANT_ID));
  const reservations=await rows(db,'gocardless_collection_reservations',q=>q.eq('tenant_id',TENANT_ID).in('plan_id',planIds));
  const canonicalPayments=await rows(db,'gocardless_payments',q=>q.eq('tenant_id',TENANT_ID).in('gocardless_mandate_id',adoptions.map(a=>a.mandate_id)));
  const settings=await rows(db,'system_settings',q=>q.eq('tenant_id',TENANT_ID).in('setting_key',['xero_gocardless_bank_account_code','membership_nominal_ledger','xero_sales_account_code']));
  const provider=await checked(db.from('tenant_accounting_settings').select('active_provider').eq('tenant_id',TENANT_ID).maybeSingle(),'accounting provider');
  const tokens=await checked(db.from('xero_token').select('tenant_id,access_token,expires_at').eq('app_tenant_id',TENANT_ID),'Xero token');
  if(tokens.length!==1||tokens[0].tenant_id!==XERO_TENANT_ID||Date.parse(tokens[0].expires_at)<now().getTime()+60000)fail('Pinned unexpired Xero authentication required');
  const xero=async(resource,query={})=>{
    const url=new URL(`https://api.xero.com/api.xro/2.0/${resource}`);
    for(const [k,v] of Object.entries(query))url.searchParams.set(k,v);
    const r=await transport(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${tokens[0].access_token}`,'Xero-tenant-id':XERO_TENANT_ID,Accept:'application/json'}});
    if(!r.ok)fail(`Xero read HTTP ${r.status}`);return r.json();
  };
  const accounts=(await xero('Accounts')).Accounts;
  if(!Array.isArray(accounts))fail('Complete Xero account evidence required');
  const banks=accounts.filter(a=>a.AccountID===BNMS_BETA_BANK.bank_account_id&&a.Type==='BANK'&&a.Status==='ACTIVE'&&a.CurrencyCode==='GBP');
  const globalBlockers=[];
  try{validateBetaHandover(handover,ids);const age=now().getTime()-Date.parse(handover.confirmedAt);
    if(age<0||age>MAX_HANDOVER_AGE_MS)fail('Reattest handover within 24 hours');}
  catch{globalBlockers.push('Explicit exact-beta legacy automatic collector handover confirmation required; empty provider schedules alone are not proof');}
  if(provider?.active_provider!=='xero')globalBlockers.push('Dedicated Xero accounting provider must be explicitly configured');
  if(banks.length!==1)globalBlockers.push('Approved beta existing bank must resolve to the pinned ACTIVE GBP BANK');
  const get=alphaProviderReader(await getTenantGocardlessCredentials(TENANT_ID,{db}),transport);
  const members=[];
  for(const a of adoptions){
    const blockers=[],member=state.member.find(m=>m.id===a.member_id);
    const agreement=state.membership_billing_agreements.find(x=>x.id===a.agreement_id);
    const plan=state.membership_payment_plans.find(x=>x.id===a.plan_id);
    const history=state.member_membership_history.find(x=>x.id===a.history_id);
    if(!member||member.is_deleted||member.deleted_at||member.membership_paused||['deleted','cancelled','paused'].includes(member.status))blockers.push('Member unavailable');
    if(state.membership_payment_plans.filter(x=>x.member_id===a.member_id).length!==1
      ||state.membership_billing_agreements.filter(x=>x.member_id===a.member_id).length!==1
      ||state.member_membership_history.filter(x=>x.member_id===a.member_id).length!==1)blockers.push('Additional canonical records require reconciliation');
    if(!agreement||!plan||!history||agreement.gocardless_mandate_id!==a.mandate_id||agreement.gocardless_customer_id!==a.customer_id
      ||plan.gocardless_mandate_id!==a.mandate_id||plan.billing_agreement_id!==a.agreement_id||history.billing_agreement_id!==a.agreement_id
      ||agreement.environment!=='live'||plan.environment!=='live'||agreement.provider!=='gocardless'||plan.provider!=='gocardless'
      ||fingerprint(agreement.metadata?.dd)!==fingerprint(a.evidence.dd)
      ||!plan.collection_stopped_at||plan.metadata?.bnms_release_required!==true||plan.metadata?.bnms_beta_held!==true
      ||plan.gocardless_subscription_id||plan.dynamic_next_collection_date!=='2026-10-01'||plan.metadata?.dynamic_first_date!=='2026-10-01'
      ||!['first_payment_pending','mandate_pending'].includes(agreement.status)||plan.status!=='first_payment_pending'
      ||history.status!=='pending_payment_setup'||history.payment_status!=='unpaid')blockers.push('Held canonical identity/terms/state drift');
    if(reservations.some(r=>r.plan_id===a.plan_id)||canonicalPayments.some(p=>p.gocardless_mandate_id===a.mandate_id))blockers.push('Canonical payment/reservation already exists');
    const preferences=state.member_preference_value.filter(p=>p.member_id===a.member_id&&p.field_id===fields[0].id);
    if(preferences.length!==1||preferences[0].value!==a.evidence.structure.structure_match_value)blockers.push('Current member class differs from approved scope');
    let price=null;
    try{price=await resolveDynamicCollectionPrice(agreement,'2026-10-01',{db});}catch(e){blockers.push(e.message);}
    const revenueCode=String(price?.nominal_code||settings.find(s=>s.setting_key==='membership_nominal_ledger')?.setting_value
      ||settings.find(s=>s.setting_key==='xero_sales_account_code')?.setting_value||'200');
    const mapping=betaAccountingMapping(a.member_id);
    if(revenueCode!==mapping.revenue_account_code)blockers.push('Beta revenue code differs from approved scoped mapping');
    if(accounts.filter(x=>x.Code===revenueCode&&x.Status==='ACTIVE'&&x.Type==='REVENUE').length!==1)blockers.push('Current Xero revenue account unavailable');
    const mandate=(await get(`mandates/${a.mandate_id}`)).mandates;
    const customer=(await get(`customers/${a.customer_id}`)).customers;
    const mandates=await readAllProviderPages(get,'mandates',{customer:a.customer_id});
    const subscriptions=await readAllProviderPages(get,'subscriptions',{mandate:a.mandate_id});
    const payments=await readAllProviderPages(get,'payments',{mandate:a.mandate_id});
    if(mandates.length!==1||mandates[0].id!==a.mandate_id||mandate?.id!==a.mandate_id||mandate.status!=='active'
      ||mandate.links?.customer!==a.customer_id||mandate.links?.creditor!=='CR0000B50W1Y2R'||customer?.id!==a.customer_id
      ||!/^\d{4}-\d{2}-\d{2}$/.test(mandate.next_possible_charge_date||'')
      ||mandate.next_possible_charge_date>'2026-10-08')blockers.push('Provider owner/mandate/earliest-date conflict');
    if(subscriptions.length)blockers.push('External subscriptions exist; explicit handover required');
    const stored=historical.filter(h=>h.member_id===a.member_id);
    if(payments.length!==stored.length||payments.some(p=>p.status!=='paid_out'||p.charge_date>='2026-10-01'
      ||p.links?.mandate!==a.mandate_id||!stored.some(h=>h.provider_payment_id===p.id&&h.amount_minor===p.amount&&h.currency===p.currency&&h.charge_date===p.charge_date)))blockers.push('Provider payment history/future schedule requires reconciliation');
    const contactIds=[...new Set(links.filter(l=>l.member_id===a.member_id).map(l=>l.xero_contact_id))];
    let futureInvoices=[];
    if(contactIds.length!==1)blockers.push('Historical Xero contact ownership ambiguous');
    else{
      let complete=false;
      for(let page=1;page<=100;page++){
        const invoices=(await xero('Invoices',{where:`Contact.ContactID==Guid("${contactIds[0]}")`,page:String(page)})).Invoices;
        if(!Array.isArray(invoices))fail('Xero invoice pagination incomplete');
        for(const invoice of invoices){
          if(invoice.Contact?.ContactID!==contactIds[0]||!invoice.DateString)fail('Xero invoice owner/date mismatch');
          if(!['VOIDED','DELETED'].includes(invoice.Status)&&(invoice.DateString.slice(0,10)>='2026-10-01'||Number(invoice.AmountDue)>0))futureInvoices.push({id:invoice.InvoiceID,date:invoice.DateString,status:invoice.Status});
        }
        if(invoices.length<100){complete=true;break;}
      }
      if(!complete)fail('Xero invoice pagination limit');
      if(futureInvoices.length)blockers.push('Future/outstanding Xero invoices require handover');
    }
    members.push({adoptionId:a.id,memberId:a.member_id,planId:a.plan_id,agreementId:a.agreement_id,historyId:a.history_id,
      mandateId:a.mandate_id,customerId:a.customer_id,adoptionHash:fingerprint(a),price,blockers,
      provider:{mandate,customer,subscriptions,payments,mandateCount:mandates.length},futureInvoices,
      accounting:{xeroTenantId:XERO_TENANT_ID,bankAccountId:banks[0]?.AccountID||null,bankCode:banks[0]?.Code||null,revenueCode,contactId:contactIds[0]||null,mapping},
      historicalInvoiceCount:stored.length});
  }
  const completedAt=now().toISOString();
  if(Date.parse(completedAt)-Date.parse(observedAt)>MAX_EVIDENCE_AGE_MS)globalBlockers.push('Readiness scan exceeded 15 minutes; repeat all evidence');
  return {version:1,batchHash:BATCH_HASH,batchId:batch.id,tenantId:TENANT_ID,observedAt,completedAt,
    stateHash:stateHash(state),state,globalBlockers,members,settings,provider,handover};
}
export function betaReleaseManifest(report,proof){
  if(report.tenantId!==TENANT_ID||report.batchHash!==BATCH_HASH||report.members?.length!==10
    ||new Set(report.members.map(m=>m.memberId)).size!==10)fail('Exact ten-member readiness scope required');
  if(report.globalBlockers.length||report.members.some(m=>m.blockers.length))fail('Beta release blocked by unresolved readiness evidence');
  validateBetaHandover(report.handover,report.members.map(m=>m.memberId));
  for(const member of report.members){
    const mapping=assertBnmsBetaAccountingContext(TENANT_ID,{memberId:member.memberId,environment:'live',
      provider:'gocardless',snapshot:member.accounting?.mapping});
    if(member.accounting.bankAccountId!==mapping.bank_account_id||member.accounting.xeroTenantId!==mapping.xero_tenant_id
      ||member.accounting.revenueCode!==mapping.revenue_account_code)fail('Beta reviewed accounting mapping mismatch');
  }
  if(!proof?.sourceHashes||!proof.deploymentId||!proof.commit)fail('Verified active deployment proof required');
  return {version:1,batchHash:BATCH_HASH,tenantId:TENANT_ID,processingNotBefore:PROCESSING_START,
    stateHash:report.stateHash,production:proof,handover:report.handover,
    members:report.members.map(m=>({adoptionId:m.adoptionId,memberId:m.memberId,planId:m.planId,
      agreementId:m.agreementId,historyId:m.historyId,mandateId:m.mandateId,customerId:m.customerId,
      adoptionHash:m.adoptionHash,price:m.price,accounting:m.accounting,processingNotBefore:PROCESSING_START,
      providerEarliestDate:m.provider.mandate.next_possible_charge_date,historicalInvoiceCount:m.historicalInvoiceCount}))};
}
export async function verifyBetaReleaseSchema(c){
  const sql=await readFile(MIGRATION,'utf8');
  const oldBeta=await readFile(new URL('../supabase/migrations/20261112_bnms_dd_beta_held.sql',import.meta.url),'utf8');
  const oldHistory=await readFile(new URL('../supabase/migrations/20261108_bnms_dd_pilot_history.sql',import.meta.url),'utf8');
  const sources=[...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(\) RETURNS trigger[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)];
  for(const [text,name] of [[oldBeta,'bnms_dd_beta_protect_payment'],[oldHistory,'bnms_dd_reject_history_mutation']]){
    const match=[...text.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(\) RETURNS trigger[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)].find(m=>m[1]===name);
    if(!match)fail('Canonical historical guard source missing');sources.push(match);
  }
  const functions={};
  for(const match of sources){
    const r=(await c.query(`SELECT p.oid,p.prosrc,p.prosecdef,p.proconfig,p.provolatile,
      n.nspname,l.lanname,p.prorettype='trigger'::regtype AS returns_trigger,pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure($1)`,[`public.${match[1]}()`])).rows[0];
    const config=match[1]==='bnms_dd_reject_history_mutation'?null:['search_path=public'];
    if(!r||r.prosrc!==match[2]||r.prosecdef||fingerprint(r.proconfig)!==fingerprint(config)
      ||r.nspname!=='public'||r.lanname!=='plpgsql'||!r.returns_trigger||r.provolatile!=='v'||r.owner!=='postgres')fail(`Installed beta guard function/security differs: ${match[1]}`);
    functions[match[1]]=r.oid;
  }
  const expected=[
    ['beta_release_owner','bnms_dd_beta_release','bnms_dd_beta_release_owner_guard',7],
    ['beta_release_immutable','bnms_dd_beta_release','bnms_dd_reject_history_mutation',27],
    ['bnms_dd_beta_plan_hold','membership_payment_plans','bnms_dd_beta_hold_guard',19],
    ['bnms_dd_beta_reservation_hold','gocardless_collection_reservations','bnms_dd_beta_hold_guard',23],
    ['bnms_dd_beta_agreement_hold','membership_billing_agreements','bnms_dd_beta_canonical_guard',19],
    ['bnms_dd_beta_history_hold','member_membership_history','bnms_dd_beta_canonical_guard',19],
    ['bnms_dd_beta_no_historical_replay','gocardless_payments','bnms_dd_beta_protect_payment',23],
  ];
  const triggers=(await c.query(`SELECT t.tgname,t.tgfoid,t.tgtype,t.tgenabled,t.tgisinternal,
    t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgattr::text AS columns,t.tgqual,
    encode(t.tgargs,'hex') AS args,n.nspname,c.relname
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE t.tgname=ANY($1)`,[expected.map(t=>t[0])])).rows;
  if(triggers.length!==expected.length)fail('Beta guard trigger set differs');
  for(const [name,table,fn,type] of expected){
    const t=triggers.find(t=>t.tgname===name);
    if(!t||t.nspname!=='public'||t.relname!==table||t.tgfoid!==functions[fn]||t.tgtype!==type
      ||!['O','A'].includes(t.tgenabled)||t.tgisinternal||t.tgconstraint!==0||t.tgdeferrable||t.tginitdeferred
      ||t.columns!==''||t.tgqual!==null||t.args!=='')fail(`Beta trigger binding/timing/events differ: ${name}`);
  }
  const access=(await c.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,c.relkind,pg_get_userbyid(c.relowner) AS owner,
    NOT EXISTS(SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND NOT(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='service_role')
        AND a.privilege_type='SELECT' AND NOT a.is_grantable)) AS safe_acl,
    has_table_privilege('service_role',c.oid,'SELECT') AS service_read,
    NOT EXISTS(SELECT FROM pg_policy WHERE polrelid=c.oid) AS no_policies
    FROM pg_class c WHERE c.oid='public.bnms_dd_beta_release'::regclass`)).rows[0];
  if(!access?.relrowsecurity||access.relforcerowsecurity||access.relkind!=='r'||access.owner!=='postgres'
    ||!access.safe_acl||!access.service_read||!access.no_policies)fail('Beta journal RLS/privileges/owner differ');
  const columns=(await c.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.bnms_dd_beta_release'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
  const columnSpec={id:'uuid',adoption_id:'uuid',tenant_id:'uuid',member_id:'uuid',plan_id:'uuid',
    evidence_sha256:'text',evidence:'jsonb',processing_not_before:'timestamp with time zone',created_at:'timestamp with time zone'};
  if(columns.length!==9||columns.some(a=>columnSpec[a.attname]!==a.type||!a.attnotnull
    ||(a.attname==='id'?a.default_value!=='gen_random_uuid()':a.attname==='created_at'?a.default_value!=='now()':
      a.attname==='processing_not_before'?!/^'2026-09-30 23:00:00\+00'::timestamp with time zone$/.test(a.default_value):a.default_value!==null)))fail('Beta journal columns/defaults differ (verify in UTC)');
  const constraints=(await c.query(`SELECT k.contype,k.convalidated,k.condeferrable,k.condeferred,
    pg_get_constraintdef(k.oid) AS definition,k.confrelid::regclass::text AS referenced_table,k.confupdtype,k.confdeltype,k.confmatchtype,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.ord) AS referenced_columns
    FROM pg_constraint k WHERE k.conrelid='public.bnms_dd_beta_release'::regclass`)).rows;
  const checks=new Set([
    `CHECK ((tenant_id = '${TENANT_ID}'::uuid))`,
    "CHECK ((evidence_sha256 ~ '^[a-f0-9]{64}$'::text))",
    "CHECK ((processing_not_before = '2026-09-30 23:00:00+00'::timestamp with time zone))",
  ]);
  const keys=new Set(['p:id','u:adoption_id','u:member_id','u:plan_id']);
  const fks=new Set(['plan_id:membership_payment_plans:id','adoption_id,tenant_id,member_id:bnms_dd_beta_adoption:id,tenant_id,member_id']);
  if(constraints.length!==9)fail('Beta journal constraint set differs');
  for(const k of constraints){
    if(!k.convalidated||k.condeferrable||k.condeferred)fail('Beta journal constraints must be validated and immediate');
    if(k.contype==='c'){if(!checks.delete(k.definition))fail('Beta journal CHECK differs');}
    else if(k.contype==='p'||k.contype==='u'){if(!keys.delete(`${k.contype}:${k.columns.join(',')}`))fail('Beta journal unique owner key differs');}
    else if(k.contype==='f'){
      if(k.confupdtype!=='a'||k.confdeltype!=='a'||k.confmatchtype!=='s'
        ||!fks.delete(`${k.columns.join(',')}:${k.referenced_table.replace(/^public\./,'')}:${k.referenced_columns.join(',')}`))fail('Beta journal foreign key owner link differs');
    }else fail('Unexpected beta journal constraint');
  }
  if(checks.size||keys.size||fks.size)fail('Beta journal constraints incomplete');
}
export async function releaseBeta(c,report,proof,{apply=false,reviewSha256,verifiedDestination=false,now=()=>new Date()}={}){
  const manifest=betaReleaseManifest(report,proof),hash=fingerprint(manifest);
  if(apply&&(!verifiedDestination||reviewSha256!==hash))fail('Verified DEST and exact reviewed manifest hash required');
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-beta-scheduled-release'))");
    const ready=(await c.query("SELECT to_regclass('public.bnms_dd_beta_release') IS NOT NULL AS ready")).rows[0].ready;
    if(!ready){if(apply)fail('Reviewed beta release schema required');await c.query('ROLLBACK');return {mode:'schema_required',hash,manifest,writes:0};}
    await verifyBetaReleaseSchema(c);
    const prior=(await c.query('SELECT * FROM bnms_dd_beta_release WHERE tenant_id=$1',[TENANT_ID])).rows;
    if(prior.length){
      if(prior.length!==10||prior.some(p=>p.evidence_sha256!==hash||!manifest.members.some(m=>m.adoptionId===p.adoption_id&&m.memberId===p.member_id&&m.planId===p.plan_id)))fail('Partial/different beta release requires reconciliation');
      await c.query('ROLLBACK');return {mode:'release_replay',hash,writes:0,readinessRevalidated:false};
    }
    assertBetaEvidenceFresh(report,now());
    await c.query(`LOCK TABLE member,preference_field,member_preference_value,membership_tier_config,
      membership_billing_agreements,membership_payment_plans,member_membership_history,
      gocardless_collection_reservations,gocardless_payments,system_settings,tenant_accounting_settings,membership_tier_vat_override,
      bnms_dd_beta_adoption,bnms_dd_beta_provider_history,bnms_dd_beta_invoice_link IN SHARE ROW EXCLUSIVE MODE`);
    const ids=manifest.members.map(m=>m.memberId),state={};
    for(const table of ['member','membership_billing_agreements','membership_payment_plans','member_membership_history']){
      state[table]=(await c.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id=$1 AND ${table==='member'?'id':'member_id'}=ANY($2::uuid[])`,[TENANT_ID,ids])).rows.map(r=>r.row);
    }
    state.membership_tier_config=(await c.query('SELECT to_jsonb(t) AS row FROM membership_tier_config t WHERE tenant_id=$1',[TENANT_ID])).rows.map(r=>r.row);
    state.preference_field=(await c.query("SELECT to_jsonb(t) AS row FROM preference_field t WHERE tenant_id=$1 AND name='member_class' AND entity_scope='member' AND is_active=true",[TENANT_ID])).rows.map(r=>r.row);
    state.member_preference_value=(await c.query('SELECT to_jsonb(t) AS row FROM member_preference_value t WHERE member_id=ANY($1::uuid[])',[ids])).rows.map(r=>r.row);
    state.membership_tier_vat_override=(await c.query('SELECT to_jsonb(t) AS row FROM membership_tier_vat_override t WHERE tenant_id=$1',[TENANT_ID])).rows.map(r=>r.row);
    if(stateHash(state)!==manifest.stateHash)fail('Canonical/member/price/consent evidence changed since review');
    const settings=(await c.query("SELECT to_jsonb(t) AS row FROM system_settings t WHERE tenant_id=$1 AND setting_key IN ('xero_gocardless_bank_account_code','membership_nominal_ledger','xero_sales_account_code')",[TENANT_ID])).rows.map(r=>r.row);
    const provider=(await c.query('SELECT active_provider FROM tenant_accounting_settings WHERE tenant_id=$1',[TENANT_ID])).rows[0]||null;
    if(fingerprint(sort(settings).map(withoutAudit))!==fingerprint(sort(report.settings).map(withoutAudit))||fingerprint(provider)!==fingerprint(report.provider))fail('Accounting settings changed');
    const adoptions=(await c.query('SELECT * FROM bnms_dd_beta_adoption WHERE tenant_id=$1',[TENANT_ID])).rows;
    const batch=(await c.query('SELECT * FROM bnms_dd_beta_batch WHERE id=$1',[report.batchId])).rows[0];
    validateBetaScope(batch,adoptions);
    if(manifest.members.some(m=>fingerprint(adoptions.find(a=>a.id===m.adoptionId))!==m.adoptionHash))fail('Adoption identity drift');
    const collisions=(await c.query(`SELECT id FROM gocardless_collection_reservations WHERE plan_id=ANY($1::uuid[])
      UNION ALL SELECT id FROM gocardless_payments WHERE tenant_id=$2 AND gocardless_mandate_id=ANY($3::text[])`,
      [manifest.members.map(m=>m.planId),TENANT_ID,manifest.members.map(m=>m.mandateId)])).rows;
    if(collisions.length)fail('Existing payment/reservation requires reconciliation');
    const histories=(await c.query('SELECT * FROM bnms_dd_beta_provider_history WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])',[TENANT_ID,ids])).rows;
    const links=(await c.query('SELECT * FROM bnms_dd_beta_invoice_link WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])',[TENANT_ID,ids])).rows;
    assertHistoricalInvoicesComplete(histories,links);
    assertBetaEvidenceFresh(report,now());
    if(!apply){await c.query('ROLLBACK');return {mode:'scheduled_beta_release_dry_run',hash,manifest,writes:0};}
    for(const m of manifest.members){
      await c.query(`INSERT INTO bnms_dd_beta_release(adoption_id,tenant_id,member_id,plan_id,evidence_sha256,evidence)
        VALUES($1,$2,$3,$4,$5,$6)`,[m.adoptionId,TENANT_ID,m.memberId,m.planId,hash,{...m,production:proof,handover:report.handover,readinessObservedAt:report.observedAt}]);
      const agreement=await c.query(`UPDATE membership_billing_agreements SET status='first_payment_pending',needs_attention=false,attention_reason=NULL,updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND member_id=$3`,[m.agreementId,TENANT_ID,m.memberId]);
      const plan=await c.query(`UPDATE membership_payment_plans SET collection_stopped_at=NULL,metadata=jsonb_set(metadata,'{bnms_release_required}','false'),updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND member_id=$3 AND collection_stopped_at IS NOT NULL`,[m.planId,TENANT_ID,m.memberId]);
      if(agreement.rowCount!==1||plan.rowCount!==1)fail('Concurrent beta release conflict');
    }
    // Lock waits and the arming transaction consume the same evidence budget.
    const dbClock=(await c.query('SELECT clock_timestamp() AS checked_at')).rows[0].checked_at;
    assertBetaEvidenceFresh(report,new Date(dbClock));
    await c.query('COMMIT');return {mode:'beta_armed_for_october_processing',hash,writes:30,providerWrites:0,membershipActivated:false};
  }catch(e){await c.query('ROLLBACK');throw e;}
}