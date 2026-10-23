import test from 'node:test';
import assert from 'node:assert/strict';
import { membershipPeriod, membershipHeading, annualMembershipFeeLabel, memberDate, activationText, memberDirectDebitPolicy, memberFirstCollection, reusesDirectDebit, creditOwnerLabel } from './membershipFeeCopy.js';

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

test('periods use valid authoritative pairs, with safe year or contact fallbacks', () => {
  const data = {
    memberStart: { termStart: '2026-10-22' },
    commitment: { term_start_date: '2025-04-01', term_end_date: '2026-03-31' },
    renewalLifecycle: { termStart: '2027-01-01', termEnd: '2027-12-31' },
  };
  assert.equal(membershipPeriod(data), '1 April 2025 – 31 March 2026');
  assert.equal(membershipPeriod({ renewalLifecycle: data.renewalLifecycle }), '1 January 2027 – 31 December 2027');
  for (const membershipYear of [undefined, 'rolling:2026-10-22', 'term-internal-431', '2026-10-22']) {
    assert.equal(membershipPeriod({ membershipYear }), 'Please contact us to confirm your membership dates.');
  }
  for (const membershipYear of ['2026', '2026/2027', '2026 – 2027']) {
    assert.equal(membershipPeriod({ membershipYear }), membershipYear);
  }
  assert.equal(memberDate('2024-02-29'), '29 February 2024');
  for (const value of ['2026-02-29', '2026-13-01', 'rolling:2026-10-22', '2026-10-22T00:00:00Z']) {
    assert.equal(memberDate(value), null);
  }
  assert.equal(membershipHeading({ memberStart: {}, renewal: {} }), 'Your Membership Renewal');
  assert.equal(membershipHeading({}), 'Your Membership');
});

test('annual fee labels preserve current-rate and VAT meaning without qualifying unrelated upfront offers', () => {
  for (const pricing_policy of ['fixed', 'dynamic']) for (const vatAmount of [0, 26.31]) {
    const data = { memberStart: { paymentMode: 'direct_debit' }, vatAmount, ddOffer: { collectionPolicy: { pricing_policy } } };
    assert.equal(annualMembershipFeeLabel(data),
      `Annual membership fee${pricing_policy === 'dynamic' ? ' at current rates' : ''}${vatAmount > 0 ? ' (excluding VAT)' : ''}`);
    data.memberStart.paymentMode = 'stripe_upfront';
    assert.equal(annualMembershipFeeLabel(data), `Annual membership fee${vatAmount > 0 ? ' (excluding VAT)' : ''}`);
  }
});

test('unknown or review-required policies never promise continuation, fixed pricing or cancellation rights', () => {
  for (const collectionPolicy of [
    undefined, { pricing_policy: 'dynamic' }, { pricing_policy: 'fixed', end_policy: 'unknown' },
    { pricing_policy: 'unknown', end_policy: 'continue' },
    { pricing_policy: 'dynamic', end_policy: 'continue', needs_review: true },
  ]) {
    const text = memberDirectDebitPolicy({ collectionPolicy });
    assert.match(text, /contact the membership team/);
    assert.doesNotMatch(text, /continue when|unless you cancel|is fixed|may change/);
  }
});

test('first collection and activation disclosures retain the recorded rule without exposing codes', () => {
  assert.equal(memberFirstCollection({ firstCollectionRule: 'nominated_day', collectionDay: 17 }), 'on the next available collection date, on day 17 of the month');
  assert.match(memberFirstCollection({ firstCollectionRule: 'anniversary' }), /matching your membership start day/);
  for (const firstCollectionRule of [undefined, 'internal_unknown', 'nominated_day']) {
    assert.match(memberFirstCollection({ firstCollectionRule, collectionDay: 29 }), /as soon as your Direct Debit is ready.*advance notice/);
  }
  assert.equal(activationText('unknown'), 'We’ll confirm when your membership becomes active.');
});

test('default credit labels are translated but deliberate tenant names are not replaced', () => {
  for (const displayName of ['Vouchers', 'Member vouchers', 'Organisation vouchers']) {
    assert.equal(creditOwnerLabel({ ownerType: 'member', displayName }), 'Member credit');
    assert.equal(creditOwnerLabel({ ownerType: 'organisation', displayName }), 'Organisation credit');
  }
  assert.equal(creditOwnerLabel({ ownerType: 'member', displayName: 'Harbour rewards' }), 'Harbour rewards (your credit)');
  assert.equal(creditOwnerLabel({ ownerType: 'organisation', displayName: 'Learning allowance' }), 'Learning allowance (organisation credit)');
});
