import test from 'node:test';
import assert from 'node:assert/strict';
import { variableMembershipCreditSchedule as schedule,
  variableMembershipCollectionFunding as funding,
  variableMembershipCreditSlices as slices } from './membershipVariableVoucherAllocation.js';

test('£10 is spread over twelve months without losing pennies or changing future prices', () => {
  const rows = schedule({creditMinor:1000,instalmentCount:12});
  assert.deepEqual(rows.map(r=>r.allocatedCreditMinor),[84,84,84,84,83,83,83,83,83,83,83,83]);
  assert.equal(rows.reduce((sum,r)=>sum+r.allocatedCreditMinor,0),1000);
  assert.equal(funding({grossMinor:1300,allocatedCreditMinor:84,minimumCashMinor:100}).cashMinor,1216);
  assert.equal(funding({grossMinor:1500,allocatedCreditMinor:84,minimumCashMinor:100}).cashMinor,1416);
});
test('fully covered months need no provider cash payment and unused credit remains explicit', () => {
  assert.deepEqual(funding({grossMinor:50,allocatedCreditMinor:84,minimumCashMinor:100}),{
    grossMinor:50,creditMinor:50,cashMinor:0,unusedCreditMinor:34,creditOnly:true,
  });
  assert.equal(funding({grossMinor:0,allocatedCreditMinor:84,minimumCashMinor:100}).unusedCreditMinor,84);
});
test('provider minimum never causes a larger fee or silent credit consumption', () => {
  assert.deepEqual(funding({grossMinor:150,allocatedCreditMinor:84,minimumCashMinor:100}),{
    grossMinor:150,creditMinor:50,cashMinor:100,unusedCreditMinor:34,creditOnly:false,
  });
  assert.throws(()=>funding({grossMinor:90,allocatedCreditMinor:84,minimumCashMinor:100}),/below the provider minimum/);
});
test('source identities and total credit survive mixed-voucher period allocation', () => {
  const input={allocations:[{voucherId:'a',amountMinor:300},{voucherId:'b',amountMinor:700}],instalmentCount:12};
  const rows=slices(input);
  assert.deepEqual(input.allocations,[{voucherId:'a',amountMinor:300},{voucherId:'b',amountMinor:700}]);
  for(const original of input.allocations) {
    assert.equal(rows.flatMap(r=>r.allocations).filter(r=>r.voucherId===original.voucherId)
      .reduce((sum,r)=>sum+r.amountMinor,0),original.amountMinor);
  }
  for(const row of rows) assert.equal(row.allocations.reduce((sum,r)=>sum+r.amountMinor,0),row.allocatedCreditMinor);
});
test('invalid or duplicate inputs fail closed without coercion', () => {
  for(const count of [0,-1,1.5,121,'12',null]) assert.throws(()=>schedule({creditMinor:1000,instalmentCount:count}));
  for(const amount of [-1,Infinity,NaN,'1000',1.2]) assert.throws(()=>schedule({creditMinor:amount,instalmentCount:12}));
  assert.throws(()=>slices({allocations:[{voucherId:'a',amountMinor:1},{voucherId:'a',amountMinor:2}],instalmentCount:12}));
});
