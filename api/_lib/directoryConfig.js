/**
 * Shared Dynamic Directory config helpers.
 *
 * Extracted from api/dynamic-directory/config.js so the authenticated-config
 * endpoint and the public embed endpoint (api/public/dynamic-directory.js)
 * resolve display settings, roles, and custom-field visibility identically.
 * All functions take an explicit `supabase` client so callers can pass either
 * the shared server client or a request-scoped service-role client.
 */

export const MEMBER_DISPLAY_DEFAULTS = {
  show_profile_photo: true, show_events: true, show_articles: true,
  show_organization: true, show_job_title: true, show_linkedin: true,
  show_awards: true, show_bio_in_popup: true,
};

export function isMemberFieldVisibleOnFront(settings, key) {
  const value = settings?.[key];
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value.front !== false;
  }
  return true;
}

// --- per-directory core-field visibility (mirror client logic) --------------
//
// dynamic_directory.core_field_visibility is a JSONB map:
//   { "<core key>": { front?: boolean, back?: boolean } }
// Missing key/side = inherit tenant-global settings. Mirrors
// client/src/utils/directorySettings.js — keep both in sync.

export const CORE_FIELD_KEYS = [
  'show_profile_photo', 'show_organization', 'show_job_title', 'show_linkedin',
  'show_events', 'show_articles', 'show_awards', 'show_bio_in_popup',
];

function normalizeVis(value) {
  if (value === undefined || value === null) return { front: true, back: true };
  if (typeof value === 'boolean') return { front: value, back: value };
  if (typeof value === 'object' && value !== null) {
    return { front: value.front !== false, back: value.back !== false };
  }
  return { front: true, back: true };
}

export function parseCoreFieldVisibility(value) {
  if (!value) return null;
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  return null;
}

/**
 * Layer a directory's core-field visibility overrides over the tenant-global
 * member display settings. Only explicit boolean front/back overrides replace
 * the global value. Mirrors client applyCoreFieldVisibility — keep in sync.
 */
export function applyCoreFieldVisibility(settings, coreFieldVisibility) {
  const overrides = parseCoreFieldVisibility(coreFieldVisibility);
  if (!overrides) return settings;
  const merged = { ...(settings || {}) };
  for (const key of CORE_FIELD_KEYS) {
    const ov = overrides[key];
    if (!ov || typeof ov !== 'object' || Array.isArray(ov)) continue;
    if (typeof ov.front !== 'boolean' && typeof ov.back !== 'boolean') continue;
    const base = normalizeVis(merged[key]);
    merged[key] = {
      front: typeof ov.front === 'boolean' ? ov.front : base.front,
      back: typeof ov.back === 'boolean' ? ov.back : base.back,
    };
  }
  return merged;
}

/** Org core back items: per-directory override → global fallback boolean. */
export function isOrgCoreItemVisible(coreFieldVisibility, key, fallback = true) {
  const overrides = parseCoreFieldVisibility(coreFieldVisibility);
  const ov = overrides?.[key];
  if (ov && typeof ov === 'object' && !Array.isArray(ov) && typeof ov.back === 'boolean') return ov.back;
  return fallback !== false;
}

// --- directory_visibility helpers (mirror client logic) ---------------------

export function parseDirVis(field) {
  if (!field.directory_visibility) return null;
  let vis = field.directory_visibility;
  if (typeof vis === 'string') {
    try { vis = JSON.parse(vis); } catch { return null; }
  }
  if (Array.isArray(vis)) return { ids: vis, labels: {}, display: {} };
  if (vis && typeof vis === 'object') {
    return {
      ids: Array.isArray(vis.ids) ? vis.ids : [],
      labels: (vis.labels && typeof vis.labels === 'object' && !Array.isArray(vis.labels)) ? vis.labels : {},
      display: (vis.display && typeof vis.display === 'object' && !Array.isArray(vis.display)) ? vis.display : {},
    };
  }
  return null;
}

export function isVisibleInDirectory(field, dirId) {
  const parsed = parseDirVis(field);
  return parsed ? parsed.ids.includes(dirId) : false;
}

/**
 * Enrich a field with per-directory display metadata (mirrors
 * client/src/utils/directorySettings.js enrichFieldForDirectory):
 *  _displayLabel — per-directory label override or the base label
 *  _visFront/_visBack — per-directory front/back flags, undefined when this
 *    field has no per-directory display entry (clients fall back to the
 *    global member_directory_display custom_fields toggles)
 *  _visOrder — per-directory sort position or null
 */
export function enrichField(field, dirId) {
  const parsed = parseDirVis(field);
  const override = parsed?.labels?.[dirId];
  const disp = parsed?.display?.[dirId];
  const hasDisp = disp && typeof disp === 'object' && !Array.isArray(disp);
  const order = hasDisp && disp.order !== null && disp.order !== '' && Number.isFinite(Number(disp.order))
    ? Number(disp.order) : null;
  return {
    ...field,
    _displayLabel: (typeof override === 'string' && override.trim()) ? override.trim() : field.label,
    _visFront: hasDisp && typeof disp.front === 'boolean' ? disp.front : undefined,
    _visBack: hasDisp && typeof disp.back === 'boolean' ? disp.back : undefined,
    _visOrder: order,
  };
}

/**
 * Sort enriched fields for a directory: per-directory _visOrder first
 * (ascending), then the incoming (display_order) sequence.
 */
export function sortFieldsForDirectory(fields) {
  return (fields || [])
    .map((f, i) => [f, i])
    .sort(([a, ai], [b, bi]) => {
      const ao = typeof a._visOrder === 'number' ? a._visOrder : null;
      const bo = typeof b._visOrder === 'number' ? b._visOrder : null;
      if (ao !== null && bo !== null && ao !== bo) return ao - bo;
      if (ao !== null && bo === null) return -1;
      if (ao === null && bo !== null) return 1;
      return ai - bi;
    })
    .map(([f]) => f);
}

