export const BUNDLE_FIELD_TYPE = 'sales_bundle';
export const BUNDLE_LABELS_KEY = '__bundle_labels';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function bundleConfigurationError(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const bundles = fields.filter(f => f?.type === BUNDLE_FIELD_TYPE);
  const nested = value => Array.isArray(value) ? value.some(nested)
    : value && typeof value === 'object' ? value.type === BUNDLE_FIELD_TYPE
      || Object.values(value).some(nested) : false;
  if (fields.some(f => Object.entries(f || {}).some(([k, v]) => k !== 'type' && nested(v)))) {
    return 'Bundle fields cannot be nested or repeated.';
  }
  if (!bundles.length) return null;
  if (form.form_type === 'survey' || bundles.length > 1) return 'Only one Bundle field is supported, on standard forms only.';
  if (fields.filter(f => f.type === 'payment').length > 1) return 'Bundle forms support only one payment element.';
  const field = bundles[0];
  if (field.multiple || field.multi_select || field.parent_field_id) return 'Bundle fields must be single-selection and top-level.';
  if (!Array.isArray(field.allowed_bundle_ids) || !field.allowed_bundle_ids.length
    || field.allowed_bundle_ids.length > 100 || field.allowed_bundle_ids.some(id => !uuid.test(id))
    || new Set(field.allowed_bundle_ids).size !== field.allowed_bundle_ids.length) {
    return 'Choose between 1 and 100 distinct allowed bundles.';
  }
  if (fields.some(f => f.type === 'membership_payment')
    || JSON.stringify(form.visibility_rules || []).includes('membership_structure')
    || fields.some(f => f.type === 'payment' && (
      f.payment_mode === 'monthly' || f.allow_monthly_payments || f.monthly_instalments
    ))) return 'Bundles cannot be combined with membership fees or monthly instalments.';
  return null;
}

export function bundlePriceField(form, paymentField) {
  return (form?.fields || []).find(f => f.type === BUNDLE_FIELD_TYPE && f.id === paymentField?.price_field_id) || null;
}
