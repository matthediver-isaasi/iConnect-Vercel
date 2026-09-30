import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSetValueConvergenceState,
  formValuesSemanticallyEqual,
  legacySetValueActionKey,
  mergeSemanticFormValueUpdates,
  planSemanticFormValueUpdate,
  prepareSetValueTransition,
  setValueActionKey,
  settleSetValueConvergence,
} from './formValueConvergence.js';

test('structured field values compare by content rather than regenerated identity', () => {
  assert.equal(formValuesSemanticallyEqual(
    { selected: [{ id: 'a', label: 'Alpha' }], meta: { page: 1, active: true } },
    { meta: { active: true, page: 1 }, selected: [{ label: 'Alpha', id: 'a' }] },
  ), true);
  assert.equal(formValuesSemanticallyEqual(['a', 'b'], ['b', 'a']), false);
});

test('semantic no-op updates preserve the form-values object identity', () => {
  const current = {
    text: 'same',
    structured: { ids: ['a', 'b'], option: { id: 'x' } },
  };
  const noOp = mergeSemanticFormValueUpdates(current, {
    text: 'same',
    structured: { option: { id: 'x' }, ids: ['a', 'b'] },
  });
  assert.equal(noOp, current);

  const changed = mergeSemanticFormValueUpdates(current, {
    structured: { option: { id: 'y' }, ids: ['a', 'b'] },
  });
  assert.notEqual(changed, current);
  assert.equal(changed.text, current.text);
  assert.equal(changed.structured.option.id, 'y');
});

test('static, field, formula, and prefill updates settle after one semantic transition', () => {
  const scenarios = [
    {
      name: 'static',
      currentValues: { trigger: 'yes', target: '' },
      updates: () => ({ target: 'configured' }),
    },
    {
      name: 'field',
      currentValues: { trigger: 'yes', source: { ids: ['a'] }, target: null },
      updates: (values) => ({ target: { ...values.source, ids: [...values.source.ids] } }),
    },
    {
      name: 'formula',
      currentValues: { trigger: 'yes', left: '2', right: '3', target: '' },
      updates: (values) => ({ target: String(Number(values.left) + Number(values.right)) }),
    },
    {
      name: 'prefill',
      currentValues: { trigger: 'yes', target: { id: 'org-1', label: 'Example' } },
      updates: () => ({ target: { label: 'Example', id: 'org-1' } }),
    },
  ];

  for (const scenario of scenarios) {
    const state = createSetValueConvergenceState();
    const first = planSemanticFormValueUpdate(state, {
      formId: `membership-${scenario.name}`,
      currentValues: scenario.currentValues,
      updates: scenario.updates(scenario.currentValues),
    });
    const committed = first.apply ? first.nextValues : scenario.currentValues;
    const settled = planSemanticFormValueUpdate(state, {
      formId: `membership-${scenario.name}`,
      currentValues: committed,
      updates: scenario.updates(committed),
    });
    assert.equal(settled.apply, false, `${scenario.name} should settle`);
    assert.equal(settled.cycle, false, `${scenario.name} should not be treated as a cycle`);
  }
});

test('a repeated automatic state is blocked once until an external edit resets the chain', () => {
  const state = createSetValueConvergenceState();
  const first = prepareSetValueTransition(state, {
    formId: 'membership-form',
    currentValues: { a: 'left', b: 'right' },
    nextValues: { a: 'right', b: 'left' },
  });
  assert.equal(first.apply, true);

  const cycle = prepareSetValueTransition(state, {
    formId: 'membership-form',
    currentValues: { a: 'right', b: 'left' },
    nextValues: { a: 'left', b: 'right' },
  });
  assert.deepEqual(cycle, { apply: false, cycle: true, shouldWarn: true });

  const blockedRepeat = prepareSetValueTransition(state, {
    formId: 'membership-form',
    currentValues: { a: 'right', b: 'left' },
    nextValues: { a: 'left', b: 'right' },
  });
  assert.deepEqual(blockedRepeat, { apply: false, cycle: true, shouldWarn: false });

  const afterRespondentEdit = prepareSetValueTransition(state, {
    formId: 'membership-form',
    currentValues: { a: 'manual', b: 'left' },
    nextValues: { a: 'right', b: 'left' },
  });
  assert.equal(afterRespondentEdit.apply, true);
});

test('long non-converging chains stop at the configured transition limit', () => {
  const state = createSetValueConvergenceState(2);
  assert.equal(prepareSetValueTransition(state, {
    formId: 'membership-form',
    currentValues: { value: 0 },
    nextValues: { value: 1 },
  }).apply, true);
  assert.equal(prepareSetValueTransition(state, {
    formId: 'membership-form',
    currentValues: { value: 1 },
    nextValues: { value: 2 },
  }).apply, true);
  assert.deepEqual(prepareSetValueTransition(state, {
    formId: 'membership-form',
    currentValues: { value: 2 },
    nextValues: { value: 3 },
  }), { apply: false, cycle: true, shouldWarn: true });

  settleSetValueConvergence(state, 'membership-form', { value: 2 });
  assert.equal(prepareSetValueTransition(state, {
    formId: 'membership-form',
    currentValues: { value: 2 },
    nextValues: { value: 3 },
  }).apply, true);
});

test('set-value action keys stay unique when persisted action ids are missing or duplicated', () => {
  assert.notEqual(
    setValueActionKey({ id: 'rule-a' }, { id: 'shared' }, 0, 0),
    setValueActionKey({ id: 'rule-a' }, { id: 'shared' }, 0, 1),
  );
  assert.notEqual(
    setValueActionKey({ id: 'rule-a' }, { id: 'shared' }, 0, 0),
    setValueActionKey({ id: 'rule-b' }, { id: 'shared' }, 1, 0),
  );
  assert.notEqual(
    setValueActionKey({ id: 'duplicate-rule' }, { id: 'duplicate-action' }, 0, 0),
    setValueActionKey({ id: 'duplicate-rule' }, { id: 'duplicate-action' }, 1, 0),
  );
  assert.equal(setValueActionKey({}, {}, 2, 3), 'action:missing:2:missing:3');
  assert.equal(legacySetValueActionKey({}, 4), 'legacy:missing:4');
});

test('FormView has no informational console output and wires semantic bounded updates', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../pages/FormView.jsx'), 'utf8');

  assert.doesNotMatch(source, /console\.(?:log|debug|info)\s*\(/);
  assert.match(source, /planSemanticFormValueUpdate\(setValueConvergenceRef\.current/);
  assert.match(source, /setFormValues\(prev => mergeSemanticFormValueUpdates\(prev, updates\)\)/);
  assert.match(source, /setValueActionKey\(rule, action, ruleIndex, actionIndex\)/);
  assert.match(source, /const EMPTY_FORM_COLLECTION = Object\.freeze\(\[\]\)/);
  assert.doesNotMatch(source, /console\.error\([^)]*,\s*error\)/);
});