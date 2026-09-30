export function getDisplayedOrganisationCardFields(columnFields) {
  return columnFields.slice(0, 2);
}

export function getRequestedOrganisationFieldIds({ viewMode, columns, columnFields }) {
  if (viewMode === 'card') {
    return getDisplayedOrganisationCardFields(columnFields).map((field) => field.id).filter(Boolean);
  }

  return columns
    .filter((column) => column.visible && column.isCustomField && column.fieldId)
    .map((column) => column.fieldId);
}

export function getOrganisationFieldsParam(args) {
  return getRequestedOrganisationFieldIds(args).join(',') || 'none';
}