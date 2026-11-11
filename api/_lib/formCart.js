import {
  cartField, cartConfigurationError, normalizeCartAnswer, priceCartLines, CART_RECEIPT_KEY,
} from '../../shared/formCart.js';
import { computeAuthoritativeHiddenFieldIds, findPaymentField } from './formFieldVisibility.js';
import { rulesUseLmicOperators } from './formLmicConditions.js';
import { loadTenantLmicCodes } from './tenantLmicCodes.js';
import { resolveSalesTaxCode } from './salesCatalogueTaxOptions.js';

export class FormCartError extends Error {
  constructor(message, status = 400, code = 'INVALID_CART') {
    super(message); this.status = status; this.code = code;
  }
}
export async function formCartReady(db) {
  const { data, error } = await db.rpc('form_cart_version');
  if (error) {
    if (['PGRST202', '42883'].includes(error.code)) return false;
    throw error;
  }
  return data === 1;
}
export async function requireFormCartReady(db) {
  if (!await formCartReady(db)) throw new FormCartError(
    'Cart checkout requires a database update. No payment has been started.', 503, 'CART_NOT_READY',
  );
}
const ordinary = product => product && !product.event_reference_kind && !product.event_id
  && !product.ticket_type_id && !product.space_requirement_id;
const eligible = item => item.is_active === true && !item.archived_at
  && (!item.available_from || Date.parse(item.available_from) <= Date.now())
  && (!item.available_to || Date.parse(item.available_to) >= Date.now());
async function rows(db, table, tenant, ids, columns = '*', idColumn = 'id') {
  if (!ids.length) return [];
  const result = await db.from(table).select(columns).eq('tenant_id', tenant).in(idColumn, ids);
  if (result.error) throw result.error;
  return result.data || [];
}
export async function cartOptions(db, form, fieldId) {
  const configError = cartConfigurationError(form);
  if (configError) throw new FormCartError(configError);
  const field = cartField(form);
  if (!field || field.id !== fieldId) throw new FormCartError('Cart not found.', 404);
  await requireFormCartReady(db);
  const [products, bundles, productStocks, bundleStocks, components] = await Promise.all([
    rows(db, 'sales_catalogue_product', form.tenant_id, field.allowed_product_ids),
    rows(db, 'sales_catalogue_bundle', form.tenant_id, field.allowed_bundle_ids),
    rows(db, 'form_product_stock', form.tenant_id, field.allowed_product_ids, 'product_id,remaining', 'product_id'),
    rows(db, 'form_bundle_stock', form.tenant_id, field.allowed_bundle_ids, 'bundle_id,remaining', 'bundle_id'),
    rows(db, 'sales_catalogue_bundle_item', form.tenant_id, field.allowed_bundle_ids, 'bundle_id,product_id', 'bundle_id'),
  ]);
  const componentProducts = await rows(db, 'sales_catalogue_product', form.tenant_id,
    [...new Set(components.map(component => component.product_id))]);
  const currency = (findPaymentField(form)?.payment_currency || 'GBP').toUpperCase();
  const categories = field.show_bundle_category === true ? await rows(db, 'sales_catalogue_category',
    form.tenant_id, [...new Set(bundles.map(bundle => bundle.category_id).filter(Boolean))], 'id,name') : [];
  const result = [];
  for (const [kind, items, stocks] of [['product', products, productStocks], ['bundle', bundles, bundleStocks]]) {
    for (const item of items) {
      if (!eligible(item) || item.currency !== currency || (kind === 'product' && !ordinary(item))) continue;
      if (kind === 'bundle' && components.filter(component => component.bundle_id === item.id)
        .some(component => !ordinary(componentProducts.find(product => product.id === component.product_id)))) continue;
      const tax = kind === 'bundle' ? field.bundle_tax[item.id]
        : { treatment: item.tax_treatment, rateBps: item.tax_rate_bps };
      // Synced provider codes may have changed since catalogue editing. Require
      // catalogue refresh rather than reserve using a different tax snapshot.
      if (kind === 'product' && item.tax_code) {
        const current = await resolveSalesTaxCode(db, form.tenant_id, item.tax_code);
        if (current.rateBps !== tax.rateBps) throw new FormCartError(
          'A product tax rate changed. Update the catalogue before accepting cart payments.', 409, 'CART_TAX_CHANGED');
      }
      const remaining = stocks.find(stock => stock[`${kind}_id`] === item.id)?.remaining ?? null;
      result.push({ kind, id: item.id, name: item.name, description: item.description || '',
        ...(kind === 'bundle' && field.show_bundle_category === true ? {
          categoryId: categories.find(category => category.id === item.category_id)?.id || null,
          categoryName: categories.find(category => category.id === item.category_id)?.name || null,
        } : {}),
        unitPriceMinor: Number(kind === 'bundle' ? item.selling_price_minor : item.standard_price_minor),
        taxTreatment: tax.treatment, taxRateBps: tax.rateBps, currency, remaining, available: remaining !== 0 });
    }
  }
  return result;
}
export async function validateCartConfiguration(db, form) {
  const error = cartConfigurationError(form);
  if (error) throw new FormCartError(error);
  const field = cartField(form);
  if (!field) return;
  const options = await cartOptions(db, form, field.id);
  if (options.length !== field.allowed_product_ids.length + field.allowed_bundle_ids.length) {
    throw new FormCartError('Choose only active, date-eligible tenant items in the Payment currency, without ticket or exhibition-space fulfilment.');
  }
  // Also validate tax and safe pricing even for zero-stock options.
  for (const item of options) {
    try { priceCartLines({ version: 1, lines: [{ kind: item.kind, id: item.id, quantity: 1 }] },
      [{ ...item, remaining: null, available: true }], item.currency); }
    catch (error) { throw new FormCartError(error.message); }
  }
}
export async function resolveFormCart(db, form, values, { hiddenFieldIds, checkStock = true } = {}) {
  delete values[CART_RECEIPT_KEY];
  delete values.__cart_hidden;
  const error = cartConfigurationError(form);
  if (error) throw new FormCartError(error);
  const field = cartField(form);
  if (!field) return null;
  await requireFormCartReady(db);
  if (!hiddenFieldIds) {
    const visibilityOptions = rulesUseLmicOperators(form.visibility_rules)
      ? { lmicCodes: await loadTenantLmicCodes(db, form.tenant_id) } : {};
    hiddenFieldIds = await computeAuthoritativeHiddenFieldIds({
      db, tenantId: form.tenant_id, form, formValues: values, visibilityOptions,
    });
  }
  if (hiddenFieldIds.has(field.id)) { values.__cart_hidden = field.id; return null; }
  let answer;
  try { answer = normalizeCartAnswer(values[field.id]); }
  catch (error) { throw new FormCartError(error.message); }
  if (field.required && !answer.lines.length) throw new FormCartError('Choose at least one cart item.');
  if (field.bundle_required === true && !answer.lines.some(line => line.kind === 'bundle')) {
    throw new FormCartError('Add at least one bundle to continue.');
  }
  values[field.id] = answer;
  const options = await cartOptions(db, form, field.id);
  let receipt;
  try {
    receipt = priceCartLines(answer, checkStock ? options : options.map(item => ({ ...item, remaining: null, available: true })),
      (findPaymentField(form)?.payment_currency || 'GBP').toUpperCase());
  } catch (error) { throw new FormCartError(error.message, 409, 'CART_UNAVAILABLE'); }
  if (receipt.grossMinor > 0 && hiddenFieldIds.has(findPaymentField(form)?.id)) {
    throw new FormCartError('The Payment element must be visible to check out this cart.');
  }
  // The database independently rebuilds this snapshot on accepted persistence.
  values[CART_RECEIPT_KEY] = { ...receipt, fieldId: field.id };
  return values[CART_RECEIPT_KEY];
}

