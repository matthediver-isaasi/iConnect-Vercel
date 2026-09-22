import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceQueryOptions, RESOURCE_READ_CACHE_KEYS } from './resourceQueryOptions.mjs';

test('ordinary reads never carry management scope', () => {
  assert.deepEqual(resourceQueryOptions(), {});
  assert.deepEqual(resourceQueryOptions({groupId:'group'}), {filter:{member_group_id:'group'}});
});
test('management is an explicit query parameter outside the entity filter', () => {
  assert.deepEqual(resourceQueryOptions({management:true,groupId:'group'}), {
    filter:{member_group_id:'group'},queryParams:{resource_context:'management'},
  });
});
test('mutation invalidation includes browsing, groups, selectors, showcases and embeds', () => {
  for (const key of ['authenticated-resources','member-group-resources','resources-list','showcase-editor-items','public-resources-showcase','embed-resource']) {
    assert.ok(RESOURCE_READ_CACHE_KEYS.includes(key),key);
  }
});