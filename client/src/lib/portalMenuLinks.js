import {
  PORTAL_MENU_LINK_TYPES,
  validateExternalHttpUrl,
} from '../../../shared/portalMenuLinks.js';

export { PORTAL_MENU_LINK_TYPES };

export function getPortalMenuLinkType(item) {
  return item?.link_type === PORTAL_MENU_LINK_TYPES.EXTERNAL
    ? PORTAL_MENU_LINK_TYPES.EXTERNAL
    : PORTAL_MENU_LINK_TYPES.INTERNAL;
}

export function validateExternalPortalUrl(value) {
  return validateExternalHttpUrl(value);
}

export function validatePortalMenuDestination(item, { hasChildren = false } = {}) {
  if (getPortalMenuLinkType(item) !== PORTAL_MENU_LINK_TYPES.EXTERNAL) {
    return { isValid: true, error: '', url: typeof item?.url === 'string' ? item.url.trim() : '' };
  }
  if (hasChildren) {
    return {
      isValid: false,
      error: 'Menu items with sub-items must remain internal parent menus. Remove the sub-items before choosing an external website.',
      url: '',
    };
  }
  return validateExternalPortalUrl(item?.url);
}

export function resolvePortalMenuDestination(item, createInternalUrl = (url) => url) {
  const linkType = getPortalMenuLinkType(item);
  const rawUrl = typeof item?.url === 'string' ? item.url.trim() : '';

  if (linkType === PORTAL_MENU_LINK_TYPES.EXTERNAL) {
    const validation = validateExternalPortalUrl(rawUrl);
    const openInNewTab = item?.open_in_new_tab === true;
    return {
      url: validation.url,
      isExternal: true,
      isValid: validation.isValid,
      error: validation.error,
      openInNewTab,
      target: openInNewTab ? '_blank' : undefined,
      rel: openInNewTab ? 'noopener noreferrer' : undefined,
    };
  }

  return {
    url: rawUrl ? createInternalUrl(rawUrl) : '',
    isExternal: false,
    isValid: true,
    error: '',
    openInNewTab: false,
    target: undefined,
    rel: undefined,
  };
}

export function isPortalMenuDestinationActive(destination, pathname) {
  return destination?.isExternal !== true && destination?.url === pathname;
}

export function getPortalMenuFallbackFeatureId({ section, title, url, link_type: linkType }) {
  const normalizedSection = section === 'admin' ? 'admin' : 'user';
  const normalizedTitle = typeof title === 'string'
    ? title.trim().replace(/[^a-zA-Z0-9]+/g, '')
    : '';
  const normalizedUrl = typeof url === 'string' ? url.trim() : '';

  if (linkType === PORTAL_MENU_LINK_TYPES.EXTERNAL || !normalizedUrl) {
    return normalizedTitle ? `page_${normalizedSection}_${normalizedTitle}` : '';
  }

  return `page_${normalizedSection}_${normalizedUrl}`;
}