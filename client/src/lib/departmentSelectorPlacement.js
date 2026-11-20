export function departmentSelectorAnchor(form, hiddenIds = new Set()) {
  if (form?.layout_type === 'card_swipe') return null;
  const firstPage = form?.pages?.[0]?.id;
  return (form?.fields || []).find(field =>
    field.department_selector_before === true
    && (!field.page_id || field.page_id === firstPage)
    && !hiddenIds.has(field.id)
  )?.id || null;
}

export function showDepartmentSelector({ form, hiddenIds, fieldId, firstPage = true }) {
  const anchor = departmentSelectorAnchor(form, hiddenIds);
  return firstPage && (fieldId ? anchor === fieldId : !anchor);
}
