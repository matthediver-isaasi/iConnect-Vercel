// Private, read-only evidence capture. No release/adoption or Xero calls.
import { mkdir, chmod, writeFile, readFile } from 'node:fs/promises';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const out='exports/private-bnms-manual-phase1';
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
  for(const table of ['bnms_dd_alpha_adoption','bnms_dd_pilot_adoption','membership_group','gocardless_collection_reservations']){
    const exists=(await c.query('SELECT to_regclass($1) present',[`public.${table}`])).rows[0].present;
    if(exists) snapshot[table]=(await c.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1`,[TENANT_ID])).rows.map(r=>r.row);
  }
  snapshot.schema=(await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (table_name LIKE '%consent%' OR table_name LIKE '%import%' OR table_name LIKE '%recognition%' OR table_name LIKE '%membership%')")).rows;
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