export const DEPARTMENT_SELECTOR_ID = '__department_selector_layout__';

export function departmentBuilderFields(form) {
  const fields = form.fields || [];
  if (!form.current_set_enabled) return fields;
  const firstPage = form.pages?.[0]?.id || null;
  const eligible = field => !field.page_id || field.page_id === firstPage;
  let index = fields.findIndex(field => eligible(field) && field.department_selector_before);
  if (index < 0) {
    const after = fields.findIndex(field => eligible(field) && field.department_selector_after);
    if (after >= 0) index = after + 1;
  }
  if (index < 0 || form.layout_type === 'card_swipe') {
    index = fields.findIndex(field => (field.page_id || null) === firstPage);
    if (index < 0) index = 0;
  }
  const result = [...fields];
  result.splice(index, 0, {
    id: DEPARTMENT_SELECTOR_ID, type: 'department_selector_layout',
    page_id: firstPage, column_index: 0, fixed: form.layout_type === 'card_swipe',
  });
  return result;
}

// The block is builder-only: persist placement on ordinary fields, never an
// answer field that could enter validation, mappings or submission payloads.
export function saveDepartmentBuilderFields(fields) {
  const index = fields.findIndex(field => field.id === DEPARTMENT_SELECTOR_ID);
  if (index < 0) return fields;
  const selector = fields[index];
  const samePage = field => !field.page_id || (field.page_id || null) === (selector.page_id || null);
  const next = fields.slice(index + 1).find(samePage);
  const previous = fields.slice(0, index).findLast(samePage);
  return fields.filter(field => field.id !== DEPARTMENT_SELECTOR_ID).map(field => ({
    ...field,
    department_selector_before: field.id === next?.id,
    department_selector_after: !next && field.id === previous?.id,
  }));
}
