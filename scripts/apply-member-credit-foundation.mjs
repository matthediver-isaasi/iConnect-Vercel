import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {connectDestination,PROJECT} from './annual-meeting-destination.mjs';

// Authorized DEST-only schema changes. Never executes a membership, voucher,
// provider payment or refund operation. Default is a transactional rehearsal.
const apply=process.argv.includes('--apply');
const redemption=process.argv.includes('--redemption');
const variable=process.argv.includes('--variable-scope');
const returnGuard=process.argv.includes('--return-guard');
const unchangedPrice=process.argv.includes('--unchanged-price');
const prepaidCarry=process.argv.includes('--prepaid-carry');
const protocol=process.argv.includes('--credit-protocol');
const files=protocol?['202612310040_member_credit_protocol.sql']:prepaidCarry?['202612310039_member_monthly_prepaid_cash_carry.sql']:unchangedPrice?['202612310038_member_monthly_unchanged_price.sql']:returnGuard?['202612310036_member_credit_incomplete_funding_returns.sql',
 '202612310037_member_credit_funding_retries.sql']:variable?['202612310033_member_credit_variable_reservation_scope.sql',
 '202612310034_member_credit_unused_release.sql','202612310035_member_credit_provenance.sql']:redemption?['202612310030_member_credit_redemption_evidence.sql',
 '202612310031_member_credit_return_verification.sql','202612310032_member_credit_funding_claims.sql']:
 ['202612310027_member_credit_backing_claim.sql','202612310029_member_credit_issuance.sql'];
