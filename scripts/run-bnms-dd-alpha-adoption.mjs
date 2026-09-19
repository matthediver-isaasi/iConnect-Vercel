#!/usr/bin/env node
// Explicit reviewed schema/data modes only. Never schedules or releases.
import { readFile, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {createClient}=await import('@supabase/supabase-js');
const {destinationConnection}=await import('./run-bnms-dd-pilot-history.mjs');
const {TENANT_ID,readAllProviderPages}=await import('./bnms-dd-pilot.mjs');
const {alphaProviderReader,privateJson,FROM,START,CREDITOR}=await import('./bnms-dd-alpha-review.mjs');
const {alphaManifest,adoptAlpha,applyAlphaSchema}=await import('./bnms-dd-alpha-adoption.mjs');
const {hash,sqlHash,reconcileHistoricalInvoices,XERO_TENANT_ID}=await import('./bnms-dd-beta-invoices.mjs');
const {getTenantGocardlessCredentials}=await import('../api/_lib/gocardlessCredentials.js');
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const migration=new URL('../supabase/migrations/20261113_bnms_dd_alpha_held.sql',import.meta.url);
async function main(args){
  const o={apply:false,migration:false,batchSize:10,prepareOnly:false,destinationOnly:false,offset:0};
  for(let n=0;n<args.length;n++){
    const a=args[n];
    if(['--apply','--migration'].includes(a)&&o[a.slice(2)]===false)o[a.slice(2)]=true;
    else if(/^--review-sha256=[a-f0-9]{64}$/.test(a)&&!o.reviewSha256)o.reviewSha256=a.split('=')[1];
    else if(['--evidence-dir','--out-dir','--entitlements'].includes(a)&&!o[a.slice(2)]&&args[n+1]&&!args[n+1].startsWith('--'))o[a.slice(2)]=args[++n];
    else if(/^--batch-size=(?:[1-9]|1[0-9]|2[0-5])$/.test(a))o.batchSize=Number(a.split('=')[1]);
    else if(/^--offset=\d+$/.test(a))o.offset=Number(a.split('=')[1]);
    else if(/^--limit=\d+$/.test(a))o.limit=Number(a.split('=')[1]);
    else if(a==='--prepare-only'&&!o.prepareOnly)o.prepareOnly=true;
    else if(a==='--destination-only'&&!o.destinationOnly)o.destinationOnly=true;
    else throw Error('Unsupported alpha argument; release/tenant/member overrides forbidden');
  }
  if(o.apply&&!o.reviewSha256)throw Error('Exact reviewed hash required');
  if(o.prepareOnly&&(o.apply||o.migration))throw Error('Prepare-only cannot apply');
  if(o.destinationOnly&&(o.apply||o.migration||o.prepareOnly))throw Error('Destination-only is strictly a read-only dry run');
  if(o.migration&&(o['evidence-dir']||o['out-dir']||o.entitlements))throw Error('Schema and data modes separate');
  const sql=await readFile(migration,'utf8'),schemaSha256=sqlHash(sql);
  if(o.migration&&!o.apply){console.log(JSON.stringify({mode:'schema_review',schemaSha256,writes:0}));return;}
  if(o.migration){
    const c=await destinationConnection();await c.connect();
    try{console.log(JSON.stringify(await applyAlphaSchema(c,sql,o.reviewSha256,{verifiedDestination:true})));}
    finally{await c.end();}return;
  }
  if(!o['evidence-dir']||!o['out-dir']||!resolve(o['out-dir']).startsWith(`${resolve('exports')}/`))throw Error('Private evidence and new output directories required');
  const input=resolve(o['evidence-dir']),out=resolve(o['out-dir']);
  await mkdir(out,{recursive:true,mode:0o700});
  const source=JSON.parse(await readFile(`${input}/source-evidence.json`,'utf8'));
  const accounting=JSON.parse(await readFile(`${input}/accounting-evidence.json`,'utf8'));
  const entitlements=o.entitlements?JSON.parse(await readFile(resolve(o.entitlements),'utf8')):[];
  const manifest=alphaManifest(source,accounting,{entitlements});
  if(o.apply&&!manifest.members.length)throw Error('No eligible reviewed alpha members');
  await privateJson(`${out}/manifest.json`,manifest);
  await privateJson(`${out}/exceptions.json`,manifest.exceptions);
  const {default:ExcelJS}=await import('exceljs');
  const workbook=new ExcelJS.Workbook();
  const summary=workbook.addWorksheet('Summary');
  summary.addRows([['BNMS alpha import — review only',''],
    ['Prepared eligible members',manifest.members.length],['Held for review',manifest.exceptions.length],
    ['Original pilot and beta excluded',manifest.excludedPilotBeta],
    ['History from (inclusive)',FROM],['History before (exclusive)',START],
    ['Manifest SHA-256',hash(manifest)],['Schema SHA-256',schemaSha256],
    ['Collections','HELD — release not approved'],
    ['Prior/current entitlement','Unknown and unchanged. Only the explicitly approved unpaid FUTURE held term is created. No current access or historical entitlement inferred.'],
    ['Live import writes','No import performed by preparation; see result.json for the actual execution mode.']]);
  summary.columns=[{width:38},{width:90}];
  const eligible=workbook.addWorksheet('Planned future memberships');
  eligible.columns=[{header:'Member UUID',key:'memberId',width:38},{header:'Email',key:'email',width:38},
    {header:'Membership class',key:'memberClass',width:30},{header:'Monthly quote GBP (dynamic)',key:'quote',width:26},
    {header:'Future term start',key:'start',width:20},{header:'Future term end',key:'end',width:20},
    {header:'Historical paid payments',key:'payments',width:24},{header:'Existing Xero invoices',key:'invoices',width:24},
    {header:'Collections',key:'collections',width:20},{header:'Prior entitlement',key:'prior',width:35}];
  eligible.addRows(manifest.members.map(m=>({memberId:m.identity.memberId,email:m.identity.email,
    memberClass:m.structure.structure_match_value,quote:m.monthlyQuoteMinor/100,start:manifest.approval.start,
    end:manifest.approval.end,payments:m.history.length,invoices:m.links.length,collections:'HELD',
    prior:'Unknown — unchanged; no current access granted'})));
  eligible.views=[{state:'frozen',ySplit:1}];eligible.autoFilter={from:'A1',to:'J1'};
  const exceptions=workbook.addWorksheet('Exceptions');
  exceptions.columns=[{header:'Member UUID',key:'memberId',width:38},{header:'Email',key:'email',width:38},
    {header:'Mandate ID',key:'mandateId',width:22},{header:'Customer ID',key:'customerId',width:22},
    {header:'Identity source',key:'source',width:20},{header:'Reasons',key:'reasons',width:100},
    {header:'Invoice reconciliation',key:'invoices',width:25},{header:'Historical payments',key:'payments',width:20}];
  const exceptionRows=manifest.exceptions.map(e=>({memberId:e.identity?.memberId||'',email:e.identity?.email||'',
    mandateId:e.mandateId||'',customerId:e.identity?.customerId||'',source:e.identity?.group||'',
    reasons:e.reasons.join('; '),invoices:e.invoiceReconciliation||'not complete',payments:e.historicalPayments??''}));
  exceptions.addRows(exceptionRows);
  exceptions.views=[{state:'frozen',ySplit:1}];exceptions.autoFilter={from:'A1',to:'H1'};
  for(const sheet of workbook.worksheets)sheet.eachRow(row=>{row.font={name:'Arial',size:10};row.alignment={vertical:'top',wrapText:true};});
  const xfile=await open(`${out}/BNMS-alpha-review.xlsx`,'wx',0o600);
  try{await xfile.writeFile(Buffer.from(await workbook.xlsx.writeBuffer()));}finally{await xfile.close();}
  const csvCell=value=>`"${String(value).replace(/"/g,'""').replace(/^([=+\-@\t\r])/,"'$1")}"`;
  const csv=[exceptions.columns.map(c=>c.header),...exceptionRows.map(r=>exceptions.columns.map(c=>r[c.key]))]
    .map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
  const csvFile=await open(`${out}/BNMS-alpha-exceptions.csv`,'wx',0o600);
  try{await csvFile.writeFile(csv);}finally{await csvFile.close();}
  if(o.prepareOnly){
    const result={mode:'prepared_not_live_validated',manifestSha256:hash(manifest),schemaSha256,
      members:manifest.members.length,exceptions:manifest.exceptions.length,writes:0,providerWrites:0,collectionReleased:false};
    await privateJson(`${out}/result.json`,result);console.log(JSON.stringify(result));return;
  }
  const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const get=alphaProviderReader(await getTenantGocardlessCredentials(TENANT_ID,{db}));
  let auth;
  const xget=async(resource)=>{
    if(!auth||auth.fetchedAt<Date.now()-15*60*1000){
      auth={...await getValidXeroAccessToken(TENANT_ID),fetchedAt:Date.now()};
      if(auth.tenantId!==XERO_TENANT_ID)throw Error('Pinned Xero tenant mismatch');
    }
    let response;
    for(let attempt=0;attempt<4;attempt++){
      response=await fetch(`https://api.xero.com/api.xro/2.0/${resource}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{Authorization:`Bearer ${auth.accessToken}`,'Xero-tenant-id':auth.tenantId,Accept:'application/json'}});
      if(response.status!==429)break;
      const seconds=Number(response.headers.get('Retry-After')||60);
      if(!Number.isFinite(seconds)||seconds<0||seconds>120||attempt===3)break;
      await new Promise(r=>setTimeout(r,Math.max(seconds,30)*1000));
    }
    if(!response.ok)throw Error(`Fresh Xero read HTTP ${response.status}${response.status===429?` (Retry-After seconds: ${Number(response.headers.get('Retry-After'))||'unspecified'})`:''}`);
    const body=await response.json();await new Promise(r=>setTimeout(r,1100));return body;
  };
  const verifyLiveMember=async m=>{
    const i=m.identity;
    const mandate=(await get(`mandates/${i.mandateId}`)).mandates;
    const customer=(await get(`customers/${i.customerId}`)).customers;
    if(mandate.status!=='active'||mandate.links?.customer!==i.customerId||mandate.links?.creditor!==CREDITOR
      ||hash(customer)!==hash(m.customer))throw Error('Fresh mandate/customer drift');
    const mandates=await readAllProviderPages(get,'mandates',{customer:i.customerId});
    if(mandates.length!==1||mandates[0].id!==i.mandateId)throw Error('Fresh customer mandate scope changed');
    const subscriptions=await readAllProviderPages(get,'subscriptions',{mandate:i.mandateId});
    if(subscriptions.length)throw Error('Fresh provider subscription exists');
    const payments=await readAllProviderPages(get,'payments',{mandate:i.mandateId});
    if(payments.some(p=>p.links?.mandate!==i.mandateId||['pending_submission','submitted','confirmed'].includes(p.status)
      ||p.charge_date>=START))throw Error('Fresh pending/future payment or ownership conflict');
    const history=payments.filter(p=>p.status==='paid_out'&&p.charge_date>=FROM&&p.charge_date<START);
    if(history.length!==m.history.length||history.some(p=>!m.history.some(h=>h.provider_payment_id===p.id)))throw Error('Fresh full historical payment coverage changed');
    const invoices=[],contacts=[];
    const numbers=[...new Set(m.links.map(l=>l.xero_invoice_number))];
    for(let n=0;n<numbers.length;n+=25){
      const query=new URLSearchParams({InvoiceNumbers:numbers.slice(n,n+25).join(','),pageSize:'100'});
      for(let page=1;page<=1000;page++){
        query.set('page',String(page));
        const data=await xget(`Invoices?${query}`);
        if(!Array.isArray(data.Invoices))throw Error('Fresh invoice pagination missing');
        invoices.push(...data.Invoices);
        if(data.Invoices.length<100)break;
        if(page===1000)throw Error('Fresh invoice pagination bound');
      }
    }
    for(const id of new Set(m.links.map(l=>l.xero_contact_id))){
      const data=await xget(`Contacts/${id}`);
      if(data.Contacts?.length!==1)throw Error('Fresh contact missing');contacts.push(data.Contacts[0]);
    }
    const links=reconcileHistoricalInvoices({tenantId:TENANT_ID,xeroTenantId:XERO_TENANT_ID,
      rows:m.history.map(h=>({...h,email:i.email,mandate_id:i.mandateId,customer_id:i.customerId})),
      provider:[{mandate,customer,payments:history}],invoices,contacts});
    const identities=links=>links.map(({evidence,evidence_sha256,...identity})=>identity);
    if(hash(identities(links))!==hash(identities(m.links)))throw Error('Fresh invoice identities changed');
  };
  const c=await destinationConnection();await c.connect();let progress=0;
  try{
    const result=await adoptAlpha(c,manifest,{...o,reviewSha256:o.reviewSha256,verifiedDestination:true,
      source,accounting,entitlements,schemaSha256,verifyLiveMember:o.destinationOnly?undefined:verifyLiveMember,
      onProgress:async report=>privateJson(`${out}/progress-${++progress}.json`,report)});
    result.validation=o.destinationOnly?'fresh_destination_only_cached_provider_accounting':'fresh_destination_and_provider_accounting';
    await privateJson(`${out}/result.json`,result);
    console.log(JSON.stringify({mode:result.mode,manifestSha256:hash(manifest),schemaSha256,
      members:manifest.members.length,exceptions:manifest.exceptions.length,excludedPilotBeta:manifest.excludedPilotBeta,
      writes:result.writes,providerWrites:0,collectionReleased:false,out}));
  }finally{await c.end();}
}
await main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({error:e.message,collectionReleased:false}));process.exitCode=1;});