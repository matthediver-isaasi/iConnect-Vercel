import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseFlatMembershipCost } from './membershipFlatCost.js';

test('accepts and preserves explicit zero and positive flat membership costs', () => {
  assert.deepEqual(parseFlatMembershipCost('0'), { valid: true, value: 0 });
  assert.deepEqual(parseFlatMembershipCost(0), { valid: true, value: 0 });
  assert.deepEqual(parseFlatMembershipCost('125.50'), { valid: true, value: 125.5 });
});

test('rejects empty, malformed, and negative flat membership costs', () => {
  for (const value of [null, undefined, '', '   ', 'not-a-number', '-0.01']) {
    const result = parseFlatMembershipCost(value);
    assert.equal(result.valid, false, `${JSON.stringify(value)} should be invalid`);
    assert.match(result.error, /0 or more/);
  }
});

test('wizard input and API save path both use the strict flat-cost contract', () => {
  const pageSource = fs.readFileSync(
    new URL('../client/src/pages/MembershipTierManagement.jsx', import.meta.url),
    'utf8',
  );
  const apiSource = fs.readFileSync(
    new URL('../api/membership/tiers.js', import.meta.url),
    'utf8',
  );

  assert.match(pageSource, /min="0"[\s\S]*value=\{config\.flat_cost \?\? ''\}/);
  assert.match(pageSource, /const parsedFlatCost = isFlat \? parseFlatMembershipCost\(config\.flat_cost\) : null/);
  assert.match(pageSource, /if \(parsedFlatCost && !parsedFlatCost\.valid\)[\s\S]*setWizardStep\(5\)/);
  assert.match(apiSource, /flat_cost: config\.pricing_model === 'flat' \? parsedFlatCost\.value : null/g);
});