// --- unified back-of-card ordering (mirrors client directorySettings.js) ----

export const CUSTOM_FIELDS_SLOT = '__custom_fields__';

export const MEMBER_BACK_DEFAULT_ORDER = [
  'show_profile_photo',
  'show_job_title',
  'show_organization',
  'show_bio_in_popup',
  'show_events',
  'show_articles',
  CUSTOM_FIELDS_SLOT,
  'show_awards',
  'show_linkedin',
];

export const ORG_BACK_DEFAULT_ORDER = [
  'org_member_count',
  'org_members_list',
  CUSTOM_FIELDS_SLOT,
];

/**
 * Resolve the unified back-of-card order into a flat list of keys
 * (core keys + `custom:<id>`). Resolution: per-directory override →
 * tenant default → hardcoded default. Mirrors
 * client/src/utils/directorySettings.js resolveBackFieldOrder — keep in sync.
 */
export function resolveBackFieldOrder({ directoryOrder, tenantOrder, defaultOrder, customFields }) {
  const coreSet = new Set(defaultOrder.filter((k) => k !== CUSTOM_FIELDS_SLOT));
  const customKeys = (customFields || []).map((f) => `custom:${f.id}`);
  const customSet = new Set(customKeys);
  const isKnown = (k) => typeof k === 'string' && (coreSet.has(k) || customSet.has(k));

  const pickSaved = (list) => (Array.isArray(list) && list.some(isKnown)) ? list : null;
  const saved = pickSaved(directoryOrder) || pickSaved(tenantOrder);

  const result = [];
  const seen = new Set();
  const push = (k) => { if (!seen.has(k)) { seen.add(k); result.push(k); } };

  if (saved) {
    for (const k of saved) {
      if (isKnown(k)) push(k);
    }
  }
  for (const k of defaultOrder) {
    if (k === CUSTOM_FIELDS_SLOT) {
      for (const ck of customKeys) push(ck);
    } else {
      push(k);
    }
  }
  return result;
}

// --- back-of-card custom-fields section label --------------------------------
// Mirrors client/src/utils/directorySettings.js — keep both in sync.

export const DEFAULT_CUSTOM_FIELDS_LABEL = 'Additional Information';

/** First non-blank string label wins; falls back to the default text. */
export function resolveCustomFieldsLabel(...labels) {
  for (const label of labels) {
    if (typeof label === 'string' && label.trim()) return label.trim();
  }
  return DEFAULT_CUSTOM_FIELDS_LABEL;
}

// --- roles ------------------------------------------------------------------

export async function fetchRoles(supabase, tenantId) {
  const { data: roleRows } = await supabase
    .from('role')
    .select('id, name, badge_background_colour, badge_text_colour')
    .eq('tenant_id', tenantId);
  return roleRows || [];
}

export function buildOrganisationMembersResponse({
  members = [],
  total = 0,
  page = 1,
  pageSize = 12,
  organization,
  roles = [],
  displaySettings = {},
}) {
  return {
    members,
    total,
    page,
    pageSize,
    organization,
    roles,
    displaySettings,
  };
}

// --- member display settings ------------------------------------------------

export async function fetchMemberDisplaySettings(supabase, tenantId) {
  const { data: settingsRows } = await supabase
    .from('system_settings')
    .select('setting_key, setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', 'member_directory_display');
  let displaySettings = { ...MEMBER_DISPLAY_DEFAULTS };
  const raw = settingsRows?.[0]?.setting_value;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') displaySettings = parsed;
    } catch {}
  }
  return displaySettings;
}

// --- member custom fields (filterable + directory-visible) ------------------

export async function fetchMemberFields(supabase, tenantId, dirId) {
  const { data: fieldRows } = await supabase
    .from('preference_field')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .eq('entity_scope', 'member')
    .order('display_order', { ascending: true });
  const memberFields = fieldRows || [];

  const memberCustomFields = memberFields
    .filter((f) => f.is_filterable)
    .map((f) => enrichField(f, dirId));

  const directoryCustomFields = sortFieldsForDirectory(
    memberFields
      .filter((f) => isVisibleInDirectory(f, dirId))
      .map((f) => enrichField(f, dirId))
  );

  return { memberCustomFields, directoryCustomFields };
}

// --- organisation display settings ------------------------------------------

function parseJsonArray(val) {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function fetchOrgDisplaySettings(supabase, tenantId) {
  const { data: settingsRows } = await supabase
    .from('system_settings')
    .select('setting_key, setting_value')
    .eq('tenant_id', tenantId)
    .like('setting_key', 'org_directory_%');
  const settingsMap = {};
  for (const s of settingsRows || []) settingsMap[s.setting_key] = s.setting_value;

  return {
    showLogo: settingsMap['org_directory_show_logo'] !== 'false',
    showTitle: settingsMap['org_directory_show_title'] !== 'false',
    showDomains: settingsMap['org_directory_show_domains'] !== 'false',
    showMemberCount: settingsMap['org_directory_show_member_count'] !== 'false',
    showNameTooltip: settingsMap['org_directory_show_name_tooltip'] === 'true',
    cardsPerRow: settingsMap['org_directory_cards_per_row'] || '3',
    excludedOrgIds: parseJsonArray(settingsMap['org_directory_excluded_orgs']),
    reverseCardRoleIds: parseJsonArray(settingsMap['org_directory_reverse_card_role_ids']),
    backFieldOrder: parseJsonArray(settingsMap['org_directory_back_field_order']),
    customFieldsLabel: settingsMap['org_directory_custom_fields_label'] || null,
  };
}
