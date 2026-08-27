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
  return effective;
}
