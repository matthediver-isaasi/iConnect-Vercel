import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_STUDIO_PAGE_KEY,
  normaliseDataStudioExclusions,
  planDataStudioPageMigration,
} from './custom-objects-role-access-helpers.mjs';

test('legacy Data Studio exclusions normalise without duplicates', () => {
  assert.deepEqual(
    normaliseDataStudioExclusions([
      'data',
      'data.custom-objects',
      'page_CustomObjectsAdmin',
      'admin.data-studio',
      'data.custom-objects.manage-data-model',
    ]),
    [DATA_STUDIO_PAGE_KEY, 'data.custom-objects.manage-data-model'],
  );
});

test('an old page row is renamed and moved without changing its id', () => {
  const row = {
    id: 'legacy-page',
    item_type: 'page',
    item_key: 'data.custom-objects',
    label: 'Custom Objects',
    icon: null,
    parent_id: 'data-module',
    is_active: true,
  };
  const plan = planDataStudioPageMigration([row], 'admin-module');
  assert.equal(plan.keeper.id, 'legacy-page');
  assert.deepEqual(plan.repairs, {
    item_key: 'admin.data-studio',
    label: 'Data Studio',
    parent_id: 'admin-module',
  });
  assert.deepEqual(plan.retireIds, []);
});

test('a canonical row wins and active duplicates are retired idempotently', () => {
  const canonical = {
    id: 'canonical-page',
    item_type: 'page',
    item_key: 'admin.data-studio',
    label: 'Data Studio',
    icon: null,
    parent_id: 'admin-module',
    is_active: true,
  };
  const legacy = {
    id: 'legacy-page',
    item_type: 'page',
    item_key: 'data.custom-objects',
    label: 'Custom Objects',
    icon: null,
    parent_id: 'data-module',
    is_active: true,
  };
  const first = planDataStudioPageMigration([legacy, canonical], 'admin-module');
  assert.equal(first.keeper.id, 'canonical-page');
  assert.deepEqual(first.repairs, {});
  assert.deepEqual(first.retireIds, ['legacy-page']);

  const rerun = planDataStudioPageMigration(
    [{ ...legacy, is_active: false }, canonical],
    'admin-module',
  );
  assert.equal(rerun.keeper.id, 'canonical-page');
  assert.deepEqual(rerun.repairs, {});
  assert.deepEqual(rerun.retireIds, []);
});