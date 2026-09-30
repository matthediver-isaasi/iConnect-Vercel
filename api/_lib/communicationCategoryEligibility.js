import { filterCommunicationCategoriesForMember } from '../../shared/communicationCategoryMembership.js';

export async function loadMemberCommunicationCategoryEligibility(
  database,
  { tenantId, memberId, activeOnly = true },
) {
  let memberQuery = database
    .from('member')
    .select('id, tenant_id, email, role_id, communications_opted_out_all')
    .eq('id', memberId)
    .eq('tenant_id', tenantId);

  const { data: member, error: memberError } = await memberQuery.maybeSingle();
  if (memberError) throw memberError;
  if (!member) return null;

  let categoryQuery = database
    .from('communication_category')
    .select('id, name, description, display_order, is_active, is_public, member_enabled')
    .eq('tenant_id', tenantId);
  if (activeOnly) categoryQuery = categoryQuery.eq('is_active', true);

  const [
    { data: categories, error: categoryError },
    { data: roleAssignments, error: roleError },
  ] = await Promise.all([
    categoryQuery.order('display_order', { ascending: true }),
    database
      .from('communication_category_role')
      .select('category_id, role_id')
      .eq('tenant_id', tenantId),
  ]);

  if (categoryError) throw categoryError;
  if (roleError) throw roleError;

  const allCategories = categories || [];
  const eligibleCategories = filterCommunicationCategoriesForMember(
    allCategories,
    roleAssignments || [],
    member,
  );

  return {
    member,
    allCategories,
    eligibleCategories,
    eligibleCategoryIds: new Set(eligibleCategories.map((category) => category.id)),
  };
}