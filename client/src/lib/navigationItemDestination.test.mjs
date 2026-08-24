import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_NAVIGATION_PAGE_VALUE,
  canBePageLessParentMenu,
  getNavigationDestinationError,
  getNavigationPageSelectValue,
  getNavigationPageUrl,
} from './navigationItemDestination.js';

test('new top-level header items can start as page-less parent menus', () => {
  for (const location of ['top_nav', 'main_nav']) {
    const item = {
      link_type: 'internal',
      location,
      parent_id: null,
      url: '',
    };

    assert.equal(canBePageLessParentMenu(item), true);
    assert.equal(getNavigationPageSelectValue(item.url), NO_NAVIGATION_PAGE_VALUE);
    assert.equal(getNavigationDestinationError(item), '');
  }
});

test('clearing and reselecting a page maps between the sentinel and persisted URL', () => {
  assert.equal(getNavigationPageUrl(NO_NAVIGATION_PAGE_VALUE), '');
  assert.equal(getNavigationPageSelectValue('Events'), 'Events');
  assert.equal(getNavigationPageUrl('Events'), 'Events');
  assert.equal(getNavigationDestinationError({
    link_type: 'internal',
    location: 'main_nav',
    parent_id: null,
    url: 'Events',
  }), '');
});

test('internal sub-menu and footer items still require a page', () => {
  assert.match(getNavigationDestinationError({
    link_type: 'internal',
    location: 'main_nav',
    parent_id: 'parent-id',
    url: '',
  }), /sub-menu item/i);

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