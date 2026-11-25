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

test('membership benefit notice explains withdrawn, kept and unconfirmed outcomes', async () => {
  const { funnelMembershipBenefitNotice } = await import('./eventFunnelCancellationNotice.js');
  assert.equal(funnelMembershipBenefitNotice({}), null);
  assert.equal(funnelMembershipBenefitNotice({ membershipBenefits: [] }), null);
  assert.deepEqual(funnelMembershipBenefitNotice({ membershipBenefits: [{ scheduleName: 'Individual', state: 'withdrawn' }] }),
    { warning: false, text: 'Individual: unused benefit withdrawn.' });
  const kept = funnelMembershipBenefitNotice({ membershipBenefits: [{ scheduleName: 'Corporate', state: 'consumed' }] });
  assert.equal(kept.warning, true);
  assert.match(kept.text, /already applied/);
  assert.equal(funnelMembershipBenefitNotice({ membershipBenefits: 'unavailable' }).warning, true);
});

test('a benefit held by a membership checkout is reported for review, not withdrawn', async () => {
  const { funnelMembershipBenefitNotice } = await import('./eventFunnelCancellationNotice.js');
  const notice = funnelMembershipBenefitNotice({ membershipBenefits: [{ state: 'reserved', scheduleName: 'Corporate' }] });
  assert.equal(notice.warning, true);
  assert.match(notice.text, /Corporate: held by a membership checkout in progress/);
});
