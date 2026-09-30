export const DATA_STUDIO_PAGE_KEY = 'admin.data-studio';
export const LEGACY_DATA_STUDIO_KEYS = new Set([
  'data',
  'data.custom-objects',
  'page_CustomObjectsAdmin',
]);

export const DATA_STUDIO_PAGE = {
  item_type: 'page',
  item_key: DATA_STUDIO_PAGE_KEY,
  label: 'Data Studio',
  icon: null,
};

export function normaliseDataStudioExclusions(exclusions) {
  return [...new Set(
    (Array.isArray(exclusions) ? exclusions : []).map((key) =>
      LEGACY_DATA_STUDIO_KEYS.has(key) ? DATA_STUDIO_PAGE_KEY : key),
  )];
}

export function planDataStudioPageMigration(rows, parentId) {
  const candidates = Array.isArray(rows) ? rows : [];
  const preferred = candidates.find(
    (row) => row.item_key === DATA_STUDIO_PAGE_KEY && row.is_active !== false,
  )
    || candidates.find((row) => row.item_key === DATA_STUDIO_PAGE_KEY)
    || candidates.find((row) => row.is_active !== false)
    || candidates[0]
    || null;

  if (!preferred) {
    return { keeper: null, repairs: null, retireIds: [] };
  }

  const desired = {
    ...DATA_STUDIO_PAGE,
    parent_id: parentId,
    is_active: true,
  };
  const repairs = {};
  for (const [column, value] of Object.entries(desired)) {
    if (preferred[column] !== value) repairs[column] = value;
  }

  return {
    keeper: preferred,
    repairs,
    retireIds: candidates
      .filter((row) => row.id !== preferred.id && row.is_active !== false)
      .map((row) => row.id),
  };
}