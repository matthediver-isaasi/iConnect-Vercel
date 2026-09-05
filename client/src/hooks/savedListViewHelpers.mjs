const PAGE_KEYS = {
  members: (memberId) => `crm_member_views_${memberId}`,
  organisations: (memberId) => `crm_org_views_${memberId}`,
  customObjects: (memberId, scopeId) => `crm_custom_object_views_${memberId}_${scopeId}`,
};

export const savedListViewPreferenceKey = (page, memberId, scopeId) => {
  if (!PAGE_KEYS[page] || !memberId) return null;
  if (page === 'customObjects' && (!scopeId || typeof scopeId !== 'string')) return null;
  return PAGE_KEYS[page](memberId, scopeId);
};

export const sanitizeSavedViews = (raw, genViewId) => {
  if (!Array.isArray(raw)) return [];
  const views = raw
    .filter(
      (view) =>
        view &&
        typeof view === 'object' &&
        typeof view.name === 'string' &&
        view.name.trim() !== '' &&
        view.filters &&
        typeof view.filters === 'object'
    )
    .map((view) => ({
      id: typeof view.id === 'string' && view.id ? view.id : genViewId(),
      name: view.name,
      isDefault: view.isDefault === true,
      filters: view.filters,
      columns: Array.isArray(view.columns) && view.columns.length > 0 ? view.columns : null,
    }));
  let seenDefault = false;
  return views.map((view) => {
    if (view.isDefault) {
      if (seenDefault) return { ...view, isDefault: false };
      seenDefault = true;
    }
    return view;
  });
};