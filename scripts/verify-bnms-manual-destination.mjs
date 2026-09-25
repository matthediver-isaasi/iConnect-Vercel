// Read-only audit: never invoke apply to discover whether adoption happened.
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {destinationConnection} from './run-bnms-dd-pilot-history.mjs';
import {hash} from './bnms-dd-beta-invoices.mjs';
import {MANUAL_TENANT as tenant, MANUAL_WORKBOOK} from '../api/_lib/bnmsManualCohort.js';
import {canonicalRows, scopeHash, SCOPE_SHA} from './bnms-dd-manual-cohort.mjs';

if(process.argv.length!==2) throw Error('Read-only audit accepts no arguments');
const saved=JSON.parse(await readFile('exports/private-bnms-manual-phase2/dry-run.json','utf8'));
if(hash(saved.review)!==saved.reviewSha256) throw Error('Historical review integrity mismatch');
const manifest=saved.review.manifest;
if(manifest.workbookSha256!==MANUAL_WORKBOOK||scopeHash(manifest.members)!==SCOPE_SHA
  ||manifest.members.length!==95||manifest.noOps.length!==10) throw Error('Historical scope mismatch');
for(const suffix of ['1790344631532','1790227062822']){
  const bytes=await readFile(`attached_assets/Direct_debits_to_match_iConnect_to_GC_${suffix}.xlsx`);
  if(createHash('sha256').update(bytes).digest('hex')!==MANUAL_WORKBOOK) throw Error('Workbook changed');
}
const out=`exports/private-bnms-manual-verification-${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{mode:0o700});
const tables=['bnms_dd_manual_manifest','bnms_dd_manual_adoption','bnms_dd_manual_release',
  'bnms_manual_invoice_operations','bnms_dd_alpha_adoption','bnms_dd_beta_adoption','bnms_dd_pilot_adoption',
  'membership_billing_agreements','membership_payment_plans','member_membership_history',
  'gocardless_customers','gocardless_mandates'];
const c=await destinationConnection();
try{
  await c.connect();
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL statement_timeout='30s'");
  const identity=(await c.query('SELECT current_database() database, current_user db_user, transaction_timestamp() observed_at, current_setting(\'transaction_read_only\') read_only')).rows[0];
  const owner=(await c.query('SELECT id,name FROM tenant WHERE id=$1',[tenant])).rows;
  if(owner.length!==1||!/\bbnms\b|british nuclear medicine society/i.test(owner[0].name)) throw Error('Tenant identity mismatch');
  const evidence={destinationProject:'lvmzliemqnieeoruhkik',verifiedTls:true,identity,workbookSha256:MANUAL_WORKBOOK,tablePresence:{},rows:{}};
  for(const table of tables){
    const present=(await c.query('SELECT to_regclass($1) present',[`public.${table}`])).rows[0].present;
    evidence.tablePresence[table]=!!present;
    if(present) evidence.rows[table]=(await c.query(`SELECT to_jsonb(t) row FROM public.${table} t WHERE tenant_id=$1`,[tenant])).rows.map(r=>r.row);
  }
  evidence.manualCatalog=(await c.query(`SELECT p.proname,pg_get_functiondef(p.oid) definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'bnms_manual_%' ORDER BY p.proname`)).rows;
  const migrations=(await c.query("SELECT to_regclass('supabase_migrations.schema_migrations') present")).rows[0].present;
  evidence.migrationLedgerPresent=!!migrations;
  if(migrations) evidence.migrationEvidence=(await c.query(`SELECT to_jsonb(t) row FROM supabase_migrations.schema_migrations t
    WHERE to_jsonb(t)->>'version' IN ('20261121','20261122')
    OR to_jsonb(t)->>'name' IN ('bnms_dd_manual_95','bnms_manual_invoice_operations')`)).rows.map(r=>r.row);
  evidence.memberStates=(await c.query('SELECT id,tenant_id,status,membership_paused FROM member WHERE id=ANY($1::uuid[])',
    [manifest.members.map(m=>m.memberId)])).rows;
  await c.query('ROLLBACK');
  for(const table of tables.filter(t=>!t.includes('manual'))){
    if(!evidence.tablePresence[table]) throw Error('Required canonical/prior-cohort table absent');
  }
  const rows=table=>evidence.rows[table]||[];
  const memberIds=new Set(manifest.members.map(m=>m.memberId));
  const canonicalCounts=Object.fromEntries(['membership_billing_agreements','membership_payment_plans','member_membership_history']
    .map(t=>[t,rows(t).filter(r=>memberIds.has(r.member_id)).length]));
  const journals=rows('bnms_dd_manual_manifest').filter(r=>r.workbook_sha256===MANUAL_WORKBOOK);
  const adoptions=rows('bnms_dd_manual_adoption').filter(r=>memberIds.has(r.member_id));
  const releases=rows('bnms_dd_manual_release').filter(r=>memberIds.has(r.member_id));
  let exactLinked=0;
  if(journals.length===1&&hash(journals[0].evidence)===journals[0].sha256
    &&journals[0].evidence.members?.length===95
    &&journals[0].evidence.tenantId===tenant
    &&journals[0].evidence.workbookSha256===MANUAL_WORKBOOK
    &&scopeHash(journals[0].evidence.members)===SCOPE_SHA){
    for(const m of journals[0].evidence.members){
      const expected=canonicalRows(m,journals[0].sha256);
      const links=Object.entries(expected).every(([t,r])=>rows(t).some(actual=>actual.id===r.id
        &&actual.member_id===r.member_id&&actual.tenant_id===tenant
        &&Object.entries(r).filter(([k])=>['agreement_id','plan_id','history_id','billing_agreement_id','customer_id','mandate_id','manifest_sha256','evidence_sha256','gocardless_customer_id','gocardless_mandate_id'].includes(k)).every(([k,v])=>actual[k]===v)));
      if(links&&rows('gocardless_customers').some(r=>r.member_id===m.memberId&&r.gocardless_customer_id===m.customerId&&r.environment==='live')
        &&rows('gocardless_mandates').some(r=>r.gocardless_customer_id===m.customerId&&r.gocardless_mandate_id===m.mandateId&&r.environment==='live'))exactLinked++;
    }
  }
  const noOpsLinked=manifest.noOps.filter(m=>{
    const a=rows('bnms_dd_alpha_adoption').find(r=>r.id===m.adoptionId&&r.member_id===m.memberId&&r.customer_id===m.customerId);
    return a&&rows('membership_billing_agreements').some(r=>r.id===a.agreement_id&&r.member_id===m.memberId&&r.gocardless_customer_id===a.customer_id&&r.gocardless_mandate_id===a.mandate_id)
      &&rows('membership_payment_plans').some(r=>r.id===a.plan_id&&r.member_id===m.memberId&&r.billing_agreement_id===a.agreement_id)
      &&rows('member_membership_history').some(r=>r.id===a.history_id&&r.member_id===m.memberId&&r.billing_agreement_id===a.agreement_id);
  }).length;
  const classification=exactLinked===95&&adoptions.length===95&&releases.length===95?'fully_linked_requires_original_replay':
    !journals.length&&!adoptions.length&&!releases.length&&Object.values(canonicalCounts).every(n=>n===0)?'unapplied':'inconsistent_stop';
  const summary={destinationProject:evidence.destinationProject,observedAt:identity.observed_at,readOnly:identity.read_only,
    workbookSha256:MANUAL_WORKBOOK,classification,manualJournals:journals.length,manualAdoptions:adoptions.length,
    manualReleases:releases.length,exactLinked,canonicalCounts,noOpsLinked,
    membersFound:evidence.memberStates.length,tablePresence:evidence.tablePresence,
    manualFunctionCount:evidence.manualCatalog.length,migrationEvidenceCount:evidence.migrationEvidence?.length??null,
    priorCohortCounts:Object.fromEntries(['bnms_dd_alpha_adoption','bnms_dd_beta_adoption','bnms_dd_pilot_adoption'].map(t=>[t,rows(t).length])),
    evidenceSha256:hash(evidence),databaseWrites:0,providerRequests:0};
  await writeFile(`${out}/destination.json`,JSON.stringify(evidence,null,2),{mode:0o600,flag:'wx'});
  await writeFile(`${out}/summary.json`,JSON.stringify(summary,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({out,...summary},null,2));
}catch(error){
  await c.query('ROLLBACK').catch(()=>{});
  console.error(`Read-only audit stopped (${error.code||'verification failure'}); no absence inferred.`);
  process.exitCode=1;
}finally{await c.end();}