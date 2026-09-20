import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {ALPHA_MANIFEST_SHA256,PROCESSING_NOT_BEFORE,MAX_EVIDENCE_AGE_MS,
  ALPHA_BANK_ACCOUNT_ID,ALPHA_XERO_TENANT_ID,validateAlphaBankApproval,boundedAlphaTransport,
  assertAlphaStageFresh,validateAlphaHandover,validateAlphaReleaseScope,readAlphaStage,assertAlphaEvidenceFresh,
  alphaReleaseManifest,releaseAlpha,alphaStateHash,verifyAlphaReleaseSchema,
  alphaHistoricalInvoiceUnchanged,assertAlphaLiveContact,alphaSchemaBundle,INVOICE_MIGRATION_SHA256,
  } from './bnms-dd-alpha-release.mjs';
import {parseAlphaReleaseArgs} from './run-bnms-dd-alpha-release.mjs';
import {TENANT_ID} from './bnms-dd-pilot.mjs';
import {alphaAccountingMapping} from '../api/_lib/bnmsAlphaAccounting.js';
import {hash} from './bnms-dd-beta-invoices.mjs';

const now=new Date('2026-09-20T12:00:00Z');
const stage=(ids=['a'])=>({manifestSha256:ALPHA_MANIFEST_SHA256,memberIds:ids,
  observedAt:'2026-09-20T11:59:00Z',completedAt:now.toISOString(),complete:true});
const handover=()=>({tenantId:TENANT_ID,manifestSha256:ALPHA_MANIFEST_SHA256,memberIds:['a'],
  confirmedAt:now.toISOString(),confirmedBy:'test administrator',evidenceReference:'test attestation',
  automaticLegacyCollectionsDisabled:true});

