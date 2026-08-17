// Helpers for the "To be confirmed" (pre-registration) events banner on /events.
// Pure functions so placement/config parsing can be unit tested.

export const DEFAULT_TBC_BANNER_TITLE = 'Events open for pre-registration';
export const DEFAULT_TBC_JUMP_LABEL = 'Jump to pre-registration events';
export const DEFAULT_TBC_JUMP_DESCRIPTION = 'Some events are open for pre-registration while their dates are confirmed.';

/**
 * Parse the tbc_events_banner system setting. Returns the parsed config when
 * the banner is enabled, otherwise null (disabled, missing, or malformed).
 */
export function parseTbcBannerConfig(systemSettings) {
  const setting = Array.isArray(systemSettings)
    ? systemSettings.find(item => item.setting_key === 'tbc_events_banner')
    : null;
  if (!setting?.setting_value) return null;
  try {
    const parsed = JSON.parse(setting.setting_value);
    return parsed?.enabled === true ? parsed : null;
  } catch {
    return null;
  }
}

export function getTbcBannerStyle(config) {
  if (!config) return undefined;
  return config.mode === 'gradient'
    ? { background: `linear-gradient(to right, ${config.from || '#dbeafe'}, ${config.to || '#e0e7ff'})` }
    : { background: config.color || '#eff6ff' };
}

export function getTbcBannerTitle(config) {
  return (config?.title || '').trim() || DEFAULT_TBC_BANNER_TITLE;
}

export function getTbcJumpLabel(config) {
  return (config?.jumpLabel || '').trim() || DEFAULT_TBC_JUMP_LABEL;
}

export function getTbcJumpDescription(config) {
  return (config?.jumpDescription || '').trim() || DEFAULT_TBC_JUMP_DESCRIPTION;
}

export function isTbcEvent(event) {
  return event?.status === 'tbc';
}

/**
 * Decide where the banner renders. The featured section renders above the
 * non-featured grid, so the banner goes above the first TBC event in rendered
 * order: featured grid if it contains one, else the non-featured grid.
 *
 * Returns { show, section: 'featured'|'nonFeatured'|null, index }.
 */
export function getTbcBannerPlacement(config, featuredEvents, nonFeaturedEvents) {
  if (!config) return { show: false, section: null, index: -1 };
  const featuredIdx = (featuredEvents || []).findIndex(isTbcEvent);
  if (featuredIdx !== -1) return { show: true, section: 'featured', index: featuredIdx };
  const nonFeaturedIdx = (nonFeaturedEvents || []).findIndex(isTbcEvent);
  if (nonFeaturedIdx !== -1) return { show: true, section: 'nonFeatured', index: nonFeaturedIdx };
  return { show: false, section: null, index: -1 };
}
