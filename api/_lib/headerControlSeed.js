// Shared helper for seeding/backfilling the positionable header control elements
// (search box, social icons, login/account) as navigation_item rows.
//
// Preserves the legacy static header behavior:
//   - Visibility comes from the `header_icons_config` system setting
//     ({ login, search, social }); missing keys default to true (the old
//     default-on header). A control whose toggle is false is NOT seeded.
//   - Relative order mirrors the old static DOM order, which depended on the
//     login position (branding header_config.loginLink.position):
//       position 'left'  -> login(account), search, social
//       position 'right' -> search, social, login(account)
//     Default position is 'left' (matches resolveHeaderLink's default).
//
// display_order uses a high base so controls land after a tenant's existing
// top-nav links (where the static controls used to sit, on the right edge).

const TITLES = { search: 'Search', social: 'Social Icons', account: 'Account' };
// Maps a control type to its toggle key in header_icons_config.
const TOGGLE_KEY = { search: 'search', social: 'social', account: 'login' };
const DISPLAY_ORDER_BASE = 1000;

// Returns the control types in their legacy DOM order for the given login position.
export function orderedControlTypes(position) {
  return position === 'right'
    ? ['search', 'social', 'account']
    : ['account', 'search', 'social'];
}

// Normalizes a header_icons_config value (object, JSON string, or null) into a
// toggles object. Missing keys default to true.
export function normalizeHeaderToggles(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const t = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    login: t.login !== false,
    search: t.search !== false,
    social: t.social !== false,
  };
}

// Normalizes the login position from a tenant's header_config. Default 'left'.
export function resolveLoginPosition(headerConfig) {
  return headerConfig?.loginLink?.position === 'right' ? 'right' : 'left';
}

// Builds the navigation_item rows to insert for a tenant, honoring visibility
// toggles, legacy ordering, and idempotency (skips types that already exist).
export function buildHeaderControlInserts({ tenantId, toggles, position, existingTypes }) {
  const existing = existingTypes instanceof Set ? existingTypes : new Set(existingTypes || []);
  const ordered = orderedControlTypes(position);

  return ordered
    .map((type, idx) => ({ type, idx }))
    .filter(({ type }) => toggles[TOGGLE_KEY[type]] !== false)
    .filter(({ type }) => !existing.has(type))
    .map(({ type, idx }) => ({
      tenant_id: tenantId,
      title: TITLES[type],
      url: '',
      link_type: 'content_block',
      content_block_type: type,
      location: 'top_nav',
      display_order: DISPLAY_ORDER_BASE + idx,
      is_active: true,
      open_in_new_tab: false,
      display_type: 'link',
      parent_id: null,
    }));
}