test('Processing gate is October 1 midnight London, not a charge-date requirement',()=>{
  assert.equal(PROCESSING_NOT_BEFORE,'2026-09-30T23:00:00Z');
});
test('CLI defaults read-only and requires separate exact approvals for schema and arming',()=>{
  for(const flag of ['--apply','--migration','--release','--tenant','--member','--skip-checks'])
    assert.throws(()=>parseAlphaReleaseArgs(['--manifest','input.json','--out','exports/new.json',flag]));
  assert.throws(()=>parseAlphaReleaseArgs(['--manifest','input.json','--out','/tmp/public.json']));
  assert.throws(()=>parseAlphaReleaseArgs(['--manifest','input.json','--out','exports/new.json','--out','exports/other.json']));
  const base=['--manifest','input.json','--out','exports/new.json','--proof','proof.json','--handover','handover.json'];
  assert.equal(parseAlphaReleaseArgs(base).apply,false);
  assert.equal(parseAlphaReleaseArgs([...base,'--apply',`--review-sha256=${'a'.repeat(64)}`]).apply,true);
  assert.deepEqual(parseAlphaReleaseArgs(['--schema']),{schema:true,apply:false});
  assert.throws(()=>parseAlphaReleaseArgs(['--schema','--apply']),/hash|SHA/);
  assert.throws(()=>parseAlphaReleaseArgs([...base,'--schema']),/separate/);
  assert.throws(()=>parseAlphaReleaseArgs([...base,'--replay','saved.json']),/Replay/);
  assert.equal(parseAlphaReleaseArgs(['--replay','saved.json','--out','exports/replay.json',
    `--review-sha256=${'b'.repeat(64)}`]).apply,false);
});
test('Unpinned/generated manifests and beta-sized scope fail closed',()=>{
  assert.throws(()=>validateAlphaReleaseScope({tenantId:TENANT_ID,members:Array(10).fill({})},[]),/immutable/);
});
test('Missing or beta-only handover cannot authorize alpha',()=>{
  assert.throws(()=>validateAlphaHandover(null,['a'],now),/exact-alpha/);
  const h=handover();h.manifestSha256='beta';assert.throws(()=>validateAlphaHandover(h,['a'],now));
  delete h.manifestSha256;h.batchHash=ALPHA_MANIFEST_SHA256;assert.throws(()=>validateAlphaHandover(h,['a'],now));
});
test('Handover exact scope, date and evidence are mandatory',()=>{
  validateAlphaHandover(handover(),['a'],now);
  for(const patch of [{memberIds:['b']},{memberIds:['a','a']},{confirmedBy:''},{evidenceReference:''},
    {confirmedAt:'2026-09-19T11:59:59Z'},{confirmedAt:'2026-09-20T12:01:00Z'},
    {automaticLegacyCollectionsDisabled:false}]){
    assert.throws(()=>validateAlphaHandover({...handover(),...patch},['a'],now));
  }
});
test('Freshness retains oldest stage time across resume and final transaction',()=>{
  assertAlphaStageFresh([stage(['a']),stage(['b'])],['a','b'],now);
  const stale={...stage(),observedAt:new Date(now.getTime()-MAX_EVIDENCE_AGE_MS-1).toISOString()};
  assert.throws(()=>assertAlphaStageFresh([stale],['a'],now),/15 minutes/);
  assert.throws(()=>assertAlphaStageFresh([stage()],['a'],new Date(now.getTime()+MAX_EVIDENCE_AGE_MS)));
});
test('Partial, duplicate, wrong-batch and future stages never count as final readiness',()=>{
  for(const stages of [[stage(['a'])],[stage(['a']),stage(['a'])],
    [{...stage(['a','b']),complete:false}],[{...stage(['a','b']),manifestSha256:'beta'}],
    [{...stage(['a','b']),completedAt:'2026-09-20T13:00:00Z'}]]){
    assert.throws(()=>assertAlphaStageFresh(stages,['a','b'],now));
  }
});
test('Staging is bounded and stops at provider rate limits, preserving prior reads',async()=>{
  const seen=[];
  const result=await readAlphaStage(['a','b','c'],async id=>{
    seen.push(id);if(id==='b')throw Object.assign(Error('secret must not escape'),{status:429});return {ok:true};
  },{now:()=>now});
  assert.deepEqual(seen,['a','b']);assert.equal(result.complete,false);
  assert.equal(result.evidence.length,1);assert.match(result.blocker,/rate limit/);
  assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(readAlphaStage(Array.from({length:26},(_,i)=>String(i)),async()=>null));
});
test('Stage cannot finish fresh if its final read exhausts time budget',async()=>{
  let clock=now;
  const result=await readAlphaStage(['a'],async()=>{clock=new Date(now.getTime()+MAX_EVIDENCE_AGE_MS+1);return {};},{now:()=>clock});
  assert.equal(result.complete,false);assert.equal(result.observedAt,now.toISOString());
});

test('Bank approval is alpha-specific, exact account and cannot be inferred from handover alone',()=>{
  const h={...handover(),accountingApproval:{approved:true,bankAccountId:ALPHA_BANK_ACCOUNT_ID,
    xeroTenantId:ALPHA_XERO_TENANT_ID,bankName:'GoCardless-GBP'}};
  validateAlphaBankApproval(h,['a'],now);
  assert.throws(()=>validateAlphaBankApproval(handover(),['a'],now),/accounting approval/);
  for(const patch of [{approved:false},{bankAccountId:'different'},{xeroTenantId:'different'},{bankName:'generic'}])
    assert.throws(()=>validateAlphaBankApproval({...h,accountingApproval:{...h.accountingApproval,...patch}},['a'],now));
});

