import { parseQuoteQuantity } from './salesContracts.js';
import { percentageInstalmentErrors } from './salesBillingConfiguration.js';

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

export function buildBillingSchedule({ lines, currency, recipient, timezone, timezoneFallback, remainderPaymentTerms, newId,
  billingMode = 'groups', percentageInstalments }) {
  if (billingMode === 'percentage') {
    const errors = percentageInstalmentErrors(percentageInstalments);
    if (errors.length) throw new Error(errors.join('; '));
    const weights = percentageInstalments.map(item => item.percentageBps);
    // First allocate whole-proposal totals, then distribute each authoritative
    // line against remaining column capacities. This avoids accumulating a
    // rounding penny per source line in the first instalment.
    const remainingNet = allocateBillingMinor(lines.reduce((n, line) => n + line.netMinor, 0), weights);
    const grossTargets = allocateBillingMinor(lines.reduce((n, line) => n + line.grossMinor, 0), weights);
    const remainingTax = grossTargets.map((gross, index) => gross - remainingNet[index]);
    if (remainingTax.some(tax => tax < 0)) throw new Error('Percentage instalment tax rounding cannot be represented by the provider; adjust percentages');
    const allocations = lines.map((line, linePosition) => {
      if (!Number.isSafeInteger(line.taxRateBps) || line.taxRateBps < 0
        || line.grossMinor !== line.netMinor + line.taxMinor) throw new Error('Invalid authoritative line tax amounts');
      const nets = allocateBillingMinor(line.netMinor, remainingNet);
      const taxes = allocateBillingMinor(line.taxMinor, remainingTax);
      nets.forEach((amount, index) => { remainingNet[index] -= amount; });
      taxes.forEach((amount, index) => { remainingTax[index] -= amount; });
      return { line, linePosition, nets, taxes };
    });
    const groups = percentageInstalments.map((item, position) => {
      const invoiceLines = allocations.map(({ line, linePosition, nets, taxes }) => {
        const netMinor = nets[position], taxMinor = taxes[position];
        if (Number((BigInt(netMinor) * BigInt(line.taxRateBps) + 5000n) / 10000n) !== taxMinor) {
          throw new Error('Percentage instalment tax rounding cannot be represented by the provider; adjust percentages');
        }
        return { linePosition, name: line.description, description: line.description, quantity: '1',
          netMinor, taxMinor, grossMinor: netMinor + taxMinor,
          taxCode: line.catalogueSnapshot?.tax_code || null, taxRateBps: line.taxRateBps };
      });
      const netMinor = invoiceLines.reduce((n, line) => n + line.netMinor, 0);
      const taxMinor = invoiceLines.reduce((n, line) => n + line.taxMinor, 0);
      return { ...structuredClone(item), position, linePosition: null,
        timing: { kind: 'acceptance', days: item.issueDelayPreset.days },
        invoiceLines, contents: invoiceLines, netMinor, taxMinor, grossMinor: netMinor + taxMinor,
        currency, taxCode: null, taxRateBps: null };
    });
    return { mode: 'percentage', percentageInstalments: structuredClone(percentageInstalments),
      timezone, timezoneFallback, recipient, remainderPaymentTerms: null, groups };
  }
  if (billingMode !== 'groups') throw new Error('Invalid billing mode');
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
