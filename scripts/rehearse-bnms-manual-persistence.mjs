// Offline-only private rehearsal. All database connections are disposable Unix
// sockets. No provider calls, environment credentials or production connection.
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from './test-support/local-postgres-harness.mjs';
import {applyManualManifest} from './run-bnms-dd-manual-cohort.mjs';
import {MIGRATION,INVOICE_MIGRATION} from './bnms-dd-manual-cohort.mjs';
const dir=process.argv[2];
if(process.argv.length!==3||!/^exports\/private-bnms-manual-phase2-refresh-[a-zA-Z0-9-]+$/.test(dir||''))throw Error('Private reviewed evidence directory required');
const load=async name=>JSON.parse(await readFile(`${dir}/${name}.json`,'utf8'));
const {review}=await load('dry-run'),catalog=await load('persistence-catalog');
const {manifest:m}=review,prefs=await load('rehearsal-preferences');
const runStamp=new Date().toISOString().replace(/[:.]/g,'-');
const h=await createLocalPostgresHarness('manual-persistence-');
// Offline fixture time only: never renew retained production evidence.
const fixtureTime=new Date(Math.max(...[m.providerCompletedAt,m.xeroCompletedAt].map(Date.parse))+1000);
const timings=[];
const run=(cmd,args)=>{if(spawnSync(cmd,args,{stdio:'ignore'}).status!==0)throw Error(`Local ${cmd} failed`);};
let c,started=false,lastQuery='';
const quoted=s=>`"${s.replaceAll('"','""')}"`;
const seed=async(table,row)=>{
 const keys=Object.keys(row);
 await c.query(`INSERT INTO ${quoted(table)} (${keys.map(quoted).join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT DO NOTHING`,
  keys.map(k=>row[k]!==null&&['json','jsonb'].includes(catalog[table].columns.find(c=>c.name===k)?.type)?JSON.stringify(row[k]):row[k]));
};
try{
 run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
 run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
 c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();
 await c.query("SET TIME ZONE 'UTC'; SET statement_timeout='15s'; SET track_functions='pl'; CREATE EXTENSION pgcrypto; CREATE EXTENSION btree_gist; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS");
 for(const [table,v] of Object.entries(catalog)){
  await c.query(`CREATE TABLE ${quoted(table)} (${v.columns.map(col=>`${quoted(col.name)} ${col.type}${col.default_expr?` DEFAULT ${col.default_expr}`:''}${col.required?' NOT NULL':''}`).join(',')})`);
 }
 console.log('Local catalog tables created');
 for(const [table,v] of Object.entries(catalog)){
  for(const k of v.constraints.filter(k=>['p','u','c','x'].includes(k.type))){
   await c.query(`ALTER TABLE ${quoted(table)} ADD CONSTRAINT ${quoted(k.name)} ${k.definition}`);
  }
 }
 // Only null quote references occur in this cohort; retain its real FK.
 await c.query(`CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY,tenant_id uuid,
  member_id uuid,organization_id uuid,term_key text,quote jsonb,stripe_payment_intent_id text)`);
 for(const table of ['membership_billing_agreements','membership_payment_plans','member_membership_history','gocardless_customers','gocardless_mandates']){
  for(const k of catalog[table].constraints.filter(k=>k.type==='f')){
   await c.query(`ALTER TABLE ${quoted(table)} ADD CONSTRAINT ${quoted(k.name)} ${k.definition}`);
  }
 }
 for(const r of m.members){await seed('member',r.owner);await seed('membership_tier_config',r.structure);}
 for(const r of prefs.fields)await seed('preference_field',r);
 for(const r of prefs.values)await seed('member_preference_value',r);
 let legacyInsertTriggerCount=0;
 try{
  const legacy=await load('legacy-insert-triggers'),functions=await load('legacy-trigger-functions');
  await c.query('CREATE TABLE bnms_dd_historical_payment(xero_invoice_id uuid)');
  for(const f of legacy.helpers.filter(f=>f.proname==='rolling_commitment_fields'))await c.query(f.definition);
  for(const name of [...new Set(legacy.triggers.map(t=>t.proname))]){
   const f=functions.find(f=>f.proname===name);
   if(!f)throw Error('Captured legacy trigger function missing');
   await c.query(f.definition);
  }
  for(const t of legacy.triggers){await c.query(t.definition);legacyInsertTriggerCount++;}
 }catch(error){if(error.code!=='ENOENT')throw error;}
 console.log('Local scoped evidence seeded; starting actual apply runner');
 const query=c.query.bind(c);
 let applyQueryCount=0;
 c.query=async(sql,...args)=>{
  applyQueryCount++;
  if(sql!=='ROLLBACK')lastQuery=String(sql).slice(0,110);
  if(sql==='SELECT clock_timestamp() now')return {rows:[{now:fixtureTime}]};
  const start=performance.now();
  try{
   const result=await query(sql,...args);
   if(sql==='SET CONSTRAINTS ALL IMMEDIATE'){
    timings.push({stage:'validator-calls',functions:(await query("SELECT funcname,calls,total_time FROM pg_stat_xact_user_functions WHERE funcname IN ('bnms_manual_complete_scope','bnms_manual_complete_cardinality') ORDER BY funcname")).rows});
   }
   return result;
  }
  finally{if(String(sql).startsWith('SET CONSTRAINTS'))timings.push({stage:'constraints',milliseconds:Math.round(performance.now()-start)});}
 };
 const schemas=await Promise.all([MIGRATION,INVOICE_MIGRATION].map(p=>readFile(p,'utf8')));
 const start=performance.now();
 const result=await applyManualManifest(c,m,{schemas,freshProvider:await load('gocardless'),deploymentProof:review.deploymentProof,now:()=>fixtureTime});
 const initialApplyQueryCount=applyQueryCount;
 timings.push({stage:'apply',milliseconds:Math.round(performance.now()-start)});
 console.log('Local actual apply committed; starting zero-write replay');
 const replayStart=performance.now();
 const replay=await applyManualManifest(c,m,{schemas,deploymentProof:review.deploymentProof});
 timings.push({stage:'replay',milliseconds:Math.round(performance.now()-replayStart)});
 const counts=(await c.query(`SELECT (SELECT count(*) FROM bnms_dd_manual_adoption)::int adoptions,
  (SELECT count(*) FROM bnms_dd_manual_release)::int releases,
  (SELECT sum(amount_minor) FROM membership_payment_plans)::int monthly_total`)).rows[0];
 const report={localOnly:true,fixtureClock:fixtureTime.toISOString(),initialApplyQueryCount,timings,result,replay,counts,legacyInsertTriggerCount,
  limitation:'Catalog columns/defaults/NOT NULL/PK/unique/check/exclusion and affected-table FKs plus both complete manual migrations exercised; captured legacy INSERT triggers included when provided. Legacy history/quote collision tables are empty fixture dependencies, not live collision evidence.'};
 await writeFile(`${dir}/persistence-rehearsal-${runStamp}.json`,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify(report));
}catch(error){
 await writeFile(`${dir}/persistence-rehearsal-failure-${runStamp}.json`,JSON.stringify({code:error.code||null,message:error.message},null,2),{mode:0o600,flag:'wx'});
  console.error(JSON.stringify({localOnly:true,failed:true,code:error.code||'LOCAL_GUARD',lastQuery,timings,privateDetailsRetained:true}));
 process.exitCode=1;
}finally{
 await c?.end();
 if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
 await h.cleanup();
}