import { pruneFormNotListedText } from '../../../shared/formNotListedChoice.js';

export function prepareFormSubmissionValues(fields, formValues) {
  const fieldList = Array.isArray(fields) ? fields : [];
  const values = formValues && typeof formValues === 'object' && !Array.isArray(formValues)
    ? formValues
    : {};
  const displayOnlyFieldIds = new Set(
    fieldList
      .filter(field => field?.type === 'instructions' || field?.type === 'image')
      .map(field => field.id),
  );
  return pruneFormNotListedText(
    fieldList,
    Object.fromEntries(
      Object.entries(values).filter(([key]) => !displayOnlyFieldIds.has(key)),
    ),
  );
}