export const BUNDLE_UNAVAILABLE_EVENT = 'form-bundle-unavailable';
export { bundleConfigurationError } from '../../../shared/formBundles.js';

export function bundlePriceSource(form) {
  const fields = form?.fields || [];
  const payment = fields.find(field => field.type === 'payment');
  return fields.find(field => field.type === 'sales_bundle' && field.id === payment?.price_field_id) || null;
}

export function parseBundleStock(unlimited, value) {
  if (unlimited) return null;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Enter a nonnegative whole number, or choose Unlimited.');
  }
  return Number(value);
}

export function notifyBundleUnavailable(formId, error, status) {
  const data = error?.errorData || error;
  if ((status ?? error?.status) !== 409 || data?.code !== 'BUNDLE_UNAVAILABLE') return false;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BUNDLE_UNAVAILABLE_EVENT, {
      detail: { formId, fieldId: data.field_id || null },
    }));
  }
  return true;
}

// Labels are an immutable, server-authored submission snapshot. Never send this
// metadata from option responses or replace the UUID answer in a payload.
export function bundleSubmissionLabel(submissionData, field, value) {
  const labels = submissionData?.__bundle_labels;
  const entry = labels?.[field?.id];
  return (typeof entry === 'string' ? entry : entry?.label || entry?.name || entry?.[value])
    || (typeof labels?.[value] === 'string' ? labels[value] : null)
    || value;
}
