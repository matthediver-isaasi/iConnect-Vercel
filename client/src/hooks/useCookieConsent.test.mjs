import test from 'node:test';
import assert from 'node:assert/strict';
import {consentState} from '../lib/consentState.js';
test('adapter never adopts legacy binary storage and fails closed',()=>{
  consentState.deny();
  assert.equal(consentState.getSnapshot().categories.analytics,false);
  let called=0;const unsubscribe=consentState.subscribe(()=>called++);
  consentState.publish({ready:true,hasActed:true,categories:{necessary:true,analytics:false,functional:true,marketing:false}});
  assert.equal(consentState.getSnapshot().categories.functional,true);
  assert.equal(consentState.getSnapshot().categories.analytics,false);
  assert.equal(called,1);unsubscribe();consentState.deny();
});