test('Final evidence age includes elapsed review/transaction time and handover age',()=>{
  const h={...handover(),accountingApproval:{approved:true,bankAccountId:ALPHA_BANK_ACCOUNT_ID,
    xeroTenantId:ALPHA_XERO_TENANT_ID,bankName:'GoCardless-GBP'}};
  const report={manifestSha256:ALPHA_MANIFEST_SHA256,members:[{memberId:'a'}],handover:h,
    observedAt:new Date(now.getTime()-1000).toISOString(),completedAt:now.toISOString()};
  assertAlphaEvidenceFresh(report,now);
  assert.throws(()=>assertAlphaEvidenceFresh(report,new Date(now.getTime()+MAX_EVIDENCE_AGE_MS)),/15 minutes/);
  assert.throws(()=>assertAlphaEvidenceFresh({...report,observedAt:'invalid'},now));
  assert.throws(()=>assertAlphaEvidenceFresh({...report,handover:{...h,confirmedAt:'2026-09-19T11:59:59Z'}},now));
});

test('Provider transport permits only pinned HTTPS GET and bounded requests',async()=>{
  let calls=0;
  const get=boundedAlphaTransport({observedAt:now.toISOString(),now:()=>now,sleep:async()=>{},
    maxRequests:1,transport:async()=>{calls++;return {ok:true};}});
  for(const [url,method]of [['https://api.xero.com/a','POST'],['https://attacker.example/a','GET'],
    ['http://api.xero.com/a','GET'],['https://user@api.xero.com/a','GET']])
    await assert.rejects(get(url,{method}),/GET/);
  assert.equal(calls,0);
  await get('https://api.xero.com/api.xro/2.0/Accounts',{method:'GET'});
  await assert.rejects(get('https://api.xero.com/api.xro/2.0/Accounts',{method:'GET'}),/budget/);
  assert.equal(calls,1);
});

test('Provider transport does not retry 429 or expose provider bodies',async()=>{
  let calls=0;
  const get=boundedAlphaTransport({observedAt:now.toISOString(),now:()=>now,
    transport:async()=>{calls++;return {ok:false,status:429,json:async()=>({token:'not visible'})};}});
  await assert.rejects(get('https://api.gocardless.com/mandates',{method:'GET'}),error=>{
    assert.equal(error.status,429);assert.match(error.message,/rate limit/);assert.ok(!error.message.includes('token'));return true;
  });
  assert.equal(calls,1);
});

test('Pacing consumes original freshness budget and never advances observation time',async()=>{
  let clock=now,calls=0;
  const get=boundedAlphaTransport({observedAt:now.toISOString(),now:()=>clock,
    sleep:async()=>{clock=new Date(now.getTime()+MAX_EVIDENCE_AGE_MS);},
    transport:async()=>{calls++;return {ok:true};}});
  await get('https://api.xero.com/api.xro/2.0/Accounts',{method:'GET'});
  await assert.rejects(get('https://api.xero.com/api.xro/2.0/Invoices',{method:'GET'}),/15 minutes/);
  assert.equal(calls,1);
});

test('429 diagnostics retain only safe timing, request identifiers and route templates',async()=>{
  for(const [host,path,provider,endpoint]of [
    ['api.xero.com','/api.xro/2.0/Contacts/private-member?email=private-email','Xero','/api.xro/2.0/Contacts/:id'],
    ['api.gocardless.com','/mandates/private-member?token=private-token','GoCardless','/mandates/:id'],
  ]){
    let calls=0,bodyRead=false;
    const get=boundedAlphaTransport({observedAt:now.toISOString(),now:()=>now,
      transport:async()=>{calls++;return {ok:false,status:429,headers:new Headers({
        'retry-after':'60','x-ratelimit-reset':'1789918800','x-request-id':'safe-request_123',
        authorization:'Bearer private-token','set-cookie':'private-cookie',
        'x-correlation-id':'private@email.example',
      }),json:async()=>{bodyRead=true;return {secret:'private-body'};}};}});
    await assert.rejects(get(`https://${host}${path}`,{method:'GET'}),error=>{
      const d=error.rateLimitDiagnostic;
      assert.equal(d.provider,provider);assert.equal(d.endpoint,endpoint);
      assert.equal(d.observedAt,now.toISOString());assert.equal(d.status,429);
      assert.deepEqual(d.retryAfter,{value:'60',format:'numeric'});
      assert.deepEqual(d.resetHeaders['x-ratelimit-reset'],{value:'1789918800',format:'numeric'});
      assert.equal(d.resetHeaders['ratelimit-reset'],null);
      assert.equal(d.requestIds['x-request-id'],'safe-request_123');
      assert.equal(d.requestIds['x-correlation-id'],null);
      assert.doesNotMatch(JSON.stringify(d),/private|authorization|set-cookie|email|token/i);
      return true;
    });
    assert.equal(calls,1);assert.equal(bodyRead,false);
  }
});

