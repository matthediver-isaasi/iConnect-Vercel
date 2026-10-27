import { parseQuoteQuantity } from './salesContracts.js';

// Only supplied evidence is used here. Legacy snapshots deliberately retain
// their unqualified names; never look up today's catalogue for a document.
export function bundleProductName(component) {
  const product = component.productSnapshot || component.product_snapshot || component;
  const name = product.name || 'Included product';
  return product.categoryName ? `${product.categoryName} — ${name}` : name;
}

export function bundleComponentQuantity(quantity, multiplier) {
  const { units, scale } = parseQuoteQuantity(String(quantity));
  const result = units * BigInt(multiplier);
  const fraction = (result % scale).toString().padStart(scale.toString().length - 1, '0').replace(/0+$/, '');
  return `${result / scale}${fraction ? `.${fraction}` : ''}`;
}

export function bundleInvoiceDescription(line, components = line.components || line.sales_quote_bundle_component || []) {
  const description = line.description || '';
  // No retrospective changes to legacy financial evidence.
  if (!components.some(c => (c.productSnapshot || c.product_snapshot)?.categoryName)) return description;
  return `${description}\nIncludes: ${components.map(c => `${bundleComponentQuantity(line.quantity, c.quantity)} × ${bundleProductName(c)}`).join('; ')}`;
}
