import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
export const migration='202701050001_public_po_booker_correction.sql';
export async function main(args=process.argv.slice(2)){
 const selected=args.includes('--member-guard')?'202701050002_public_po_corrected_member_guard.sql':migration;
 args=args.filter(a=>a!=='--member-guard');
 const sql=await readFile(new URL(`../supabase/migrations/${selected}`,import.meta.url),'utf8');
 const sha256=createHash('sha256').update(sql).digest('hex');
 if(!args.length){console.log(JSON.stringify({migration:selected,sha256,writes:false}));return;}
 if(args.length!==2||!args.includes('--apply')||!args.includes(`--review-sha256=${sha256}`))
  throw Error('Explicit apply and matching reviewed hash required');
 const target=destinationTarget(process.env);
 const response=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
 if(!response.ok)throw Error('Unable to load destination TLS certificate');
 const client=new pg.Client({connectionString:target.toString(),
  ssl:{rejectUnauthorized:true,ca:await response.text(),servername:target.hostname}});
 try{
  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query(sql.replace(/^BEGIN;/,'').replace(/COMMIT;\s*$/,''));
  const {rows}=await client.query(`SELECT
   has_table_privilege('authenticated','public.public_po_booker_correction','SELECT') AS browser_read,
   has_table_privilege('service_role','public.public_po_booker_correction','INSERT') AS direct_insert,
   has_column_privilege('service_role','public.public_invoice_po_billing','billing_contact','UPDATE') AS contact_update,
   has_function_privilege('authenticated','public.correct_public_po_booker(uuid,text,text,uuid,text,text,text,jsonb)','EXECUTE') AS browser_execute`);
  if(rows.some(r=>Object.values(r).some(Boolean)))throw Error('Correction authority grants are unsafe');
  await client.query('COMMIT');
  console.log(JSON.stringify({applied:true,migration:selected,sha256,target:'verified DEST',businessRowsChanged:0}));
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(()=>{console.error('Migration failed; no success confirmed. Review target, grants and SQL contract.');process.exitCode=1;});
