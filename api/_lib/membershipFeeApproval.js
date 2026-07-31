// Task #3241 — shared "Auto-approve fees" materialisation.
//
// Tier configs carry an `auto_approve_fees` flag. When it is enabled, fees
// for the config's current membership year should count as approved even
// when no invoicing row exists yet. This helper is the single place that
// (a) decides whether auto-approval applies and (b) materialises it by
// upserting the invoicing row with `fees_approved: true`, so every surface
// (form-application processing, workflow create_membership, admin UI reads)
// agrees afterwards.
//
// Absence of an invoicing row means "not approved" (there is no explicit
// rejected state), so auto-approve simply wins whenever the config says so.

import { supabase } from './database.js';
import { getConfigForMember, getConfigForOrganisation } from './membershipConfigResolver.js';
import { calculateMembershipYearWindow } from './membershipYear.js';

async function upsertApproval(table, matchColumn, tenantId, targetId, yearLabel) {
  const { data: existing, error: selectError } = await supabase
    .from(table)
    .select('id, fees_approved')
    .eq('tenant_id', tenantId)
    .eq(matchColumn, targetId)
    .eq('membership_year', yearLabel)
    .maybeSingle();

  if (selectError) {
    console.error(`[FeeApproval] Error reading ${table} for ${matchColumn}=${targetId}:`, selectError.message);
    return { approved: false, error: selectError };
  }

  if (existing?.fees_approved) {
    return { approved: true };
  }

  let writeError = null;
  if (existing) {
    const { error } = await supabase
      .from(table)
      .update({ fees_approved: true })
      .eq('id', existing.id);
    writeError = error;
  } else {
    const { error } = await supabase
      .from(table)
      .insert({
        tenant_id: tenantId,
        [matchColumn]: targetId,
        membership_year: yearLabel,
        fees_approved: true,
        // 'automatic' (the resolver's fallback), NOT 'manual': approval must
        // never change the effective invoicing mode, or auto-approval
        // deadlocks the Create Membership workflow action (Task #3244).
        // (organisation_membership_invoicing.invoicing_mode is NOT NULL, so
        // an explicit value is required.)
        invoicing_mode: 'automatic',
      });
    writeError = error;
  }

  if (writeError) {
    console.error(`[FeeApproval] Failed to auto-approve fees on ${table} for ${matchColumn}=${targetId}:`, writeError.message);
    return { approved: false, error: writeError };
  }

  console.log(`[FeeApproval] Auto-approved membership fees on ${table} for ${matchColumn}=${targetId}, year ${yearLabel}`);
  return { approved: true };
}

// Materialise auto-approval for a member covered by a member-scoped config.
// options.config / options.yearLabel let callers that already resolved them
// (e.g. the workflow path, which has the simulation result) skip re-resolution.
// Returns { applies, approved, yearLabel } — `applies` is whether the config
// has auto_approve_fees; `approved` is whether the invoicing row now says so.
export async function autoApproveMemberFees(tenantId, memberId, options = {}) {
  let config = options.config;
  if (config === undefined) {
    config = await getConfigForMember(tenantId, memberId);
  }
  if (!config || config.structure_scope_type !== 'member' || !config.auto_approve_fees) {
    return { applies: false, approved: false, yearLabel: null };
  }
  const yearLabel = options.yearLabel || calculateMembershipYearWindow(config).label;
  const result = await upsertApproval('member_membership_invoicing', 'member_id', tenantId, memberId, yearLabel);
  return { applies: true, approved: result.approved, yearLabel };
}

// Same for an organisation-scoped config.
export async function autoApproveOrgFees(tenantId, organizationId, options = {}) {
  let config = options.config;
  if (config === undefined) {
    config = await getConfigForOrganisation(tenantId, organizationId);
  }
  if (!config || !config.auto_approve_fees) {
    return { applies: false, approved: false, yearLabel: null };
  }
  const yearLabel = options.yearLabel || calculateMembershipYearWindow(config).label;
  const result = await upsertApproval('organisation_membership_invoicing', 'organization_id', tenantId, organizationId, yearLabel);
  return { applies: true, approved: result.approved, yearLabel };
}
