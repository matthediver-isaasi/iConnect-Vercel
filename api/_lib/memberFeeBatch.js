/**
 * Shared, side-effect-free pieces for the imported member fee batch.
 *
 * The runner deliberately supplies its database and service functions. This
 * keeps selection/classification testable without a live database and prevents
 * a batch from accidentally using a different tenant's global client.
 */

export const BATCH_OUTCOMES = Object.freeze({
  ELIGIBLE: 'eligible',
  ALREADY_APPROVED: 'already_approved',
  ALREADY_RECORDED: 'already_recorded',
  MISSING_MEMBER: 'missing_member',
  TENANT_MISMATCH: 'tenant_mismatch',
  MISSING_EMAIL: 'missing_email',
  UNMAPPED_TIER: 'unmapped_tier',
  INVALID_DATE_CONFIG: 'invalid_date_config',
  PO_SUBMITTED: 'po_submitted',
  TERMINAL_TOKEN: 'terminal_token',
  DUPLICATE_ACTIVE_TOKEN: 'duplicate_active_token',
  OTHER_SKIPPED: 'other_skipped',
  ERROR: 'error',
});

export const PROCESSABLE_OUTCOMES = new Set([
  BATCH_OUTCOMES.ELIGIBLE,
  BATCH_OUTCOMES.ALREADY_APPROVED,
]);

export function classifySimulationFailure(errorMessage) {
  const message = String(errorMessage || 'Membership simulation failed');
  if (/tier|band|member-scoped.*config|active.*config|match/i.test(message)) {
    return { outcome: BATCH_OUTCOMES.UNMAPPED_TIER, reason: message };
  }
  if (/date|year|config|configuration|invalid/i.test(message)) {
    return { outcome: BATCH_OUTCOMES.INVALID_DATE_CONFIG, reason: message };
  }
  return { outcome: BATCH_OUTCOMES.OTHER_SKIPPED, reason: message };
}

export function tokenDecision(rows, now = new Date()) {
  const tokens = rows || [];
  const active = tokens.filter((row) => {
    if (row.status === 'pending') {
      return !row.expires_at || new Date(row.expires_at) > now;
    }
    return row.status === 'po_submitted';
  });
  if (active.filter((row) => row.status === 'pending').length > 1) {
    return {
      outcome: BATCH_OUTCOMES.DUPLICATE_ACTIVE_TOKEN,
      reason: 'More than one active pending token exists for this member and year',
    };
  }
  if (active.some((row) => row.status === 'po_submitted')) {
    return {
      outcome: BATCH_OUTCOMES.PO_SUBMITTED,
      reason: 'A Purchase Order has already been submitted for this membership year',
      tokenStatus: 'po_submitted',
    };
  }
  if (active.some((row) => row.status === 'pending')) {
    return { tokenStatus: 'pending_reuse' };
  }
  if (tokens.some((row) => row.status === 'paid')) {
    return {
      outcome: BATCH_OUTCOMES.TERMINAL_TOKEN,
      reason: 'A token for this membership year is already paid',
      tokenStatus: 'paid',
    };
  }
  return { tokenStatus: tokens.length ? 'expired_or_cancelled' : 'none' };
}

export function classifyCountRows(rows) {
  const counts = Object.fromEntries(Object.values(BATCH_OUTCOMES).map((key) => [key, 0]));
  for (const row of rows || []) counts[row.outcome] = (counts[row.outcome] || 0) + 1;
  counts.processable = (rows || []).filter((row) => PROCESSABLE_OUTCOMES.has(row.outcome)).length;
  return counts;
}

export function pageByCursor(rows, { after = null, limit = 50 } = {}) {
  const ordered = [...(rows || [])].sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
  const filtered = after ? ordered.filter((row) => row.cursor > after) : ordered;
  const page = filtered.slice(0, limit);
  return {
    rows: page,
    total: ordered.length,
    hasMore: filtered.length > page.length,
    nextCursor: filtered.length > page.length ? page.at(-1)?.cursor || null : null,
  };
}

