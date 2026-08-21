export const PORTAL_MENU_LINK_TYPES = {
  INTERNAL: 'internal',
  EXTERNAL: 'external',
};

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