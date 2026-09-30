#!/usr/bin/env node
// Schema review: --migration; apply requires --apply --review-sha256=<hash>.
// Data review: --evidence /tmp/bnms-beta-invoice-evidence.json --out /tmp/new-report.json
// Data apply adds --apply --review-sha256=<manifest hash>; fresh GET revalidation required.
import { readFile, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { destinationConnection, parseHistoryArgs } from './run-bnms-dd-pilot-history.mjs';
import { hash, invoiceManifest, importInvoiceLinks, applyInvoiceSchema } from './bnms-dd-beta-invoices.mjs';
const migration=new URL('../supabase/migrations/20261109_bnms_dd_beta_invoice_links.sql',import.meta.url);
async function main(){
  const o=parseHistoryArgs(process.argv.slice(2));
  if(o.migration){
    const sql=await readFile(migration,'utf8'),digest=createHash('sha256').update(sql).digest('hex');
    if(!o.apply){console.log(JSON.stringify({mode:'schema_review',hash:digest,writes:0}));return;}
    if(o.reviewSha256!==digest) throw Error('Exact reviewed migration SHA required');
    const c=await destinationConnection();await c.connect();
    try { console.log(JSON.stringify(await applyInvoiceSchema(c,sql,digest))); }finally{await c.end();}
    return;
  }
  const file=await open(o.out,'wx',0o600);
  try{
    let evidence=JSON.parse(await readFile(o.evidence,'utf8'));
    const reviewed=invoiceManifest(evidence),digest=hash(reviewed);
    if(o.apply){
      if(o.reviewSha256!==digest) throw Error('Exact reviewed manifest SHA required');
      const fresh=`/tmp/bnms-beta-invoice-refresh-${randomUUID()}.json`;
      const result=spawnSync(process.execPath,['scripts/prepare-bnms-dd-beta-invoices.mjs',fresh],{encoding:'utf8',timeout:180000});
      if(result.status!==0) throw Error('Fresh provider/Xero GET verification failed; no invoice links written');
      evidence=JSON.parse(await readFile(fresh,'utf8'));
      if(hash(invoiceManifest(evidence))!==digest) throw Error('Fresh accounting evidence differs: review a new manifest');
    }
    const c=await destinationConnection();await c.connect();
    let result;
    const schemaSha256=createHash('sha256').update(await readFile(migration,'utf8')).digest('hex');
    try{result=await importInvoiceLinks(c,reviewed,{apply:o.apply,reviewSha256:o.reviewSha256,evidence,schemaSha256});}finally{await c.end();}
    await file.writeFile(JSON.stringify({result,manifest:reviewed},null,2));
    console.log(JSON.stringify(result));
  }finally{await file.close();}
}
main().catch(e=>{console.error(`Beta invoice reconciliation stopped: ${e.message.replace(/https?:\/\/\S+/g,'[redacted-url]')}`);process.exitCode=1;});