function costBreakdownFromSimulation(simResult) {
  return {
    annualCost: simResult.annualCost,
    annualCostBeforeDiscounts: simResult.annualCostBeforeDiscounts,
    customDiscountTotal: simResult.customDiscountTotal || 0,
    customDiscountDetails: simResult.customDiscountDetails || [],
    prorataCost: simResult.prorataCost,
    prorataDays: simResult.prorataDays,
    dailyCost: simResult.dailyCost,
    freeDiscount: simResult.freeDiscount || 0,
    freePeriodDaysApplied: simResult.freePeriodDaysApplied || 0,
    freePeriodAmount: simResult.freePeriodAmount,
    freePeriodUnit: simResult.freePeriodUnit,
    yearNumber: simResult.yearNumber,
    rolloverDiscount: simResult.rolloverDiscount || 0,
    proRataEnabled: simResult.proRataEnabled,
    overrideType: simResult.overrideType || null,
    overrideDiscountType: simResult.overrideDiscountType || null,
    overrideDiscountValue: simResult.overrideDiscountValue || null,
    vatRatePercent: simResult.vatRatePercent || null,
    vatAmount: simResult.vatAmount || 0,
    totalWithVat: simResult.totalWithVat || simResult.finalCost || 0,
    taxLabel: simResult.taxLabel || null,
  };
}

export function buildMemberFeeEmailPayload(simResult, { tenantId, memberId }) {
  const finalCost = Math.round((simResult.finalCost || 0) * 100) / 100;
  return {
    client: undefined,
    tenantId,
    organizationId: null,
    memberId,
    organizationName: simResult.member?.name || 'Member',
    membershipYear: simResult.membershipYear.label,
    finalCost,
    currency: simResult.currency || 'GBP',
    tierLabel: simResult.tierLabel,
    costBreakdown: costBreakdownFromSimulation(simResult),
    recipientEmails: [simResult.member?.email].filter(Boolean),
    tierConfig: simResult.config,
    stripeEnabled: !!simResult.config?.online_card_payment,
  };
}

/**
 * Classify one already-selected member. No writes happen here.
 */
export async function classifyMemberFee(member, {
  tenantId,
  targetYear = null,
  simulate,
  resolveApproval,
  loadHistory,
  loadTokens,
}) {
  const base = {
    cursor: member?.id || member?.email || 'unknown',
    memberId: member?.id || null,
    email: member?.email || null,
    memberName: [member?.first_name, member?.last_name].filter(Boolean).join(' ') || null,
  };
  if (!member) return { ...base, outcome: BATCH_OUTCOMES.MISSING_MEMBER, reason: 'Member was not found in the selected tenant' };
  if (member.tenant_id !== tenantId) return { ...base, outcome: BATCH_OUTCOMES.TENANT_MISMATCH, reason: 'Member belongs to a different tenant' };

  let simResult;
  try {
    simResult = await simulate(tenantId, member.id, {
      source: 'bulk-imported-fees',
      mode: 'manual',
      targetYear,
    });
  } catch (error) {
    return { ...base, ...classifySimulationFailure(error.message), reason: error.message };
  }
  if (!simResult?.success) {
    return { ...base, ...classifySimulationFailure(simResult?.error), reason: simResult?.error };
  }
  const membershipYear = simResult.membershipYear?.label;
  if (!membershipYear || (targetYear && membershipYear !== targetYear)) {
    return {
      ...base,
      outcome: BATCH_OUTCOMES.INVALID_DATE_CONFIG,
      reason: targetYear
        ? `Requested membership year ${targetYear} is not the resolved year`
        : 'Simulation did not resolve a membership year',
    };
  }

  let historyRows;
  try {
    historyRows = await loadHistory(tenantId, member.id, membershipYear);
  } catch (error) {
    return { ...base, membershipYear, outcome: BATCH_OUTCOMES.ERROR, reason: `Could not read membership history: ${error.message}` };
  }
  if ((historyRows || []).length > 1) {
    return { ...base, membershipYear, outcome: BATCH_OUTCOMES.ERROR, reason: 'Duplicate membership history rows exist for this member and year' };
  }
  if ((historyRows || []).length === 1 || simResult.existingRecord) {
    return { ...base, membershipYear, outcome: BATCH_OUTCOMES.ALREADY_RECORDED, reason: 'Membership history already exists for this year' };
  }
  if (!String(member.email || '').trim()) {
    return { ...base, membershipYear, outcome: BATCH_OUTCOMES.MISSING_EMAIL, reason: 'Member has no email address' };
  }

  let approval;
  try {
    approval = await resolveApproval({ tenantId, memberId: member.id, membershipYear });
  } catch (error) {
    return { ...base, membershipYear, outcome: BATCH_OUTCOMES.ERROR, reason: `Could not read fee approval: ${error.message}` };
  }

  let tokenInfo;
  try {
    tokenInfo = tokenDecision(await loadTokens(tenantId, member.id, membershipYear));
  } catch (error) {
    return { ...base, membershipYear, outcome: BATCH_OUTCOMES.ERROR, reason: `Could not read fee tokens: ${error.message}` };
  }
  if (tokenInfo.outcome) return { ...base, membershipYear, ...tokenInfo };

  return {
    ...base,
    membershipYear,
    outcome: approval?.required && approval?.approved
      ? BATCH_OUTCOMES.ALREADY_APPROVED
      : BATCH_OUTCOMES.ELIGIBLE,
    approvalRequired: !!approval?.required,
    approved: !!approval?.approved,
    tokenStatus: tokenInfo.tokenStatus,
    finalCost: simResult.finalCost,
    currency: simResult.currency || 'GBP',
    tierLabel: simResult.tierLabel || null,
    configId: simResult.config?.id || null,
    simulation: simResult,
  };
}

