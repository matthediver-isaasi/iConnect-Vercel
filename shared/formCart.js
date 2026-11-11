import { calculateQuoteLine, SALES_TAX_TREATMENTS } from './salesContracts.js';

export const CART_FIELD_TYPE = 'sales_cart';
export const CART_VERSION = 1;
export const CART_RECEIPT_KEY = '__cart_receipt';
export const CART_MAX_LINES = 100;
export const CART_MAX_QUANTITY = 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function cartField(form) {
  return (form?.fields || []).find(field => field?.type === CART_FIELD_TYPE) || null;
}

// Only identities and quantities cross the respondent trust boundary.
export function normalizeCartAnswer(answer) {
  if (answer == null || answer === '') return { version: CART_VERSION, lines: [] };
  if (!answer || Array.isArray(answer) || answer.version !== CART_VERSION
    || !Array.isArray(answer.lines) || answer.lines.length > CART_MAX_LINES) {
    throw new Error('Invalid cart answer.');
  }
  const normalized = new Map();
  for (const line of answer.lines) {
    if (!line || !['product', 'bundle'].includes(line.kind) || !uuid.test(line.id)
      || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > CART_MAX_QUANTITY) {
      throw new Error(`Cart quantities must be whole numbers from 1 to ${CART_MAX_QUANTITY}.`);
    }
    const id = line.id.toLowerCase();
    const key = `${line.kind}:${id}`;
    const quantity = (normalized.get(key)?.quantity || 0) + line.quantity;
    if (quantity > CART_MAX_QUANTITY) throw new Error('Combined cart quantity is too large.');
    normalized.set(key, { kind: line.kind, id, quantity });
  }
  return { version: CART_VERSION, lines: [...normalized.values()].sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)) };
}

export function cartConfigurationError(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const carts = fields.filter(field => field?.type === CART_FIELD_TYPE);
  const nested = value => Array.isArray(value) ? value.some(nested)
    : value && typeof value === 'object'
      ? [CART_FIELD_TYPE, 'sales_cart_view'].includes(value.type) || Object.values(value).some(nested) : false;
  if (fields.some(field => Object.entries(field || {}).some(([key, value]) => key !== 'type' && nested(value)))) {
    return 'Cart elements cannot be nested or repeated.';
  }
  const views = fields.filter(field => field?.type === 'sales_cart_view');
  if (views.some(field => field.parent_field_id || field.required || field.multiple || field.multi_select)) {
    return 'Cart view must be a top-level display element without required answers.';
  }
  if (!carts.length) return views.length ? 'Add a Cart element before using Cart view.' : null;
  if (carts.length !== 1 || (form.form_type && form.form_type !== 'standard')) {
    return 'Only one Cart is supported, on standard forms only.';
  }
  const cart = carts[0];
  if (cart.bundle_max_quantities !== undefined) {
    const limits = cart.bundle_max_quantities;
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)
      || Object.entries(limits).some(([id, max]) => !uuid.test(id) || !Number.isSafeInteger(max) || max < 1 || max > CART_MAX_QUANTITY)) {
      return 'Bundle purchase limits must be whole numbers from 1 to 1000.';
    }
  }
  for (const key of ['bundle_label', 'bundle_category_label']) {
    if (cart[key] !== undefined && (typeof cart[key] !== 'string' || cart[key].length > 120)) return 'Cart labels must be text of up to 120 characters.';
  }
  if (cart.bundle_required !== undefined && typeof cart.bundle_required !== 'boolean') return 'Require a bundle must be on or off.';
  if (cart.bundle_required && !cart.allowed_bundle_ids?.length) return 'Choose at least one bundle when a bundle is required.';
  if (cart.bundle_display !== undefined && !['cards', 'dropdown'].includes(cart.bundle_display)) {
    return 'Choose Item cards or Dropdown for Bundle display.';
  }
  if (cart.show_bundle_category !== undefined && typeof cart.show_bundle_category !== 'boolean') {
    return 'Enable bundle category filter must be a boolean.';
  }
  if (cart.cart_version !== CART_VERSION || !cart.id || cart.parent_field_id || cart.multiple || cart.multi_select) {
    return 'Use a version 1 top-level Cart.';
  }
  if (fields.some(field => ['sales_bundle', 'membership_payment'].includes(field.type))
    || JSON.stringify(form.visibility_rules || []).includes('membership_structure')) {
    return 'Carts cannot be combined with legacy Bundle elements or membership fees.';
  }
  const payment = fields.filter(field => field.type === 'payment');
  if (payment.length !== 1 || payment[0].price_field_id !== cart.id) {
    return 'Connect exactly one Payment element to the Cart total.';
  }
  if (payment[0].payment_mode === 'monthly' || payment[0].allow_monthly_payments || payment[0].monthly_instalments) {
    return 'Carts support one-off payments only.';
  }
  for (const key of ['allowed_product_ids', 'allowed_bundle_ids']) {
    if (!Array.isArray(cart[key]) || cart[key].some(id => typeof id !== 'string' || !uuid.test(id))
      || new Set(cart[key].map(id => id.toLowerCase())).size !== cart[key].length) {
      return 'Choose distinct catalogue items for the Cart.';
    }
  }
  const count = cart.allowed_product_ids.length + cart.allowed_bundle_ids.length;
  if (!count || count > CART_MAX_LINES) return `Choose between 1 and ${CART_MAX_LINES} Cart items.`;
  // Bundle prices have no catalogue-level tax authority. An author must make
  // the treatment explicit; never infer it from component rates or default 0.
  for (const id of cart.allowed_bundle_ids) {
    const tax = cart.bundle_tax?.[id];
    if (!tax || !SALES_TAX_TREATMENTS.includes(tax.treatment)
      || !Number.isInteger(tax.rateBps) || tax.rateBps < 0 || tax.rateBps > 100000
      || (tax.treatment !== 'standard' && tax.rateBps !== 0)) {
      return 'Set an explicit valid tax treatment and rate for every Cart bundle.';
    }
  }
  return null;
}

