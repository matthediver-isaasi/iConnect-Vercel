import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeMembershipProjectCode, membershipProjectTracking } from '../../shared/membershipProjectCode.js';
import { createXeroMembershipInvoice } from './xero.js';
import { freezeMembershipPreparation } from './accountingSourcePreparation.js';
import { buildAgreementSnapshot } from './ddOfferCore.js';

test('project codes trim, clear and never invent a default', () => {
  for (const code of [null, undefined, '', '  ']) {
    assert.equal(normalizeMembershipProjectCode(code), null);
    assert.deepEqual(membershipProjectTracking(code), {});
  }
  assert.deepEqual(membershipProjectTracking(' MEMBERSHIPS '),
    { Tracking: [{ Name: 'Projects', Option: 'MEMBERSHIPS' }] });
});

const db = { from() { return {
  select() { return this; }, eq() { return this; }, in() { return this; },
  then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
  async maybeSingle() { return { data: null, error: null }; },
}; } };
const args = {
  appTenantId: 'tenant-a', organizationName: 'Member', invoicingEmail: 'member@example.invalid',
  membershipYear: '2026', finalCost: 100, currency: 'GBP', vatRate: 'NONE',
  extraLineItems: [{ description: 'Training fund', quantity: 1, unitCost: 20, nominalCode: '300' }],
};
const deps = { supabase: db, prepareOnly: true,
  getValidXeroAccessToken: async id => { assert.equal(id, 'tenant-a'); return { accessToken: 'fake', tenantId: 'xero-a' }; },
  findOrCreateXeroContact: async () => 'contact-a',
  fetch: async () => { throw new Error('No live provider requests allowed'); },
};
test('real Xero builder tracks only fee line and leaves genuine PO / TBC unchanged', async () => {
  for (const reference of [null, 'PO-123']) {
    for (const code of [null, ' ', ' MEMBERSHIPS ']) {
      const result = await createXeroMembershipInvoice({ ...args, reference, xeroProjectCode: code }, deps);
      assert.equal(result.payload.Reference, reference || 'TBC');
      assert.deepEqual(result.payload.LineItems[0].Tracking,
        code?.trim() ? [{ Name: 'Projects', Option: 'MEMBERSHIPS' }] : undefined);
      assert.equal(result.payload.LineItems[1].Tracking, undefined);
      assert.equal(result.payload.LineItems[0].UnitAmount, '100.00');
      assert.equal(result.payload.LineItems[1].AccountCode, '300');
    }
  }
});

test('queued preparation retains original tracking including explicit blank after edits', async () => {
  for (const code of ['MEMBERSHIPS', null]) {
    const original = { ...args, xeroProjectCode: code };
    const frozen = await freezeMembershipPreparation({ db, args: original, totalMinor: 12000 });
    original.xeroProjectCode = 'CHANGED';
    const replay = await createXeroMembershipInvoice(frozen.args, deps);
    assert.deepEqual(replay.payload.LineItems[0].Tracking,
      code ? [{ Name: 'Projects', Option: code }] : undefined);
  }
});

test('DD consent saves the selected structure rather than a later mutable setting', () => {
  const config = { id: 'future', xero_project_code: 'MEMBERSHIPS' };
  const snapshot = buildAgreementSnapshot({ offer: { currency: 'GBP', collectionPolicy: { version: 1, end_policy: 'stop', pricing_policy: 'fixed' } }, simResult: { config } });
  config.xero_project_code = 'CHANGED';
  assert.equal(snapshot.xero_project_code, 'MEMBERSHIPS');
});

test('pricing editor preserves hidden values, shows one control for both models, and supports historical disabled state', () => {
  const source = readFileSync(new URL('../../client/src/pages/MembershipTierManagement.jsx', import.meta.url), 'utf8');
  assert.equal((source.match(/data-testid="input-xero-project-code"/g) || []).length, 1);
  assert.match(source, /tierData\?\.accountingProvider === 'xero'/);
  assert.match(source, /handleConfigChange\('xero_project_code', e.target.value\)/);
  assert.match(source, /xero_project_code: \(config.xero_project_code \|\| ''\)\.trim\(\) \|\| null/);
  const control = source.slice(source.indexOf('id="membership-xero-project-code"'), source.indexOf('data-testid="input-xero-project-code"'));
  assert.match(control, /disabled=\{!isEditable\}/);
  assert.equal((source.match(/xero_project_code: c.xero_project_code \|\| null/g) || []).length, 3);
});

test('QuickBooks strips tracking before queueing and provider dispatch', () => {
  const source = readFileSync(new URL('./accountingProvider.js', import.meta.url), 'utf8');
  const qbo = source.slice(source.indexOf('function makeQuickBooksProvider()'));
  assert.ok(qbo.indexOf('xeroProjectCode: ignoredXeroProjectCode') < qbo.indexOf('queueMembershipInvoice'));
});
