// No provider requests. Default private dry-run; apply is a future parent-reviewed operation.
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash,sqlHash} from './bnms-dd-beta-invoices.mjs';
import {destinationConnection} from './run-bnms-dd-pilot-history.mjs';
import {prepareManualManifest,assertExecutableManifest,assertFreshManualProvider,canonicalRows,MIGRATION,INVOICE_MIGRATION} from './bnms-dd-manual-cohort.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {MANUAL_TENANT as TENANT,MANUAL_WORKBOOK} from '../api/_lib/bnmsManualCohort.js';
import {MANUAL_RUNTIME_PATHS,manualRuntimeHashes,assertManualRuntimeProof} from './bnms-manual-runtime-proof.mjs';
const allowedTables=new Set(['gocardless_customers','gocardless_mandates','membership_billing_agreements',
 'membership_payment_plans','member_membership_history','bnms_dd_manual_manifest','bnms_dd_manual_adoption','bnms_dd_manual_release']);
export async function insert(c,table,row){
 if(!allowedTables.has(table)||!Object.keys(row).length||Object.keys(row).some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))throw Error('Unsafe canonical insert');
 const keys=Object.keys(row);
 await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
const rows=async(c,table,where,args)=>(await c.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE ${where}`,args)).rows.map(r=>r.row);

export async function applyManualManifest(c,manifest,{schemas,freshProvider,deploymentProof,now=()=>new Date(),onProgress=()=>{}}){
 let stage='runtime_review';
 const started=performance.now();
 const progress=(name,completed)=>{stage=name;onProgress({stage:name,...(completed===undefined?{}:{completed,total:95}),
  observedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started)});};
 assertManualRuntimeProof(deploymentProof,await manualRuntimeHashes(),now());
 if(hash(manifest.runtimeDeployment||null)!==hash(deploymentProof))throw Error('Reviewed manifest deployment proof differs');
 const manifestSha=hash(manifest);
 await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 try{
  await c.query("SET LOCAL application_name='bnms-manual-95-reviewed-release'");
  await c.query("SET LOCAL lock_timeout='15s'");
  await c.query("SET LOCAL statement_timeout='60s'");
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  progress('journal_lock');
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('bnms-manual-95:ddbc1a3d',0))");
  const exists=(await c.query("SELECT to_regclass('public.bnms_dd_manual_manifest') present")).rows[0].present;
  if(exists){
   const prior=await rows(c,'bnms_dd_manual_manifest','workbook_sha256=$1',[MANUAL_WORKBOOK]);
   if(prior.length){
    if(prior.length!==1||prior[0].sha256!==manifestSha||hash(prior[0].evidence)!==manifestSha)throw Error('Existing immutable manifest differs');
    const a=await rows(c,'bnms_dd_manual_adoption','manifest_sha256=$1',[manifestSha]);
    const r=await rows(c,'bnms_dd_manual_release','manifest_sha256=$1',[manifestSha]);
    if(a.length!==95||r.length!==95||a.some(x=>!manifest.members.some(m=>m.ids.adoption===x.id
      &&m.ids.agreement===x.agreement_id&&m.ids.plan===x.plan_id&&m.ids.history===x.history_id&&hash(m)===x.evidence_sha256)))throw Error('Immutable replay journal incomplete');
    await c.query('ROLLBACK');return {mode:'replay',writes:0,manifestSha256:manifestSha};
   }
  }
  assertExecutableManifest(manifest,now());
  if(!freshProvider)throw Error('Apply requires freshly reacquired provider evidence');
  assertFreshManualProvider(manifest,freshProvider);
  // Concurrent generic imports cannot insert a duplicate between CAS and commit.
  progress('canonical_table_locks');
  await c.query('LOCK TABLE member,membership_billing_agreements,membership_payment_plans,member_membership_history,gocardless_customers,gocardless_mandates IN SHARE ROW EXCLUSIVE MODE');
  await c.query('LOCK TABLE membership_tier_config,membership_tier_vat_override,member_preference_value,preference_field IN SHARE MODE');
  progress('live_cas',0);
  let checked=0;
  for(const m of manifest.members){
   const member=await rows(c,'member','id=$1 AND tenant_id=$2',[m.memberId,TENANT]);
   if(member.length!==1||hash(member[0])!==hash(m.owner))throw Error('Live member drift');
   const configs=await rows(c,'membership_tier_config',
    "tenant_id=$1 AND is_active=true AND dd_enabled=true AND structure_scope_type='member' AND lower(trim(structure_match_value))=lower(trim($2)) AND (effective_from IS NULL OR effective_from<=$3) AND (effective_to IS NULL OR effective_to>=$3)",
    [TENANT,m.structure.structure_match_value,'2026-10-01']);
   if(configs.length!==1||hash(configs[0])!==hash(m.structure))throw Error('Live applicable price/terms drift');
   const pref=(await c.query(`SELECT v.member_id,f.id AS field_id,f.name,v.value FROM member_preference_value v
    JOIN preference_field f ON f.id=v.field_id WHERE v.member_id=$1 AND f.tenant_id=$2 AND f.entity_scope='member' AND f.is_active=true`,
    [m.memberId,TENANT])).rows;
   const sort=a=>[...a].sort((x,y)=>x.field_id.localeCompare(y.field_id));
   if(hash(sort(pref))!==hash(sort(m.preferences)))throw Error('Live member class/preference drift');
   for(const table of ['membership_billing_agreements','membership_payment_plans','member_membership_history']){
    if((await rows(c,table,'member_id=$1',[m.memberId])).length)throw Error('Existing canonical member collision');
   }
   if((await c.query(`SELECT id FROM membership_billing_agreements WHERE gocardless_customer_id=$1 OR gocardless_mandate_id=$2
     UNION ALL SELECT id FROM membership_payment_plans WHERE gocardless_mandate_id=$2
     UNION ALL SELECT id FROM gocardless_payments WHERE gocardless_mandate_id=$2`,[m.customerId,m.mandateId])).rowCount)throw Error('Canonical provider identity collision');
   const customers=await rows(c,'gocardless_customers','gocardless_customer_id=$1 OR member_id=$2',[m.customerId,m.memberId]);
   const mandates=await rows(c,'gocardless_mandates','gocardless_mandate_id=$1 OR gocardless_customer_id=$2',[m.mandateId,m.customerId]);
   if(customers.length>1||mandates.length>1||customers.some(x=>x.tenant_id!==TENANT||x.member_id!==m.memberId||x.organization_id||x.environment!=='live'||x.gocardless_customer_id!==m.customerId)
    ||mandates.some(x=>x.tenant_id!==TENANT||x.environment!=='live'||x.status!=='active'||x.gocardless_mandate_id!==m.mandateId||x.gocardless_customer_id!==m.customerId))throw Error('Live provider mirror ownership collision');
   checked++;
   if(checked%10===0||checked===95)progress('live_cas',checked);
  }
  if((await c.query('SELECT id FROM membership_tier_vat_override WHERE tenant_id=$1',[TENANT])).rowCount)throw Error('Live VAT override drift');
  progress('atomic_schema_install');
  if(!exists){for(const sql of schemas)await c.query(sql);}
  else throw Error('Unpopulated schema must be independently catalog-verified before reuse; automatic reuse prohibited');
  await insert(c,'bnms_dd_manual_manifest',{sha256:manifestSha,tenant_id:TENANT,workbook_sha256:MANUAL_WORKBOOK,evidence:manifest});
  let writes=1;
  progress('canonical_inserts',0);
  let inserted=0;
  for(const m of manifest.members){
   const customer=await rows(c,'gocardless_customers','gocardless_customer_id=$1',[m.customerId]);
   const mandate=await rows(c,'gocardless_mandates','gocardless_mandate_id=$1',[m.mandateId]);
   if(!customer.length){await insert(c,'gocardless_customers',{tenant_id:TENANT,member_id:m.memberId,gocardless_customer_id:m.customerId,
    email:m.customer.email,environment:'live',metadata:{source:'bnms_manual_95',workbook_sha256:MANUAL_WORKBOOK}});writes++;}
   if(!mandate.length){await insert(c,'gocardless_mandates',{tenant_id:TENANT,gocardless_customer_id:m.customerId,gocardless_mandate_id:m.mandateId,
    scheme:'bacs',status:'active',environment:'live',metadata:{source:'bnms_manual_95',workbook_sha256:MANUAL_WORKBOOK}});writes++;}
   for(const [table,row] of Object.entries(canonicalRows(m,manifestSha))){await insert(c,table,row);writes++;}
   inserted++;
   if(inserted%10===0||inserted===95)progress('canonical_inserts',inserted);
  }
  progress('precommit_freshness');
  const clock=(await c.query('SELECT clock_timestamp() now')).rows[0].now;
  assertExecutableManifest(manifest,new Date(clock));
  if(new Date(clock).getTime()-Date.parse(freshProvider.observedAt)>15*60*1000)throw Error('Fresh provider stage expired before commit');
  progress('deferred_constraints');
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  progress('commit');
  await c.query('COMMIT');
  progress('committed');
  return {mode:'manual_95_atomic_adoption_release',writes,manifestSha256:manifestSha,monthlyTotalMinor:87174,freshProviderSha256:hash(freshProvider)};
 }catch(error){error.manualStage=stage;await c.query('ROLLBACK');progress('rolled_back');throw error;}
}

export async function main(args=process.argv.slice(2)){
 const directoryArgs=args.filter(a=>a.startsWith('--evidence-dir='));
 if(directoryArgs.length>1||(directoryArgs.length&&!/^--evidence-dir=exports\/private-bnms-manual-phase2-refresh-[a-zA-Z0-9-]+$/.test(directoryArgs[0])))
  throw Error('Exact private refresh directory required');
 const dir=directoryArgs[0]?.slice('--evidence-dir='.length)||'exports/private-bnms-manual-phase2';
 args=args.filter(a=>!a.startsWith('--evidence-dir='));
 const load=async p=>JSON.parse(await readFile(p,'utf8'));
 if(args.length&&!(/^--reviewed-apply=[a-f0-9]{64}$/.test(args[0])&&args.length===1))throw Error('Only default dry-run or exact --reviewed-apply SHA supported');
 await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
 const schemas=await Promise.all([MIGRATION,INVOICE_MIGRATION].map(p=>readFile(p,'utf8')));
 const schemaHashes=schemas.map(sqlHash);
 const runtimePaths=[...MANUAL_RUNTIME_PATHS,'scripts/bnms-manual-runtime-proof.mjs',
  'scripts/bnms-dd-manual-cohort.mjs','scripts/run-bnms-dd-manual-cohort.mjs',
  'scripts/bnms-manual-phase1-readonly.mjs'];
 const runtimeHashes=Object.fromEntries(await Promise.all(runtimePaths.map(async p=>[p,sqlHash(await readFile(p))])));
 if(!args.length){
  let deploymentProof=null;
  try{deploymentProof=await load(`${dir}/runtime-deployment-proof.json`);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const manifest=prepareManualManifest({
   sheet:await load('exports/private-bnms-manual-phase1/spreadsheet.json'),
   snapshot:(await load(`${directoryArgs.length?dir:'exports/private-bnms-manual-phase2-refresh-20260924-0615'}/destination.json`)).snapshot,
   provider:await load(`${directoryArgs.length?dir:'exports/private-bnms-manual-phase2-refresh-20260924-0615'}/gocardless.json`),
   xero:await load(`${dir}/xero-exact-contact-bindings.json`),
   cachedAccounting:await load('exports/private-bnms-alpha-20260920-verified/accounting-evidence.json')});
  let deploymentBlocker=null;
  try{assertManualRuntimeProof(deploymentProof,await manualRuntimeHashes());}
  catch(error){deploymentBlocker=error.message;manifest.blockers.push(deploymentBlocker);}
  manifest.runtimeDeployment=deploymentProof;
  const requiredRuntimeSourceHashes=await manualRuntimeHashes();
  const review={manifest,deploymentProof,deploymentBlocker,requiredRuntimeSourceHashes,
   requiredManualRuntimeSha256:hash(requiredRuntimeSourceHashes),schemaHashes,runtimeHashes,scope:'exact_separate_95',liveWrites:0};
  const reviewSha256=hash(review);
  await writeFile(`${dir}/dry-run.json`,JSON.stringify({reviewSha256,review},null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({mode:manifest.blockers.length?'blocked_dry_run':'review_ready',reviewSha256,
   members:95,alphaNoOps:10,monthlyTotalMinor:87174,blockers:manifest.blockers.length,writes:0}));
  return;
 }
 const saved=await load(`${dir}/dry-run.json`);
 if(hash(saved.review)!==args[0].split('=')[1]||saved.reviewSha256!==hash(saved.review)||hash(schemaHashes)!==hash(saved.review.schemaHashes)
   ||hash(runtimeHashes)!==hash(saved.review.runtimeHashes))throw Error('Parent-reviewed manifest, runtime or schema hash differs');
 // Reject absent/old/unknown deployment before any connection or provider read.
 assertManualRuntimeProof(saved.review.deploymentProof,await manualRuntimeHashes());
 const c=await destinationConnection();
 try{
  await c.connect();
  // Replay does not call any provider; an existing journal is verified inside the transaction.
  const installed=(await c.query("SELECT to_regclass('public.bnms_dd_manual_manifest') present")).rows[0].present;
  let freshProvider;
  if(!installed){
   assertExecutableManifest(saved.review.manifest);
   destinationTarget(process.env);
   const {createClient}=await import('@supabase/supabase-js');
   const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
   const {getTenantGocardlessCredentials}=await import('../api/_lib/gocardlessCredentials.js');
   const {readFreshExceptionGoCardless}=await import('./bnms-dd-alpha-operator-exception.mjs');
   freshProvider=await readFreshExceptionGoCardless(await getTenantGocardlessCredentials(TENANT,{db}));
   await writeFile(`${dir}/apply-provider.json`,JSON.stringify(freshProvider,null,2),{mode:0o600,flag:'wx'});
  }
  const result=await applyManualManifest(c,saved.review.manifest,{schemas,freshProvider,deploymentProof:saved.review.deploymentProof,
   onProgress:event=>console.log(JSON.stringify({mode:'progress',...event}))});
  await writeFile(`${dir}/applied.json`,JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(result));
 }finally{await c.end();}
}
export function safeManualFailure(error){
 const safeMessages=new Set(['Live member drift','Live applicable price/terms drift',
  'Unsafe canonical insert',
  'Live member class/preference drift','Live provider mirror ownership collision','Live VAT override drift',
  'Fresh GET evidence required before release; no timestamps may be renewed',
  'Fresh provider stage expired before commit','Parent-reviewed manifest, runtime or schema hash differs']);
 const stages=new Set(['runtime_review','journal_lock','canonical_table_locks','live_cas','atomic_schema_install',
  'canonical_inserts','precommit_freshness','deferred_constraints','commit','committed']);
 return {stage:stages.has(error?.manualStage)?error.manualStage:'manual_cohort_guarded_execution',code:/^[0-9A-Z]{5}$/.test(error?.code||'')?error.code:'GUARD_STOP',
  reason:safeMessages.has(error?.message)?error.message:'Restricted failure; inspect reviewed evidence without replaying apply'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(error=>{console.error(JSON.stringify(safeManualFailure(error)));process.exitCode=1;});