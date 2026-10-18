import { decimalToMinor, minorToDecimal } from "../../pages/sales/catalogueProductForm.js";

export const presetSnapshot = (preset) => preset ? { id: preset.id, name: preset.name, days: Number(preset.days) } : null;
export const groupsForEditing = (groups = []) => groups.map(group => ({ ...structuredClone(group), allocatedAmount: minorToDecimal(group.allocatedMinor) }));

export function groupsForSaving(groups = [], items = [], sellingMinor, { copying = false } = {}) {
  if (!groups.length) return [];
  const products = items.filter(item => item.productId).map(item => item.productId);
  const assigned = groups.flatMap(group => group.productIds || []);
  if (products.some(id => assigned.filter(value => value === id).length !== 1)
    || assigned.some(id => !products.includes(id))) throw new Error("Assign every included product to exactly one billing group. Remove memberships for products no longer included.");
  const saved = groups.map((group, position) => {
    if (!group.name?.trim()) throw new Error("Give every billing group a name.");
    if (!group.paymentTerms?.id) throw new Error(`Choose payment terms for ${group.name}.`);
    if (group.timing?.kind === "acceptance" && (!Number.isSafeInteger(Number(group.timing.days)) || Number(group.timing.days) < 0)) throw new Error("Issue delay must be a non-negative whole number of calendar days.");
    if (group.timing?.kind === "fixed" && (!/^\d{4}-\d{2}-\d{2}$/.test(group.timing.date || "") || new Date(`${group.timing.date}T12:00:00Z`).toISOString().slice(0, 10) !== group.timing.date)) throw new Error("Choose a valid fixed invoice date.");
    if (!["fixed", "acceptance"].includes(group.timing?.kind)) throw new Error("Choose invoice timing for every group.");
    return {
      id: group.id, name: group.name.trim(), position, productIds: [...group.productIds],
      ...(copying && group.sourceGroupId ? { sourceGroupId: group.sourceGroupId } : {}),
      allocatedMinor: decimalToMinor(group.allocatedAmount ?? minorToDecimal(group.allocatedMinor), { required: true }),
      timing: group.timing.kind === "fixed" ? { kind: "fixed", date: group.timing.date } : { kind: "acceptance", days: Number(group.timing.days) },
      paymentTerms: presetSnapshot(group.paymentTerms),
      ...(group.timing.kind === "acceptance" && group.issueDelayPreset ? { issueDelayPreset: presetSnapshot(group.issueDelayPreset) } : {}),
    };
  });
  if (saved.reduce((sum, group) => sum + BigInt(group.allocatedMinor), 0n) !== BigInt(sellingMinor)) throw new Error("Billing group allocations must equal the independent bundle selling price exactly.");
  return saved;
}

// Stable largest-remainder allocation: ties follow the displayed group order.
// Suggestions never change the bundle price and are applied only on request.
export function suggestedGroupAmounts(groups, items, products, sellingMinor) {
  if (!groups.length) return [];
  let weights = groups.map(group => (group.productIds || []).reduce((sum, id) => {
    const product = products.find(value => value.id === id);
    if (!product || product.standardPriceMinor == null) throw new Error("Load all assigned product prices before applying suggestions. Unavailable prices are not treated as zero.");
    const quantity = items.find(value => value.productId === id)?.quantity;
    if (!Number.isSafeInteger(Number(quantity)) || Number(quantity) < 1) throw new Error("Use whole positive product quantities and remove stale memberships before applying suggestions.");
    return sum + BigInt(product?.standardPriceMinor || 0) * BigInt(quantity);
  }, 0n));
  if (weights.every(weight => weight === 0n)) weights = weights.map(() => 1n);
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  const amount = BigInt(sellingMinor);
  const shares = weights.map((weight, index) => ({ index, amount: amount * weight / total, remainder: amount * weight % total }));
  let remaining = amount - shares.reduce((sum, share) => sum + share.amount, 0n);
  for (const share of [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining-- > 0n) share.amount++;
  }
  return shares.map(share => minorToDecimal(Number(share.amount)));
}

export const billingScheduleOf = value => value?.billingSchedule ?? value?.billing_schedule
  ?? value?.currentVersion?.billingSchedule ?? value?.currentVersion?.billing_schedule
  ?? value?.quote?.billingSchedule ?? value?.quote?.billing_schedule ?? null;
export const billingValue = (value, camel, snake, fallback = "") => value?.[camel] ?? value?.[snake] ?? fallback;
export function billingTimingText(timing) {
  if (timing?.kind === "fixed") return `Issue on ${timing.date}`;
  const days = Number(timing?.days || 0);
  return days ? `Issue ${days} calendar day${days === 1 ? "" : "s"} after acceptance` : "Issue on acceptance";
}