test('429 diagnostics handle absent, HTTP-date and invalid timing without guessing reset semantics',async()=>{
  for(const [value,expected]of [
    [null,null],
    ['Sun, 20 Sep 2026 16:00:00 GMT',{value:'Sun, 20 Sep 2026 16:00:00 GMT',format:'http-date'}],
    ['0',{value:'0',format:'numeric'}],
    ['secret@example.com',{value:null,format:'discarded-invalid'}],
    ['-1',{value:null,format:'discarded-invalid'}],
  ]){
    const get=boundedAlphaTransport({observedAt:now.toISOString(),now:()=>now,
      transport:async()=>({ok:false,status:429,headers:new Headers(value===null?{}:{'retry-after':value})})});
    await assert.rejects(get('https://api.xero.com/unknown/private-id?email=private',{method:'GET'}),error=>{
      assert.deepEqual(error.rateLimitDiagnostic.retryAfter,expected);
      assert.equal(error.rateLimitDiagnostic.endpoint,'[unrecognized route]');
      assert.ok(Object.values(error.rateLimitDiagnostic.resetHeaders).every(x=>x===null));
      assert.ok(Object.values(error.rateLimitDiagnostic.requestIds).every(x=>x===null));
      return true;
    });
  }
});

test('Canonical hashes ignore audit time and row order but retain economic changes',()=>{
  const one={member:[{id:'b',status:'active',updated_at:'old'},{id:'a',status:'active'}]};
  const two={member:[{id:'a',status:'active'},{id:'b',status:'active',updated_at:'new'}]};
  assert.equal(alphaStateHash(one),alphaStateHash(two));
  two.member[1].status='cancelled';
  assert.notEqual(alphaStateHash(one),alphaStateHash(two));
});

test('Unpinned report cannot enter even a dry-run release transaction',async()=>{
  let calls=0;
  const c={query:async()=>{calls++;throw Error('must not query');}};
  await assert.rejects(alphaReleaseManifest({tenantId:TENANT_ID,manifestSha256:ALPHA_MANIFEST_SHA256,manifest:{members:[]}},{}),/immutable/);
  await assert.rejects(releaseAlpha(c,{},{}),/immutable/);
  assert.equal(calls,0);
});

test('Schema approval covers both migrations and strips only pinned outer invoice transaction',async()=>{
  const bundle=await alphaSchemaBundle();
  assert.equal(bundle.migrations.length,2);
  assert.equal(bundle.migrations[1].sha256,INVOICE_MIGRATION_SHA256);
  assert.equal(bundle.hash,hash(bundle.migrations));
  assert.notEqual(bundle.hash,bundle.migrations[0].sha256);
  assert.ok(!/^BEGIN;/.test(bundle.invoiceSql));
  assert.ok(!/\bCOMMIT;\s*$/.test(bundle.invoiceSql));
  assert.match(bundle.invoiceSql,/bnms_alpha_claim_invoice/);
});

