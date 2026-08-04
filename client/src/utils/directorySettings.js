const CORE_FIELDS = [
  { key: 'show_profile_photo', label: 'Profile Photos', description: 'Display member profile photos', backOnly: false },
  { key: 'show_organization', label: 'Organization', description: "Display the member's organization name", backOnly: false },
  { key: 'show_job_title', label: 'Job Title', description: "Display the member's job title", backOnly: false },
  { key: 'show_linkedin', label: 'LinkedIn Profile', description: 'Display LinkedIn profile link if available', backOnly: false },
  { key: 'show_events', label: 'Events Attended', description: 'Display count of events attended', backOnly: false },
  { key: 'show_articles', label: 'Articles Published', description: 'Display count of published articles', backOnly: false },
  { key: 'show_awards', label: 'Awards', description: "Display member's earned awards", backOnly: false },
  { key: 'show_bio_in_popup', label: 'Biography', description: 'Display member biography in the detail view', backOnly: true },
];

export { CORE_FIELDS };

export function normalizeFieldVisibility(value) {
  if (value === undefined || value === null) return { front: true, back: true };
  if (typeof value === 'boolean') return { front: value, back: value };
  if (typeof value === 'object' && value !== null) {
    return {
      front: value.front !== false,
      back: value.back !== false,
    };
  }
  return { front: true, back: true };
}

export function isVisibleOnFront(settings, key) {
  const vis = normalizeFieldVisibility(settings?.[key]);
  return vis.front;
}

export function isVisibleOnBack(settings, key) {
  const vis = normalizeFieldVisibility(settings?.[key]);
  return vis.back;
}

export function isCustomFieldVisibleOnFront(settings, fieldId) {
  const cfSettings = settings?.custom_fields?.[fieldId];
  const vis = normalizeFieldVisibility(cfSettings);
  return vis.front;
}

export function isCustomFieldVisibleOnBack(settings, fieldId) {
  const cfSettings = settings?.custom_fields?.[fieldId];
  const vis = normalizeFieldVisibility(cfSettings);
  return vis.back;
}

/**
 * Parse a preference field's directory_visibility JSON into its canonical
 * shape: { ids, labels, display }. Supports all legacy forms:
 *  - array of directory ids                  -> { ids, labels: {}, display: {} }
 *  - { ids, labels }                         -> display: {}
 *  - { ids, labels, display }                -> full per-directory config
 * Returns null when unset/invalid (caller should fall back to the legacy
 * show_in_member_directory / show_in_directory_card booleans).
 */
