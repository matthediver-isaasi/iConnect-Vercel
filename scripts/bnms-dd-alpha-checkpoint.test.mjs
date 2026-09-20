import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {openAlphaCheckpoint,alphaRetryNotBefore,assertAlphaCheckpointRetryAllowed,
  ALPHA_INVOICE_START,ALPHA_INVOICE_WHERE,alphaInvoiceQuery} from './bnms-dd-alpha-checkpoint.mjs';
import {boundedAlphaTransport,assertAlphaEvidenceFresh,ALPHA_MANIFEST_SHA256,
  authenticateAlphaProviderGeneration,ALPHA_XERO_TENANT_ID} from './bnms-dd-alpha-release.mjs';
import {readAlphaReleaseEvidence,ALPHA_BANK_ACCOUNT_ID} from './bnms-dd-alpha-release.mjs';
import {hash} from './bnms-dd-beta-invoices.mjs';
import {main as runAlphaRelease} from './run-bnms-dd-alpha-release.mjs';
import {readAllProviderPages,TENANT_ID} from './bnms-dd-pilot.mjs';

const scope={tenant:'pinned',environment:'live',manifest:'exact',invoiceStart:ALPHA_INVOICE_START};
const options={method:'GET',headers:{Authorization:'Bearer MUST_NOT_BE_SAVED'}};
const base='https://api.xero.com/api.xro/2.0/';
const response=body=>({ok:true,status:200,json:async()=>body});
const diagnostic=(observedAt='2026-09-20T10:00:00.000Z',retryAfter={value:'60',format:'numeric'})=>
  ({status:429,provider:'Xero',observedAt,endpoint:'/api.xro/2.0/Invoices',retryAfter});
