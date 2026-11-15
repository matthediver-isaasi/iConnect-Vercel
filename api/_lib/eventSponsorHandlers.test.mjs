import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { duplicateSponsorCategories } from './duplicateSponsorCategories.js';

function database(seed) {
  const rows=structuredClone(seed), writes=[];
  return {rows,writes,from(table) {
    const filters=[]; let insert, single=false;
    const q={
      select(){return q;}, eq(k,v){filters.push(r=>r[k]===v);return q;},
      order(){return q;}, in(k,v){filters.push(r=>v.includes(r[k]));return q;},
      single(){single=true;return q;}, maybeSingle(){single=true;return q;},
      insert(data){insert=data;return q;},
      delete(){throw new Error('Unexpected rollback');},
      then(resolve,reject){
        if(insert) {
          const added=(Array.isArray(insert)?insert:[insert]).map(r=>({...r,id:randomUUID()}));
          (rows[table] ||= []).push(...added); writes.push({table,added});
          return Promise.resolve({data:single?added[0]:added,error:null}).then(resolve,reject);
        }
        const selected=(rows[table]||[]).filter(r=>filters.every(f=>f(r)));
        return Promise.resolve({data:single?selected[0]||null:selected,error:null}).then(resolve,reject);
      }
    }; return q;
  }};
}
async function handler(path, bindings) {
  const source=(await readFile(new URL(path,import.meta.url),'utf8'))
    .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g,'')
    .replace('export default async function handler','async function handler');
  return vm.runInNewContext(`${source};handler`,bindings);
}
const response=()=>({code:200,status(c){this.code=c;return this;},json(body){this.body=body;return this;},setHeader(){}});

for(const type of ['simple','complex']) test(`${type} duplication copies independent sponsor categories and assignments`,async()=>{
  const table=type==='simple'?'event':'complex_event';
  const db=database({
    [table]:[{id:'event-a',tenant_id:'tenant',slug:'event-a',title:'Original',pricing_config:{}}],
    event_sponsor_category:[
      {id:'gold',tenant_id:'tenant',event_id:'event-a',event_type:type,name:'Gold',display_order:1},
      {id:'other',tenant_id:'other-tenant',event_id:'event-a',event_type:type,name:'Private'}
    ],
    event_sponsor_assignment:[{id:'a',tenant_id:'tenant',event_id:'event-a',event_type:type,sponsor_id:'s',category_id:'gold',sponsorship_detail:'Lunch'}],
  });
  const fn=await handler(`../${type==='simple'?'events':'complex-events'}/[id]/duplicate.js`,{
    supabase:db,randomUUID,duplicateSponsorCategories,
    getTenantContext:async()=>({isAuthenticated:true,tenantId:'tenant',tenantUserId:'admin'}),
    hasAdminAccess:async()=>true,authorizeGroupAdminEventAction:async()=>({ok:true}),
    cloneEventRegistrationCommunication:async()=>{},recomputeComplexEventDates:async()=>{},
    resolveSessionCategories:async(_db,_tenant,sessions)=>sessions,
    console:{log(){},error(){}},
  });
  const res=response();await fn({method:'POST',query:{id:'event-a'}},res);
  assert.equal(res.code,200,JSON.stringify(res.body));
  const copied=db.rows.event_sponsor_assignment.find(a=>a.event_id===res.body.id);
  assert.ok(copied);assert.notEqual(copied.category_id,'gold');
  const category=db.rows.event_sponsor_category.find(c=>c.id===copied.category_id);
  assert.equal(category.event_id,res.body.id);assert.equal(category.name,'Gold');
  assert.equal(copied.sponsorship_detail,'Lunch');
  assert.equal(db.rows.event_sponsor_assignment[0].category_id,'gold');
});

test('public sponsors expose event categories, never linked organisation or legacy sponsor category',async()=>{
  const db=database({
    event_sponsor_assignment:[{tenant_id:'tenant',event_id:'e',event_type:'simple',sponsor_id:'s',category_id:'c'}],
    event_sponsor:[{id:'s',tenant_id:'tenant',name:'Sponsor'}],
    event_sponsor_category:[
      {id:'c',tenant_id:'tenant',event_id:'e',event_type:'simple',name:'Bronze'},
      {id:'wrong',tenant_id:'tenant',event_id:'other',event_type:'simple',name:'Gold'},
    ]
  });
  const fn=await handler('../public/event-sponsors.js',{
    createClient:()=>db,resolveTenantFromRequest:async()=>({id:'tenant'}),
    process:{env:{SUPABASE_URL:'fixture',SUPABASE_SERVICE_KEY:'fixture'}},console,
  });
  const res=response();await fn({method:'GET',query:{event_id:'e',event_type:'simple'}},res);
  assert.equal(res.code,200);assert.equal(res.body.categories.length,1);
  assert.equal(res.body.categories[0].name,'Bronze');
  const source=await readFile(new URL('../public/event-sponsors.js',import.meta.url),'utf8');
  assert.match(source,/select\('id, name, logo_url, website_url, description'\)/);
  assert.doesNotMatch(source,/select\('[^']*organization/);
});
