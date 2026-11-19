import test from 'node:test';
import assert from 'node:assert/strict';
import { returnToAdmin } from './endMasquerade.js';
function fixture({ok=true,data={success:true,returnUrl:'/members?tab=all'},storageError=false}={}){
 const events=[];
 return {events,options:{
  fetchImpl:async(url,options)=>{
   assert.equal(url,'/api/auth/end-masquerade');assert.equal(options.method,'POST');
   assert.equal(options.credentials,'include');events.push('post');
   return {ok,json:async()=>data};
  },
  queryClient:{async cancelQueries(){events.push('cancel');},clear(){events.push('clear');}},
  storage:{removeItem(key){if(storageError)throw new Error('Storage unavailable');events.push(`remove:${key}`);}},
  navigate:href=>events.push(`navigate:${href}`),
 }};
}
test('successful restoration clears old identity and role caches before navigation',async()=>{
 const f=fixture();await returnToAdmin(f.options);
 assert.deepEqual(f.events,['post','cancel','clear','remove:agcas_member','remove:agcas_organization','navigate:/members?tab=all']);
});
test('failed restoration neither clears identity nor navigates and remains retryable',async()=>{
 for(const opts of [{ok:false,data:{error:'Original admin unavailable'}},{data:{success:false}}]){
  const f=fixture(opts);await assert.rejects(returnToAdmin(f.options));assert.deepEqual(f.events,['post']);
 }
});
test('untrusted return locations cannot redirect off-site',async()=>{
 const f=fixture({data:{success:true,returnUrl:'//example.test'}});await returnToAdmin(f.options);
 assert.equal(f.events.at(-1),'navigate:/members');
});
test('local cache failure cannot strand an already restored admin in the old view',async()=>{
 const f=fixture({storageError:true});await assert.rejects(returnToAdmin(f.options));
 assert.equal(f.events.at(-1),'navigate:/members?tab=all');
});
