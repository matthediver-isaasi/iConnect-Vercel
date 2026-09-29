import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('a successful calculation for another year never becomes an actionable preview', async () => {
  const source = await readFile(new URL('./org-membership.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async function preview(');
  const end = source.indexOf('\n  {\n', start);
  for (const key of ['currentYear', 'nextYear']) {
    const warnings = { currentYear: null, nextYear: null };
    const preview = new Function('simulateMembershipForOrg', 'mapSimResultToYearData', 'previewWarnings',
      `const tenantId = 'tenant', organizationId = 'org'; ${source.slice(start, end)}; return preview;`)(
      async () => ({ success: true, membershipYear: { label: 'wrong-year' }, finalCost: 100 }),
      () => assert.fail('Mismatched quote must not be mapped'), warnings,
    );
    assert.equal(await preview(key, { label: 'requested-year' }, '2027-01-01'), null);
    assert.equal(warnings[key].membershipYear, 'requested-year');
    assert.equal(warnings[key].code, 'membership_year_mismatch');
    assert.equal(warnings[key === 'currentYear' ? 'nextYear' : 'currentYear'], null);
  }
});