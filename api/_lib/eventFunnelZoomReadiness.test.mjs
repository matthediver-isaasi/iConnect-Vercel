import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyExistingFunnelZoomAccess} from './eventFunnelZoomReadiness.js';
import {getFunnelZoomAuthority} from './zoomClient.js';
import {zoomRequest} from './zoomRegistration.js';
test('unconfigured targets need no provider access and unsupported integrations remain pending',async()=>{
  const base={booking:{},deadlineAt:Date.now()+10000,getAuthority:()=>assert.fail('No authentication expected')};
  assert.equal(await verifyExistingFunnelZoomAccess({...base,targetsFor:async()=>[{is_online:true}]}),true);
  for(const target of [{teams_meeting_id:'teams'},{location:'https://zoom.us/j/123'},{lms_url:'https://example.test'}])
    assert.equal(await verifyExistingFunnelZoomAccess({...base,targetsFor:async()=>[target]}),false);
});
test('existing Zoom access uses account-bound authority, deadlines and recipient-specific resolution without writes',async()=>{
  const calls=[],deadlineAt=Date.now()+10000;
  const input={tenantId:'tenant',booking:{attendee_email:'guest@example.test'},deadlineAt,
    targetsFor:async()=>[{zoom_meeting_id:'meeting'},{zoom_webinar_id:'webinar'}],
    getAuthority:async(tenant,options)=>{assert.equal(tenant,'tenant');assert.equal(options.deadlineAt,deadlineAt);return {token:'fixture-token'};},
    resolverFor:(_db,tenant,email,options)=>{
      assert.equal(tenant,'tenant');assert.equal(email,'guest@example.test');
      return async target=>{
        assert.equal(await options.getToken(),'fixture-token');calls.push(target);return 'https://zoom.us/j/123?tk=fixture';
      };
    }};
  assert.equal(await verifyExistingFunnelZoomAccess(input),true);assert.equal(calls.length,2);
  await assert.rejects(verifyExistingFunnelZoomAccess({...input,resolverFor:()=>async()=>{throw new Error('Missing personal access');}}),/Missing/);
  assert.equal(await verifyExistingFunnelZoomAccess({...input,deadlineAt:0,getAuthority:()=>assert.fail('Expired')}),false);
});
test('connection changes cannot share the funnel authentication cache identity',async()=>{
  const keys=[];
  for(const account of ['fixture-account-a','fixture-account-b']) {
    const result=await getFunnelZoomAuthority('tenant',{deadlineAt:12345,
      credentialsFor:async()=>({account_id:account,client_id:'fixture-client',client_secret:'fixture-only'}),
      tokenFor:async(key,_account,_client,_secret,options)=>{
        keys.push(key);assert.equal(options.deadlineAt,12345);return 'fixture-token';
      }});
    assert.equal(result.token,'fixture-token');assert.match(result.authorityHash,/^[a-f0-9]{64}$/);
  }
  assert.notEqual(keys[0],keys[1]);
  await assert.rejects(getFunnelZoomAuthority('tenant',{credentialsFor:async()=>null}),/unavailable/);
});
test('Zoom requests enforce the remaining invocation deadline without contacting expired targets',async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({id:'fixture'})};};
  try {
    await assert.rejects(zoomRequest('fixture','meetings/123',{deadlineAt:0}),/deadline/);
    assert.equal(calls.length,0);
    await zoomRequest('fixture','meetings/123',{deadlineAt:Date.now()+5000,redirect:'error'});
    assert.equal(calls.length,1);assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.redirect,'error');assert.equal('deadlineAt' in calls[0].options,false);
  } finally {globalThis.fetch=original;}
});
