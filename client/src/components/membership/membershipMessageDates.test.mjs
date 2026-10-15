import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {formatMembershipMessageDates} from './membershipMessageDates.mjs';

test('renewal warning displays the UK date without changing its wording', () => {
  const message='No eligible membership structure exists for rolling renewal on 2026-05-30; review the structure effective dates.';
  assert.equal(formatMembershipMessageDates(message),
    'No eligible membership structure exists for rolling renewal on 30/05/2026; review the structure effective dates.');
  assert.equal(message.includes('2026-05-30'),true);
});
test('multiple dates are formatted with padded days and months', () => {
  assert.equal(formatMembershipMessageDates('From 2026-01-02 to 2027-04-01.'),'From 02/01/2026 to 01/04/2027.');
});
test('valid leap days are formatted but invalid calendar dates are preserved', () => {
  assert.equal(formatMembershipMessageDates('2024-02-29; 2026-02-29; 2026-13-01'),
    '29/02/2024; 2026-02-29; 2026-13-01');
});
test('missing messages, UK dates and ordinary labels remain unchanged', () => {
  for(const value of [undefined,null,'','No tier matched','30/05/2026'])
    assert.equal(formatMembershipMessageDates(value),value);
});
test('both current and next year card warnings use the presentation formatter', () => {
  const source=readFileSync(new URL('../MemberMembershipTab.jsx',import.meta.url),'utf8');
  for(const year of ['currentYear','nextYear'])
    assert.ok(source.includes(`formatMembershipMessageDates(data?.pricingErrors?.${year})`));
});
