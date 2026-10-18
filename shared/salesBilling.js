import { parseQuoteQuantity } from './salesContracts.js';

function componentQuantity(quantity, multiplier) {
  const { units, scale } = parseQuoteQuantity(quantity);
  const result = units * BigInt(multiplier);
  const whole = result / scale;
  const fraction = (result % scale).toString().padStart(scale.toString().length - 1, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

// Integer largest-remainder allocation; ties follow frozen group order.
export function allocateBillingMinor(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || !weights.length
    || weights.some(w => !Number.isSafeInteger(w) || w < 0)) throw new Error('Invalid billing allocation');
  let values = weights.map(BigInt);
  let sum = values.reduce((a, b) => a + b, 0n);
  if (!sum) { values = values.map(() => 1n); sum = BigInt(values.length); }
  const rows = values.map((w, i) => ({ i, value: BigInt(total) * w / sum, remainder: BigInt(total) * w % sum }));
  let remaining = BigInt(total) - rows.reduce((a, r) => a + r.value, 0n);
  for (const row of [...rows].sort((a, b) => a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining-- > 0n) row.value++;
  }
  return rows.map(r => Number(r.value));
}

export function billingTimingLabel(timing) {
  return timing.kind === 'fixed' ? `Issue on ${timing.date}` : timing.days === 0
    ? 'Issue on acceptance' : `Issue ${timing.days} calendar days after acceptance`;
}

export function resolveBillingTimezone(value) {
  if (!value) return { timezone: 'UTC', timezoneFallback: true };
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
  catch { throw new Error('Tenant billing timezone is invalid'); }
  return { timezone: value, timezoneFallback: false };
}

export function billingCalendarDate(timestamp, timezone, days = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
  const part = name => parts.find(p => p.type === name).value;
  const date = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildBillingSchedule({ lines, currency, recipient, timezone, timezoneFallback, remainderPaymentTerms, newId }) {
  const groups = [];
  const remainder = [];
  lines.forEach((line, linePosition) => {
    const configured = line.kind === 'bundle' ? line.catalogueSnapshot?.billing_groups : null;
    if (!configured?.length) { remainder.push({ line, linePosition }); return; }
    const ordered = [...configured].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const weights = ordered.map(g => g.allocatedMinor);
    if (weights.reduce((a, b) => a + b, 0) !== line.standardUnitPriceMinor) throw new Error('Bundle billing allocations must equal its selling price');
    const membership = ordered.flatMap(g => g.productIds);
    if (new Set(membership).size !== membership.length || membership.length !== line.components.length
      || line.components.some(c => !membership.includes(c.productId))) throw new Error('Every bundle product must belong to exactly one billing group');
    const nets = allocateBillingMinor(line.netMinor, weights);
    const taxes = allocateBillingMinor(line.taxMinor, weights);
    ordered.forEach((group, index) => {
      // Both providers calculate tax per invoice line. Reject allocations which
      // cannot express the frozen tax rate without changing accepted economics.
      if (Number((BigInt(nets[index]) * BigInt(line.taxRateBps) + 5000n) / 10000n) !== taxes[index]) {
        throw new Error('Billing group tax rounding cannot be represented by the provider; adjust allocations');
      }
      groups.push({ ...group, id: newId(), sourceGroupId: group.id, linePosition, position: groups.length,
        bundleLineLabel: `Line ${linePosition + 1}: ${line.description || line.catalogueSnapshot?.name || 'Bundle'}`,
        bundleQuantity: line.quantity,
        invoiceLines: [{ name: group.name, description: group.name, quantity: '1', netMinor: nets[index],
          taxMinor: taxes[index], grossMinor: nets[index] + taxes[index],
          taxCode: line.catalogueSnapshot?.tax_code || null, taxRateBps: line.taxRateBps }],
        contents: line.components.filter(c => group.productIds.includes(c.productId)).map(c => ({
          productId: c.productId, name: c.productSnapshot.name,
          quantity: componentQuantity(line.quantity, c.quantity),
          componentQuantity: c.quantity, bundleQuantity: line.quantity,
        })), netMinor: nets[index], taxMinor: taxes[index], grossMinor: nets[index] + taxes[index],
        currency, taxCode: line.catalogueSnapshot?.tax_code || null, taxRateBps: line.taxRateBps });
    });
  });
  if (remainder.length) {
    if (!remainderPaymentTerms) throw new Error('Select payment terms for the remainder group');
    groups.push({ id: newId(), name: 'Remainder', position: groups.length, linePosition: null,
      timing: { kind: 'acceptance', days: 0 }, paymentTerms: remainderPaymentTerms,
      invoiceLines: remainder.map(({ line, linePosition }) => ({ linePosition, name: line.description,
        description: line.description, quantity: '1', netMinor: line.netMinor, taxMinor: line.taxMinor,
        grossMinor: line.grossMinor, taxCode: line.catalogueSnapshot?.tax_code || null, taxRateBps: line.taxRateBps })),
      contents: remainder.map(({ line, linePosition }) => ({ linePosition, name: line.description, quantity: line.quantity,
        netMinor: line.netMinor, taxMinor: line.taxMinor, grossMinor: line.grossMinor,
        taxCode: line.catalogueSnapshot?.tax_code || null, taxRateBps: line.taxRateBps })),
      netMinor: remainder.reduce((n, r) => n + r.line.netMinor, 0),
      taxMinor: remainder.reduce((n, r) => n + r.line.taxMinor, 0),
      grossMinor: remainder.reduce((n, r) => n + r.line.grossMinor, 0),
      currency, taxCode: null, taxRateBps: null });
  }
  return { timezone, timezoneFallback, recipient, remainderPaymentTerms: remainderPaymentTerms || null, groups };
}
