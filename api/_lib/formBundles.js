import { bundleConfigurationError, BUNDLE_FIELD_TYPE, BUNDLE_LABELS_KEY, bundlePriceField } from '../../shared/formBundles.js';
import { computeAuthoritativeHiddenFieldIds, findPaymentField } from './formFieldVisibility.js';
import { rulesUseLmicOperators } from './formLmicConditions.js';
import { loadTenantLmicCodes } from './tenantLmicCodes.js';

export class FormBundleError extends Error {
  constructor(message, status = 400, code = 'INVALID_BUNDLE_SELECTION') {
    super(message); this.status = status; this.code = code;
  }
}
export async function validateBundleConfiguration(db, form) {
  const error = bundleConfigurationError(form);
  if (error) throw new FormBundleError(error);
  const field = (form?.fields || []).find(f => f.type === BUNDLE_FIELD_TYPE);
  if (!field) return;
  const { data, error: dbError } = await db.from('sales_catalogue_bundle')
    .select('id,currency').eq('tenant_id', form.tenant_id).in('id', field.allowed_bundle_ids);
  if (dbError) throw dbError;
  if (data?.length !== field.allowed_bundle_ids.length) throw new FormBundleError('Allowed bundles must belong to this tenant.');
  const payment = findPaymentField(form);
  if (bundlePriceField(form, payment) && (new Set(data.map(b => b.currency)).size !== 1
    || data.some(b => b.currency !== (payment.payment_currency || 'GBP').toUpperCase()))) {
    throw new FormBundleError('Bundle prices and the payment field must use the same currency.');
  }
}
export async function bundleOptions(db, form, fieldId) {
  const error = bundleConfigurationError(form);
  if (error) throw new FormBundleError(error);
  const field = (form.fields || []).find(f => f.id === fieldId && f.type === BUNDLE_FIELD_TYPE);
  if (!field) throw new FormBundleError('Bundle field not found', 404);
  const { data, error: dbError } = await db.from('sales_catalogue_bundle')
    .select('id,name,selling_price_minor,currency,is_active,archived_at,available_from,available_to')
    .eq('tenant_id', form.tenant_id).in('id', field.allowed_bundle_ids);
  if (dbError) throw dbError;
  const { data: stocks, error: stockError } = await db.from('form_bundle_stock')
    .select('bundle_id,remaining').eq('tenant_id', form.tenant_id).in('bundle_id', field.allowed_bundle_ids);
  if (stockError) throw stockError;
  const now = Date.now();
  return (data || []).filter(b => b.is_active && !b.archived_at
    && (!b.available_from || Date.parse(b.available_from) <= now)
    && (!b.available_to || Date.parse(b.available_to) >= now)).map(b => {
    const remaining = stocks?.find(s => s.bundle_id === b.id)?.remaining ?? null;
    return { id: b.id, name: b.name, amountMinor: Number(b.selling_price_minor), currency: b.currency,
      remaining, available: remaining !== 0 };
  });
}
// Mutates only the bundle's effective stored answer, never other raw answers.
// A hidden selection has no allocation/pricing authority.
export async function resolveFormBundle(db, form, values, { hiddenFieldIds, checkStock = true } = {}) {
  const field = (form?.fields || []).find(f => f.type === BUNDLE_FIELD_TYPE);
  delete values[BUNDLE_LABELS_KEY];
  delete values.__bundle_hidden;
  const configError = bundleConfigurationError(form);
  if (configError) throw new FormBundleError(configError);
  if (!field) return null;
  if (!hiddenFieldIds) {
    const visibilityOptions = rulesUseLmicOperators(form.visibility_rules)
      ? { lmicCodes: await loadTenantLmicCodes(db, form.tenant_id) } : {};
    hiddenFieldIds = await computeAuthoritativeHiddenFieldIds({
      db, tenantId: form.tenant_id, form, formValues: values, visibilityOptions,
    });
  }
  if (hiddenFieldIds.has(field.id)) { values.__bundle_hidden = field.id; return null; }
  const id = values[field.id];
  if (id == null || id === '') {
    if (field.required) throw new FormBundleError('Choose a bundle.');
    return null;
  }
  if (typeof id !== 'string' || !field.allowed_bundle_ids.includes(id)) throw new FormBundleError('Choose an allowed bundle.');
  const selected = (await bundleOptions(db, form, field.id)).find(b => b.id === id);
  if (!selected || (checkStock && !selected.available)) throw new FormBundleError(
    'This bundle is no longer available. Your other answers are saved here; please choose another bundle.',
    409, 'BUNDLE_UNAVAILABLE',
  );
  if (!Number.isSafeInteger(selected.amountMinor) || selected.amountMinor < 0) throw new FormBundleError('Bundle price is invalid.');
  const payment = findPaymentField(form);
  if (bundlePriceField(form, payment) && selected.currency !== (payment.payment_currency || 'GBP').toUpperCase()) {
    throw new FormBundleError('Bundle and payment currencies do not match.');
  }
  values[BUNDLE_LABELS_KEY] = { [field.id]: selected.name };
  return { ...selected, fieldId: field.id };
}

export async function bundlePayableAmount(db, form, values, paymentField) {
  const selected = await resolveFormBundle(db, form, values);
  return bundlePriceField(form, paymentField) ? (selected?.amountMinor || 0) / 100 : null;
}

// Recovery belongs to the immutable attempt, not today's catalogue. In
// particular, an archive/price edit must not strand an already-payable intent.
export async function recoverBundlePaymentAttempt(db, submission, values, provider) {
  if (!submission) return null;
  const { data: allocation, error } = await db.from('form_bundle_allocation')
    .select('*').eq('tenant_id', submission.tenant_id)
    .eq('submission_id', submission.id).maybeSingle();
  if (error) throw error;
  if (!allocation) return null;
  if (values?.[allocation.field_id] !== allocation.bundle_id
    || submission.submission_data?.[allocation.field_id] !== allocation.bundle_id) {
    throw new FormBundleError('The reserved bundle selection cannot change.', 409, 'IDEMPOTENCY_KEY_REUSED');
  }
  if (provider !== submission.payment_provider) {
    throw new FormBundleError('Continue with the original payment method for this reserved bundle.', 409, 'BUNDLE_ATTEMPT_UNRESOLVED');
  }
  if (allocation.state === 'released') {
    throw new FormBundleError('This bundle payment attempt has ended. Start a new attempt.', 409, 'BUNDLE_ATTEMPT_ENDED');
  }
  const amount = Number(submission.payment_amount);
  const currency = submission.payment_currency;
  if (!Number.isFinite(amount) || amount <= 0 || !currency
    || (submission.payment_meta?.price_field_id === allocation.field_id
      && (Math.round(amount * 100) !== Number(allocation.amount_minor)
        || currency.toUpperCase() !== allocation.currency))) {
    throw new FormBundleError('The reserved payment snapshot needs administrator review.', 409, 'BUNDLE_ATTEMPT_UNRESOLVED');
  }
  return { membershipMeta: null, amount, currency, organizationId: submission.organization_id || null };
}
