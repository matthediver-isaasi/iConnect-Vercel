#!/usr/bin/env node
// Read-only accounting investigation, except ordinary Xero OAuth token rotation.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

destinationTarget(process.env);
if(process.argv.length>3||(process.argv[2]&&!resolve(process.argv[2]).startsWith('/tmp/'))) throw Error('Only a new private /tmp output path is supported');
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { TENANT_ID, providerReader, readAllProviderPages } = await import('./bnms-dd-pilot.mjs');
const { fingerprint } = await import('./bnms-dd-pilot-history.mjs');
const { destinationConnection } = await import('./run-bnms-dd-pilot-history.mjs');
const { getTenantGocardlessCredentials } = await import('../api/_lib/gocardlessCredentials.js');
const { createClient } = await import('@supabase/supabase-js');
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const c = await destinationConnection();
await c.connect();
let rows;
try {
  await c.query('BEGIN READ ONLY');
  rows = (await c.query(`SELECT h.*, a.mandate_id,a.customer_id,m.email,to_jsonb(m)->>'xero_contact_id' AS member_contact_id
    FROM bnms_dd_beta_provider_history h JOIN bnms_dd_beta_adoption a ON a.id=h.adoption_id
    JOIN bnms_dd_beta_batch b ON b.id=a.batch_id JOIN member m ON m.id=h.member_id AND m.tenant_id=h.tenant_id
    WHERE b.evidence_sha256=$1 AND h.tenant_id=$2 ORDER BY h.member_id,h.charge_date`,
  ['aaeb5efa50de77db5b6213c23d32a71ae0aa19d88484f1afd911f49fa44739c2',TENANT_ID])).rows;
  const tokens = (await c.query('SELECT tenant_id FROM xero_token WHERE app_tenant_id=$1',[TENANT_ID])).rows;
  if(tokens.length!==1||tokens[0].tenant_id!=='3d57dce6-2205-462f-abf6-9c7cbf00be23') throw Error('Xero connection pin mismatch');
  await c.query('ROLLBACK');
} finally { await c.end(); }
if(rows.length!==221||new Set(rows.map(r=>r.member_id)).size!==10) throw Error('Beta batch count drift');
const auth = await getValidXeroAccessToken(TENANT_ID);
if(auth.tenantId!=='3d57dce6-2205-462f-abf6-9c7cbf00be23') throw Error('Xero organisation mismatch');
const invoices=[];
for(let n=0;n<rows.length;n+=30) {
  const numbers=rows.slice(n,n+30).map(r=>r.evidence.metadata?.['Invoice number']);
  if(numbers.some(v=>!/^INV-\d+$/.test(v))) throw Error('Non-exact invoice number evidence');
  const url=new URL('https://api.xero.com/api.xro/2.0/Invoices');
  url.searchParams.set('InvoiceNumbers',numbers.join(','));
  const response=await fetch(url,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${auth.accessToken}`,'Xero-tenant-id':auth.tenantId,Accept:'application/json'}});
  if(!response.ok) throw Error(`Xero invoice GET failed HTTP ${response.status}`);
  invoices.push(...(await response.json()).Invoices);
  await new Promise(resolve=>setTimeout(resolve,1100));
}
const unique=[...new Map(invoices.map(i=>[i.InvoiceID,i])).values()];
const contacts=[];
for(const id of new Set(unique.map(i=>i.Contact.ContactID))){
  const response=await fetch(`https://api.xero.com/api.xro/2.0/Contacts/${id}`,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${auth.accessToken}`,'Xero-tenant-id':auth.tenantId,Accept:'application/json'}});
  if(!response.ok) throw Error(`Xero contact GET failed HTTP ${response.status}`);
  contacts.push(...(await response.json()).Contacts);
  await new Promise(resolve=>setTimeout(resolve,1100));
}
const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const get=providerReader(await getTenantGocardlessCredentials(TENANT_ID,{db}));
const provider=[];
for(const mandateId of new Set(rows.map(r=>r.mandate_id))){
  const mandate=(await get(`mandates/${mandateId}`)).mandates;
  const customer=(await get(`customers/${mandate.links.customer}`)).customers;
  const payments=await readAllProviderPages(get,'payments',{mandate:mandateId});
  provider.push({mandate,customer,payments:payments.filter(p=>rows.some(r=>r.provider_payment_id===p.id))});
}
const report={version:1,tenantId:TENANT_ID,xeroTenantId:auth.tenantId,rows,invoices:unique,contacts,provider};
await writeFile(process.argv[2]||'/tmp/bnms-beta-invoice-evidence.json',JSON.stringify(report),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({historicalRows:rows.length,invoices:unique.length,evidenceSha256:fingerprint(report)}));