import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('./MonthlyMembershipRecoveryCard.jsx', import.meta.url),
  'utf8',
);

test('recovery UI requires explicit confirmation and posts confirmed true', () => {
  assert.match(source, /confirmed:\s*true/);
  assert.match(source, /disabled=\{!confirmed \|\| busy\}/);
  assert.match(source, /Confirmation may create|confirmationDisclosure/);
});

test('recovery UI provides loading, errors, preview and invalidation', () => {
  assert.match(source, /Loading pending agreements/);
  assert.match(source, /role="alert"/);
  assert.match(source, /monthly-recovery\?agreementId=/);
  assert.match(source, /invalidateQueries/);
  assert.match(source, /This is not a general provider recovery tool/);
  assert.match(source, /Mandate status/);
  assert.match(source, /Earliest possible charge/);
  assert.match(source, /Latest invoice status/);
  assert.match(source, /Latest invoice paid/);
  assert.match(source, /Membership history/);
  assert.match(source, /Local payment status/);
  assert.match(source, /Selected agreement/);
  assert.match(source, /Inspect a known historical agreement ID/);
  assert.match(source, /result\.resumed !== true/);
});