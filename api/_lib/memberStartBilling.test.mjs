import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemberStartBilling } from './memberStartBilling.js';
const parties = [
  { key: 'member:one', label: 'Member', email: 'member@example.test', fields: [] },
  { key: 'organization:two', label: 'Organisation', email: 'finance@example.test', fields: [
    { key: 'custom:line', value: '10 Example Road' }, { key: 'custom:town', value: 'London' },
    { key: 'custom:email', value: 'accounts@example.test' },
  ] },
];
const billing = { recipientKey: 'organization:two', addressSourceKey: 'organization:two', addressFields: ['custom:line', 'custom:town'] };
test('linked billing party, independent address source and ordered fields are frozen', () => {
  const quote = resolveMemberStartBilling(parties, billing);
  assert.equal(quote.organizationName, 'Organisation');
  assert.equal(quote.invoicingAddress, '10 Example Road\nLondon');
  assert.equal(quote.invoicingEmail, 'finance@example.test');
  assert.equal(resolveMemberStartBilling(parties, { ...billing, recipientKey: 'member:one' }).organizationName, 'Member');
  assert.equal(resolveMemberStartBilling(parties, { ...billing, emailField: 'custom:email' }).invoicingEmail, 'accounts@example.test');
});
test('unlinked parties, stale fields, missing email and duplicate selections fail closed', () => {
  for (const change of [{ recipientKey: 'organization:foreign' }, { addressSourceKey: 'organization:foreign' },
    { addressFields: ['custom:missing'] }, { addressFields: [] }, { addressFields: ['custom:line', 'custom:line'] },
    { emailField: 'custom:line' }]) assert.throws(() => resolveMemberStartBilling(parties, { ...billing, ...change }));
});
