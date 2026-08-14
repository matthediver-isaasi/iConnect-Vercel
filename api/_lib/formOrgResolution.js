// Organisation resolution + write-time tenant guard for the form
// application processor (Task #3550).
//
// Resolution order — first match wins:
//   1. effectivePrefillOrgId (explicit prefill_organization_id, or the
//      organisation_dropdown selection promoted by the caller)
//   2. The organisation_id already stamped on the form_submission row
//   3. The organisation_id of the resolved member (prefill/dropdown member
//      id, or tenant-scoped lookup by email)
//   4. Case-insensitive name match against orgData.name — tenant-scoped
//      (NULL-tenant legacy rows remain matchable).
//
// Every step passes the found row through the caller-supplied
// rejectCrossTenant(row, stage, extra) callback, which returns true when the
// row belongs to ANOTHER tenant (and records a processing note). A rejected
// row is treated as "not found" so the create path runs in the submitting
// tenant instead.
//
// Dependency-free (supabase client injected) so it can be unit tested with a
// fake client — see formOrgResolution.test.mjs.

export async function resolveExistingOrganization(supabase, {
  effectiveTenantId,
  effectivePrefillOrgId,
  prefillWasExplicit,       // true when prefill_organization_id was supplied by the caller
  usedDropdownSelection,    // true when effectivePrefillOrgId came from the organisation_dropdown
  submissionId,
  memberIdForOrgLookup,     // prefill_member_id || dropdownSelectedMemberId
  memberEmail,
  orgName,
  rejectCrossTenant,
}) {
  let existingOrg = null;
  let orgResolutionMethod = null;

  if (effectivePrefillOrgId) {
    const { data: foundOrg } = await supabase
      .from('organization')
      .select('*')
      .eq('id', effectivePrefillOrgId)
      .maybeSingle();
    if (foundOrg && !rejectCrossTenant(foundOrg, 'organization_resolve', { method: 'prefill_organization_id' })) {
      existingOrg = foundOrg;
      orgResolutionMethod = (usedDropdownSelection && !prefillWasExplicit)
        ? 'organisation_dropdown_selection'
        : 'prefill_organization_id';
    }
  }

  if (!existingOrg && submissionId) {
    const { data: subRow } = await supabase
      .from('form_submission')
      .select('organization_id')
      .eq('id', submissionId)
      .maybeSingle();
    if (subRow?.organization_id) {
      const { data: foundOrg } = await supabase
        .from('organization')
        .select('*')
        .eq('id', subRow.organization_id)
        .maybeSingle();
      if (foundOrg && !rejectCrossTenant(foundOrg, 'organization_resolve', { method: 'form_submission.organization_id' })) {
        existingOrg = foundOrg;
        orgResolutionMethod = 'form_submission.organization_id';
      }
    }
  }

  if (!existingOrg) {
    // Try via the resolved member (prefill/dropdown member id, or by email
    // within tenant).
    let resolvedMember = null;
    if (memberIdForOrgLookup) {
      const { data: m } = await supabase
        .from('member')
        .select('id, organization_id, tenant_id')
        .eq('id', memberIdForOrgLookup)
        .maybeSingle();
      if (m && !rejectCrossTenant(m, 'member_resolve_for_org', { method: 'prefill/dropdown member id' })) {
        resolvedMember = m;
      }
    } else if (memberEmail) {
      let q = supabase
        .from('member')
        .select('id, organization_id, tenant_id')
        .ilike('email', memberEmail);
      if (effectiveTenantId) q = q.eq('tenant_id', effectiveTenantId);
      const { data: m } = await q.limit(1).maybeSingle();
      resolvedMember = m;
    }
    if (resolvedMember?.organization_id) {
      const { data: foundOrg } = await supabase
        .from('organization')
        .select('*')
        .eq('id', resolvedMember.organization_id)
        .maybeSingle();
      if (foundOrg && !rejectCrossTenant(foundOrg, 'organization_resolve', { method: 'resolved_member.organization_id' })) {
        existingOrg = foundOrg;
        orgResolutionMethod = 'resolved_member.organization_id';
      }
    }
  }

  if (!existingOrg && orgName) {
    // Tenant-scope the name match: this lookup used to be completely
    // unscoped, so a name collision with an organisation in ANOTHER tenant
    // would silently link (and suppress creation of) the org. NULL-tenant
    // (legacy) rows remain matchable.
    let nameQuery = supabase
      .from('organization')
      .select('*')
      .ilike('name', orgName);
    if (effectiveTenantId) {
      nameQuery = nameQuery.or(`tenant_id.eq.${effectiveTenantId},tenant_id.is.null`);
    }
    const { data: foundOrg } = await nameQuery.limit(1).maybeSingle();
    if (foundOrg && !rejectCrossTenant(foundOrg, 'organization_resolve', { method: 'org_name_match' })) {
      existingOrg = foundOrg;
      orgResolutionMethod = 'org_name_match';
    }
  }

  return { existingOrg, orgResolutionMethod };
}

/**
 * Write-time tenant guard (defence in depth, Task #3550): constrain an
 * organisation UPDATE so a cross-tenant row can never be mutated even if a
 * bad resolution slipped through (stale bundle, future regression, race).
 *
 * - Row already in a tenant  -> update must match the effective tenant.
 * - NULL-tenant (legacy) row -> update must match tenant_id IS NULL (the
 *   update payload adopts it into the effective tenant).
 * - No effective tenant known -> no extra filter (legacy/pre-tenant forms).
 *
 * NOTE: uses plain .eq()/.is() filters — PostgREST .or() is NOT reliable on
 * UPDATE, do not "simplify" this to a single .or() filter.
 *
 * @returns the same query builder with the tenant filter applied.
 */
export function applyOrgWriteTenantGuard(updateQuery, effectiveTenantId, existingRow) {
  if (!effectiveTenantId) return updateQuery;
  if (existingRow?.tenant_id) return updateQuery.eq('tenant_id', effectiveTenantId);
  return updateQuery.is('tenant_id', null);
}