// Optional authentic-data contract test: private member exports are deliberately
// not copied into source control. All interactions below are local/fake clients.
let approvedManifest;
try{
  approvedManifest=JSON.parse(await readFile(process.env.BNMS_ALPHA_TEST_MANIFEST
    ||'exports/private-bnms-alpha-final-review-20260920/manifest.json','utf8'));
}catch(error){if(error.code!=='ENOENT')throw error;}
function authenticReport(){
  const manifest=structuredClone(approvedManifest);
  return {tenantId:TENANT_ID,manifestSha256:ALPHA_MANIFEST_SHA256,manifest,globalBlockers:[],
    members:manifest.members.map(m=>{
      const revenue={Full:'200','Full with NMC':'200','Full junior':'201','Full junior with NMC':'201'}[m.structure.structure_match_value];
      return {adoptionId:m.ids.adoption,memberId:m.identity.memberId,planId:m.ids.plan,agreementId:m.ids.agreement,
        historyId:m.ids.membership,mandateId:m.identity.mandateId,customerId:m.identity.customerId,
        adoptionHash:'a'.repeat(64),price:{monthly_amount_minor:m.monthlyQuoteMinor,currency:'GBP'},blockers:[],
        provider:{mandate:m.mandate},historicalInvoiceCount:m.history.length,
        accounting:{mapping:alphaAccountingMapping(revenue),bankAccountId:ALPHA_BANK_ACCOUNT_ID,
          xeroTenantId:ALPHA_XERO_TENANT_ID,revenueCode:revenue,contactId:m.links[0].xero_contact_id,
          contact:assertAlphaLiveContact(m.links,m.links[0].evidence.contact,m.identity.memberId)}};
    })};
}
const testProof={deploymentId:'dpl_test',commit:'a'.repeat(40),sourceHashes:{'api/_lib/bnmsAlphaAccounting.js':'b'.repeat(64)}};
test('Authentic pinned alpha scope produces exact249 release manifest and rejects owner/mapping drift',
  {skip:!approvedManifest&&'Private immutable alpha manifest not available'},async()=>{
    const report=authenticReport(),manifest=await alphaReleaseManifest(report,testProof);
    assert.equal(manifest.members.length,249);
    assert.equal(manifest.members.reduce((n,m)=>n+m.historicalInvoiceCount,0),2137);
    assert.equal(manifest.processingNotBefore,PROCESSING_NOT_BEFORE);
    const before=hash(manifest);
    report.members[0].accounting.mapping.bank_account_id='different';
    await assert.rejects(alphaReleaseManifest(report,testProof),/accounting/);
    const report2=authenticReport();report2.members[0].agreementId=report2.members[1].agreementId;
    await assert.rejects(alphaReleaseManifest(report2,testProof),/owner/);
    assert.equal(hash(await alphaReleaseManifest(authenticReport(),testProof)),before);
  });
test('Historical financial recheck ignores audit edits but blocks refunds, missing payments and line changes',
  {skip:!approvedManifest&&'Private immutable alpha manifest not available'},()=>{
    for(const member of approvedManifest.members)
      for(const link of member.links)assert.equal(alphaHistoricalInvoiceUnchanged(link,link.evidence.invoice),true);
    const link=approvedManifest.members[0].links[0],invoice=link.evidence.invoice;
    assert.equal(alphaHistoricalInvoiceUnchanged(link,{...invoice,UpdatedDateUTC:'changed'}),true);
    for(const patch of [{AmountCredited:1},{AmountDue:1},{Payments:[]},{Status:'VOIDED'},{Total:999},
      {Contact:{ContactID:'different'}},{LineItems:invoice.LineItems.map(line=>({...line,AccountCode:'999'}))},
      {CreditNotes:[{CreditNoteID:'credit'}]}])
      assert.equal(alphaHistoricalInvoiceUnchanged(link,{...invoice,...patch}),false);
  });
