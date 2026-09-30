import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MEMBERSHIP_INVOICE_PO_FALLBACK,
  resolveMembershipInvoiceReference,
} from './membershipInvoiceReference.js';
import { buildXeroMembershipReference } from './xero.js';
import { buildQuickBooksMembershipCustomerMemo } from './quickbooks.js';

test('membership reference contract uses exactly TBC when no genuine PO exists', () => {
  assert.equal(MEMBERSHIP_INVOICE_PO_FALLBACK, 'TBC');
  for (const value of [
    undefined,
    null,
    '',
    '  ',
    'TBC',
    'pending',
    'PO to follow',
    'No PO number',
    'not applicable',
    'nil',
    'TBC - awaiting PO',
  ]) {
    assert.equal(resolveMembershipInvoiceReference(value), 'TBC');
  }
  assert.equal(resolveMembershipInvoiceReference('Membership 2026/27'), 'TBC');
  assert.equal(resolveMembershipInvoiceReference('Membership 2026/27 - PO: TBC'), 'TBC');
});

test('membership reference contract preserves genuine POs', () => {
  assert.equal(resolveMembershipInvoiceReference('PO-12345'), 'PO-12345');
  assert.equal(resolveMembershipInvoiceReference('Membership 12345'), 'Membership 12345');
  assert.equal(
    resolveMembershipInvoiceReference('Membership 2026/27 - PO: PO-12345'),
    'PO-12345',
  );
});

test('provider facade applies the contract to both accounting providers', () => {
  const source = fs.readFileSync(new URL('./accountingProvider.js', import.meta.url), 'utf8');
  const matches = source.match(/reference: resolveMembershipInvoiceReference\(args\?\.reference\)/g) || [];
  assert.equal(matches.length, 2, 'Xero and QuickBooks facade methods must normalize membership references');
});

test('outgoing Xero and QuickBooks membership fields resolve TBC and genuine POs', () => {
  assert.equal(buildXeroMembershipReference(), 'TBC');
  assert.equal(buildXeroMembershipReference('Membership 2026/27'), 'TBC');
  assert.equal(buildXeroMembershipReference('PO-XERO-1'), 'PO-XERO-1');

  assert.deepEqual(buildQuickBooksMembershipCustomerMemo(), { value: 'TBC' });
  assert.deepEqual(
    buildQuickBooksMembershipCustomerMemo('Membership 2026/27 - PO: PO-QBO-1'),
    { value: 'PO-QBO-1' },
  );
});