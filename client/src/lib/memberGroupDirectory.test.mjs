import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isMemberGroupDirectoryVisible,
  resolveHideOnGroupPage,
} from './memberGroupDirectory.js';

test('directory visibility depends on active and explicit hidden state, not self-join', () => {
  assert.equal(isMemberGroupDirectoryVisible({
    is_active: true,
    allow_self_join: true,
    hide_on_group_page: false,
  }), true);
  assert.equal(isMemberGroupDirectoryVisible({
    is_active: true,
    allow_self_join: false,
    hide_on_group_page: false,
  }), true);
  assert.equal(isMemberGroupDirectoryVisible({
    is_active: true,
    allow_self_join: false,
    hide_on_group_page: true,
  }), false);
  assert.equal(isMemberGroupDirectoryVisible({
    is_active: false,
    allow_self_join: true,
    hide_on_group_page: false,
  }), false);
});

test('legacy, create, edit, and duplicate form values default safely to visible', () => {
  assert.equal(resolveHideOnGroupPage(undefined), false);
  assert.equal(resolveHideOnGroupPage({}), false);
  assert.equal(resolveHideOnGroupPage({ hide_on_group_page: false }), false);
  assert.equal(resolveHideOnGroupPage({ hide_on_group_page: true }), true);
});