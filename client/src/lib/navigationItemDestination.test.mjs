import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_NAVIGATION_PAGE_VALUE,
  canBePageLessParentMenu,
  getNavigationDestinationError,
  getNavigationPageSelectValue,
  getNavigationPageUrl,
  isPageLessParentMenu,
} from './navigationItemDestination.js';

test('top-level and nested header items can be page-less parent menus', () => {
  for (const location of ['top_nav', 'main_nav']) {
    for (const parent_id of [null, 'parent-id']) {
      const item = {
        link_type: 'internal',
        location,
        parent_id,
        url: '',
      };

      assert.equal(canBePageLessParentMenu(item), true);
      assert.equal(getNavigationPageSelectValue(item.url), NO_NAVIGATION_PAGE_VALUE);
      assert.equal(getNavigationDestinationError(item), '');
      assert.equal(item.parent_id, parent_id);
      assert.equal(item.url, '');
    }
  }
});

test('clearing and reselecting a page maps between the sentinel and persisted URL', () => {
  const nestedItem = {
    link_type: 'internal',
    location: 'main_nav',
    parent_id: 'parent-id',
    url: 'Events',
  };

  nestedItem.url = getNavigationPageUrl(NO_NAVIGATION_PAGE_VALUE);
  assert.equal(nestedItem.url, '');
  assert.equal(nestedItem.parent_id, 'parent-id');
  assert.equal(getNavigationPageSelectValue(nestedItem.url), NO_NAVIGATION_PAGE_VALUE);
  assert.equal(getNavigationDestinationError(nestedItem), '');

  nestedItem.url = getNavigationPageUrl('Events');
  assert.equal(nestedItem.url, 'Events');
  assert.equal(nestedItem.parent_id, 'parent-id');
  assert.equal(getNavigationPageSelectValue(nestedItem.url), 'Events');
  assert.equal(getNavigationDestinationError(nestedItem), '');
});

test('page-less nested header parents are menu controls only when they have children', () => {
  const nestedParent = {
    link_type: 'internal',
    location: 'main_nav',
    parent_id: 'parent-id',
    url: '',
    children: [{ id: 'child-id' }],
  };

  assert.equal(isPageLessParentMenu(nestedParent), true);
  assert.equal(isPageLessParentMenu({ ...nestedParent, url: 'Events' }), false);
  assert.equal(isPageLessParentMenu({ ...nestedParent, children: [] }), false);
  assert.equal(isPageLessParentMenu({ ...nestedParent, link_type: 'external' }), false);
  assert.equal(isPageLessParentMenu({ ...nestedParent, location: 'footer' }), false);
});

test('internal footer items still require a page', () => {
  assert.match(getNavigationDestinationError({
    link_type: 'internal',
    location: 'footer',
    parent_id: null,
    url: '',
  }), /footer item/i);
});

test('unrelated navigation item types retain their destination rules', () => {
  assert.equal(getNavigationDestinationError({
    link_type: 'external',
    location: 'main_nav',
    parent_id: null,
    url: '',
  }), 'URL is required');
  assert.equal(getNavigationDestinationError({
    link_type: 'external',
    location: 'main_nav',
    parent_id: null,
    url: 'https://example.com',
  }), '');
  assert.equal(getNavigationDestinationError({
    link_type: 'form_modal',
    location: 'main_nav',
    parent_id: null,
    url: '',
  }), '');
  assert.equal(getNavigationDestinationError({
    link_type: 'content_block',
    location: 'footer',
    parent_id: null,
    url: '',
  }), '');
});