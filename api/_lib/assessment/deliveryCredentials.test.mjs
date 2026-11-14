import test from 'node:test';
import assert from 'node:assert/strict';
import {sealInvitation,openInvitation} from './deliveryCredentials.js';
test('queued invitation credentials are encrypted and bound to tenant and appointment',()=>{
  const secret='isolated-only-fixture-secret',token='never-store-plaintext',context='tenant:appointment';
  const envelope=sealInvitation(token,context,secret);
  assert.equal(JSON.stringify(envelope).includes(token),false);
  assert.equal(openInvitation(envelope,context,secret),token);
  assert.throws(()=>openInvitation(envelope,'other:appointment',secret));
  assert.throws(()=>openInvitation(envelope,context,'different-fixture-secret'));
});
