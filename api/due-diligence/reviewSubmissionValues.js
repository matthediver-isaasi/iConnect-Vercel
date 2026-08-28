import {
  FORM_NOT_LISTED_LABELS_KEY,
  FORM_NOT_LISTED_TEXT_KEY,
  containsFormNotListedValue,
} from '../../shared/formNotListedChoice.js';

/**
 * Produce the field-id keyed values that the review UI treats as effective.
 * An explicit reviewed value wins unless it is undefined; otherwise the
 * original submission's field-id value, then its legacy field-name value, is
 * used. Restricting the result to saved fields also prevents arbitrary review
 * keys becoming input to relationship validation.
 */
export function effectiveReviewSubmissionValues(
  form,
  originalSubmissionValues = {},
  reviewedFormValues = {},
) {
  const effective = {};
  const original = originalSubmissionValues && typeof originalSubmissionValues === 'object'
    ? originalSubmissionValues
    : {};
  const reviewed = reviewedFormValues && typeof reviewedFormValues === 'object'
    ? reviewedFormValues
    : {};

  for (const field of (Array.isArray(form?.fields) ? form.fields : [])) {
    const fieldKey = field?.id || field?.name;
    if (!fieldKey) continue;
    const hasReviewedValue = Object.prototype.hasOwnProperty.call(reviewed, fieldKey)
      && reviewed[fieldKey] !== undefined;
    effective[fieldKey] = hasReviewedValue
      ? reviewed[fieldKey]
      : (original[fieldKey] ?? (field.name ? original[field.name] : undefined));
  }
  for (const reservedKey of [FORM_NOT_LISTED_LABELS_KEY, FORM_NOT_LISTED_TEXT_KEY]) {
    const originalMap = original[reservedKey];
    const reviewedMap = reviewed[reservedKey];
    if ((originalMap && typeof originalMap === 'object' && !Array.isArray(originalMap))
        || (reviewedMap && typeof reviewedMap === 'object' && !Array.isArray(reviewedMap))) {
      effective[reservedKey] = {
        ...(originalMap && typeof originalMap === 'object' && !Array.isArray(originalMap) ? originalMap : {}),
        ...(reviewedMap && typeof reviewedMap === 'object' && !Array.isArray(reviewedMap) ? reviewedMap : {}),
      };
    } else if (reviewedMap !== undefined) {
      effective[reservedKey] = reviewedMap;
    }
  }
  if (effective[FORM_NOT_LISTED_TEXT_KEY]
      && typeof effective[FORM_NOT_LISTED_TEXT_KEY] === 'object'
      && !Array.isArray(effective[FORM_NOT_LISTED_TEXT_KEY])) {
    for (const field of (Array.isArray(form?.fields) ? form.fields : [])) {
      const fieldKey = field?.id || field?.name;
      if (!fieldKey || !Object.prototype.hasOwnProperty.call(reviewed, fieldKey)) continue;
      if (!containsFormNotListedValue(reviewed[fieldKey])) {
        delete effective[FORM_NOT_LISTED_TEXT_KEY][fieldKey];
      }
    }
    if (Object.keys(effective[FORM_NOT_LISTED_TEXT_KEY]).length === 0) {
      delete effective[FORM_NOT_LISTED_TEXT_KEY];
    }
  }
  return effective;
}
