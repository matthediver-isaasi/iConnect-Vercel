const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const days = value => Number.isSafeInteger(value) && value >= 0 && value <= 36500;
const name = value => typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= 100;
const date = value => typeof value === 'string' && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function billingPresetErrors(value) {
  if (!object(value) || Object.keys(value).some(key => !['issueDelays', 'paymentTerms'].includes(key))) return ['Billing presets must contain separate issueDelays and paymentTerms lists'];
  const errors = [];
  for (const kind of ['issueDelays', 'paymentTerms']) {
    const list = value[kind];
    if (!Array.isArray(list) || list.length > 100) { errors.push(`${kind} must contain at most 100 presets`); continue; }
    const ids = new Set();
    for (const item of list) {
      if (!object(item) || !UUID.test(item.id || '') || !name(item.name) || !days(item.days)
        || typeof item.isActive !== 'boolean' || typeof item.isDefault !== 'boolean'
        || item.isDefault && !item.isActive
        || Object.keys(item).some(key => !['id', 'name', 'days', 'isActive', 'isDefault'].includes(key))) {
        errors.push(`${kind}: each preset needs a stable UUID, name, 0–36500 whole calendar days, active status and default status`);
      }
      if (ids.has(item?.id)) errors.push(`${kind}: duplicate preset identity`);
      ids.add(item?.id);
    }
    if (list.filter(item => item?.isDefault).length > 1) errors.push(`${kind}: choose at most one default`);
  }
  return errors;
}

export function bundleBillingGroupErrors(groups, items, sellingPriceMinor) {
  if (!Array.isArray(groups) || groups.length > 100) return ['billingGroups must be an array of at most 100 groups'];
  if (!groups.length) return [];
  const errors = [], ids = new Set(), membership = new Set();
  let total = 0n;
  groups.forEach((group, index) => {
    if (!object(group)) { errors.push('Invalid billing group'); return; }
    if (!UUID.test(group.id || '') || ids.has(group.id)) errors.push('Billing group identities must be unique UUIDs');
    ids.add(group.id);
    if (!name(group.name)) errors.push('Billing group names must contain 1–100 characters');
    if (group.position !== index) errors.push('Billing group positions must match their order');
    if (!Number.isSafeInteger(group.allocatedMinor) || group.allocatedMinor < 0) errors.push('Group allocations must be non-negative safe minor-unit amounts');
    else total += BigInt(group.allocatedMinor);
    if (!Array.isArray(group.productIds)) errors.push('Every group needs a product membership list');
    else for (const id of group.productIds) {
      if (!UUID.test(id) || membership.has(id)) errors.push('Each product can belong to exactly one billing group');
      membership.add(id);
    }
    if (!(group.timing?.kind === 'acceptance' && days(group.timing.days))
      && !(group.timing?.kind === 'fixed' && date(group.timing.date))) errors.push('Choose an acceptance delay in whole calendar days or a valid fixed invoice date');
    if (!UUID.test(group.paymentTerms?.id || '') || !name(group.paymentTerms?.name) || !days(group.paymentTerms?.days)) errors.push('Select named payment terms separately from invoice timing');
    if (group.issueDelayPreset != null && (!UUID.test(group.issueDelayPreset.id || '')
      || !name(group.issueDelayPreset.name) || !days(group.issueDelayPreset.days)
      || group.timing?.kind !== 'acceptance' || group.issueDelayPreset.days !== group.timing.days)) errors.push('Issue-delay selection must match invoice timing');
  });
  if (Array.isArray(items)) {
    const products = new Set(items.map(item => item.productId));
    if (products.size !== membership.size || [...products].some(id => !membership.has(id))) errors.push('Assign every bundle product to exactly one billing group');
  }
  if (Number.isSafeInteger(sellingPriceMinor) && total !== BigInt(sellingPriceMinor)) errors.push('Group allocations must equal the bundle selling price exactly');
  return errors;
}

// A saved selection survives deactivation or later preset edits. A changed/new
// selection must resolve from this tenant's current active presets, never from
// the client-supplied label or day count.
export function resolveBillingGroups(groups, presets, previousGroups = []) {
  const resolve = (selection, kind, previous) => {
    if (previous && selection?.id === previous.id && selection.name === previous.name && selection.days === previous.days) return structuredClone(previous);
    const found = presets?.[kind]?.find(item => item.id === selection?.id && item.isActive);
    if (!found) throw new Error(`Select an active ${kind === 'paymentTerms' ? 'payment-term' : 'issue-delay'} preset belonging to this tenant`);
    return { id: found.id, name: found.name.trim(), days: found.days };
  };
  return groups.map((group, position) => {
    const previous = previousGroups.find(item => item.id === group.id);
    const paymentTerms = resolve(group.paymentTerms, 'paymentTerms', previous?.paymentTerms);
    const issueDelayPreset = group.issueDelayPreset
      ? resolve(group.issueDelayPreset, 'issueDelays', previous?.issueDelayPreset) : null;
    return { id: group.id, name: group.name.trim(), position, productIds: [...group.productIds],
      allocatedMinor: group.allocatedMinor, paymentTerms,
      ...(group.sourceGroupId ? { sourceGroupId: group.sourceGroupId } : {}),
      timing: group.timing.kind === 'fixed' ? { kind: 'fixed', date: group.timing.date }
        : { kind: 'acceptance', days: issueDelayPreset?.days ?? group.timing.days },
      ...(issueDelayPreset ? { issueDelayPreset } : {}) };
  });
}
