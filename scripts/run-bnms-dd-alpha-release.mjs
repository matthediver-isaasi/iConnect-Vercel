#!/usr/bin/env node
// Strictly read-only preparation. There is intentionally no --apply mode.
import {readFile,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {destinationConnection} from './run-bnms-dd-pilot-history.mjs';
import {TENANT_ID} from './bnms-dd-pilot.mjs';
import {sqlHash} from './bnms-dd-beta-invoices.mjs';
import {verifyAlphaSchema} from './bnms-dd-alpha-adoption.mjs';
import {prepareAlphaRelease} from './bnms-dd-alpha-release.mjs';

export function parseAlphaReleaseArgs(args){
  const opts={};
  for(let i=0;i<args.length;i++){
    const key=args[i].slice(2);
    if(!['manifest','out','handover'].includes(key)||args[i]!==`--${key}`||opts[key]
      ||!args[i+1]||args[i+1].startsWith('--'))throw Error('Preparation only: unsupported or duplicate alpha argument');
    opts[key]=args[++i];
  }
  if(!opts.manifest||!opts.out||!resolve(opts.out).startsWith(`${resolve('exports')}/`))
    throw Error('Reviewed manifest and new private exports output required');
  return opts;
}
export async function main(args=process.argv.slice(2)){
  const opts=parseAlphaReleaseArgs(args);
  const manifest=JSON.parse(await readFile(resolve(opts.manifest),'utf8'));
  const handover=opts.handover?JSON.parse(await readFile(resolve(opts.handover),'utf8')):null;
  const sql=await readFile(new URL('../supabase/migrations/20261113_bnms_dd_alpha_held.sql',import.meta.url),'utf8');
  const c=await destinationConnection();await c.connect();
  let report;
  try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='30s'");
    const observedAt=new Date().toISOString();
    await verifyAlphaSchema(c,sqlHash(sql));
    const rows=async(sql,args=[TENANT_ID])=>(await c.query(sql,args)).rows;
    const adoptions=await rows('SELECT * FROM bnms_dd_alpha_adoption WHERE tenant_id=$1 ORDER BY id');
    const canonical=await rows(`SELECT a.id AS adoption_id,to_jsonb(p) AS plan,to_jsonb(b) AS agreement,
      to_jsonb(h) AS history,to_jsonb(m) AS member FROM bnms_dd_alpha_adoption a
      JOIN membership_payment_plans p ON p.id=a.plan_id
      JOIN membership_billing_agreements b ON b.id=a.agreement_id
      JOIN member_membership_history h ON h.id=a.history_id JOIN member m ON m.id=a.member_id WHERE a.tenant_id=$1`);
    const historical=await rows('SELECT * FROM bnms_dd_alpha_provider_history WHERE tenant_id=$1 ORDER BY id');
    const links=await rows('SELECT * FROM bnms_dd_alpha_invoice_link WHERE tenant_id=$1 ORDER BY history_id');
    const collisions=await rows(`SELECT r.id FROM gocardless_collection_reservations r JOIN bnms_dd_alpha_adoption a
      ON r.plan_id=a.plan_id OR r.billing_agreement_id=a.agreement_id WHERE a.tenant_id=$1
      UNION ALL SELECT p.id FROM gocardless_payments p JOIN bnms_dd_alpha_adoption a
      ON p.gocardless_mandate_id=a.mandate_id WHERE a.tenant_id=$1`);
    report=prepareAlphaRelease({manifest,adoptions,canonical,historical,links,handover,observedAt,
      completedAt:new Date().toISOString()});
    if(collisions.length)report.globalBlockers.push('Canonical payments/reservations already exist; reconciliation required');
    report.existingHeldMigrationSha256=sqlHash(sql);
    report.scheduledReleaseMigrationSha256=null;
    await c.query('ROLLBACK');
  }catch(error){await c.query('ROLLBACK');throw error;}
  finally{await c.end();}
  const output=await open(resolve(opts.out),'wx',0o600);
  try{await output.writeFile(JSON.stringify(report,null,2));}finally{await output.close();}
  console.log(JSON.stringify({mode:report.mode,members:report.members.length,
    historicalInvoiceCount:report.historicalInvoiceCount,excludedExceptions:report.excludedExceptions,
    releasable:report.releasable,blockers:report.globalBlockers,writes:0,providerWrites:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});