export async function processMemberFee(row, {
  tenantId,
  client,
  setApproval,
  sendEmail,
  loadHistory,
  loadTokens,
  recordNote = async () => {},
}) {
  if (!PROCESSABLE_OUTCOMES.has(row.outcome)) return { ...row, action: 'not_processed' };
  const historyRows = await loadHistory(tenantId, row.memberId, row.membershipYear);
  if ((historyRows || []).length > 0) {
    return { ...row, action: 'skipped_replay', outcome: BATCH_OUTCOMES.ALREADY_RECORDED, reason: 'Membership history appeared before apply' };
  }
  const tokenInfo = tokenDecision(await loadTokens(tenantId, row.memberId, row.membershipYear));
  if (tokenInfo.outcome) return { ...row, action: 'skipped_replay', ...tokenInfo };

  if (row.approvalRequired) {
    await setApproval({
      client,
      tenantId,
      memberId: row.memberId,
      membershipYear: row.membershipYear,
      approved: true,
    });
  }
  const emailResult = await sendEmail(buildMemberFeeEmailPayload(row.simulation, { tenantId, memberId: row.memberId }));
  if (!emailResult?.success) throw new Error(emailResult?.error || 'Fee email failed');
  await recordNote({
    tenantId,
    memberId: row.memberId,
    membershipYear: row.membershipYear,
    email: String(row.email).trim().toLowerCase(),
    finalCost: row.finalCost,
  });
  return {
    ...row,
    action: 'applied',
    outcome: BATCH_OUTCOMES.ELIGIBLE,
    emailed: true,
    sentTo: emailResult.sentTo || [String(row.email).trim().toLowerCase()],
    tokenStatus: tokenInfo.tokenStatus,
  };
}

export async function processMemberFeeRows(rows, dependencies) {
  const results = [];
  for (const row of rows || []) {
    if (!PROCESSABLE_OUTCOMES.has(row.outcome)) continue;
    try {
      results.push(await processMemberFee(row, dependencies));
    } catch (error) {
      results.push({
        ...row,
        action: 'error',
        outcome: BATCH_OUTCOMES.ERROR,
        reason: error.message,
      });
    }
  }
  return results;
}

export async function executeMemberFeeBatch(rows, { apply = false, ...dependencies } = {}) {
  if (!apply) return [];
  return processMemberFeeRows(rows, dependencies);
}