export function cartQuantityError(field, answer) {
  const normalized = normalizeCartAnswer(answer);
  for (const line of normalized.lines) {
    if (line.kind !== 'bundle') continue;
    const max = field.bundle_max_quantities?.[line.id] ?? CART_MAX_QUANTITY;
    if (!Number.isSafeInteger(max) || max < 1 || max > CART_MAX_QUANTITY) return 'Invalid bundle purchase limit.';
    if (line.quantity > max) return `You can add a maximum of ${max} of this bundle per cart.`;
  }
  return null;
}

// Called only with server-resolved items (never browser prices).
export function priceCartLines(answer, items, currency) {
  const normalized = normalizeCartAnswer(answer);
  const lines = normalized.lines.map(line => {
    const item = items.find(item => item.kind === line.kind && item.id === line.id);
    if (!item || item.currency !== currency || item.available !== true) {
      throw new Error('A cart item is unavailable or uses a different currency.');
    }
    if (item.remaining !== null && (!Number.isInteger(item.remaining) || item.remaining < line.quantity)) {
      throw new Error('There is not enough stock for this cart.');
    }
    if (!Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 0
      || !SALES_TAX_TREATMENTS.includes(item.taxTreatment)
      || !Number.isInteger(item.taxRateBps) || item.taxRateBps < 0 || item.taxRateBps > 100000
      || (item.taxTreatment !== 'standard' && item.taxRateBps !== 0)) {
      throw new Error('Cart pricing or tax configuration is invalid.');
    }
    const amounts = calculateQuoteLine({
      quantity: String(line.quantity), quotedUnitPriceMinor: item.unitPriceMinor,
      discountBps: 0, taxRateBps: item.taxRateBps,
    });
    return { ...line, name: item.name, description: item.description || '',
      unitPriceMinor: item.unitPriceMinor, taxTreatment: item.taxTreatment, taxRateBps: item.taxRateBps,
      currency, netMinor: amounts.netMinor, taxMinor: amounts.taxMinor, grossMinor: amounts.grossMinor };
  });
  const sum = key => {
    const value = lines.reduce((total, line) => total + BigInt(line[key]), 0n);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Cart total is too large.');
    return Number(value);
  };
  return { version: CART_VERSION, currency, lines,
    netMinor: sum('netMinor'), taxMinor: sum('taxMinor'), grossMinor: sum('grossMinor') };
}

export function formatCartReceipt(receipt) {
  if (receipt?.version !== CART_VERSION || !Array.isArray(receipt.lines)) return '';
  const money = value => `${receipt.currency} ${(value / 100).toFixed(2)}`;
  return [...receipt.lines.map(line =>
    `${line.quantity} × ${line.name}${line.description ? ` — ${line.description}` : ''}: ${money(line.unitPriceMinor)} each, net ${money(line.netMinor)}, tax ${money(line.taxMinor)} (${line.taxTreatment}, ${line.taxRateBps / 100}%), total ${money(line.grossMinor)}`),
  `Total: ${money(receipt.grossMinor)} (tax ${money(receipt.taxMinor)})`].join('\n');
}
