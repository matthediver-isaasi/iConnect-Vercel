export const PORTAL_MENU_LINK_TYPES = {
  INTERNAL: 'internal',
  EXTERNAL: 'external',
};

export const CUSTOM_OBJECT_ROLE_ACCESS_PREFIX = 'custom-object:';

export function getCustomObjectPortalListUrl(objectId) {
  const id = typeof objectId === 'string' ? objectId.trim() : '';
  return id ? `CustomObjectsAdmin/${encodeURIComponent(id)}/records` : '';
}

export function getCustomObjectIdFromPortalListUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.trim().match(
    /^\/?CustomObjectsAdmin\/([^/?#]+)\/records\/?(?:[?#].*)?$/i,
  );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function getCustomObjectIdFromPortalPath(url) {
  if (typeof url !== 'string') return null;
  const match = url.trim().match(
    /^\/?CustomObjectsAdmin\/([^/?#]+)\/records(?:\/[^?#]*)?\/?(?:[?#].*)?$/i,
  );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function getCustomObjectPortalRoleAccessId(objectId) {
  const id = typeof objectId === 'string' ? objectId.trim() : '';
  return id ? `${CUSTOM_OBJECT_ROLE_ACCESS_PREFIX}${id}:view-records` : '';
}

export function getCustomObjectIdFromPortalRoleAccessId(featureId) {
  if (typeof featureId !== 'string'
      || !featureId.startsWith(CUSTOM_OBJECT_ROLE_ACCESS_PREFIX)
      || !featureId.endsWith(':view-records')) {
    return null;
  }
  const objectId = featureId.slice(
    CUSTOM_OBJECT_ROLE_ACCESS_PREFIX.length,
    -':view-records'.length,
  );
  return objectId || null;
}

export function validateExternalHttpUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) {
    return {
      isValid: false,
      error: 'Enter a complete external URL starting with http:// or https://.',
      url: '',
    };
  }

  let parsed;
  try {
    parsed = new URL(url);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
      return {
        isValid: false,
        error: 'External URLs must be complete HTTP(S) addresses starting with http:// or https://.',
        url: '',
      };
    }
  } catch {
    return {
      isValid: false,
      error: 'Enter a valid external URL, for example https://www.example.com.',
      url: '',
    };
  }

  return { isValid: true, error: '', url: parsed.href };
}

export function validatePortalMenuRecord(record) {
  const suppliedType = record?.link_type;
  if (suppliedType != null
      && suppliedType !== PORTAL_MENU_LINK_TYPES.INTERNAL
      && suppliedType !== PORTAL_MENU_LINK_TYPES.EXTERNAL) {
    return {
      isValid: false,
      error: 'Destination type must be internal or external.',
      linkType: PORTAL_MENU_LINK_TYPES.INTERNAL,
      openInNewTab: false,
      url: '',
    };
  }

  const linkType = suppliedType === PORTAL_MENU_LINK_TYPES.EXTERNAL
    ? PORTAL_MENU_LINK_TYPES.EXTERNAL
    : PORTAL_MENU_LINK_TYPES.INTERNAL;
  if (linkType === PORTAL_MENU_LINK_TYPES.EXTERNAL) {
    const validation = validateExternalHttpUrl(record?.url);
    return {
      ...validation,
      linkType,
      openInNewTab: record?.open_in_new_tab === true,
    };
  }

  return {
    isValid: true,
    error: '',
    linkType,
    openInNewTab: false,
    url: typeof record?.url === 'string' ? record.url.trim() : '',
  };
}