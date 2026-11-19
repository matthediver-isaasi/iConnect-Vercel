import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('./session.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('export async function createSession('),
  source.indexOf('// Bearer tokens for native/mobile clients')).replace('export async','async');
async function run({insertError=false,deleteError=false,fenceAllowed=true}={}){
 const events=[],cookies=[];
 const db={from(){return {
  async insert(){events.push('insert');return {error:insertError?new Error('insert failed'):null};},
  delete(){return {async eq(key,id){events.push(`delete:${id}`);return {error:deleteError&&id==='old'?new Error('delete failed'):null};}};}
 };}};
 const create=new Function('supabase','applyMemberSessionAccessFence','generateSessionId','SESSION_MAX_AGE',
  'PRODUCTION_COOKIE_DOMAIN','getMemberSessionAccessFence','isMemberSessionFenceRevoked','signSessionId',
  'serialize','SESSION_COOKIE_NAME',`${body};return createSession;`)(
   db,async data=>({allowed:true,sessionData:data}),()=> 'new',1000,'.iconn.app',
   async()=>({allowed:fenceAllowed}),()=>false,id=>id,()=> 'cookie','sid');
 const result=await create({setHeader(k,v){cookies.push(v);}},
  {memberId:'member'},{replaceSessionId:'old',req:{headers:{}}});
 return {events,cookies,result};
}
test('insertion failure preserves the previous session and cookie',async()=>{
 const r=await run({insertError:true});assert.deepEqual(r.events,['insert']);
 assert.equal(r.result,null);assert.equal(r.cookies.length,0);
});
test('a rejected replacement is removed without destroying the original',async()=>{
 const r=await run({fenceAllowed:false});assert.deepEqual(r.events,['insert','delete:new']);
 assert.equal(r.result,null);assert.equal(r.cookies.length,0);
});
test('replacement requires successful retirement before issuing the new cookie',async()=>{
 const failed=await run({deleteError:true});
 assert.deepEqual(failed.events,['insert','delete:old','delete:new']);
 assert.equal(failed.result,null);assert.equal(failed.cookies.length,0);
 const success=await run();assert.deepEqual(success.events,['insert','delete:old']);
 assert.equal(success.cookies.length,1);assert.equal(success.result.id,'new');
});
