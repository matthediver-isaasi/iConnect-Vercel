/**
 * Tenant Context for Multi-Tenant Isolation
 * 
 * This module defines tenant scoping rules and provides helpers
 * for enforcing data isolation between organizations.
 */

import { getSessionMember } from './session.js';

/**
 * Entity tenant scope classifications:
 * - GLOBAL: Shared across all tenants (system-wide data)
 * - TENANT: Per-organization data, must be filtered by organization_id
 * - HYBRID: Template is global, instances are per-tenant
 * - MEMBER: Scoped to member's own data or their organization
 */
export const TENANT_SCOPE = {
  GLOBAL: 'global',
  TENANT: 'tenant',
  HYBRID: 'hybrid',
  MEMBER: 'member',
};

/**
 * Entity to tenant scope mapping
 * 
 * GLOBAL entities are system-wide and accessible to all tenants:
 * - SystemSettings, PreferenceField (definitions), TypographyStyle (defaults)
 * - IEditElementTemplate (template library), RoleAccessItem (capability catalog)
 * 
 * TENANT entities are per-organization:
 * - Members, Events, Bookings, Forms, Resources, etc.
 * 
 * HYBRID entities have global templates but tenant-specific instances:
 * - IEditPage, IEditPageElement (pages are per-tenant, templates are global)
 * 
 * MEMBER entities are scoped to the authenticated member:
 * - MemberPreferenceValue, MemberCommunicationPreference
 */
export const entityTenantScope = {
  // GLOBAL - System-wide, shared across all tenants
  'SystemSettings': TENANT_SCOPE.GLOBAL,
  'PreferenceField': TENANT_SCOPE.GLOBAL,
  'TypographyStyle': TENANT_SCOPE.GLOBAL,
  'IEditElementTemplate': TENANT_SCOPE.GLOBAL,
  'RoleAccessItem': TENANT_SCOPE.GLOBAL,
  'AwardClassification': TENANT_SCOPE.GLOBAL,
  'AwardSublevel': TENANT_SCOPE.GLOBAL,
  'ButtonStyle': TENANT_SCOPE.GLOBAL,
  'TourGroup': TENANT_SCOPE.GLOBAL,
  'TourStep': TENANT_SCOPE.GLOBAL,
  'RedirectMapping': TENANT_SCOPE.GLOBAL,
  
  // TENANT - Per-organization data
  'Organization': TENANT_SCOPE.TENANT,
  'Member': TENANT_SCOPE.TENANT,
  'TeamMember': TENANT_SCOPE.TENANT,
  'OrganizationContact': TENANT_SCOPE.TENANT,
  'Event': TENANT_SCOPE.TENANT,
  'Booking': TENANT_SCOPE.TENANT,
  'Program': TENANT_SCOPE.TENANT,
  'ProgramTicketTransaction': TENANT_SCOPE.TENANT,
  'TrainingFundTransaction': TENANT_SCOPE.TENANT,
  'Voucher': TENANT_SCOPE.TENANT,
  'VoucherTransaction': TENANT_SCOPE.TENANT,
  'DiscountCode': TENANT_SCOPE.TENANT,
  'DiscountCodeUsage': TENANT_SCOPE.TENANT,
  'Form': TENANT_SCOPE.TENANT,
  'FormSubmission': TENANT_SCOPE.TENANT,
  'EmailTemplate': TENANT_SCOPE.TENANT,
  'JobPosting': TENANT_SCOPE.TENANT,
  'Resource': TENANT_SCOPE.TENANT,
  'ResourceCategory': TENANT_SCOPE.TENANT,
  'ResourceFolder': TENANT_SCOPE.TENANT,
  'ResourceAuthorSettings': TENANT_SCOPE.TENANT,
  'FileRepository': TENANT_SCOPE.TENANT,
  'FileRepositoryFolder': TENANT_SCOPE.TENANT,
  'BlogPost': TENANT_SCOPE.TENANT,
  'ArticleCategory': TENANT_SCOPE.TENANT,
  'ArticleComment': TENANT_SCOPE.TENANT,
  'ArticleReaction': TENANT_SCOPE.TENANT,
  'ArticleView': TENANT_SCOPE.TENANT,
  'CommentReaction': TENANT_SCOPE.TENANT,
  'GuestWriter': TENANT_SCOPE.TENANT,
  'NewsPost': TENANT_SCOPE.TENANT,
  'NavigationItem': TENANT_SCOPE.TENANT,
  'PortalNavigationItem': TENANT_SCOPE.TENANT,
  'PortalMenu': TENANT_SCOPE.TENANT,
  'PageBanner': TENANT_SCOPE.TENANT,
  'Floater': TENANT_SCOPE.TENANT,
  'Role': TENANT_SCOPE.TENANT,
  'Award': TENANT_SCOPE.TENANT,
  'OfflineAward': TENANT_SCOPE.TENANT,
  'OfflineAwardAssignment': TENANT_SCOPE.TENANT,
  'EngagementAward': TENANT_SCOPE.TENANT,
  'EngagementAwardAssignment': TENANT_SCOPE.TENANT,
  'OrganisationAward': TENANT_SCOPE.TENANT,
  'OrganisationAwardAssignment': TENANT_SCOPE.TENANT,
  'WallOfFameSection': TENANT_SCOPE.TENANT,
  'WallOfFameCategory': TENANT_SCOPE.TENANT,
  'WallOfFamePerson': TENANT_SCOPE.TENANT,
  'MemberGroup': TENANT_SCOPE.TENANT,
  'MemberGroupAssignment': TENANT_SCOPE.TENANT,
  'MemberGroupGuest': TENANT_SCOPE.TENANT,
  'SupportTicket': TENANT_SCOPE.TENANT,
  'SupportTicketResponse': TENANT_SCOPE.TENANT,
  'Workflow': TENANT_SCOPE.TENANT,
  'WorkflowLog': TENANT_SCOPE.TENANT,
  'Speaker': TENANT_SCOPE.TENANT,
  'CardDeck': TENANT_SCOPE.TENANT,
  'DynamicDirectory': TENANT_SCOPE.TENANT,
  'CommunicationCategory': TENANT_SCOPE.TENANT,
  'CommunicationCategoryRole': TENANT_SCOPE.TENANT,
  'PageVisibility': TENANT_SCOPE.TENANT,
  'OrganizationPreferenceValue': TENANT_SCOPE.TENANT,
  'XeroToken': TENANT_SCOPE.TENANT,
  
  // HYBRID - Pages are per-tenant, but use global templates
  'IEditPage': TENANT_SCOPE.HYBRID,
  'IEditPageElement': TENANT_SCOPE.HYBRID,
  
  // MEMBER - Scoped to the authenticated member
  'MemberPreferenceValue': TENANT_SCOPE.MEMBER,
  'MemberCommunicationPreference': TENANT_SCOPE.MEMBER,
  'MemberCredentials': TENANT_SCOPE.MEMBER,
  
  // Special cases - tokens and auth
  'MagicLink': TENANT_SCOPE.GLOBAL, // Magic links are looked up by token, not tenant
};

