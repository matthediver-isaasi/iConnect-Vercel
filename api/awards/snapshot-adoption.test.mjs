import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './snapshot-adoption.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
  const calls=[];
  const db={from(table){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:table==='assessment_round'?{id:id(1),award_id:id(2)}:{id:id(3),reference:'AW-1'}})};return q;},
    rpc:async(name,args)=>{calls.push({name,args});return{data:{changed:1,applicationVersionId:id(4)}};}};
  const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};
  return{calls,db,res};
}
// Authentication details remain covered by awards/index tests. Here exercise
// malformed requests before any command, including version-map coercion.
test('snapshot adoption never executes without verified authentication',async()=>{
  const f=fixture();
  await handler({method:'POST',headers:{},body:{roundId:id(1),applicationId:id(3),snapshotId:id(4)}},f.res,{
    supabase:f.db,getTenantContext:async()=>null,
  });
  assert.ok([401,403,503].includes(f.res.statusCode));assert.equal(f.calls.length,0);
});