test('Live Xero contact must have exact immutable owner, active status and email; names cannot authorize a match',
  {skip:!approvedManifest&&'Private immutable alpha manifest not available'},()=>{
    const member=approvedManifest.members[0],contact=member.links[0].evidence.contact;
    for(const m of approvedManifest.members)
      assertAlphaLiveContact(m.links,m.links[0].evidence.contact,m.identity.memberId);
    assert.doesNotThrow(()=>assertAlphaLiveContact(member.links,{...contact,Name:'Renamed same owner'},member.identity.memberId));
    for(const patch of [{ContactID:'00000000-0000-4000-8000-000000000000'},{ContactStatus:'ARCHIVED'},
      {EmailAddress:''},{EmailAddress:'different-owner@example.test'}])
      assert.throws(()=>assertAlphaLiveContact(member.links,{...contact,...patch},member.identity.memberId),/exact immutable/);
    assert.throws(()=>assertAlphaLiveContact([...member.links,{...member.links[0],member_id:'other'}],contact,member.identity.memberId));
    assert.throws(()=>assertAlphaLiveContact([{...member.links[0],xero_tenant_id:'other'}],contact,member.identity.memberId));
    assert.throws(()=>assertAlphaLiveContact([],contact,member.identity.memberId));
  });
test('Missing schema dry run cannot arm; apply requires review and verified destination before transaction',
  {skip:!approvedManifest&&'Private immutable alpha manifest not available'},async()=>{
    const seen=[],c={query:async sql=>{seen.push(sql);return {rows:[{ready:false}]};}};
    const report=authenticReport();
    const result=await releaseAlpha(c,report,testProof);
    assert.equal(result.mode,'schema_required');assert.equal(result.writes,0);
    assert.equal(seen.at(-1),'ROLLBACK');
    assert.ok(!seen.some(sql=>sql.startsWith('INSERT')||sql.startsWith('UPDATE')||sql==='COMMIT'));
    seen.length=0;
    await assert.rejects(releaseAlpha(c,report,testProof,{apply:true,reviewSha256:result.hash}),/Verified DEST/);
    assert.equal(seen.length,0);
    await assert.rejects(releaseAlpha(c,report,testProof,{apply:true,reviewSha256:result.hash,verifiedDestination:true}),/schema required/);
    assert.equal(seen.at(-1),'ROLLBACK');
  });

