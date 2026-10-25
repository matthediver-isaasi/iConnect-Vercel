import { filterCommunicationCategoriesForMember } from '../../shared/communicationCategoryMembership.js';
import { jobBoardEligible, jobAlertSettings } from './jobAlerts.js';

export async function loadMemberCommunicationCategoryEligibility(
  database,
  { tenantId, memberId, activeOnly = true },
) {
  let memberQuery = database
    .from('member')
    .select('*')
    .eq('id', memberId)
    .eq('tenant_id', tenantId);

  const { data: member, error: memberError } = await memberQuery.maybeSingle();
  if (memberError) throw memberError;
  if (!member) return null;

  let categoryQuery = database
    .from('communication_category')
    .select('id, name, description, display_order, is_active, is_public, member_enabled, system_key')
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
  let eligibleCategories = filterCommunicationCategoriesForMember(
    allCategories,
    roleAssignments || [],
    member,
  );
  if (eligibleCategories.some(category => category.system_key === 'job_postings')) {
    const settings = await jobAlertSettings(database, tenantId);
    const allowed = settings.enabled && await jobBoardEligible(database, member);
    eligibleCategories = eligibleCategories.filter(category => category.system_key !== 'job_postings' || allowed);
  }
  eligibleCategories.sort((a, b) => Number(a.system_key === 'job_postings') - Number(b.system_key === 'job_postings'));

  return {
    member,
    allCategories,
    eligibleCategories,
    eligibleCategoryIds: new Set(eligibleCategories.map((category) => category.id)),
  };
}