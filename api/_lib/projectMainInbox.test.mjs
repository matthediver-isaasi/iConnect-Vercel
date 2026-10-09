import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { projectMessageHtml } from './projectMainInbox.js';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const ctx = { memberId: id(1), tenantId: id(2), roleId: null };
let fixture;
const handlers = {};
// Bundle actual handlers; only auth, database transport and unrelated email
// rendering are replaced. Never connect to a live database/provider.
globalThis.__projectMainInboxTest = {
  get db() { return fixture.db; },
  context: () => ctx,
};
for (const endpoint of ['index','[id]','search','unread-count']) {
  const output = await build({
    entryPoints: [`api/communication/inbox/${endpoint}.js`], bundle:true,write:false,
    format:'cjs',platform:'node',packages:'external',logLevel:'silent',
    plugins:[{ name:'isolated-inbox',setup(b) {
      b.onLoad({filter:/\/_lib\/database\.js$/},()=>({contents:'export const supabase = {from(...a){return globalThis.__projectMainInboxTest.db.from(...a)}};'}));
      b.onLoad({filter:/\/_lib\/tenantContext\.js$/},()=>({contents:'export const getTenantContext = async()=>globalThis.__projectMainInboxTest.context(); export const hasFeatureAccess=async()=>true;'}));
      b.onLoad({filter:/\/_lib\/campaignService\.js$/},()=>({contents:'export const stripHiddenDynamicRegions=x=>x; export const applyDynamicSlotValues=x=>x;'}));
      b.onLoad({filter:/\/_lib\/transactionalInbox\.js$/},()=>({contents:'export const resolveTransactionalInboxLabel=()=> "Notifications";'}));
    }}],
  });
  const mod = new Module(`${process.cwd()}/isolated-main-inbox.cjs`);
  mod.filename = `${process.cwd()}/isolated-main-inbox.cjs`;
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(output.outputFiles[0].text,mod.filename);
  handlers[endpoint] = mod.exports.default;
}
after(()=>delete globalThis.__projectMainInboxTest);

function setup({ identity = id(3), revoked = false } = {}) {
  const project = { id:id(4),recipient_id:id(3),board_id:id(5),card_id:id(6),
    content:'Please review <script>alert(1)</script> & budget',author_name:'Author',
    created_at:'2026-10-09T14:00:00Z',read_at:null,pinned_at:null,is_archived:false,is_favourite:false,folder_id:null,
    tenant_id:ctx.tenantId,board_name:'Launch',card_title:'Budget' };
  const tables = {
    member:[{id:ctx.memberId,tenant_id:ctx.tenantId,identity_id:identity}],
    project_mention_inbox:[project,{...project,id:id(7),tenant_id:id(9)}],
    email_campaign_recipient:[], member_inbox_message_state:[], member_transactional_message:[], member_inbox_folder:[],
  };
  const calls=[];
  const db={from(table) {
    const call={table,filters:[],patch:null};calls.push(call);
    let single=false, count=false, start=0,end=Infinity,limit=Infinity,upsert=null;
    const q={
      select(_s,opts){count=!!opts?.count;return q;},
      eq(k,v){call.filters.push([k,'eq',v]);return q;},
      is(k,v){call.filters.push([k,'eq',v]);return q;},
      in(k,v){call.filters.push([k,'in',v]);return q;},
      not(k,_op,v){call.filters.push([k,'not',v]);return q;},
      or(){return q;}, order(){return q;},
      limit(v){limit=v;return q;},range(a,b){start=a;end=b;return q;},
      maybeSingle(){single=true;return q;},
      update(p){call.patch=p;return q;},
      upsert(rows){upsert=rows;return q;},
      then(resolve,reject) {
        let rows = table==='project_mention_inbox_visible'
          ? (revoked ? [] : tables.project_mention_inbox) : (tables[table] || []);
        if (upsert) {tables[table].push(...upsert);rows=upsert;}
        rows=rows.filter(r=>call.filters.every(([k,op,v])=>{
          const value=k.split('.').reduce((o,p)=>o?.[p],r);
          return op==='eq'? value===v : op==='in'?v.includes(value):value!==v;
        }));
        if(call.patch) rows.forEach(r=>Object.assign(r,call.patch));
        const total=rows.length;
        rows=rows.slice(start,Math.min(end+1,start+limit)).map(r=>({...r}));
        return Promise.resolve({data:single?(rows[0]||null):rows,error:null,count:count?total:null}).then(resolve,reject);
      },
    };
    return q;
  }};
  fixture={db,tables,project,calls};return fixture;
}
async function request(endpoint,method='GET',body={},query={}) {
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};
  await handlers[endpoint]({method,body,query},res);
  return res;
}

