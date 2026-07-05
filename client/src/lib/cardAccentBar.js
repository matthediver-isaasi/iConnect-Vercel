// Shared resolver for the tenant-configurable card accent bar — the thin bar
// shown under the feature image on News, Blog article, and Resource cards.
//
// The setting lives in `branding_config.cardAccentBar` and is surfaced on the
// public branding payload as `branding.brandingConfig.cardAccentBar`:
//   { enabled: boolean, color: string }
//
// Tenants that have never configured it fall back to the historical deep-purple
// so nothing changes visually until they opt in.

export const DEFAULT_CARD_ACCENT_BAR_COLOR = '#5d0d77';

// Resolve the accent bar config from a tenant branding payload.
// Returns { enabled, color }. When `enabled` is false, callers should render
// no bar. When unset, defaults to enabled with the historical purple color.
export function resolveCardAccentBar(branding) {
  const cfg = branding?.brandingConfig?.cardAccentBar;
  if (cfg && typeof cfg === 'object') {
    return {
      enabled: cfg.enabled !== false,
      color: cfg.color || DEFAULT_CARD_ACCENT_BAR_COLOR,
    };
  }
  return { enabled: true, color: DEFAULT_CARD_ACCENT_BAR_COLOR };
}
