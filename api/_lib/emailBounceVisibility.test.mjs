import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignAddressSuppressed, loadBounces, setBounceVisibility } from './emailBounceService.js';
import { createBounceHandler } from '../admin/communications/bounces.js';

const id = '00000000-0000-4000-8000-000000000001';
function fixture(rows) {
  const calls = [];
  const db = { from(table) {
    const predicates = []; let update; let single = false;
    const q = {
      select() { return q; }, order() { return q; }, range() { return q; }, limit() { return q; },
      eq(k,v) { predicates.push(r => r[k] === v); return q; },
      is(k,v) { predicates.push(r => (r[k] ?? null) === v); return q; },
      not(k,_op,v) { predicates.push(r => (r[k] ?? null) !== v); return q; },
      filter() { return q; },
      update(v) { update = v; calls.push(v); return q; },
      maybeSingle() { single = true; return q; },
      then(resolve) {
        const found = (table === 'email_address_bounce' ? rows : []).filter(r => predicates.every(p => p(r)));
        if (update) found.forEach(row => Object.assign(row, update));
        resolve({ data: single ? found[0] || null : found, count: found.length, error: null });
      },
    }; return q;
  } };
  return {db, calls};
}
test('hide/unhide touches only visibility, remains suppressed, and cannot cross tenants', async () => {
  const row = {id,tenant_id:'tenant',email:'a@example.invalid',resolved_at:null,last_bounced_at:'2026-10-01'};
  const {db,calls} = fixture([row]);
  const ctx = {tenantId:'tenant',memberId:'manager'};
  await setBounceVisibility(db,ctx,{id,hidden:true,resolved_at:'forged',email:'forged'});
  assert.ok(row.hidden_at);
  assert.equal(row.hidden_by,'member:manager');
  assert.deepEqual(Object.keys(calls[0]).sort(),['hidden_at','hidden_by']);
  assert.equal(await campaignAddressSuppressed(db,'tenant',row.email),true);
  assert.equal((await loadBounces(db,'tenant',{view:'active'})).total,0);
  assert.equal((await loadBounces(db,'tenant',{view:'hidden'})).total,1);
  assert.equal((await loadBounces(db,'tenant',{view:'all'})).total,1);
  await assert.rejects(setBounceVisibility(db,{...ctx,tenantId:'other'},{id,hidden:false}),{status:404});
  assert.ok(row.hidden_at);
  await setBounceVisibility(db,ctx,{id,hidden:false});
  assert.equal(row.hidden_at,null);
  assert.equal((await loadBounces(db,'tenant',{view:'active'})).total,1);
  assert.equal(await campaignAddressSuppressed(db,'tenant',row.email),true);
});
test('hidden includes resolved history; ordinary resolved view excludes it', async () => {
  const {db} = fixture([{id,tenant_id:'tenant',email:'a@example.invalid',resolved_at:'date',hidden_at:'date'}]);
  assert.equal((await loadBounces(db,'tenant',{view:'hidden'})).total,1);
  assert.equal((await loadBounces(db,'tenant',{view:'resolved'})).total,0);
  assert.equal(await campaignAddressSuppressed(db,'tenant','a@example.invalid'),false);
});
test('invalid visibility payloads fail before database writes', async () => {
  const db = {from(){assert.fail('Must reject first');}};
  for (const input of [{id,hidden:'false'},{id:'invalid',hidden:true},{id}]) {
    await assert.rejects(setBounceVisibility(db,{tenantId:'tenant',memberId:'manager'},input),{status:400});
  }
});
test('PATCH uses management permission and visibility service, never resolution/provider checks', async () => {
  let written = false;
  const handler = createBounceHandler({
    db:{},getTenantContext:async()=>({isAuthenticated:true,tenantId:'tenant',memberId:'manager'}),
    hasAdminAccess:async()=>false,
    hasFeatureAccess:async(_role,feature)=>{assert.equal(feature,'communication.management');return true;},
    setBounceVisibility:async(_db,ctx,input)=>{written=true;assert.equal(ctx.tenantId,'tenant');assert.deepEqual(input,{id,hidden:true});return {item:{id,hidden_at:'date'}};},
    resolveBounce:()=>assert.fail('Do not resolve'),
  });
  const res = {setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'PATCH',query:{memberId:'other'},body:{id,hidden:true}},res);
  assert.equal(res.code,200); assert.equal(written,true);
});