/**
 * Get the tenant scope for an entity
 * @param {string} entity - Entity name (PascalCase)
 * @returns {string} - One of TENANT_SCOPE values
 */
export function getEntityTenantScope(entity) {
  return entityTenantScope[entity] || TENANT_SCOPE.TENANT;
}

/**
 * Get tenant context from request
 * Returns the organization_id from the authenticated member's session
 * 
 * @param {Request} req - Express/Vercel request object
 * @returns {Promise<{organizationId: string|null, memberId: string|null, isAuthenticated: boolean}>}
 */
export async function getTenantContext(req) {
  const member = await getSessionMember(req);
  
  if (!member) {
    return {
      organizationId: null,
      memberId: null,
      isAuthenticated: false,
      isSuperAdmin: false,
    };
  }
  
  // TODO: Add super-admin detection based on role or specific flag
  // Super admins can bypass tenant restrictions for platform management
  const isSuperAdmin = false; // Will be implemented later
  
  return {
    organizationId: member.organization_id,
    memberId: member.id,
    isAuthenticated: true,
    isSuperAdmin,
  };
}

/**
 * Get the tenant filter column for an entity
 * Most entities use 'organization_id', but some use different column names
 * 
 * @param {string} entity - Entity name
 * @returns {string} - Column name to filter by
 */
export function getTenantColumn(entity) {
  // Most entities use organization_id
  const customColumns = {
    'Member': 'organization_id',
    'Organization': 'id', // Organization is filtered by its own ID
    'OrganizationPreferenceValue': 'organization_id',
    'MemberPreferenceValue': 'member_id',
    'MemberCommunicationPreference': 'member_id',
    'MemberCredentials': 'member_id',
  };
  
  return customColumns[entity] || 'organization_id';
}

/**
 * Check if an entity requires tenant filtering for read operations
 * Some entities are publicly readable (events, resources) but still tenant-scoped
 * 
 * @param {string} entity - Entity name
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @returns {boolean}
 */
export function requiresTenantFilter(entity, method = 'GET') {
  const scope = getEntityTenantScope(entity);
  
  // Global entities never require tenant filtering
  if (scope === TENANT_SCOPE.GLOBAL) {
    return false;
  }
  
  // For writes (POST, PATCH, DELETE), always require tenant context
  if (method !== 'GET') {
    return true;
  }
  
  // Some entities have public read access but are still tenant-scoped
  // The caller may need to handle these specially (e.g., public events page)
  const publicReadEntities = [
    'Event',
    'BlogPost',
    'NewsPost',
    'Resource',
    'JobPosting',
  ];
  
  // For now, require tenant filter for all tenant-scoped reads
  // Public pages will need to use separate public API endpoints
  return scope === TENANT_SCOPE.TENANT || scope === TENANT_SCOPE.HYBRID || scope === TENANT_SCOPE.MEMBER;
}
