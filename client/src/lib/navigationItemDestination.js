export const NO_NAVIGATION_PAGE_VALUE = '_none';

export function canBePageLessParentMenu(item) {
  return item?.link_type === 'internal' &&
    item?.location !== 'footer';
}

export function isPageLessParentMenu(item) {
  return canBePageLessParentMenu(item) &&
    !item?.url &&
    Array.isArray(item?.children) &&
    item.children.length > 0;
}

export function getNavigationPageSelectValue(url) {
  return url || NO_NAVIGATION_PAGE_VALUE;
}

export function getNavigationPageUrl(selectValue) {
  return selectValue === NO_NAVIGATION_PAGE_VALUE ? '' : selectValue;
}

export function getNavigationDestinationError(item) {
  if (
    item?.link_type === 'content_block' ||
    item?.link_type === 'form_modal' ||
    item?.url ||
    canBePageLessParentMenu(item)
  ) {
    return '';
  }

  if (item?.link_type === 'internal') {
    return item?.location === 'footer'
      ? 'Select a page for this footer item'
      : 'Select a page for this sub-menu item';
  }

  return 'URL is required';
}