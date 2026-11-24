import { parseQuoteQuantity } from './salesContracts.js';

// Versioned commercial meaning, not a membership price or payment receipt.
export const PROPOSAL_MEMBERSHIP_BENEFIT = Object.freeze({
  version: 1,
  scope: 'organization',
  coverage: 'next_new_period',
  periods: 1,
  baseFeeOnly: true,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => {
  throw Object.assign(new Error(message), { code: 'PROPOSAL_MEMBERSHIP_INVALID', status: 400 });
};

export function membershipProductErrors(value) {
  if (value === null) return [];
  if (!object(value) || Object.keys(value).some(key => key !== 'scheduleId')
    || !UUID.test(value.scheduleId || '')) {
    return ['Choose an organisational membership schedule; only scheduleId is supported.'];
  }
  return [];
}

export function validateMembershipBenefitSnapshot(snapshot) {
  if (!object(snapshot) || !UUID.test(snapshot.scheduleId || '')
    || typeof snapshot.scheduleName !== 'string' || !snapshot.scheduleName.trim()
    || Object.entries(PROPOSAL_MEMBERSHIP_BENEFIT).some(([key, value]) => snapshot[key] !== value)
    || Object.keys(snapshot).some(key => ![
      ...Object.keys(PROPOSAL_MEMBERSHIP_BENEFIT), 'scheduleId', 'scheduleName',
    ].includes(key))) {
    fail('The included membership benefit is invalid. Recreate the proposal line before issuing it.');
  }
  return structuredClone(snapshot);
}

export function freezeMembershipBenefit(schedule, tenantId) {
  if (!UUID.test(tenantId || '') || !schedule || schedule.tenant_id !== tenantId
    || !UUID.test(schedule.id || '')
    || (schedule.structure_scope_type || 'organization') !== 'organization'
    || schedule.is_active === false || typeof schedule.name !== 'string' || !schedule.name.trim()) {
    fail('Choose an active organisational membership schedule belonging to this tenant.');
  }
  return { ...PROPOSAL_MEMBERSHIP_BENEFIT, scheduleId: schedule.id, scheduleName: schedule.name };
}

export function membershipBenefitLabel(snapshot) {
  const benefit = validateMembershipBenefitSnapshot(snapshot);
  return `${benefit.scheduleName}: base membership fee included for the next newly created matching period only. Add-ons remain payable. Existing periods and later renewals are not covered.`;
}

function exactlyOne(quantity, label) {
  let parsed;
  try { parsed = parseQuoteQuantity(String(quantity)); }
  catch { fail(`${label}: use quantity 1 for an included membership.`); }
  if (parsed.units !== parsed.scale) {
    fail(`${label}: membership quantity must be 1; future free periods cannot be stacked.`);
  }
}

/**
 * Input is the SERVER-resolved quote shape, not a browser-authored benefit.
 * All occurrences are retained until validation; duplicates are never collapsed.
 * Bundle and component quantities must independently be one, not just multiply
 * to one (e.g. 0.5 × 2 would otherwise hide unsupported fractional benefits).
 */
export function collectProposalMembershipBenefits(lines, organisation, tenantId) {
  if (!Array.isArray(lines)) fail('Proposal lines are unavailable.');
  const benefits = [];
  const seen = new Set();
  for (const [lineIndex, line] of lines.entries()) {
    if (!object(line)) fail('Proposal contains an invalid line.');
    const occurrences = line.kind === 'product'
      ? [{ snapshot: line.catalogueSnapshot, quantity: '1', componentIndex: null }]
      : line.kind === 'bundle'
        ? (line.components || []).map((component, componentIndex) => ({
          snapshot: component.productSnapshot, quantity: component.quantity, componentIndex,
        })) : [];
    for (const occurrence of occurrences) {
      const snapshot = occurrence.snapshot?.membershipBenefit;
      if (snapshot === undefined || snapshot === null) continue;
      const benefit = validateMembershipBenefitSnapshot(snapshot);
      exactlyOne(line.quantity, `Line ${lineIndex + 1}`);
      exactlyOne(occurrence.quantity, `Line ${lineIndex + 1} component`);
      if (seen.has(benefit.scheduleId.toLowerCase())) {
        fail(`${benefit.scheduleName} occurs more than once. Include at most one benefit per organisation and schedule in a proposal.`);
      }
      seen.add(benefit.scheduleId.toLowerCase());
      benefits.push({ lineIndex, componentIndex: occurrence.componentIndex, benefit });
    }
  }
  if (benefits.length && (!UUID.test(tenantId || '') || !organisation
    || !UUID.test(organisation.id || '') || organisation.tenant_id !== tenantId)) {
    fail('Select a valid customer organisation before including a membership benefit.');
  }
  return benefits;
}

function minor(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be non-negative integer minor units.`);
  return value;
}

/**
 * Pure preview only. Eligibility must be rechecked under the database lock when
 * creating the history row. Never use this result to mark a payment as received.
 */
export function previewProposalMembershipBenefit({
  entitlement, tenantId, organisationId, scheduleId, existingHistoryId = null,
  baseNetMinor, baseVatMinor, addonNetMinor = 0, addonVatMinor = 0,
}) {
  minor(baseNetMinor, 'Base fee');
  minor(baseVatMinor, 'Base VAT');
  minor(addonNetMinor, 'Add-on fee');
  minor(addonVatMinor, 'Add-on VAT');
  if (!UUID.test(tenantId || '') || !UUID.test(organisationId || '') || !UUID.test(scheduleId || '')) {
    fail('A tenant, customer organisation and resolved schedule are required.');
  }
  const eligible = Boolean(entitlement && !existingHistoryId
    && entitlement.tenant_id === tenantId && entitlement.organization_id === organisationId
    && entitlement.schedule_id === scheduleId && entitlement.consumed_history_id === null);
  if (eligible) {
    const snapshot = validateMembershipBenefitSnapshot(entitlement.benefit_snapshot);
    if (snapshot.scheduleId !== scheduleId) fail('Entitlement schedule does not match its accepted snapshot.');
  }
  const net = (eligible ? 0 : baseNetMinor) + addonNetMinor;
  const vat = (eligible ? 0 : baseVatMinor) + addonVatMinor;
  const total = net + vat;
  if (![net, vat, total, baseNetMinor + baseVatMinor].every(Number.isSafeInteger)) {
    fail('Membership total exceeds the supported minor-unit range.');
  }
  return {
    eligible,
    originalBaseNetMinor: baseNetMinor,
    originalBaseVatMinor: baseVatMinor,
    waivedBaseNetMinor: eligible ? baseNetMinor : 0,
    waivedBaseVatMinor: eligible ? baseVatMinor : 0,
    addonNetMinor,
    addonVatMinor,
    remainingNetMinor: net,
    remainingVatMinor: vat,
    remainingTotalMinor: total,
    noPaymentRequired: total === 0,
  };
}