test('list, body search and unread badge include only current tenant/member project messages',async()=>{
  const f=setup();
  const list=await request('index');
  assert.equal(list.statusCode,200);
  assert.equal(list.body.messages.length,1);
  assert.equal(list.body.messages[0].source,'project');
  assert.equal(list.body.messages[0].card_id,id(6));
  assert.equal(list.body.unreadCount,1);
  const search=await request('search','GET',{}, {q:'budget'});
  assert.deepEqual(search.body.recipientIds,[id(4)]);
  const unread=await request('unread-count');
  assert.equal(unread.body.unreadCount,1);
  assert.equal(unread.body.latestMessageId,id(4));
  for(const call of f.calls.filter(c=>c.table==='project_mention_inbox_visible')) {
    assert.ok(call.filters.some(([k,,v])=>k==='tenant_id'&&v===ctx.tenantId));
    assert.ok(call.filters.some(([k,,v])=>k==='recipient_id'&&v===id(3)));
  }
});
test('reading main inbox details updates the original board notification and escapes user HTML',async()=>{
  const f=setup();
  const detail=await request('[id]','GET',{}, {id:id(4),source:'project'});
  assert.equal(detail.statusCode,200);
  assert.equal(detail.body.message.source,'project');
  assert.ok(f.project.read_at);
  assert.ok(detail.body.message.html.includes('&lt;script&gt;'));
  assert.ok(!detail.body.message.html.includes('<script>'));
  assert.equal((await request('unread-count')).body.unreadCount,0);
});
test('archive, restore, read, unread, pin, favourite and folder actions mutate one shared record',async()=>{
  const f=setup();
  f.tables.member_inbox_folder.push({id:id(8),tenant_id:ctx.tenantId,member_id:ctx.memberId});
  for(const [action,key,expected] of [['read','read_at',true],['unread','read_at',false],['pin','pinned_at',true],
    ['unpin','pinned_at',false],['archive','is_archived',true],['unarchive','is_archived',false],
    ['favourite','is_favourite',true],['unfavourite','is_favourite',false]]) {
    const result=await request('index','POST',{project_id:id(4),action});
    assert.equal(result.statusCode,200);
    assert.equal(!!f.project[key],expected);
  }
  assert.equal((await request('index','POST',{project_id:id(4),action:'move',folder_id:id(8)})).statusCode,200);
  assert.equal(f.project.folder_id,id(8));
  await request('index','POST',{project_id:id(4),action:'archive'});
  assert.equal((await request('unread-count')).body.unreadCount,0);
  assert.equal((await request('index')).body.messages[0].is_archived,true);
});
test('revoked members, cross-tenant IDs and absent member identities cannot reveal or mutate notifications',async()=>{
  for(const options of [{revoked:true},{identity:null}]) {
    setup(options);
    assert.equal((await request('index')).body.messages.length,0);
    assert.equal((await request('[id]','GET',{}, {id:id(4),source:'project'})).statusCode,404);
    assert.equal((await request('index','POST',{project_id:id(4),action:'read'})).statusCode,404);
  }
  const f=setup();
  assert.equal((await request('[id]','GET',{}, {id:id(7),source:'project'})).statusCode,404);
  assert.equal((await request('index','POST',{project_ids:[id(4),id(7)],action:'read'})).statusCode,404);
  assert.equal(f.project.read_at,null);
});
test('mixed bulk action keeps campaign, transactional and project state separate',async()=>{
  const f=setup();
  f.tables.email_campaign_recipient.push({id:id(10),member_id:ctx.memberId,email_campaign:{tenant_id:ctx.tenantId}});
  f.tables.member_transactional_message.push({id:id(11),member_id:ctx.memberId,tenant_id:ctx.tenantId,is_read:false});
  const result=await request('index','POST',{recipient_ids:[id(10)],transactional_ids:[id(11)],project_ids:[id(4)],action:'read'});
  assert.equal(result.statusCode,200);
  assert.equal(result.body.updated,3);
  assert.equal(f.tables.member_inbox_message_state[0].is_read,true);
  assert.equal(f.tables.member_transactional_message[0].is_read,true);
  assert.ok(f.project.read_at);
});
test('project HTML encodes all markup characters',()=>{
  assert.equal(projectMessageHtml(`<&>"'`),'<p style="white-space:pre-wrap">&lt;&amp;&gt;&quot;&#39;</p>');
});
