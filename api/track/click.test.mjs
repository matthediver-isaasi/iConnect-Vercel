import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function load(relative, database) {
  let source=await readFile(new URL(relative,import.meta.url),'utf8');
  source=source.replace(/import \{ supabase \} from '[^']+';/,`const supabase = globalThis.__clickTestDatabase;`);
  source=source.replace(/from '[^']*emailDeliveryClassification.js'/,`from '${new URL('../_lib/emailDeliveryClassification.js',import.meta.url).href}'`);
  source=source.replace(/from '[^']*campaignEngagement.js'/,`from '${new URL('../_lib/campaignEngagement.js',import.meta.url).href}'`);
  globalThis.__clickTestDatabase=database;
  const module=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
  delete globalThis.__clickTestDatabase;
  return module;
}
const campaign='11111111-1111-4111-8111-111111111111', recipient='22222222-2222-4222-8222-222222222222';
const token=Buffer.from(`${campaign}:${recipient}:0`).toString('base64url');
test('tracked request persists once, scopes recipient and preserves encoded destinations',async()=>{
  const writes=[],filters=[];
  const db={from(table){return {
    select(){return this;}, eq(...args){filters.push(args);return this;},
    async maybeSingle(){return {data:{id:recipient,member_id:null}};},
    async insert(row){writes.push({table,row});return {};}
  };}};
  const {default:handler,decodeTrackingToken}=await load('./click.js',db);
  let location;
  const res={setHeader(){},redirect(code,url){assert.equal(code,302);location=url;},status(){return this;},json(){}};
  const url='https://example.invalid/a?value=a%26b&other=%2525';
  await handler({method:'GET',headers:{},query:{t:token,url}},res);
  assert.equal(location,url);
  assert.equal(writes.length,1);
  assert.equal(writes[0].table,'email_link_click');
  assert.equal(writes[0].row.original_url,url);
  assert.ok(filters.some(([k,v])=>k==='campaign_id'&&v===campaign));
  assert.equal(decodeTrackingToken('garbage'),null);
  assert.equal(decodeTrackingToken(Buffer.from(`${campaign}:${recipient}:1oops`).toString('base64url')),null);
});
test('provider clicks cannot mutate counters, delivery or timestamps in sync',async()=>{
  const {applyEventToRecipientState,buildRecipientState}=await load('../_lib/mailgunEventSync.js',null);
  const state=buildRecipientState({id:recipient,click_count:4,status:'sent'});
  const before=structuredClone(state);
  for(let i=0;i<3;i++)applyEventToRecipientState(state,{event:'clicked',id:'event'},'2026-01-01T00:00:00Z');
  assert.deepEqual(state,before);
});
test('rewritten relative campaign links redirect unchanged on the tenant host',async()=>{
  const service=await readFile(new URL('../_lib/campaignService.js',import.meta.url),'utf8');
  const section=service.slice(service.indexOf('export function generateTrackingToken('),
    service.indexOf('// Helper to fetch all members with pagination'));
  const rewrite=new Function('getTenantBaseUrl','isStandaloneCampaignPreferencePlaceholder',
    `${section.replaceAll('export function','function')}; return rewriteLinksForTracking;`)(
      ()=>'https://tenant.example.invalid',()=>false);
  const destination='/events?category=training&value=a%26b';
  const html=rewrite('<a href="/events?category=training&amp;value=a%26b">Events</a>',campaign,recipient,'tenant');
  const tracked=new URL(html.match(/href="([^"]+)"/)[1]);
  const records=[];
  const db={from(){return {
    select(){return this;},eq(){return this;},
    async maybeSingle(){return {data:{id:recipient,member_id:null}};},
    async insert(row){records.push(row);return {};}
  };}};
  const {default:handler}=await load('./click.js',db);
  let location;
  await handler({method:'GET',headers:{},query:Object.fromEntries(tracked.searchParams)},
    {setHeader(){},redirect(code,url){assert.equal(code,302);location=url;},
      status(code){assert.fail(`Unexpected status ${code}`);}});
  assert.equal(location,destination);
  assert.equal(new URL(location,tracked).origin,'https://tenant.example.invalid');
  assert.equal(records[0].original_url,destination);
  assert.equal(records.length,1);
});
test('relative-path support does not allow executable URLs or header injection',async()=>{
  const {default:handler}=await load('./click.js',null);
  for(const url of ['javascript:alert(1)','data:text/html,test','/events\r\nX-Test: injected','']) {
    let status;
    await handler({method:'GET',headers:{},query:{url}},
      {status(code){status=code;return this;},json(){},redirect(){assert.fail('Unsafe redirect');}});
    assert.equal(status,400);
  }
});
test('click webhook retries retain evidence without recipient/campaign counter writes',async()=>{
  const writes=[];
  const db={from(table){return {
    select(){return this;},eq(){return this;},
    async single(){return {data:table==='email_campaign_recipient'?{id:recipient,campaign_id:campaign}:{id:campaign,tenant_id:campaign}};},
    async insert(row){writes.push({table,row});return {};}
  };}};
  const {default:handler}=await load('../webhooks/mailgun.js',db);
  const response={status(code){assert.equal(code,200);return this;},json(){}};
  const req={method:'POST',body:{'event-data':{event:'clicked',id:'event',recipient:'fixture@example.invalid',message:{headers:{'message-id':'<message>'}}}}};
  await handler(req,response);await handler(req,response);
  assert.equal(writes.length,2); // database owns durable deduplication
  assert.ok(writes.every(w=>w.table==='email_event'));
});
test('failed evidence persistence requests a webhook retry',async(t)=>{
  t.mock.method(console,'error',()=>{});
  const db={from(){return {
    select(){return this;},eq(){return this;},
    async single(){return {data:null};},
    async insert(){return {error:{message:'fixture failure'}};}
  };}};
  const {default:handler}=await load('../webhooks/mailgun.js',db);
  let status;
  await handler({method:'POST',body:{event:'clicked',id:'fixture',recipient:'fixture@example.invalid'}},
    {status(value){status=value;return this;},json(){}});
  assert.equal(status,500);
});
