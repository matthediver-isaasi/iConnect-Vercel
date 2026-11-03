import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node:querystring';
import { formMembershipFeeQuery } from './formMembershipFeeQuery.js';

test('saved checkout status sends scalar form scope, including on refresh and provider return', () => {
  const overrides = '&formId=form&paymentFieldId=field&renewalScheduleAnswer=a%2Fb';
  const previous = parse(`memberId=member${overrides}&voucherCheckoutId=fee&formId=form&paymentFieldId=field`);
  assert.deepEqual(previous.formId, ['form','form']); // Incident reproduction.
  for (const checkoutId of [undefined, 'fee', 'fee']) {
    const query = parse(formMembershipFeeQuery({ memberId:'member', overrideParams:overrides, checkoutId }));
    assert.equal(query.formId, 'form');
    assert.equal(query.paymentFieldId, 'field');
    assert.equal(query.renewalScheduleAnswer, 'a/b');
    assert.equal(query.voucherCheckoutId, checkoutId);
  }
});
