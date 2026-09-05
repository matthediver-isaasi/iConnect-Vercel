import test from 'node:test';
import assert from 'node:assert/strict';
import {
  savedListViewPreferenceKey,
  sanitizeSavedViews,
} from './savedListViewHelpers.mjs';

test('custom object saved views are safely isolated per object and member', () => {
  assert.equal(
    savedListViewPreferenceKey('customObjects', 'member-1', 'object-a'),
    'crm_custom_object_views_member-1_object-a',
  );
  assert.notEqual(
    savedListViewPreferenceKey('customObjects', 'member-1', 'object-a'),
    savedListViewPreferenceKey('customObjects', 'member-1', 'object-b'),
  );
  assert.equal(savedListViewPreferenceKey('customObjects', 'member-1'), null);
  assert.equal(savedListViewPreferenceKey('customObjects', null, 'object-a'), null);
});

test('saved views retain valid custom object state and enforce one default', () => {
  const views = sanitizeSavedViews([
    { id: 'a', name: 'A', isDefault: true, filters: { includeArchived: true }, columns: [] },
    { id: 'b', name: 'B', isDefault: true, filters: { filters: { relationship: [] } }, columns: [{ id: 'name' }] },
  ], () => 'generated');
  assert.equal(views.length, 2);
  assert.equal(views.filter((view) => view.isDefault).length, 1);
  assert.equal(views[0].columns, null);
  assert.deepEqual(views[1].columns, [{ id: 'name' }]);
});