export async function recoverCartPaymentAttempt(db, submission, values, provider) {
  if (!submission) return null;
  if (!await formCartReady(db)) {
    if (submission.submission_data?.[CART_RECEIPT_KEY]) await requireFormCartReady(db);
    return null;
  }
  const { data: receipt, error } = await db.from('form_cart_receipt').select('*')
    .eq('tenant_id', submission.tenant_id).eq('submission_id', submission.id).maybeSingle();
  if (error) throw error;
  if (!receipt) return null;
  let answer;
  try { answer = normalizeCartAnswer(values?.[receipt.field_id]); }
  catch (error) { throw new FormCartError(error.message, 409, 'IDEMPOTENCY_KEY_REUSED'); }
  if (JSON.stringify(answer) !== JSON.stringify(normalizeCartAnswer(receipt.answer))) {
    throw new FormCartError('The accepted cart cannot change. Continue the original checkout.', 409, 'IDEMPOTENCY_KEY_REUSED');
  }
  if (receipt.state === 'released') throw new FormCartError('This cart payment attempt ended. Start a new attempt.', 409, 'CART_ATTEMPT_ENDED');
  if (provider !== submission.payment_provider || Math.round(Number(submission.payment_amount) * 100) !== receipt.terms.grossMinor
    || submission.payment_currency?.toUpperCase() !== receipt.terms.currency) {
    throw new FormCartError('Continue the original payment method. This cart needs review if it cannot be resumed.', 409, 'CART_ATTEMPT_UNRESOLVED');
  }
  return { membershipMeta: null, amount: Number(submission.payment_amount), currency: submission.payment_currency,
    organizationId: submission.organization_id || null, cart: receipt.terms };
}
