import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDirVis,
  isVisibleInDirectory,
  enrichField,
  sortFieldsForDirectory,
} from './directoryConfig.js';

const DIR = 'dir-1';

test('parseDirVis: legacy array form', () => {
  const parsed = parseDirVis({ directory_visibility: JSON.stringify(['main', DIR]) });
  assert.deepEqual(parsed, { ids: ['main', DIR], labels: {}, display: {} });
});

test('parseDirVis: ids+labels form (no display)', () => {
  const parsed = parseDirVis({ directory_visibility: JSON.stringify({ ids: [DIR], labels: { [DIR]: 'X' } }) });
  assert.deepEqual(parsed.ids, [DIR]);
  assert.deepEqual(parsed.labels, { [DIR]: 'X' });
  assert.deepEqual(parsed.display, {});
});

test('parseDirVis: full display form + invalid JSON returns null', () => {
  const parsed = parseDirVis({
    directory_visibility: JSON.stringify({ ids: [DIR], labels: {}, display: { [DIR]: { front: false, back: true, order: 2 } } })
  });
  assert.deepEqual(parsed.display[DIR], { front: false, back: true, order: 2 });
  assert.equal(parseDirVis({ directory_visibility: '{bad json' }), null);
  assert.equal(parseDirVis({ directory_visibility: null }), null);
});

test('isVisibleInDirectory honours ids; no config means not visible', () => {
  assert.equal(isVisibleInDirectory({ directory_visibility: JSON.stringify([DIR]) }, DIR), true);
  assert.equal(isVisibleInDirectory({ directory_visibility: JSON.stringify(['main']) }, DIR), false);
  assert.equal(isVisibleInDirectory({}, DIR), false);
});

test('enrichField: per-directory flags, label override, order', () => {
  const field = {
    id: 'f1', label: 'Skills',
    directory_visibility: JSON.stringify({
      ids: [DIR], labels: { [DIR]: 'Expertise' },
      display: { [DIR]: { front: true, back: false, order: 3 } }
    })
  };
  const e = enrichField(field, DIR);
  assert.equal(e._displayLabel, 'Expertise');
  assert.equal(e._visFront, true);
  assert.equal(e._visBack, false);
  assert.equal(e._visOrder, 3);
});

test('enrichField: no display entry leaves flags undefined (legacy fallback)', () => {
  const field = { id: 'f1', label: 'Skills', directory_visibility: JSON.stringify({ ids: [DIR], labels: {} }) };
  const e = enrichField(field, DIR);
  assert.equal(e._displayLabel, 'Skills');
  assert.equal(e._visFront, undefined);
  assert.equal(e._visBack, undefined);
  assert.equal(e._visOrder, null);
});

test('enrichField: entry for a DIFFERENT directory does not leak', () => {
  const field = {
    id: 'f1', label: 'Skills',
    directory_visibility: JSON.stringify({ ids: [DIR, 'other'], display: { other: { front: false, back: false, order: 1 } } })
  };
  const e = enrichField(field, DIR);
  assert.equal(e._visFront, undefined);
  assert.equal(e._visBack, undefined);
  assert.equal(e._visOrder, null);
});

test('sortFieldsForDirectory: ordered fields first (asc), rest keep sequence', () => {
  const mk = (id, order) => ({ id, _visOrder: order });
  const sorted = sortFieldsForDirectory([mk('a', null), mk('b', 2), mk('c', null), mk('d', 0)]);
  assert.deepEqual(sorted.map(f => f.id), ['d', 'b', 'a', 'c']);
});

test('sortFieldsForDirectory: no orders -> stable no-op', () => {
  const fields = [{ id: 'a', _visOrder: null }, { id: 'b', _visOrder: null }];
  assert.deepEqual(sortFieldsForDirectory(fields).map(f => f.id), ['a', 'b']);
});

// --- core-only reorder with interleaved legacy custom:* keys ----------------

const { reorderCoreFieldOrder } = await import('../../client/src/utils/directorySettings.js');

test('reorderCoreFieldOrder: reorders core keys, custom:* keys stay in place', () => {
  const order = ['show_profile_photo', 'custom:x', 'show_organization', 'custom:y', 'show_job_title'];
  // Move core index 0 (profile_photo) to core index 2 (after job_title)
  const next = reorderCoreFieldOrder(order, 0, 2);
  assert.deepEqual(next, ['show_organization', 'custom:x', 'show_job_title', 'custom:y', 'show_profile_photo']);
});

test('reorderCoreFieldOrder: out-of-range indices are a no-op', () => {
  const order = ['show_profile_photo', 'custom:x', 'show_organization'];
  assert.deepEqual(reorderCoreFieldOrder(order, 0, 5), order);
  assert.deepEqual(reorderCoreFieldOrder(order, -1, 0), order);
});

test('reorderCoreFieldOrder: core-only array behaves like a plain move', () => {
  const order = ['show_profile_photo', 'show_organization', 'show_job_title'];
  assert.deepEqual(
    reorderCoreFieldOrder(order, 2, 0),
    ['show_job_title', 'show_profile_photo', 'show_organization']
  );
});
