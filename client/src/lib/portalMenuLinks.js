import {
  getCustomObjectIdFromPortalListUrl,
  getCustomObjectIdFromPortalPath,
  getCustomObjectIdFromPortalRoleAccessId,
  getCustomObjectPortalListUrl,
  getCustomObjectPortalRoleAccessId,
  PORTAL_MENU_LINK_TYPES,
  validateExternalHttpUrl,
} from '../../../shared/portalMenuLinks.js';

export {
  getCustomObjectIdFromPortalListUrl,
  getCustomObjectIdFromPortalPath,
  getCustomObjectIdFromPortalRoleAccessId,
  getCustomObjectPortalListUrl,
  getCustomObjectPortalRoleAccessId,
  PORTAL_MENU_LINK_TYPES,
};

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
  if (destination?.isExternal === true || typeof destination?.url !== 'string') return false;
  if (!destination.url.trim()) return false;
  const normalizePath = (value) => {
    const path = String(value || '').split(/[?#]/, 1)[0];
    const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
    return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
  };
  const destinationPath = normalizePath(destination.url);
  const currentPath = normalizePath(pathname);
  return currentPath === destinationPath || currentPath.startsWith(`${destinationPath}/`);
}

export async function loadViewableCustomObjectPortalDestinations(fetchImpl = fetch) {
  const objects = [];
  let page = 1;
  let total = 0;
  do {
    const response = await fetchImpl(
      `/api/custom-objects?status=active&pageSize=100&page=${page}`,
      { credentials: 'include' },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.message || body.error || `Unable to load Custom Objects (${response.status})`);
    }
    const rows = Array.isArray(body.data) ? body.data : [];
    objects.push(...rows);
    total = Number(body.total) || rows.length;
    if (rows.length === 0) break;
    page += 1;
  } while (objects.length < total);

  return objects
    .filter(object => object.status === 'active' && object.capabilities?.view === true)
    .map(object => ({
      objectId: String(object.id),
      value: getCustomObjectPortalListUrl(String(object.id)),
      label: `Custom Object: ${object.plural_label || object.singular_label || object.object_key}`,
      featureId: getCustomObjectPortalRoleAccessId(String(object.id)),
    }));
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