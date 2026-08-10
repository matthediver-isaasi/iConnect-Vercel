import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasMembershipStructureAction,
  collectRevealableIds,
  findUnrevealedHidden,
} from './formHiddenReachability.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const builderSrc = fs.readFileSync(path.join(__dirname, '../pages/FormBuilder.jsx'), 'utf8');

// ---------------------------------------------------------------------------
// hasMembershipStructureAction
// ---------------------------------------------------------------------------

test('hasMembershipStructureAction: true only for a rule action with a config_id', () => {
  assert.equal(hasMembershipStructureAction(null), false);
  assert.equal(hasMembershipStructureAction([]), false);
  assert.equal(hasMembershipStructureAction([{ actions: [{ action_type: 'visibility' }] }]), false);
  // membership action missing config_id does not count
  assert.equal(hasMembershipStructureAction([{ actions: [{ action_type: 'membership_structure', config_id: '  ' }] }]), false);
  assert.equal(hasMembershipStructureAction([
    { actions: [{ action_type: 'set_value' }] },
    { actions: [{ action_type: 'membership_structure', config_id: 'cfg-1' }] },
  ]), true);
});

// ---------------------------------------------------------------------------
// collectRevealableIds — all three rule shapes the builder recognises
// ---------------------------------------------------------------------------

test('collectRevealableIds: visibility field_states, show action, legacy show rule', () => {
  const ids = collectRevealableIds([
    { actions: [{ action_type: 'visibility', field_states: { page_a: { visible: true }, field_b: { visible: false } } }] },
    { actions: [{ action_type: 'show', target_field_ids: ['field_c'] }] },
    { action: 'show', target_field_ids: ['field_d'] },
    null,
  ]);
  assert.ok(ids.has('page_a'));
  assert.ok(!ids.has('field_b')); // visible:false is not a reveal
  assert.ok(ids.has('field_c'));
  assert.ok(ids.has('field_d'));
});

// ---------------------------------------------------------------------------
// findUnrevealedHidden
// ---------------------------------------------------------------------------

const pages = [
  { id: 'page_shown', title: 'Shown' },
  { id: 'page_revealed', title: 'Revealed', starts_hidden: true },
  { id: 'page_stuck', title: 'Best membership for you', starts_hidden: true },
];
const fields = [
  { id: 'f_normal', label: 'Normal', page_id: 'page_shown' },
  { id: 'f_hidden_revealed', label: 'Hidden revealed', page_id: 'page_shown', starts_hidden: true },
  { id: 'f_hidden_stuck', label: 'Hidden stuck', page_id: 'page_shown', starts_hidden: true },
  { id: 'f_on_stuck_page', label: 'Membership payment', page_id: 'page_stuck' },
];
const rules = [
  { actions: [{ action_type: 'visibility', field_states: { page_revealed: { visible: true }, f_hidden_revealed: { visible: true } } }] },
];

test('findUnrevealedHidden: reports hidden pages/fields no rule reveals', () => {
  const result = findUnrevealedHidden(fields, pages, rules);
  assert.deepEqual(result.pages, [{ id: 'page_stuck', title: 'Best membership for you' }]);
  assert.deepEqual(result.fields, [{ id: 'f_hidden_stuck', label: 'Hidden stuck' }]);
});

test('findUnrevealedHidden: fields on an unreachable page are not double-reported', () => {
  const withHiddenField = fields.map(f =>
    f.id === 'f_on_stuck_page' ? { ...f, starts_hidden: true } : f);
  const result = findUnrevealedHidden(withHiddenField, pages, rules);
  // page covers it; field list unchanged
  assert.deepEqual(result.fields.map(f => f.id), ['f_hidden_stuck']);
});

test('findUnrevealedHidden: legacy string "true" starts_hidden is treated as hidden (FormView parity)', () => {
  const legacyPages = [{ id: 'page_legacy', title: 'Legacy', starts_hidden: 'true' }];
  const legacyFields = [{ id: 'f_legacy', label: 'Legacy field', page_id: 'page_shown', starts_hidden: 'true' }];
  const result = findUnrevealedHidden(legacyFields, legacyPages, []);
  assert.deepEqual(result.pages.map(p => p.id), ['page_legacy']);
  assert.deepEqual(result.fields.map(f => f.id), ['f_legacy']);
  // 'false' string is NOT hidden
  const notHidden = findUnrevealedHidden([{ id: 'f2', starts_hidden: 'false' }], [], []);
  assert.deepEqual(notHidden.fields, []);
});

test('FormBuilder: warning dismissal is keyed to the finding set (new findings resurface)', () => {
  assert.ok(builderSrc.includes('dismissedKey === findingKey'), 'render gate must compare the dismissed key to the current finding key');
  assert.ok(builderSrc.includes('setDismissedKey(findingKey)'), 'dismiss must record the current finding key');
});

test('findUnrevealedHidden: empty when everything is revealed or visible', () => {
  const allRevealed = [
    { actions: [{ action_type: 'visibility', field_states: { page_stuck: { visible: true }, f_hidden_stuck: { visible: true } } }] },
    ...rules,
  ];
  const result = findUnrevealedHidden(fields, pages, allRevealed);
  assert.deepEqual(result, { pages: [], fields: [] });
});

// ---------------------------------------------------------------------------
// FormBuilder source contracts (Task #3497)
// ---------------------------------------------------------------------------

test('FormBuilder: save validation only requires a price source without a membership action', () => {
  assert.ok(
    builderSrc.includes('hasMembershipStructureAction(formData.visibility_rules)'),
    'save validation must consult hasMembershipStructureAction'
  );
  // dangling price_field_id must still error even with a membership action
  assert.ok(
    builderSrc.includes('points at a price source field that no longer exists'),
    'dangling price_field_id must still be an error'
  );
  // the unconditional "needs a price source" toast shape must be gated
  const gated = /if \(!pf\.price_field_id\) \{\s*if \(!membershipDerived\) \{/.test(builderSrc);
  assert.ok(gated, 'missing price source must be allowed when membershipDerived');
});

test('FormBuilder: membership action panel distinguishes Membership Payment from Payment', () => {
  assert.ok(builderSrc.includes('membership-action-no-payment-warning'));
  assert.ok(
    builderSrc.includes("fields.some(f => f.type === 'membership_payment')"),
    'panel must branch on an existing membership_payment field'
  );
  assert.ok(builderSrc.includes('separate mechanism for charging'));
});

test('FormBuilder: builder tab renders the unreachable-hidden warning', () => {
  assert.ok(builderSrc.includes('<UnreachableHiddenWarning'));
  assert.ok(builderSrc.includes('unreachable-hidden-warning'));
  assert.ok(builderSrc.includes('findUnrevealedHidden(fields, pages, visibilityRules)'));
});
