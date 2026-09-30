import { hasAdminAccess } from './tenantContext.js';
import {
  OpportunityHttpError, principalFromContext, opportunityPermissions,
} from './opportunityRules.js';

export function actorFields(principal, prefix) {
  return { [`${prefix}_kind`]: principal.kind, [`${prefix}_id`]: principal.id };
}

export async function one(query, notFound = 'Record not found') {
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new OpportunityHttpError(404, notFound);
  return data;
}

export async function validatePrincipal(db, tenantId, principal) {
  const table = principal?.kind === 'member' ? 'member'
    : principal?.kind === 'tenant_user' ? 'tenant_user' : null;
  if (!table || !principal.id) throw new OpportunityHttpError(400, 'Invalid principal');
  await one(db.from(table).select('id').eq('tenant_id', tenantId).eq('id', principal.id),
    'Principal not found in tenant');
}

export async function validateTenantRecord(db, table, tenantId, id, label) {
  if (!id) throw new OpportunityHttpError(400, `${label} is required`);
  return one(db.from(table).select('*').eq('tenant_id', tenantId).eq('id', id),
    `${label} not found in tenant`);
}

export async function loadOpportunityAccess(db, context, id, adminAccess = hasAdminAccess) {
  const principal = principalFromContext(context);
  const opportunity = await one(
    db.from('opportunity').select('*').eq('tenant_id', context.tenantId).eq('id', id),
    'Opportunity not found',
  );
  const { data: collaborators, error } = await db.from('opportunity_collaborator')
    .select('*').eq('tenant_id', context.tenantId).eq('opportunity_id', id);
  if (error) throw error;
  const permissions = opportunityPermissions(
    opportunity, principal, collaborators || [], await adminAccess(context),
  );
  if (!permissions.canView) throw new OpportunityHttpError(404, 'Opportunity not found');
  return { opportunity, collaborators: collaborators || [], permissions, principal };
}

export async function appendActivity(db, opportunity, principal, action, summary, metadata = {}, links = {}) {
  const row = {
    tenant_id: opportunity.tenant_id,
    opportunity_id: opportunity.id,
    organization_id: opportunity.organization_id,
    member_id: links.memberId || null,
    event_id: links.eventId || null,
    actor_kind: principal.kind,
    actor_id: principal.id,
    action,
    summary,
    metadata,
  };
  const { error } = await db.from('opportunity_activity').insert(row);
  if (error) throw error;
}

export async function enrichOpportunities(db, tenantId, opportunities) {
  if (!opportunities?.length) return opportunities || [];
  const ids = opportunities.map((item) => item.id);
  const orgIds = [...new Set(opportunities.map((item) => item.organization_id))];
  const stageIds = [...new Set(opportunities.map((item) => item.stage_id))];
  const memberOwnerIds = [...new Set(opportunities.filter((item) => item.owner_kind === 'member').map((item) => item.owner_id))];
  const userOwnerIds = [...new Set(opportunities.filter((item) => item.owner_kind === 'tenant_user').map((item) => item.owner_id))];
  const [orgResult, stageResult, memberResult, userResult, contactResult] = await Promise.all([
    db.from('organization').select('id,name').eq('tenant_id', tenantId).in('id', orgIds),
    db.from('opportunity_stage').select('id,name,color,probability,is_won,is_lost').eq('tenant_id', tenantId).in('id', stageIds),
    memberOwnerIds.length ? db.from('member').select('id,first_name,last_name,email').eq('tenant_id', tenantId).in('id', memberOwnerIds) : Promise.resolve({ data: [], error: null }),
    userOwnerIds.length ? db.from('tenant_user').select('id,name,email').eq('tenant_id', tenantId).in('id', userOwnerIds) : Promise.resolve({ data: [], error: null }),
    db.from('opportunity_contact_role').select('opportunity_id,member_id,role,is_primary')
      .eq('tenant_id', tenantId).in('opportunity_id', ids).eq('is_primary', true),
  ]);
  for (const result of [orgResult, stageResult, memberResult, userResult, contactResult]) {
    if (result.error) throw result.error;
  }
  const contactIds = [...new Set((contactResult.data || []).map((item) => item.member_id))];
  const contactResultMembers = contactIds.length
    ? await db.from('member').select('id,first_name,last_name,email').eq('tenant_id', tenantId).in('id', contactIds)
    : { data: [], error: null };
  if (contactResultMembers.error) throw contactResultMembers.error;
  const mapById = (rows) => new Map((rows || []).map((item) => [item.id, item]));
  const organisations = mapById(orgResult.data);
  const stages = mapById(stageResult.data);
  const members = mapById(memberResult.data);
  const users = mapById(userResult.data);
  const contacts = mapById(contactResultMembers.data);
  const primaryByOpportunity = new Map((contactResult.data || []).map((item) => [item.opportunity_id, item]));
  const memberDisplay = (member) => member && {
    id: member.id, name: [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email,
    email: member.email,
  };
  return opportunities.map((opportunity) => {
    const owner = opportunity.owner_kind === 'member'
      ? memberDisplay(members.get(opportunity.owner_id))
      : (users.get(opportunity.owner_id) && { id: opportunity.owner_id,
        name: users.get(opportunity.owner_id).name || users.get(opportunity.owner_id).email,
        email: users.get(opportunity.owner_id).email });
    const contactRole = primaryByOpportunity.get(opportunity.id);
    return {
      ...opportunity,
      organization: organisations.get(opportunity.organization_id) || null,
      stage: stages.get(opportunity.stage_id) || null,
      owner: owner ? { ...owner, kind: opportunity.owner_kind } : null,
      primaryContact: contactRole ? { ...memberDisplay(contacts.get(contactRole.member_id)), role: contactRole.role } : null,
    };
  });
}

export function sendOpportunityError(res, error, fallback) {
  const status = error instanceof OpportunityHttpError ? error.status
    : ['23505', '23514', 'P0001'].includes(error?.code) ? 409 : 500;
  return res.status(status).json({
    error: status === 500 ? fallback : error.message,
    ...(error.code ? { code: error.code } : {}),
  });
}