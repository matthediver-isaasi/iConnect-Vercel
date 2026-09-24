// Private, read-only evidence capture. No release/adoption or Xero calls.
import { mkdir, chmod, writeFile, readFile } from 'node:fs/promises';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
if(process.argv.slice(2).some(a=>a!=='--phase2')||process.argv.length>3)throw Error('Only --phase2 is supported; no apply mode');
const out=process.argv.includes('--phase2')?'exports/private-bnms-manual-phase2':'exports/private-bnms-manual-phase1';
await mkdir(out,{recursive:true,mode:0o700});await chmod(out,0o700);
const save=async(name,data)=>writeFile(`${out}/${name}.json`,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});
const {destinationConnection}=await import('./run-bnms-dd-pilot-history.mjs');
const {snapshotDestination}=await import('./bnms-dd-alpha-review.mjs');
const {TENANT_ID}=await import('./bnms-dd-pilot.mjs');
const {readFreshExceptionGoCardless}=await import('./bnms-dd-alpha-operator-exception.mjs');
const {getTenantGocardlessCredentials}=await import('../api/_lib/gocardlessCredentials.js');
const {createClient}=await import('@supabase/supabase-js');
const c=await destinationConnection();
try {
  await c.connect();
  const snapshot=await snapshotDestination(c);
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  for(const table of ['bnms_dd_alpha_adoption','bnms_dd_pilot_adoption','membership_group','gocardless_collection_reservations','gocardless_customers','gocardless_mandates','membership_tier_vat_override']){
    const exists=(await c.query('SELECT to_regclass($1) present',[`public.${table}`])).rows[0].present;
    if(exists) snapshot[table]=(await c.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1`,[TENANT_ID])).rows.map(r=>r.row);
  }
  snapshot.schema=(await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (table_name LIKE '%consent%' OR table_name LIKE '%import%' OR table_name LIKE '%recognition%' OR table_name LIKE '%membership%')")).rows;
  snapshot.accountingSettings=(await c.query("SELECT setting_key,setting_value FROM system_settings WHERE tenant_id=$1 AND setting_key IN ('xero_gocardless_bank_account_code','membership_nominal_ledger','xero_sales_account_code')",[TENANT_ID])).rows;
  snapshot.accountingProvider=(await c.query('SELECT active_provider FROM tenant_accounting_settings WHERE tenant_id=$1',[TENANT_ID])).rows;
  snapshot.contactSchema=(await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (column_name LIKE '%contact_id%' OR column_name='xero_contact_id')")).rows;
  await c.query('ROLLBACK');
  await save('destination',{observedAt:new Date().toISOString(),snapshot});
  const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const credentials=await getTenantGocardlessCredentials(TENANT_ID,{db});
  const provider=await readFreshExceptionGoCardless(credentials);
  await save('gocardless',provider);
  console.log(JSON.stringify({readOnly:true,xeroRequests:0,providerRequests:provider.requests,providerCounts:Object.fromEntries(Object.entries(provider.discovery).map(([k,v])=>[k,v.length]))}));
} catch(e) {
  await save('error',{message:e.message});
  console.error('Read-only preflight stopped; see private error artifact.');process.exitCode=1;
} finally {await c.end();}