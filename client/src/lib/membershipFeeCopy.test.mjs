import test from 'node:test';
import assert from 'node:assert/strict';
import { membershipPeriod, membershipHeading, memberDate, activationText, memberDirectDebitPolicy, reusesDirectDebit, creditOwnerLabel } from './membershipFeeCopy.js';

test('dates are readable, paired from one source and never inferred from internal rolling keys', () => {
  assert.equal(membershipPeriod({ memberStart: {termStart:'2026-10-22',termEnd:'2027-10-21'},membershipYear:'rolling:2026-10-22' }), '22 October 2026 – 21 October 2027');
  assert.doesNotMatch(membershipPeriod({membershipYear:'rolling:2026-10-22'}), /rolling:/);
  assert.equal(memberDate('2026-02-30'),null);
  assert.equal(memberDate(undefined),null);
  assert.equal(membershipHeading({memberStart:{}}),'Your Membership');
  assert.equal(membershipHeading({renewal:{}}),'Your Membership Renewal');
});

test('plain payment disclosures respect fixed/variable and stopping/continuing policies', () => {
  for(const pricing_policy of ['fixed','dynamic']) for(const end_policy of ['stop','continue']) {
    const text=memberDirectDebitPolicy({collectionPolicy:{pricing_policy,end_policy}});
    assert.equal(text.includes('may change'), pricing_policy==='dynamic');
    assert.equal(text.includes('continue when your membership renews'),end_policy==='continue');
    assert.equal(text.includes('stop at the end'),end_policy==='stop');
    assert.doesNotMatch(text,/billing period|dynamic|structure|policy|mandate permits/);
  }
  assert.match(memberDirectDebitPolicy({}),/contact the membership team/);
});

test('a saved DD choice or historical mandate does not prove renewal reuse', () => {
  assert.equal(reusesDirectDebit({memberStart:{paymentMode:'direct_debit'},ddStatus:{hasMandate:true}}),false);
  assert.equal(reusesDirectDebit({renewal:{provider:'gocardless',status:'notice_sent',mode:'confirm'}}),true);
  assert.match(activationText('first_payment'),/after your first payment/);
  assert.match(activationText('mandate'),/once your Direct Debit is confirmed/);
  assert.doesNotMatch(activationText('unrecognised_internal_value'),/unrecognised/);
});

test('credit labels retain tenant terminology and distinguish ownership', () => {
  assert.equal(creditOwnerLabel({ownerType:'member',displayName:'Member vouchers'}),'Member credit');
  assert.equal(creditOwnerLabel({ownerType:'organization'}),'Organisation credit');
  assert.match(creditOwnerLabel({ownerType:'member',displayName:'Training fund'}),/Training fund/);
});
