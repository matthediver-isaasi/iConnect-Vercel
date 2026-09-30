#!/usr/bin/env node
// Schema-only installation audit. No arming or provider financial operations.
import {readFile,open,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';

const REVIEW='2fa038c9f924347fa42273582df1b0222bfd5d07ee62bdb6b8f2d5192f52ab5d';
export async function main(args=process.argv.slice(2)){
  const apply=args.includes('--apply-reviewed-schema'),outIndex=args.indexOf('--out');
  if(outIndex<0||!args[outIndex+1]||args.length!==(apply?3:2)
    ||!resolve(args[outIndex+1]).startsWith(`${resolve('exports')}/`))
    throw Error('Use --out exports/private-directory/new.json [--apply-reviewed-schema]');
  const target=destinationTarget(process.env);
  const {destinationConnection}=await import('./run-bnms-dd-pilot-history.mjs');
  const {hash}=await import('./bnms-dd-beta-invoices.mjs');
  const {TENANT_ID,MEMBER_ID}=await import('./bnms-dd-pilot.mjs');
  const {validateAlphaReleaseScope,alphaSchemaBundle,verifyAlphaReleaseSchema}=await import('./bnms-dd-alpha-release.mjs');
  const {main:reviewedCli}=await import('./run-bnms-dd-alpha-release.mjs');
  const bundle=await alphaSchemaBundle();assert.equal(bundle.hash,REVIEW,'Independently reviewed bundle changed');
  const manifest=JSON.parse(await readFile('exports/private-bnms-alpha-final-review-20260920/manifest.json','utf8'));
  const output=resolve(args[outIndex+1]);await mkdir(dirname(output),{recursive:true,mode:0o700});
  const file=await open(output,'wx',0o600);
  const report={target:{project:'lvmzliemqnieeoruhkik',host:target.hostname,database:target.pathname.slice(1),tlsVerified:true},
    bundleHash:bundle.hash,migrations:bundle.migrations,applyRequested:apply,startedAt:new Date().toISOString()};
  const save=async()=>{await file.truncate(0);await file.write(JSON.stringify(report,null,2),0,'utf8');await file.sync();};
  const c=await destinationConnection();await c.connect();
  async function snapshot(){
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try{
      await c.query("SET LOCAL timezone='UTC'; SET LOCAL statement_timeout='60s'");
      const read=async(sql,values=[])=>(await c.query(sql,values)).rows.map(row=>row.row);
      const adoptions=await read('SELECT to_jsonb(a) AS row FROM bnms_dd_alpha_adoption a WHERE tenant_id=$1',[TENANT_ID]);
      validateAlphaReleaseScope(manifest,adoptions);
      const beta=await read('SELECT to_jsonb(a) AS row FROM bnms_dd_beta_adoption a WHERE tenant_id=$1',[TENANT_ID]);
      assert.equal(beta.length,10);
      const memberIds=[...adoptions.map(a=>a.member_id),...beta.map(a=>a.member_id),MEMBER_ID];
      assert.equal(new Set(memberIds).size,260);
      const data={};
      for(const table of ['member','membership_billing_agreements','membership_payment_plans','member_membership_history'])
        data[table]=await read(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id=$1 AND ${table==='member'?'id':'member_id'}=ANY($2::uuid[])`,[TENANT_ID,memberIds]);
      assert.equal(data.member.length,260);
      data.member_preference_value=await read('SELECT to_jsonb(t) AS row FROM member_preference_value t WHERE member_id=ANY($1::uuid[])',[memberIds]);
      const plans=data.membership_payment_plans.map(p=>p.id);
      const mandates=data.membership_billing_agreements.map(a=>a.gocardless_mandate_id).filter(Boolean);
      data.gocardless_collection_reservations=await read('SELECT to_jsonb(t) AS row FROM gocardless_collection_reservations t WHERE tenant_id=$1 AND plan_id=ANY($2::uuid[])',[TENANT_ID,plans]);
      data.gocardless_payments=await read('SELECT to_jsonb(t) AS row FROM gocardless_payments t WHERE tenant_id=$1 AND gocardless_mandate_id=ANY($2::text[])',[TENANT_ID,mandates]);
      data.gocardless_customers=await read('SELECT to_jsonb(t) AS row FROM gocardless_customers t WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])',[TENANT_ID,memberIds]);
      data.gocardless_mandates=await read('SELECT to_jsonb(t) AS row FROM gocardless_mandates t WHERE tenant_id=$1 AND gocardless_mandate_id=ANY($2::text[])',[TENANT_ID,mandates]);
      const tables=(await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND
        (c.relname ~ '^bnms_dd_(alpha|beta|pilot|historical)' OR c.relname='bnms_alpha_invoice_operations') ORDER BY c.relname`)).rows;
      const schema={release:tables.some(t=>t.relname==='bnms_dd_alpha_release'),
        operations:tables.some(t=>t.relname==='bnms_alpha_invoice_operations')};
      for(const {relname} of tables){
        assert.match(relname,/^[a-z0-9_]+$/);
        data[relname]=await read(`SELECT to_jsonb(t) AS row FROM public.${relname} t`);
      }
      // Absent-to-empty is the only permitted data transition for new tables.
      data.bnms_dd_alpha_release||=[];
      data.bnms_alpha_invoice_operations||=[];
      const alphaPlans=data.membership_payment_plans.filter(p=>adoptions.some(a=>a.plan_id===p.id));
      assert.equal(alphaPlans.length,249);
      assert.ok(alphaPlans.every(p=>p.collection_stopped_at&&p.metadata?.bnms_alpha_held===true
        &&p.metadata?.bnms_release_required===true&&p.status==='first_payment_pending'));
      const betaPlans=data.membership_payment_plans.filter(p=>beta.some(a=>a.plan_id===p.id));
      assert.equal(betaPlans.length,10);
      assert.ok(betaPlans.every(p=>p.collection_stopped_at&&p.metadata?.bnms_release_required===true));
      const alphaHistory=data.member_membership_history.filter(h=>adoptions.some(a=>a.history_id===h.id));
      assert.equal(alphaHistory.length,249);
      assert.ok(alphaHistory.every(h=>h.status==='pending_payment_setup'&&h.payment_status==='unpaid'));
      const alphaReservations=data.gocardless_collection_reservations.filter(r=>adoptions.some(a=>a.plan_id===r.plan_id));
      assert.equal(alphaReservations.length,0);
      assert.equal(data.bnms_dd_alpha_release.length,0);
      assert.equal(data.bnms_alpha_invoice_operations.length,0);
      assert.equal(data.bnms_dd_alpha_provider_history.length,2137);
      assert.equal(data.bnms_dd_alpha_invoice_link.length,2137);
      assert.equal(manifest.exceptions.length,170);
      const alphaMembers=new Set(adoptions.map(a=>a.member_id));
      assert.ok(manifest.exceptions.every(e=>!alphaMembers.has(e.identity?.memberId)));
      const tableHashes=Object.fromEntries(Object.keys(data).sort().map(table=>{
        const recordHashes=data[table].map(hash).sort();
        return [table,{rows:data[table].length,sha256:hash(recordHashes)}];
      }));
      await c.query('ROLLBACK');
      return {observedAt:new Date().toISOString(),schema,tableHashes,dataSha256:hash(tableHashes),
        alphaMembers:249,alphaHeld:249,betaMembers:10,pilotMembers:1,excludedExceptions:170,
        historicalInvoices:2137,alphaReservations:0,alphaReleases:0,alphaInvoiceOperations:0};
    }catch(error){await c.query('ROLLBACK');throw error;}
  }
  try{
    report.before=await snapshot();await save();
    if(apply){
      await reviewedCli(['--schema','--apply',`--review-sha256=${REVIEW}`]);
      report.schemaApplyCompletedAt=new Date().toISOString();await save();
    }
    await c.query("SET timezone='UTC'");
    await verifyAlphaReleaseSchema(c);
    report.installedCatalogVerified=true;
    report.after=await snapshot();
    assert.equal(report.after.dataSha256,report.before.dataSha256,'Cohort data changed across schema installation');
    report.unchanged=true;report.completedAt=new Date().toISOString();await save();
    console.log(JSON.stringify({mode:apply?'alpha_schema_only_install_verified':'alpha_schema_only_verification',
      bundleHash:REVIEW,dataSha256:report.after.dataSha256,unchanged:true,alphaHeld:249,exceptionsExcluded:170,
      alphaReleases:0,alphaInvoiceOperations:0,alphaReservations:0,out:output}));
  }catch(error){
    report.failure=error.message;report.failedAt=new Date().toISOString();await save();throw error;
  }finally{await c.end();await file.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(`Alpha schema audit stopped: ${error.message}`);process.exitCode=1;});