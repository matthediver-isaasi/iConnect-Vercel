import test from 'node:test';
import assert from 'node:assert/strict';
import {funnelCancellationRecoveryNotice} from './eventFunnelCancellationNotice.js';
test('pending or ambiguous financial recovery is not presented as a completed refund',()=>{
  for(const recovery of ['queued','retry','idle','needs_review','lease_lost',undefined]){
    const notice=funnelCancellationRecoveryNotice({operationId:'operation',orderId:'order',recovery});
    assert.equal(notice.warning,true);assert.match(notice.text,/registration report/);
    assert.doesNotMatch(notice.text,/refund completed|refund issued/i);
  }
});
test('completed recovery is distinct from approval and legacy results stay unchanged',()=>{
  assert.equal(funnelCancellationRecoveryNotice({operationId:'operation',orderId:'order',recovery:'complete'}).warning,false);
  assert.equal(funnelCancellationRecoveryNotice(null),null);
});
