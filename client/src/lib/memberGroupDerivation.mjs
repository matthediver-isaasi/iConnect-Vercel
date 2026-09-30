/**
 * Derive the effective group for a member detail Group card.
 * Pure function — no React or DOM dependency — safe to unit-test directly.
 *
 * Design contract
 * ───────────────
 * • When an organisation IS selected in formData (`formOrgId` is truthy):
 *   - hasOrg = true
 *   - derivedGroupId = the org's own organization_group_id (looked up from
 *     the loaded organizations list). Null when the org has no group or is
 *     not yet in the list.
 *   - The manual formGroupId / memberGroupId is IGNORED.
 *
 * • When no organisation is selected in formData (`formOrgId` is falsy):
 *   - hasOrg = false
 *   - derivedGroupId = formGroupId when editing (in-progress selection),
 *     memberGroupId when viewing (persisted value).
 *
 * This means the card tracks live edits: clearing the org immediately
 * exposes the manual selector; picking a new org immediately shows that
 * org's group.
 *
 * @param {object}  params
 * @param {string|null|undefined} params.formOrgId     Currently-selected org in formData
 * @param {string|null|undefined} params.formGroupId   Manually-selected group in formData
 * @param {string|null|undefined} params.memberGroupId Persisted member.organization_group_id
 * @param {boolean}              params.isEditing       Whether the form is in edit mode
 * @param {Array<{id: string, organization_group_id?: string|null}>} params.organizations
 *   Loaded organisations list (each item may carry organization_group_id)
 *
 * @returns {{ hasOrg: boolean, derivedGroupId: string|null }}
 */
export function deriveMemberGroup({ formOrgId, formGroupId, memberGroupId, isEditing, organizations }) {
  const hasOrg = !!formOrgId;
  const selectedOrg = hasOrg ? (organizations || []).find(o => o.id === formOrgId) : null;
  const derivedGroupId = hasOrg
    ? (selectedOrg?.organization_group_id || null)
    : (isEditing ? (formGroupId || null) : (memberGroupId || null));
  return { hasOrg, derivedGroupId };
}
