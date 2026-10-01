import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupInitialSelectionCandidate,
  hasGroupInitialSelectionAnswer,
  groupInitialSelectionSurfaceReady,
  repeatableGroupInitialCellEntries,
  resolveGroupInitialSelection,
} from './formGroupInitialSelection.js';

const id = '10000000-0000-4000-8000-000000000001';
const field = { id: 'group', name: 'legacy-group', type: 'organisation_group_dropdown', group_initial_selection: { mode: 'specific', group_id: id } };

test('contract defaults absent/none to no selection and reads only the fixed URL parameter', () => {
  assert.equal(groupInitialSelectionCandidate({ ...field, group_initial_selection: undefined }, `?group_id=${id}`), null);
  assert.equal(groupInitialSelectionCandidate({ ...field, group_initial_selection: { mode: 'none' } }, `?group_id=${id}`), null);
  assert.equal(groupInitialSelectionCandidate(field), id);
  const urlField = { ...field, group_initial_selection: { mode: 'url', group_id: 'ignored' } };
  assert.equal(groupInitialSelectionCandidate(urlField, `?group_id=${id}`), id);
  for (const search of ['', '?group_id=not-a-uuid', `?legacy-group=${id}`, `?group_id=${id}&group_id=${id}`]) {
    assert.equal(groupInitialSelectionCandidate(urlField, search), null);
  }
  assert.equal(groupInitialSelectionCandidate({ ...field, group_initial_selection: { mode: 'specific', group_id: 'bad' } }), null);
});

test('presence protects every blank representation and name-keyed historical answers', () => {
  for (const value of ['', null, [], undefined, 'saved']) {
    assert.equal(hasGroupInitialSelectionAnswer(field, { group: value }, undefined), true);
    assert.equal(hasGroupInitialSelectionAnswer(field, { 'legacy-group': value }, undefined), true);
  }
  assert.equal(hasGroupInitialSelectionAnswer(field, {}, undefined), false);
  assert.deepEqual(repeatableGroupInitialCellEntries(field), []);
  assert.deepEqual(repeatableGroupInitialCellEntries(field, { group: null }), [['group', null]]);
});

test('candidate must be successfully loaded, tenant-allowed, conditional and available', () => {
  const input = { field, values: {}, ready: true, optionsLoaded: true, options: [{ id }], conditionalResolution: { valid: true } };
  assert.equal(resolveGroupInitialSelection(input), id);
  assert.equal(resolveGroupInitialSelection({ ...input, field: { ...field, locked: true } }), id);
  for (const override of [
    { ready: false }, { optionsLoaded: false }, { optionsError: true }, { options: [] },
    { disabled: true }, { field: { ...field, read_only: true } }, { field: { ...field, display_only: true } }, { values: { group: '' } },
    { conditionalResolution: { valid: false } }, { optionIsAvailable: () => false },
  ]) assert.equal(resolveGroupInitialSelection({ ...input, ...override }), null);
});

test('surface readiness waits for matching defaults, auth, draft, prefill and current-set restoration', () => {
  const input = { form: { id: 'form' }, initialized: true, initializedFormId: 'form', authResolved: true };
  assert.equal(groupInitialSelectionSurfaceReady(input), true);
  for (const override of [
    { initialized: false }, { initializedFormId: 'old-form' }, { authResolved: false },
    { draftToken: 'draft' }, { prefillExpected: true }, { currentSetPending: true }, { blocked: true },
  ]) assert.equal(groupInitialSelectionSurfaceReady({ ...input, ...override }), false);
  assert.equal(groupInitialSelectionSurfaceReady({ ...input, draftToken: 'draft', draftLoaded: true, prefillExpected: true, prefillApplied: true }), true);
});