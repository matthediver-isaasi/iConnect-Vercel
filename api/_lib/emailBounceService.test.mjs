import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignAddressSuppressed, loadBounces, resolveBounce } from './emailBounceService.js';
import { createBounceHandler } from '../admin/communications/bounces.js';
import { classifyEmailDelivery } from './emailDeliveryClassification.js';
import { readFileSync } from 'node:fs';
test('soft/permanent/exhausted classification and send-time boundary',()=>{
 for (const [severity,code,reason,expected] of [
 ['temporary',421,'generic','soft_bounce'],
 ['permanent',550,'generic','hard_bounce'],
 ['permanent',421,'generic','delivery_failed'],
 ['permanent',null,'too-old','delivery_failed'],
 [null,null,'generic','delivery_failed'],
 ]) assert.equal(classifyEmailDelivery({event:'failed',severity,reason,'delivery-status':{code}}),expected);
 const code=readFileSync(new URL('./campaignService.js',import.meta.url),'utf8');
 const check=code.indexOf('if (await campaignAddressSuppressed(');
 assert.ok(check>0);
 assert.ok(check<code.indexOf('providerSubmitted = true;',check));
 assert.ok(check<code.indexOf('const result = await sendEmail({',check));
 assert.match(code,/select\('id, email, status, delivery_outcome,/);
});
function fixture(result) {
 const calls=[];const db={from(t){calls.push(['from',t]);return new Proxy({}, {get(_,k){return (...args)=>{calls.push([k,...args]);return ['maybeSingle','single'].includes(k)?Promise.resolve(result):db.fromResult;}}});}};
 db.fromResult=new Proxy({}, {get(_,k){return (...args)=>{calls.push([k,...args]);return ['maybeSingle','single'].includes(k)?Promise.resolve(result):db.fromResult;}}});
 return {db,calls};
}
test('suppression normalizes address, scopes tenant, ignores resolved history and fails closed',async()=>{
 const f=fixture({data:{id:'x'}});
 assert.equal(await campaignAddressSuppressed(f.db,'tenant',' TEST@Example.invalid '),true);
 assert.ok(f.calls.some(c=>c[0]==='eq'&&c[1]==='tenant_id'&&c[2]==='tenant'));
 assert.ok(f.calls.some(c=>c[0]==='eq'&&c[1]==='email'&&c[2]==='test@example.invalid'));
 assert.ok(f.calls.some(c=>c[0]==='is'&&c[1]==='resolved_at'&&c[2]===null));
 await assert.rejects(campaignAddressSuppressed(fixture({error:{}}).db,'t','e'),/could not be checked/);
});
test('member warning resolves current tenant-owned email, never a caller supplied email',async()=>{
 const f=fixture({data:{email:'NEW@example.invalid'}});
 await loadBounces(f.db,'tenant',{memberId:'member',email:'old@example.invalid'});
 assert.ok(f.calls.some(c=>c[0]==='eq'&&c[1]==='email'&&c[2]==='new@example.invalid'));
});
test('resolution requires fresh evidence, checks provider and uses atomic audit RPC',async()=>{
 const f=fixture({data:{id:'b',email:'x@example.invalid',last_bounced_at:'2026-10-05T00:00:00Z',resolved_at:null}});
 let called=0;
 f.db.rpc=async(name,args)=>{called++;assert.equal(name,'resolve_email_address_bounce');assert.equal(args.p_tenant,'t');assert.equal(args.p_actor,'m');return {data:true}};
 const body={id:'b',expectedLastBouncedAt:'2026-10-05T00:00:00+00:00',reason:'Mailbox corrected'};
 await assert.rejects(resolveBounce(f.db,{tenantId:'t',memberId:'m'},body,async()=>{throw new Error('Provider unavailable')}),/Provider unavailable/);
 assert.equal(called,0);
 assert.deepEqual(await resolveBounce(f.db,{tenantId:'t',memberId:'m'},body,async()=>({domain:'example.invalid',checkedAt:new Date().toISOString()})),{ok:true});
 assert.equal(called,1);
});
test('endpoint enforces tenant and feature boundaries for both reads and writes',async()=>{
 for (const [context,allowed,status] of [[{},true,401],[{isAuthenticated:true,tenantId:'t',tenantMismatch:true},true,403],[{isAuthenticated:true,tenantId:'t'},false,403]]) {
 const res={setHeader(){},status(s){this.code=s;return this},json(b){this.body=b;return this}};
 for(const method of ['GET','POST']){
 await createBounceHandler({getTenantContext:async()=>context,hasAdminAccess:async()=>false,hasFeatureAccess:async()=>allowed,loadBounces:()=>{throw Error('must not load')}})({method,query:{}},res);
 assert.equal(res.code,status);
 }
 }
});