const db=await connectDestination();
try {
 await db.query('BEGIN');
 await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('member-credit-foundation-migrations',0))");
 for(const file of files){
  const sql=readFileSync(`supabase/migrations/${file}`,'utf8');
  if((sql.match(/^BEGIN;$/gm)||[]).length!==1||(sql.match(/^COMMIT;$/gm)||[]).length!==1)
   throw new Error(`Unexpected transaction envelope: ${file}`);
  await db.query(sql.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
  console.log(JSON.stringify({file,sha256:createHash('sha256').update(sql).digest('hex')}));
 }
 const checks=await db.query(`
  SELECT c.relname,c.relrowsecurity,
   has_table_privilege('anon',c.oid,'SELECT') anonymous_read,
   has_table_privilege('authenticated',c.oid,'SELECT') authenticated_read,
   has_table_privilege('service_role',c.oid,'INSERT') service_insert,
   has_table_privilege('service_role',c.oid,'UPDATE') service_update,
   has_table_privilege('service_role',c.oid,'DELETE') service_delete
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[])`,
  [['member_credit_backing_claim','member_membership_credit','member_credit_expiry_review',
   ...(redemption?['member_credit_redemption','member_credit_funding_claim']:[])]]);
 if(checks.rowCount!==(redemption?5:3)||checks.rows.some(r=>!r.relrowsecurity||r.anonymous_read||r.authenticated_read
   ||r.service_insert||r.service_update||r.service_delete))throw new Error('Private credit table permissions failed');
 const functions=await db.query(`
  SELECT proname,has_function_privilege('anon',oid,'EXECUTE') anonymous_execute,
   has_function_privilege('authenticated',oid,'EXECUTE') authenticated_execute,
   has_function_privilege('service_role',oid,'EXECUTE') service_execute
  FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
   'claim_member_credit_backing','apply_member_amendment_before_credit',
   'voucher_admin_write_before_member_credit','voucher_credit_reserve_before_member_credit',
   'member_credit_funding_proofs','review_member_credit_expiry','list_member_credit_expiry_reviews',
   'member_credit_execution_available')
   AND (proname<>'member_credit_execution_available' OR pronargs=0)`);
 if(functions.rowCount!==8||functions.rows.some(r=>r.anonymous_execute||r.authenticated_execute
   ||(r.proname.includes('before_credit')||r.proname.includes('before_member_credit')
    ?r.service_execute:!r.service_execute)))throw new Error('Credit function permissions failed');
 if(redemption){
  const receipts=await db.query(`SELECT proname,
   has_function_privilege('anon',oid,'EXECUTE') anonymous_execute,
   has_function_privilege('authenticated',oid,'EXECUTE') authenticated_execute,
   has_function_privilege('service_role',oid,'EXECUTE') service_execute
   FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'record_member_credit_redemption','claim_member_credit_funding',
    'member_credit_return_context','apply_verified_member_credit_return',
    'voucher_credit_refund_before_member_credit','voucher_credit_transition_before_member_credit')`);
  if(receipts.rowCount!==6||receipts.rows.some(r=>r.anonymous_execute||r.authenticated_execute
    ||(r.proname.includes('before_member_credit')?r.service_execute:!r.service_execute)))
   throw new Error('Redemption/return function permissions failed');
 }
 if((await db.query('SELECT public.member_credit_execution_available() available')).rows[0].available!==false)
  throw new Error('Unfinished execution must remain disabled');
 if(variable){
  const r=(await db.query(`SELECT
   has_function_privilege('anon','public.member_credit_membership_purchase_scope(uuid,uuid,text)','EXECUTE') a,
   has_function_privilege('authenticated','public.member_credit_membership_purchase_scope(uuid,uuid,text)','EXECUTE') b,
   has_function_privilege('service_role','public.member_credit_membership_purchase_scope(uuid,uuid,text)','EXECUTE') c`)).rows[0];
  if(r.a||r.b||r.c)throw new Error('Internal variable scope helper is exposed');
  const old=(await db.query(`SELECT
   has_function_privilege('anon','public.member_credit_funding_proofs_before_provenance(uuid,uuid[])','EXECUTE') a,
   has_function_privilege('authenticated','public.member_credit_funding_proofs_before_provenance(uuid,uuid[])','EXECUTE') b,
   has_function_privilege('service_role','public.member_credit_funding_proofs_before_provenance(uuid,uuid[])','EXECUTE') c`)).rows[0];
  if(old.a||old.b||old.c)throw new Error('Internal provenance reader is exposed');
 }
 if(returnGuard){
  const secure=(await db.query(`SELECT
   (SELECT relrowsecurity FROM pg_class WHERE oid='public.member_credit_funding_retry'::regclass) rls,
   has_table_privilege('anon','public.member_credit_funding_retry','SELECT') anon_read,
   has_table_privilege('authenticated','public.member_credit_funding_retry','SELECT') auth_read,
   has_table_privilege('service_role','public.member_credit_funding_retry','INSERT,UPDATE,DELETE') direct_write,
   has_function_privilege('service_role','public.claim_member_credit_funding_before_retry(uuid,uuid,jsonb)','EXECUTE') bypass,
   has_function_privilege('anon','public.record_member_credit_funding_throttle(uuid,uuid,text,text,integer)','EXECUTE') anon_execute,
   has_function_privilege('authenticated','public.record_member_credit_funding_throttle(uuid,uuid,text,text,integer)','EXECUTE') auth_execute,
   has_function_privilege('service_role','public.record_member_credit_funding_throttle(uuid,uuid,text,text,integer)','EXECUTE') service_execute`)).rows[0];
  if(!secure.rls||secure.anon_read||secure.auth_read||secure.direct_write||secure.bypass
    ||secure.anon_execute||secure.auth_execute||!secure.service_execute)throw new Error('Funding retry protections failed');
 }
 if(unchangedPrice||prepaidCarry){
  for(const role of ['anon','authenticated','service_role']){
   const r=await db.query('SELECT has_function_privilege($1,$2,$3) allowed',
    [role,prepaidCarry?'public.member_monthly_prepaid_cash_carry(jsonb,jsonb)':'public.member_monthly_unchanged_price_carry(jsonb,jsonb)','EXECUTE']);
   if(r.rows[0].allowed)throw new Error('Internal unchanged-price predicate is exposed');
  }
 }
 if(protocol){
  const ready=(await db.query(`SELECT
    member_credit_execution_available('liability-backed-member-credit-v1') supported,
    member_credit_execution_available('unknown') unsupported,
    member_credit_execution_available() legacy`)).rows[0];
  if(!ready.supported||ready.unsupported||ready.legacy)throw new Error('Credit protocol isolation failed');
  for(const signature of ['member_credit_execution_available(text)',
    'begin_member_credit_execution(uuid,uuid,uuid,uuid,text,text,text)']){
   for(const role of ['anon','authenticated','service_role']){
    const r=await db.query('SELECT has_function_privilege($1,$2,$3) allowed',[role,`public.${signature}`,'EXECUTE']);
    if(r.rows[0].allowed!==(role==='service_role'))throw new Error('Credit protocol access protection failed');
   }
  }
 }
 await db.query("NOTIFY pgrst, 'reload schema'");
 await db.query(apply?'COMMIT':'ROLLBACK');
 console.log(JSON.stringify({target:PROJECT,applied:apply,tables:checks.rows,functions:functions.rows,
  legacyCreditExecutionEnabled:false,protocolCreditExecutionEnabled:protocol?true:null}));
}catch(error){
 await db.query('ROLLBACK');
 console.error('Migration rolled back:',error.message);
 process.exitCode=1;
}finally{await db.end();}
