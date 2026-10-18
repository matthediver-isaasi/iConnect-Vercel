import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSalesSettingsPatch, mapSalesSettingsRow } from '../../shared/salesContracts.js';
import { patchSalesSettings } from './salesFoundation.js';
import { PARTNERSHIP_TERMS_HTML } from '../../client/src/components/sales/partnershipTerms.js';

test('standalone GFI clauses run 1–14, preserving percentages, durations and statutes', () => {
  assert.deepEqual([...PARTNERSHIP_TERMS_HTML.matchAll(/<h3>(\d+)\./g)].map(m => Number(m[1])), Array.from({ length: 14 }, (_, i) => i + 1));
  for (const text of ['90 days', '25%', '50%', '75%', '100%', '2018', '1999', '4%']) assert.ok(PARTNERSHIP_TERMS_HTML.includes(text), text);
  assert.equal(/\bclauses?\s+\d/i.test(PARTNERSHIP_TERMS_HTML), false, 'Review numbered cross-references if terms change');
});

test('settings require bounded HTML, and explicit empty is preserved', () => {
  for (const value of ['', PARTNERSHIP_TERMS_HTML]) assert.equal(validateSalesSettingsPatch({ expectedVersion: 1, partnershipTermsHtml: value }).ok, true);
  for (const value of [null, false, 42, {}, 'x'.repeat(100001)]) assert.equal(validateSalesSettingsPatch({ expectedVersion: 1, partnershipTermsHtml: value }).ok, false);
  assert.equal(mapSalesSettingsRow({ partnership_terms_html: '' }).partnershipTermsHtml, '');
});

test('save sanitizes HTML server-side and retains tables in tenant-scoped versioned RPC', async () => {
  let call;
  await patchSalesSettings({ rpc: async (name, args) => {
    call = { name, args };
    return { data: { partnership_terms_html: args.p_patch.partnershipTermsHtml }, error: null };
  } }, 'tenant-a', { actorId: 'actor', actorType: 'tenant_user' }, {
    expectedVersion: 4, partnershipTermsHtml: '<script>alert(1)</script><p onclick="bad()">Terms</p><table><tr><td>25%</td></tr></table>',
  });
  assert.equal(call.args.p_tenant_id, 'tenant-a');
  assert.equal(call.args.p_expected_version, 4);
  assert.doesNotMatch(call.args.p_patch.partnershipTermsHtml, /script|onclick/);
  assert.match(call.args.p_patch.partnershipTermsHtml, /<table>/);
});
