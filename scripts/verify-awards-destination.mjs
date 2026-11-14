// DEST-only catalog preflight / rollback rehearsal. No commit or fixture-data
// mode: customer records and providers are never part of this runner.
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {connectDestination} from './lib/member-index-destination.mjs';
const args=process.argv.slice(2);
if(args.some(a=>a!=='--rehearse'))throw new Error('Only --rehearse is supported');
const names=(await readdir('supabase/migrations')).filter(n=>/^2027012200\d\d_(?:awards|assessment)_.*\.sql$/.test(n)).sort();
const files=await Promise.all(names.map(async name=>({name,sql:await readFile(`supabase/migrations/${name}`,'utf8')})));
const digest=createHash('sha256').update(files.map(f=>`${f.name}\n${f.sql}`).join('\n')).digest('hex');
const db=await connectDestination();
try{
  await db.query('BEGIN READ ONLY');
  const required=['tenant','member','organization','organization_contact','form','form_submission','event','complex_event'];
  const found=await db.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])`,[required]);
  if(found.rows.length!==required.length)throw new Error('Destination canonical tables are missing');
  const existing=await db.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND (c.relname LIKE 'awards\\_%' ESCAPE '\\' OR c.relname LIKE 'assessment\\_%' ESCAPE '\\')`);
  await db.query('ROLLBACK');
  console.log(JSON.stringify({target:'verified DEST',canonicalTablesVerified:found.rows.length,migrationFiles:files.length,digest,existingAwardRelations:existing.rows.map(r=>r.relname)}));
  if(!args.includes('--rehearse'))process.exitCode=0;
  else{
    if(existing.rows.length)throw new Error('Existing awards objects require migration-history reconciliation; no rehearsal attempted');
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='750ms'; SET LOCAL statement_timeout='15s'; SET LOCAL idle_in_transaction_session_timeout='20s'");
    for(const file of files){
      const sql=file.sql.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
      if(sql===file.sql||/^\s*(?:COMMIT|ROLLBACK|BEGIN)\s*;\s*$/m.test(sql))throw new Error('Unexpected transaction boundary');
      await db.query(sql);
    }
    const checks=await db.query(`SELECT c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT') AS anon_read,
      has_table_privilege('authenticated',c.oid,'SELECT') AS browser_read,
      has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE') AS direct_write
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
      AND (c.relname LIKE 'awards\\_%' ESCAPE '\\' OR c.relname LIKE 'assessment\\_%' ESCAPE '\\')`);
    if(checks.rows.some(r=>!r.relrowsecurity||r.anon_read||r.browser_read||r.direct_write))throw new Error('Awards grant/RLS rehearsal failed');
    await db.query('ROLLBACK');
    console.log(JSON.stringify({rehearsal:'rolled back',tablesVerified:checks.rows.length,customerWrites:0,providerCalls:0}));
  }
}catch(error){
  await db.query('ROLLBACK').catch(()=>{});
  console.error(JSON.stringify({status:'failed; rolled back',code:error.code||null,message:error.message}));
  process.exitCode=1;
}finally{await db.end();}
