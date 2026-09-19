import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatePools, matchingStructures, main } from './bnms-dd-beta-review.mjs';
import { TENANT_ID, MEMBER_ID, CUSTOMER_ID, MANDATE_ID } from './bnms-dd-pilot.mjs';

const grid = () => {
  const rows = [['match_outcome', 'customer_email', 'normalized_email', 'iConnect Email address',
    'iConnect UUID', 'gocardless_customer_id', 'gocardless_mandate_id', 'mandate_status', 'matched_member_id', 'error_message']];
  for (let n = 0; n < 47; n++) rows.push(['', '', '', `member${n}@example.test`, `member${n}`, `CU${n}`, `MD${n}`, '', '', '']);
  rows[3][4] = MEMBER_ID; rows[3][5] = CUSTOMER_ID; rows[3][6] = MANDATE_ID;
  return rows;
};
test('beta pools exclude original pilot and ambiguous identity, prefer explicit spreadsheet mapping', () => {
  const g = grid();
  const members = g.slice(1).map(r => ({ id: r[4], email: r[3], tenant_id: TENANT_ID }));
  members.push({ id: 'direct', email: 'direct@example.test', tenant_id: TENANT_ID });
  const discovery = [{ matched_member_id: 'direct', customer_email: 'direct@example.test', gocardless_customer_id: 'CU999', gocardless_mandate_id: 'MD999' }];
  let pools = candidatePools(g, members, discovery);
  assert.equal(pools[0].length, 46);
  assert.equal(pools[1].length, 1);
  assert.ok(!pools.flat().some(r => r.memberId === MEMBER_ID));
  members.push({ id: 'duplicate', email: members[0].email, tenant_id: TENANT_ID });
  pools = candidatePools(g, members, [...discovery, ...discovery]);
  assert.equal(pools[0].length, 45);
  assert.equal(pools[1].length, 0);
});
test('structure evidence accepts SQL Date objects and inclusive boundaries; does not infer terms', () => {
  const s = { is_active: true, dd_enabled: true, structure_scope_type: 'member', structure_match_value: 'Full',
    effective_from: new Date('2026-09-01'), effective_to: new Date('2026-09-30') };
  assert.equal(matchingStructures([s], [{ value: 'Full' }], '2026-09-01').length, 1);
  assert.equal(matchingStructures([s], [{ value: 'Full' }], '2026-09-30').length, 1);
  assert.equal(matchingStructures([s], [{ value: 'Full' }], '2026-10-01').length, 0);
  assert.equal(matchingStructures([s], [], '2026-09-19').length, 0);
});
test('no apply or unsafe output path accepted', async () => {
  await assert.rejects(main(['--apply']), /no apply mode/);
  await assert.rejects(main(['--out', 'report.json']), /no apply mode/);
});