async function fixture(t){
  await mkdir('exports',{recursive:true});
  const dir=await mkdtemp('exports/alpha-checkpoint-test-');
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir+'/checkpoint.json';
}
test('inclusive invoice DATE lower bound has no future cap',()=>{
  assert.equal(ALPHA_INVOICE_START,'2026-01-01');
  assert.equal(ALPHA_INVOICE_WHERE,'Date>=DateTime(2026,1,1)');
  assert.equal('2025-12-31'>=ALPHA_INVOICE_START,false);
  assert.equal('2026-01-01'>=ALPHA_INVOICE_START,true);
  assert.equal('2027-01-01'>=ALPHA_INVOICE_START,true);
  const query=alphaInvoiceQuery(['first','second'],2);
  assert.deepEqual(query,{ContactIDs:'first,second',page:'2',where:ALPHA_INVOICE_WHERE,order:'InvoiceID ASC'});
  const encoded=new URLSearchParams(query);
  assert.equal(encoded.get('where'),'Date>=DateTime(2026,1,1)');
});
test('numeric and HTTP-date retry deadlines, absent and malformed headers',()=>{
  assert.equal(alphaRetryNotBefore(diagnostic()),'2026-09-20T10:01:00.000Z');
  assert.equal(alphaRetryNotBefore(diagnostic(undefined,{value:'Sun, 20 Sep 2026 10:02:00 GMT',format:'http-date'})),'2026-09-20T10:02:00.000Z');
  assert.equal(alphaRetryNotBefore(diagnostic(undefined,null)),null);
  assert.equal(alphaRetryNotBefore(diagnostic(undefined,{value:null,format:'discarded-invalid'})),null);
  assert.throws(()=>alphaRetryNotBefore(diagnostic(undefined,{value:'bad',format:'numeric'})));
});
test('429 saves successful pages/contact reads, resumes failed page only and never stores authorization',async t=>{
  const path=await fixture(t);let instant=new Date('2026-09-20T10:00:00Z'),calls=0;
  const now=()=>instant;
  const urls=[base+'Contacts/contact',base+'Invoices?ContactIDs=contact&page=1',base+'Invoices?ContactIDs=contact&page=2'];
  let journal=await openAlphaCheckpoint(path,scope,{now});
  const get=journal.wrap(async url=>{
    calls++;
    if(String(url).endsWith('page=2'))throw Object.assign(Error('limited'),{rateLimitDiagnostic:diagnostic()});
    return response({Invoices:[{InvoiceID:'first'}]});
  });
  for(const url of urls.slice(0,2))await get(url,options);
  await assert.rejects(get(urls[2],options),/limited/);
  await journal.close();
  assert.equal(calls,3);
  assert.equal((await readFile(path,'utf8')).includes('MUST_NOT_BE_SAVED'),false);
  journal=await openAlphaCheckpoint(path,scope,{now});
  await assert.rejects(journal.wrap(async()=>{calls++;})(urls[0],options),/prohibited/);
  await journal.close();assert.equal(calls,3);
  instant=new Date('2026-09-20T10:01:01Z');
  journal=await openAlphaCheckpoint(path,scope,{now});
  const resumed=journal.wrap(async()=>{calls++;return response({Invoices:[]});});
  for(const url of urls)await resumed(url,options);
  assert.equal(calls,4);assert.equal(journal.stats.reused,2);
  assert.equal(journal.oldestObservedAt,'2026-09-20T10:00:00.000Z');
  await journal.close();
});
test('long-wait discovery resumes cached pages but final revalidation invalidates whole stale list',async t=>{
  const path=await fixture(t);let instant=new Date('2026-09-20T10:00:00Z'),calls=0;
  const now=()=>instant,first=base+'Invoices?ContactIDs=a&page=1',second=base+'Invoices?ContactIDs=a&page=2';
  let journal=await openAlphaCheckpoint(path,scope,{now});
  await journal.wrap(async()=>response({Invoices:[{InvoiceID:'old'}]}))(first,options);
  await journal.close();
  instant=new Date('2026-09-21T10:00:00Z');
  journal=await openAlphaCheckpoint(path,scope,{now});
  const get=journal.wrap(async()=>{calls++;return response({Invoices:[]});});
  await get(first,options);await get(second,options);
  assert.equal(calls,1);assert.equal(journal.oldestObservedAt,'2026-09-20T10:00:00.000Z');
  await journal.revalidate();
  await get(first,options);await get(second,options);
  assert.equal(calls,3);assert.equal(journal.stats.invalidated,2);
  assert.equal(journal.oldestObservedAt,'2026-09-21T10:00:00.000Z');
  await journal.close();
});
test('mismatched tenant/date/environment and corrupt checkpoints fail closed',async t=>{
  const path=await fixture(t);
  const journal=await openAlphaCheckpoint(path,scope);await journal.close();
  for(const change of [{tenant:'other'},{invoiceStart:'2025-01-01'},{environment:'sandbox'}])
    await assert.rejects(openAlphaCheckpoint(path,{...scope,...change}),/scope-mismatched/);
  await writeFile(path,'{"broken":');
  await assert.rejects(openAlphaCheckpoint(path,scope));
});
test('seed deadline enforced before any request and preflight including missing retry header',async t=>{
  const path=await fixture(t),seed=diagnostic(),now=()=>new Date('2026-09-20T10:00:01Z');
  const journal=await openAlphaCheckpoint(path,scope,{now,seedRateLimit:seed});
  assert.throws(()=>journal.assertAllowed(),/prohibited/);await journal.close();
  await assert.rejects(assertAlphaCheckpointRetryAllowed(path,{now,seedRateLimit:seed}),/prohibited/);
  const path2=await fixture(t),unknown=await openAlphaCheckpoint(path2,scope,{now,seedRateLimit:diagnostic(undefined,null)});
  assert.throws(()=>unknown.assertAllowed(),/operator review/);await unknown.close();
});
test('exclusive lock prevents competing scans; orphan temporary file is not read as a checkpoint',async t=>{
  const path=await fixture(t);
  await writeFile(path+'.interrupted.tmp','partial',{mode:0o600});
  const journal=await openAlphaCheckpoint(path,scope);
  await assert.rejects(openAlphaCheckpoint(path,scope),/locked/);await journal.close();
  const again=await openAlphaCheckpoint(path,scope);await again.close();
});
test('revalidation keeps fresh responses and refuses mutation/non-provider requests even on cache path',async t=>{
  const path=await fixture(t),now=()=>new Date('2026-09-20T10:00:00Z');
  const journal=await openAlphaCheckpoint(path,scope,{now});let calls=0;
  const get=journal.wrap(async()=>{calls++;return response({Accounts:[]});});
  await get(base+'Accounts',options);await journal.revalidate();await get(base+'Accounts',options);
  assert.equal(calls,1);
  await assert.rejects(get(base+'Accounts',{method:'POST'}),/GET/);
  await assert.rejects(get('https://evil.invalid/',options),/GET/);
  await journal.close();
});
test('bounded transport 429 diagnostic is persisted without consuming response body',async t=>{
  const path=await fixture(t),now=()=>new Date('2026-09-20T10:00:00Z');
  const journal=await openAlphaCheckpoint(path,scope,{now});
  const transport=boundedAlphaTransport({now,observedAt:now().toISOString(),transport:async()=>({
    ok:false,status:429,headers:new Headers({'Retry-After':'33701'}),
    json:async()=>{throw Error('must not consume failure body');},
  })});
  await assert.rejects(journal.wrap(transport)(base+'Accounts',options),/rate limit/);
  await journal.close();
  const saved=JSON.parse(await readFile(path,'utf8'));
  assert.equal(saved.state.notBefore,'2026-09-20T19:21:41.000Z');
  assert.deepEqual(saved.state.entries,{});
});
test('invalid observation timestamps are rejected even with valid file digest',async t=>{
  const path=await fixture(t),journal=await openAlphaCheckpoint(path,scope);
  await journal.wrap(async()=>response({Accounts:[]}))(base+'Accounts',options);await journal.close();
  const saved=JSON.parse(await readFile(path,'utf8'));
  Object.values(saved.state.entries)[0].observedAt='invalid';
  saved.sha256=createHash('sha256').update(JSON.stringify(saved.state)).digest('hex');
  await writeFile(path,JSON.stringify(saved));
  await assert.rejects(openAlphaCheckpoint(path,scope),/Invalid alpha checkpoint response/);
});
test('real cursor paginator resumes failed cursor and duplicate provider IDs never count as complete',async t=>{
  const path=await fixture(t),now=()=>new Date('2026-09-20T10:00:00Z');let calls=0;
  let journal=await openAlphaCheckpoint(path,scope,{now});
  const reader=transport=>async(resource,query)=>{
    const url=new URL('https://api.gocardless.com/'+resource);
    for(const [key,value]of Object.entries(query))url.searchParams.set(key,value);
    return (await transport(url,options)).json();
  };
  await assert.rejects(readAllProviderPages(reader(journal.wrap(async url=>{
    calls++;
    if(url.searchParams.has('after'))throw Error('network interruption');
    return response({payments:[{id:'one'}],meta:{cursors:{after:'next'}}});
  })),'payments'),/interruption/);
  await journal.close();
  journal=await openAlphaCheckpoint(path,scope,{now});
  const result=await readAllProviderPages(reader(journal.wrap(async url=>{
    calls++;assert.equal(url.searchParams.get('after'),'next');
    return response({payments:[{id:'two'}],meta:{cursors:{after:null}}});
  })),'payments');
  assert.deepEqual(result.map(x=>x.id),['one','two']);assert.equal(calls,3);
  await journal.close();
  const duplicatePath=await fixture(t),duplicate=await openAlphaCheckpoint(duplicatePath,scope,{now});
  await assert.rejects(readAllProviderPages(reader(duplicate.wrap(async url=>response({
    payments:[{id:'same'}],meta:{cursors:{after:url.searchParams.has('after')?null:'next'}},
  }))),'payments'),/Duplicate/);
  await duplicate.close();
});
test('completed discovery retaining an old observation cannot satisfy final release freshness',async t=>{
  const path=await fixture(t);let instant=new Date('2026-09-20T10:00:00Z');
  let journal=await openAlphaCheckpoint(path,scope,{now:()=>instant});
  await journal.wrap(async()=>response({Accounts:[]}))(base+'Accounts',options);await journal.close();
  instant=new Date('2026-09-21T10:00:00Z');
  journal=await openAlphaCheckpoint(path,scope,{now:()=>instant});
  await journal.wrap(async()=>{throw Error('must reuse discovery');})(base+'Accounts',options);
  assert.throws(()=>assertAlphaEvidenceFresh({
    manifestSha256:ALPHA_MANIFEST_SHA256,members:[{memberId:'one'}],
    observedAt:journal.oldestObservedAt,completedAt:instant.toISOString(),
  },instant),/15 minutes/);
  await journal.close();
});
test('authenticated generations resume interrupted reads, reject account drift before replay, and invalidate rotated credentials',async t=>{
  const path=await fixture(t),now=()=>new Date('2026-09-20T10:00:00Z');
  const tokens=[{tenant_id:ALPHA_XERO_TENANT_ID,access_token:'xero-original'}];
  const credentials={source:'tenant',tenantId:TENANT_ID,environment:'live',accessToken:'live_gc'};
  let identities=0,reads=0,wrong=false;
  const identity=async url=>{
    identities++;
    return response(url.pathname==='/connections'
      ? [{id:'connection',tenantId:wrong?'wrong':ALPHA_XERO_TENANT_ID}]
      : {creditors:{id:'CR0000B50W1Y2R'}});
  };
  let checkpoint=await openAlphaCheckpoint(path,scope,{now});
  await authenticateAlphaProviderGeneration({tokens,credentials,transport:identity,checkpoint});
  const get=checkpoint.wrap(async url=>{
    reads++;if(new URL(url).searchParams.get('page')==='2')throw Error('interrupted');
    return response({Invoices:[{InvoiceID:'old'}]});
  });
  await get(base+'Invoices?page=1',options);
  await assert.rejects(get(base+'Invoices?page=2',options),/interrupted/);
  await checkpoint.close();
  checkpoint=await openAlphaCheckpoint(path,scope,{now});
  wrong=true;
  await assert.rejects(authenticateAlphaProviderGeneration({tokens,credentials,transport:identity,checkpoint}),/Xero connection/);
  assert.equal(reads,2);
  wrong=false;
  await authenticateAlphaProviderGeneration({tokens,credentials,transport:identity,checkpoint});
  const resumed=checkpoint.wrap(async()=>{reads++;return response({Invoices:[]});});
  await resumed(base+'Invoices?page=1',options);await resumed(base+'Invoices?page=2',options);
  assert.equal(reads,3);
  tokens[0].access_token='xero-rotated';
  await authenticateAlphaProviderGeneration({tokens,credentials,transport:identity,checkpoint});
  await resumed(base+'Invoices?page=1',options);
  assert.equal(reads,4);assert.equal(checkpoint.stats.invalidated,2);
  assert.equal(identities,7);
  const saved=await readFile(path,'utf8');
  assert.equal(saved.includes('xero-rotated'),false);assert.equal(saved.includes('live_gc'),false);
  await checkpoint.close();
});
test('final apply authentication forces fresh lists and sees new invoices despite a still-fresh dry run cache',async t=>{
  const path=await fixture(t),now=()=>new Date('2026-09-20T10:00:00Z');
  const tokens=[{tenant_id:ALPHA_XERO_TENANT_ID,access_token:'xero'}];
  const credentials={source:'tenant',tenantId:TENANT_ID,environment:'live',accessToken:'live_gc'};
  const transport=async url=>response(url.pathname==='/connections'
    ? [{id:'connection',tenantId:ALPHA_XERO_TENANT_ID}]:{creditors:{id:'CR0000B50W1Y2R'}});
  let checkpoint=await openAlphaCheckpoint(path,scope,{now});
  await authenticateAlphaProviderGeneration({tokens,credentials,transport,checkpoint});
  await checkpoint.wrap(async()=>response({Invoices:[]}))(base+'Invoices?page=1',options);
  await checkpoint.close();
  checkpoint=await openAlphaCheckpoint(path,scope,{now});
  await authenticateAlphaProviderGeneration({tokens,credentials,transport,checkpoint,forceFresh:true});
  let calls=0;
  const body=await (await checkpoint.wrap(async()=>{
    calls++;return response({Invoices:[{InvoiceID:'new-after-review',AmountDue:100}]});
  })(base+'Invoices?page=1',options)).json();
  assert.equal(calls,1);assert.equal(body.Invoices[0].InvoiceID,'new-after-review');
  await checkpoint.close();
});

