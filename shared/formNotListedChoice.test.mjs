import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_NOT_LISTED_LABELS_KEY,
  FORM_NOT_LISTED_VALUE,
  applyExclusiveFormNotListedSelection,
  hasEnabledFormNotListedChoice,
  prependFormNotListedOption,
  preserveFormNotListedLabelSnapshots,
  resolveFormNotListedDisplayValue,
  snapshotFormNotListedLabels,
} from './formNotListedChoice.js';

const field = {
  id: 'org',
  type: 'organisation_dropdown',
  not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
};

test('enables only supported fields with a non-blank configured label', () => {
  assert.equal(hasEnabledFormNotListedChoice(field), true);
  assert.equal(hasEnabledFormNotListedChoice({ ...field, type: 'select' }), false);
  assert.equal(hasEnabledFormNotListedChoice({ ...field, not_listed_choice: { enabled: true, label: ' ' } }), false);
});

test('prepends one stable synthetic value without changing real options', () => {
  assert.deepEqual(prependFormNotListedOption(field, [{ value: 'org-1', label: 'Org 1' }]), [
    { value: FORM_NOT_LISTED_VALUE, label: 'My organisation is not listed' },
    { value: 'org-1', label: 'Org 1' },
  ]);
});

test('multi-select synthetic choice is exclusive with real values', () => {
  assert.deepEqual(applyExclusiveFormNotListedSelection(['one'], FORM_NOT_LISTED_VALUE), [FORM_NOT_LISTED_VALUE]);
  assert.deepEqual(applyExclusiveFormNotListedSelection([FORM_NOT_LISTED_VALUE], 'one'), ['one']);
  assert.deepEqual(applyExclusiveFormNotListedSelection([FORM_NOT_LISTED_VALUE], FORM_NOT_LISTED_VALUE), []);
});

test('snapshots and resolves the submitted label after configuration changes', () => {
  const stored = snapshotFormNotListedLabels([field], { org: FORM_NOT_LISTED_VALUE });
  assert.equal(stored[FORM_NOT_LISTED_LABELS_KEY].org, 'My organisation is not listed');
  const renamed = { ...field, not_listed_choice: { enabled: false, label: 'A new label' } };
  assert.equal(
    resolveFormNotListedDisplayValue(renamed, FORM_NOT_LISTED_VALUE, stored),
    'My organisation is not listed',
  );
});

test('snapshots repeatable child labels independently beneath the container field', () => {
  const repeatable = {
    id: 'rows',
    type: 'repeatable_row',
    repeatable_row: {
      children: [{
        id: 'country',
        type: 'country',
        not_listed_choice: { enabled: true, label: 'Original country label' },
      }],
    },
  };
  const stored = snapshotFormNotListedLabels([repeatable], {
    rows: [{ country: FORM_NOT_LISTED_VALUE }],
  });
  assert.equal(stored[FORM_NOT_LISTED_LABELS_KEY].rows.country, 'Original country label');
  const renamedChild = {
    ...repeatable.repeatable_row.children[0],
    not_listed_choice: { enabled: false, label: 'Renamed country label' },
  };
  assert.equal(
    resolveFormNotListedDisplayValue(
      renamedChild,
      FORM_NOT_LISTED_VALUE,
      stored,
      { parentField: repeatable },
    ),
    'Original country label',
  );
});

test('trusted historical labels survive a later submission edit while new labels are retained', () => {
  const merged = preserveFormNotListedLabelSnapshots({
    __not_listed_choice_labels: {
      rows: { new_child: 'New child label', old_child: 'Renamed label' },
    },
  }, {
    __not_listed_choice_labels: {
      rows: { old_child: 'Original child label' },
      top_level: 'Original top-level label',
    },
  });
  assert.deepEqual(merged.__not_listed_choice_labels, {
    rows: {
      new_child: 'New child label',
      old_child: 'Original child label',
    },
    top_level: 'Original top-level label',
  });
});