export function parseDirectoryVisibilityConfig(field) {
  if (!field?.directory_visibility) return null;
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

/**
 * Whether a field is assigned to a directory ('main' = built-in directory).
 * Falls back to the legacy boolean when no directory_visibility JSON exists.
 */
export function isFieldInDirectory(field, dirId, legacyFlagKey) {
  const parsed = parseDirectoryVisibilityConfig(field);
  if (parsed) return parsed.ids.includes(dirId);
  if (dirId === 'main' && legacyFlagKey) return field?.[legacyFlagKey] !== false;
  return false;
}

/**
 * Enrich a field with per-directory display metadata:
 *  _displayLabel — label override for this directory (or the base label)
 *  _visFront / _visBack — per-directory front/back flags, or undefined when
 *    this field has no per-directory display entry (callers then fall back
 *    to the global member_directory_display custom_fields toggles)
 *  _visOrder — per-directory sort position (number) or null
 */
export function enrichFieldForDirectory(field, dirId) {
  const parsed = parseDirectoryVisibilityConfig(field);
  const override = parsed?.labels?.[dirId];
  const disp = parsed?.display?.[dirId];
  const hasDisp = disp && typeof disp === 'object' && !Array.isArray(disp);
  const order = hasDisp && Number.isFinite(Number(disp.order)) && disp.order !== null && disp.order !== ''
    ? Number(disp.order) : null;
  return {
    ...field,
    _displayLabel: (typeof override === 'string' && override.trim()) ? override.trim() : field.label,
    _visFront: hasDisp && typeof disp.front === 'boolean' ? disp.front : undefined,
    _visBack: hasDisp && typeof disp.back === 'boolean' ? disp.back : undefined,
    _visOrder: order,
  };
}

/** Per-directory front visibility with fallback to the global settings. */
export function isFieldVisibleOnFrontFor(field, settings) {
  if (typeof field?._visFront === 'boolean') return field._visFront;
  return isCustomFieldVisibleOnFront(settings, field?.id);
}

/** Per-directory back visibility with fallback to the global settings. */
export function isFieldVisibleOnBackFor(field, settings) {
  if (typeof field?._visBack === 'boolean') return field._visBack;
  return isCustomFieldVisibleOnBack(settings, field?.id);
}

/**
 * Order fields for a directory card. Fields with a per-directory _visOrder
 * sort first (ascending); the rest keep the legacy global field_order (then
 * display_order) sequence after them.
 */
export function getDirectoryOrderedFields(fields, settings) {
  const base = getOrderedCustomFields(fields || [], settings);
  const baseIndex = new Map(base.map((f, i) => [f.id, i]));
  return [...base].sort((a, b) => {
    const ao = typeof a._visOrder === 'number' ? a._visOrder : null;
    const bo = typeof b._visOrder === 'number' ? b._visOrder : null;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    return baseIndex.get(a.id) - baseIndex.get(b.id);
  });
}

/**
 * Reorder the CORE-field subsequence of a field_order array by visible-list
 * indices, leaving any other keys (legacy 'custom:*') at their positions.
 * The Member Directory Settings page renders only core rows, so drag indices
 * refer to the core-only list, not the raw array.
 */
export function reorderCoreFieldOrder(fieldOrder, srcIdx, destIdx) {
  const isCore = (k) => CORE_FIELDS.some(cf => cf.key === k);
  const coreKeys = (fieldOrder || []).filter(isCore);
  if (srcIdx < 0 || srcIdx >= coreKeys.length || destIdx < 0 || destIdx >= coreKeys.length) {
    return fieldOrder;
  }
  const [moved] = coreKeys.splice(srcIdx, 1);
  coreKeys.splice(destIdx, 0, moved);
  let i = 0;
  return (fieldOrder || []).map(k => (isCore(k) ? coreKeys[i++] : k));
}

// ---- Unified back-of-card ordering (core + custom fields interleaved) ------
//
// The back/detail side of directory cards renders from a single ordered list
// of keys: core field keys (member: CORE_FIELDS keys; org: ORG_BACK_CORE_ITEMS
// keys) plus `custom:<field_id>` entries. A tenant-wide default order lives in
// member_directory_display.back_field_order (member) and the
// org_directory_back_field_order system setting (organisation); each dynamic
// directory may override it via dynamic_directory.back_field_order.
// Resolution: per-directory override → tenant default → hardcoded default.
// Ordering only sequences visible content — visibility toggles still gate it.
//
// NOTE: mirrored in api/_lib/directoryConfig.js (resolveBackFieldOrder);
// keep both implementations in sync.

export const CUSTOM_FIELDS_SLOT = '__custom_fields__';

/** Member back default order — mirrors the historical hardcoded render. */
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

/** Organisation reverse-card core elements (orderable body sections). */
export const ORG_BACK_CORE_ITEMS = [
  { key: 'org_member_count', label: 'Member count', description: 'Number of members in the organisation' },
  { key: 'org_members_list', label: 'Members / contacts list', description: 'Members grouped by the configured reverse-card roles' },
];

export const ORG_BACK_DEFAULT_ORDER = [
  'org_member_count',
  'org_members_list',
  CUSTOM_FIELDS_SLOT,
];

/**
 * Resolve the unified back-of-card order into a flat list of keys
 * (core keys + `custom:<id>`, custom slot expanded).
 *
 * @param directoryOrder per-directory override (dynamic_directory.back_field_order)
 * @param tenantOrder    tenant-wide default order
 * @param defaultOrder   hardcoded default (may contain CUSTOM_FIELDS_SLOT)
 * @param customFields   custom fields ALREADY in their legacy-resolved order
 *                       (e.g. getDirectoryOrderedFields output); fields absent
 *                       from any saved list are appended at the slot position.
 */
export function resolveBackFieldOrder({ directoryOrder, tenantOrder, defaultOrder, customFields }) {
  const coreSet = new Set(defaultOrder.filter(k => k !== CUSTOM_FIELDS_SLOT));
  const customKeys = (customFields || []).map(f => `custom:${f.id}`);
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
  // Append anything missing following the default order; custom fields keep
  // their incoming (legacy-resolved) sequence at the slot position.
  for (const k of defaultOrder) {
    if (k === CUSTOM_FIELDS_SLOT) {
      for (const ck of customKeys) push(ck);
    } else {
      push(k);
    }
  }
  return result;
}

/**
 * Group an ordered list of back-of-card items (each `{ kind: 'block'|'stat'|'custom', ... }`)
 * into render sections: consecutive 'stat' items share one grid, consecutive
 * 'custom' items share one "Additional Information" grid, 'block' items stand
 * alone. Returns `[{ type: 'block'|'stat'|'custom', items: [...] }]`.
 * Pure — shared by every detail-dialog renderer and unit-testable.
 */
export function groupBackOrderItems(items) {
  const sections = [];
  let i = 0;
  while (i < (items?.length || 0)) {
    const kind = items[i].kind;
    if (kind === 'stat' || kind === 'custom') {
      const batch = [];
      while (i < items.length && items[i].kind === kind) {
        batch.push(items[i]);
        i += 1;
      }
      sections.push({ type: kind, items: batch });
    } else {
      sections.push({ type: 'block', items: [items[i]] });
      i += 1;
    }
  }
  return sections;
}

/** Move an entry within a resolved back order list (drag-and-drop helper). */
export function reorderBackFieldOrder(order, srcIdx, destIdx) {
  if (!Array.isArray(order)) return order;
  if (srcIdx < 0 || srcIdx >= order.length || destIdx < 0 || destIdx >= order.length) return order;
  const next = [...order];
  const [moved] = next.splice(srcIdx, 1);
  next.splice(destIdx, 0, moved);
  return next;
}

export function hasDirectoryFieldValue(field, rawValue) {
  if (rawValue === undefined || rawValue === null) return false;

  if (Array.isArray(rawValue)) {
    return rawValue.length > 0;
  }

  if (typeof rawValue === 'string') {
    if (rawValue.trim() === '') return false;
    if (field?.field_type === 'picklist') {
      try {
        const parsed = JSON.parse(rawValue);
        if (Array.isArray(parsed)) return parsed.length > 0;
      } catch {
        // Not JSON; non-empty string is a value
      }
    }
    return true;
  }

  return true;
}

export function getOrderedCustomFields(fields, settings) {
  const fieldOrder = settings?.field_order;
  if (!fieldOrder || !Array.isArray(fieldOrder) || fieldOrder.length === 0) {
    return fields;
  }
  const customOrder = fieldOrder
    .filter(k => k.startsWith('custom:'))
    .map(k => k.replace('custom:', ''));

  const fieldMap = new Map(fields.map(f => [f.id, f]));
  const ordered = [];
  for (const id of customOrder) {
    const field = fieldMap.get(id);
    if (field) {
      ordered.push(field);
      fieldMap.delete(id);
    }
  }
  for (const field of fieldMap.values()) {
    ordered.push(field);
  }
  return ordered;
}

// ---- Boolean-aware directory filter helpers (shared by directory pages) ----

const BOOL_TRUE = new Set(['true', 'yes', '1']);
const BOOL_FALSE = new Set(['false', 'no', '0']);

function toBoolCanonical(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (BOOL_TRUE.has(s)) return 'true';
  if (BOOL_FALSE.has(s)) return 'false';
  return null;
}

/**
 * Options to render in a directory filter dropdown for a field.
 * Boolean fields have no stored options, so provide Yes/No.
 */
export function getDirectoryFilterOptions(field) {
  if (field?.field_type === 'boolean') {
    return [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ];
  }
  return field?.options || [];
}

/**
 * Whether a stored preference value matches any of the selected filter values.
 * Handles arrays and normalises boolean-ish values (true/'true'/'yes'/'1', etc.)
 * so boolean custom fields filter correctly regardless of how they were stored.
 */
export function directoryFilterValueMatches(storedValue, selectedValues) {
  const selected = Array.isArray(selectedValues) ? selectedValues : [selectedValues];
  if (Array.isArray(storedValue)) {
    return selected.some((v) => storedValue.includes(v));
  }
  if (selected.includes(storedValue)) return true;
  const storedBool = toBoolCanonical(storedValue);
  if (storedBool !== null) {
    return selected.some((v) => toBoolCanonical(v) === storedBool);
  }
  return false;
}