test('Disposable installed alpha catalog verifies exact function bodies, trigger events and security',
  {timeout:60000},async()=>{
    const root=await mkdtemp(`${tmpdir()}/alpha-release-catalog-`),data=`${root}/data`;
    let c,started=false;
    const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);};
    try{
      run('initdb',['-D',data,'--no-locale','--encoding=UTF8','--auth=trust','-U','postgres']);
      run('pg_ctl',['-D',data,'-l',`${root}/postgres.log`,'-o',`-k ${root} -h '' -p 5417`,'-w','start']);started=true;
      c=new pg.Client({host:root,port:5417,user:'postgres',database:'postgres'});await c.connect();
      await c.query(`SET timezone='UTC'; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE member(id uuid PRIMARY KEY);
        CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY);
        CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY);
        CREATE TABLE member_membership_history(id uuid PRIMARY KEY);
        CREATE TABLE gocardless_payments(id uuid PRIMARY KEY);
        CREATE TABLE gocardless_collection_reservations(id uuid PRIMARY KEY,plan_id uuid);`);
      const history=await readFile(new URL('../supabase/migrations/20261108_bnms_dd_pilot_history.sql',import.meta.url),'utf8');
      const reject=history.match(/CREATE (?:OR REPLACE )?FUNCTION public\.bnms_dd_reject_history_mutation\(\) RETURNS trigger[\s\S]*?\$\$;/)[0];
      await c.query(reject);
      const held=await readFile(new URL('../supabase/migrations/20261113_bnms_dd_alpha_held.sql',import.meta.url),'utf8');
      await c.query(held);
      const bundle=await alphaSchemaBundle();
      await c.query('BEGIN');await c.query(bundle.releaseSql);await c.query(bundle.invoiceSql);await c.query('ROLLBACK');
      assert.deepEqual((await c.query(`SELECT to_regclass('public.bnms_dd_alpha_release') AS release,
        to_regclass('public.bnms_alpha_invoice_operations') AS invoice`)).rows[0],{release:null,invoice:null});
      await c.query('BEGIN');await c.query(bundle.releaseSql);
      await assert.rejects(verifyAlphaReleaseSchema(c),/Mandatory alpha invoice-operation schema missing/);
      await c.query(bundle.invoiceSql);await verifyAlphaReleaseSchema(c);await c.query('COMMIT');
      await verifyAlphaReleaseSchema(c);
      for(const tamper of [
        'ALTER TABLE bnms_dd_alpha_release DISABLE ROW LEVEL SECURITY',
        'GRANT INSERT ON bnms_dd_alpha_release TO service_role',
        'ALTER TABLE membership_payment_plans DISABLE TRIGGER bnms_dd_alpha_plan_hold',
        `CREATE OR REPLACE FUNCTION bnms_dd_alpha_release_owner_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN RETURN NEW; END $$`,
        'ALTER FUNCTION bnms_dd_alpha_hold_guard() SECURITY DEFINER',
        'ALTER TABLE bnms_dd_alpha_release ALTER COLUMN evidence DROP NOT NULL',
        'CREATE POLICY unsafe ON bnms_dd_alpha_release USING(true)',
        'ALTER TABLE bnms_dd_alpha_release DROP CONSTRAINT bnms_dd_alpha_release_plan_id_key',
        'DROP TABLE bnms_alpha_invoice_operations',
        'GRANT EXECUTE ON FUNCTION bnms_alpha_claim_invoice(uuid,uuid,text,jsonb) TO PUBLIC',
        'GRANT EXECUTE ON FUNCTION bnms_alpha_link_invoice(uuid,uuid,text) TO authenticated',
        'REVOKE EXECUTE ON FUNCTION bnms_alpha_assert_invoice(uuid,uuid,text,text,text) FROM service_role',
        'ALTER FUNCTION bnms_alpha_claim_invoice(uuid,uuid,text,jsonb) SECURITY INVOKER',
        'ALTER FUNCTION bnms_alpha_claim_invoice(uuid,uuid,text,jsonb) STRICT',
        'ALTER FUNCTION bnms_alpha_assert_invoice(uuid,uuid,text,text,text) OWNER TO service_role',
        'ALTER FUNCTION bnms_alpha_claim_invoice(uuid,uuid,text,jsonb) SET search_path=pg_temp,public',
        `CREATE FUNCTION bnms_alpha_claim_invoice(integer) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$`,
        `CREATE OR REPLACE FUNCTION bnms_alpha_link_invoice(p_operation uuid,p_token uuid,p_invoice text)
          RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN '{}'::jsonb; END $$`,
        'GRANT UPDATE ON bnms_alpha_invoice_operations TO service_role',
        'GRANT UPDATE(request_identity) ON bnms_alpha_invoice_operations TO service_role',
        'ALTER TABLE bnms_alpha_invoice_operations DISABLE ROW LEVEL SECURITY',
        'ALTER TABLE bnms_alpha_invoice_operations DROP CONSTRAINT bnms_alpha_invoice_operations_payment_id_key',
        `ALTER TABLE bnms_alpha_invoice_operations DROP CONSTRAINT bnms_alpha_invoice_operations_plan_id_fkey;
          ALTER TABLE bnms_alpha_invoice_operations ADD FOREIGN KEY(plan_id) REFERENCES member(id)`,
        'ALTER TABLE bnms_alpha_invoice_operations ALTER COLUMN request_identity DROP NOT NULL',
        'ALTER TABLE bnms_alpha_invoice_operations ALTER COLUMN claim_token DROP DEFAULT',
      ]){
        await c.query('BEGIN');await c.query(tamper);
        await assert.rejects(verifyAlphaReleaseSchema(c),/Alpha|alpha/);
        await c.query('ROLLBACK');await verifyAlphaReleaseSchema(c);
      }
    }finally{
      if(c)await c.end();
      if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
      await rm(root,{recursive:true,force:true});
    }
  });