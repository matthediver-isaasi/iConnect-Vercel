import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {connectDestination,PROJECT} from './annual-meeting-destination.mjs';

// Private storage only. Does not create cancellation requests, stop providers,
// enable public routes, issue credit, send mail or execute financial operations.
const apply=process.argv.includes('--apply'),verifyOnly=process.argv.includes('--verify');
const worker=process.argv.includes('--worker');
const forms=process.argv.includes('--forms')||worker;
const finance=process.argv.includes('--finance')||forms;
if(apply&&verifyOnly)throw Error('Choose application or verification, not both');
const pinned=[
 ['202612310047_member_cancellation_journal.sql','fc3e713b03aea311b148927a47d64ffb7a745ca272dc98713973357eb4a0d258'],
 ['202612310048_member_cancellation_access.sql','f3fa0b13a6342af2bddade1a20a0d70f4158266414ddf2c92f8e3d7bcb19d89c'],
 ['202612310049_member_cancellation_admission.sql','306f950af922e84024db59ccde0202aeea40b9ebfd71d4325d99b5bbec4a5e05'],
 ['202612310050_member_cancellation_recovery.sql','9c2a4b4fc9e9f936f8d32e4b125ca5cc577e5fe197ecbc9e648b51d30bf947f2'],
];
if(finance)pinned.push(
 ['202612310051_member_cancellation_finance.sql','5437b4a98612c9ec9ed9262324514ec67adb726d00a17f70c9a587370c3cad2d'],
 ['202612310052_member_cancellation_credit.sql','d5c69e6e244d8d1485472ff46d46154f880fd2b2de613bd1fe8a92f1ce133171'],
);
if(forms)pinned.push(['202612310053_membership_change_forms.sql',
 '7ecd1c9ab6fe354c966f625adbe8033b5331fdcb4e9c871aaf97dbf80a05f1d5']);
if(worker)pinned.push(['202612310054_member_cancellation_finance_worker.sql',
 'd243f703ea98c41c770683180aea05f3d4f67fe4c3b1b3434d65fd290b6ca426']);
const sources=pinned.map(([file,hash])=>{
 const sql=readFileSync(`supabase/migrations/${file}`,'utf8');
 if(createHash('sha256').update(sql).digest('hex')!==hash)throw Error(`Migration differs from reviewed hash: ${file}`);
 if((sql.match(/^BEGIN;$/gm)||[]).length!==1||(sql.match(/^COMMIT;$/gm)||[]).length!==1)throw Error('Unexpected transaction envelope');
 return {file,hash,sql};
});
const tables=['member_cancellation_request','member_cancellation_provider_stop','member_cancellation_event',
 'member_cancellation_purchase_candidate','member_cancellation_job'];
if(finance)tables.push('member_cancellation_finance','member_cancellation_finance_step',
 'member_cancellation_finance_application','member_credit_backing_claim','member_membership_credit');
if(forms)tables.push('membership_change_form','membership_change_form_history');
const serviceFunctions=new Set(['claim_member_cancellation_provider_stop','record_member_cancellation_provider_stop',
 'apply_member_cancellation_access','begin_member_cancellation','claim_member_cancellation_jobs','finish_member_cancellation_job']);
if(finance)for(const name of ['prepare_member_cancellation_finance','claim_member_cancellation_finance_step',
 'observe_member_cancellation_finance_step','record_member_cancellation_balance','member_credit_funding_proofs'])serviceFunctions.add(name);
if(forms)serviceFunctions.add('save_membership_change_form');
if(worker)serviceFunctions.add('claim_member_cancellation_finance_jobs');
const functions=sources.flatMap(({sql})=>[...sql.matchAll(/CREATE FUNCTION public\.(\w+)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g)]
 .map(m=>({name:m[1],body:m[2].trim()})));
if(functions.length!==(worker?18:forms?17:finance?16:10))throw Error('Cancellation function contract changed');
const db=await connectDestination();
try{
 await db.query(verifyOnly?'BEGIN READ ONLY':'BEGIN');
 await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
 if(!verifyOnly){
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('member-credit-foundation-migrations',0))");
  for(const {sql} of worker?sources.slice(7):forms?sources.slice(6):finance?sources.slice(4):sources)await db.query(sql.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
 }
 const tableChecks=(await db.query(`SELECT c.relname,c.relrowsecurity,
  has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon_access,
  has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') auth_access,
  has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE') direct_write,
  has_table_privilege('service_role',c.oid,'SELECT') service_read
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1)`,[tables])).rows;
 if(tableChecks.length!==tables.length||tableChecks.some(r=>!r.relrowsecurity||r.anon_access||r.auth_access||r.direct_write||!r.service_read)){
  throw Error('Cancellation table access protections failed');
 }
 const checks=(await db.query(`SELECT proname,prosrc,
  has_function_privilege('anon',oid,'EXECUTE') anon_execute,
  has_function_privilege('authenticated',oid,'EXECUTE') auth_execute,
  has_function_privilege('service_role',oid,'EXECUTE') service_execute,
  prosecdef,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1)`,
 [functions.map(f=>f.name)])).rows;
 if(checks.length!==functions.length||checks.some(r=>{
  const expected=functions.find(f=>f.name===r.proname);
  return !expected||r.prosrc.trim()!==expected.body||r.anon_execute||r.auth_execute
   ||r.service_execute!==serviceFunctions.has(r.proname)||!r.prosecdef
   ||!r.proconfig?.some(v=>v==='search_path=pg_catalog, public');
 }))throw Error('Cancellation function bodies or access protections failed');
 const flags=(await db.query(`SELECT count(*)::integer AS cancelled_members FROM member WHERE membership_cancelled=true`)).rows[0];
 if(!verifyOnly&&!forms&&flags.cancelled_members!==0)throw Error('A storage migration must not cancel existing members');
 await db.query(apply?'COMMIT':'ROLLBACK');
 console.log(JSON.stringify({target:PROJECT,applied:apply,verified:verifyOnly,
  migrations:sources.map(({file,hash})=>({file,sha256:hash})),
  privateTablesVerified:tableChecks.length,functionsVerified:checks.length,...flags,publicCancellationEnabled:false}));
}catch(error){
 await db.query('ROLLBACK');
 console.error('Cancellation migration rolled back:',error.message);process.exitCode=1;
}finally{await db.end();}