let authenticManifest;
try{authenticManifest=JSON.parse(await readFile('exports/private-bnms-alpha-final-review-20260920/manifest.json','utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;}
test('readAlphaReleaseEvidence orchestration resumes interruption and final apply discovers a post-review invoice',
  {skip:!authenticManifest&&'Private exact alpha manifest unavailable'},async t=>{
    const checkpointPath=await fixture(t),manifest=authenticManifest;
    const instant=new Date('2026-09-21T10:00:00Z'),now=()=>instant;
    const tables={
      bnms_dd_alpha_adoption:[],bnms_dd_alpha_provider_history:[],bnms_dd_alpha_invoice_link:[],
      membership_payment_plans:[],membership_billing_agreements:[],member_membership_history:[],member:[],
      preference_field:[{id:'field',tenant_id:TENANT_ID,name:'member_class',entity_scope:'member',is_active:true}],
      member_preference_value:[],membership_tier_config:[],membership_tier_vat_override:[],
      system_settings:[],tenant_accounting_settings:[{active_provider:'xero',tenant_id:TENANT_ID}],
      xero_token:[{app_tenant_id:TENANT_ID,tenant_id:ALPHA_XERO_TENANT_ID,access_token:'test_xero',
        expires_at:'2026-09-21T11:00:00Z'}],
      tenant_integrations:[{tenant_id:TENANT_ID,integration_type:'gocardless',is_enabled:true,
        credentials:{environment:'live',access_token:'live_test',creditor_id:'CR0000B50W1Y2R'}}],
      gocardless_collection_reservations:[],gocardless_payments:[],
    };
    for(const m of manifest.members){
      const common={tenant_id:TENANT_ID,member_id:m.identity.memberId};
      tables.bnms_dd_alpha_adoption.push({...common,id:m.ids.adoption,mandate_id:m.identity.mandateId,
        customer_id:m.identity.customerId,plan_id:m.ids.plan,agreement_id:m.ids.agreement,history_id:m.ids.membership,
        manifest_sha256:ALPHA_MANIFEST_SHA256,evidence_sha256:hash(m),evidence:m});
      tables.bnms_dd_alpha_provider_history.push(...m.history.map(h=>({...h,adoption_id:m.ids.adoption})));
      tables.bnms_dd_alpha_invoice_link.push(...m.links);
      const provider={...common,provider:'gocardless',environment:'live',status:'first_payment_pending',
        gocardless_mandate_id:m.identity.mandateId,billing_agreement_id:m.ids.agreement};
      tables.membership_payment_plans.push({...provider,id:m.ids.plan,collection_stopped_at:instant.toISOString(),
        metadata:{bnms_release_required:true,bnms_alpha_held:true},dynamic_next_collection_date:'2026-10-01'});
      tables.membership_billing_agreements.push({...provider,id:m.ids.agreement,gocardless_customer_id:m.identity.customerId,
        metadata:{dd:m.dd}});
      tables.member_membership_history.push({...common,id:m.ids.membership,billing_agreement_id:m.ids.agreement,
        status:'pending_payment_setup',payment_status:'unpaid'});
      tables.member.push({...m.sourceMember,id:m.identity.memberId,tenant_id:TENANT_ID});
      tables.member_preference_value.push({member_id:m.identity.memberId,field_id:'field',
        value:m.structure.structure_match_value});
    }
    const db={supabaseUrl:'https://pinned-test.invalid',from(table){
      let values=tables[table]||[],single=false;
      const query={
        select(){return query;},order(){return query;},
        eq(key,value){values=values.filter(r=>r[key]===value);return query;},
        in(key,list){values=values.filter(r=>list.includes(r[key]));return query;},
        range(start,end){values=values.slice(start,end+1);return query;},
        maybeSingle(){single=true;return query;},single(){single=true;return query;},
        then(resolve){resolve({data:single?(values[0]||null):values,error:null});},
      };return query;
    }};
    const handover={tenantId:TENANT_ID,manifestSha256:ALPHA_MANIFEST_SHA256,
      memberIds:manifest.members.map(m=>m.identity.memberId),confirmedAt:instant.toISOString(),
      confirmedBy:'Test operator',evidenceReference:'Test attestation',automaticLegacyCollectionsDisabled:true,
      accountingApproval:{bankAccountId:ALPHA_BANK_ACCOUNT_ID,xeroTenantId:ALPHA_XERO_TENANT_ID,
        bankName:'GoCardless-GBP',approved:true}};
    const contact=manifest.members[0].links[0].xero_contact_id;
    let failOnce=true,addedInvoice=false,wrongAccount=false;
    const calls=[];
    const transport=async url=>{
      const target=new URL(url);calls.push(target.pathname+target.search);
      if(target.pathname==='/connections')return response([{id:'connection',tenantId:wrongAccount?'wrong':ALPHA_XERO_TENANT_ID}]);
      if(target.pathname.startsWith('/creditors/'))return response({creditors:{id:'CR0000B50W1Y2R'}});
      const resource=target.pathname.split('/').filter(Boolean).at(-1);
      if(['mandates','customers','payments','subscriptions'].includes(resource)){
        const field={mandates:'mandate',customers:'customer',payments:'payments',subscriptions:'subscriptions'}[resource];
        return response({[resource]:manifest.members.flatMap(m=>m[field]),meta:{cursors:{after:null}}});
      }
      if(resource==='Accounts')return response({Accounts:[{AccountID:ALPHA_BANK_ACCOUNT_ID,Type:'BANK',Status:'ACTIVE',CurrencyCode:'GBP'}]});
      if(target.pathname.includes('/Contacts/')){
        if(failOnce){failOnce=false;throw Error('simulated interruption');}
        return response({Contacts:[manifest.members.find(m=>m.links[0].xero_contact_id===resource).links[0].evidence.contact]});
      }
      if(resource==='Invoices'){
        assert.equal(target.searchParams.get('where'),ALPHA_INVOICE_WHERE);
        const ids=target.searchParams.get('ContactIDs').split(',');
        const invoices=manifest.members.flatMap(m=>m.links.map(l=>l.evidence.invoice))
          .filter(i=>ids.includes(i.Contact.ContactID));
        if(addedInvoice&&ids.includes(contact))invoices.push({
          InvoiceID:'new-after-dry-run',Contact:{ContactID:contact},DateString:'2026-10-01T00:00:00',
          Status:'AUTHORISED',AmountDue:100,
        });
        const page=Number(target.searchParams.get('page'));
        return response({Invoices:invoices.slice((page-1)*100,page*100)});
      }
      throw Error('Unexpected test provider endpoint');
    };
    const options={manifest,handover,checkpointPath,now,transport,sleep:async()=>{}};
    await assert.rejects(readAlphaReleaseEvidence(db,options),/simulated interruption/);
    const accountReads=()=>calls.filter(u=>u.endsWith('/Accounts')).length;
    assert.equal(accountReads(),1);
    wrongAccount=true;
    await assert.rejects(readAlphaReleaseEvidence(db,options),/Xero connection/);
    assert.equal(accountReads(),1);
    wrongAccount=false;
    const resumed=await readAlphaReleaseEvidence(db,options);
    assert.equal(accountReads(),1);
    assert.ok(resumed.checkpoint.reused>0);
    assert.equal(resumed.members.some(m=>m.futureInvoices.some(i=>i.id==='new-after-dry-run')),false);
    addedInvoice=true;
    const applied=await readAlphaReleaseEvidence(db,{...options,forceFresh:true});
    assert.equal(accountReads(),2);
    assert.equal(applied.members.some(m=>m.futureInvoices.some(i=>i.id==='new-after-dry-run')),true);
    assert.ok(applied.members.some(m=>m.blockers.includes('Future/outstanding Xero invoices require reconciliation')));
  });
test('canonical runner cooldown stops before proof loading or authenticated deployment verification',
  {skip:!process.env.DEST_SUPABASE_URL||!process.env.DEST_SUPABASE_KEY},async t=>{
    const checkpointPath=await fixture(t);
    const journal=await openAlphaCheckpoint(checkpointPath,scope,{seedRateLimit:
      diagnostic('2026-09-20T10:00:00Z',{value:'3153600000',format:'numeric'})});
    await journal.close();
    let calls=0;
    await assert.rejects(runAlphaRelease([
      '--manifest','does-not-exist.json','--handover','does-not-exist.json',
      '--proof','does-not-exist.json','--out',checkpointPath+'.result',
      '--checkpoint',checkpointPath,
    ],process.env,{vercelRequest:async()=>{calls++;throw Error('must not verify deployment');}}),/retry prohibited/);
    assert.equal(calls,0);
  });