/**
 * Tenant Context for Multi-Tenant Isolation
 * 
 * This module defines tenant scoping rules and provides helpers
 * for enforcing data isolation between tenants.
 * 
 * Multi-tenancy hierarchy:
 * - TENANT: The SaaS subscribing company (top level)
 * - ORGANIZATION: Organizational members within a tenant (member companies)
 * - MEMBER: Individual people associated with organizations
 */

import { getSessionMember, getSessionTenantUser } from './session.js';
import { supabase } from './database.js';

/**
 * Entity tenant scope classifications:
 * - GLOBAL: Shared across all tenants (system-wide data)
 * - TENANT: Per-tenant data, must be filtered by tenant_id
 * - ORGANIZATION: Per-organization data within a tenant (uses organization_id)
 * - MEMBER: Scoped to member's own data
 */
export const TENANT_SCOPE = {
  GLOBAL: 'global',
  TENANT: 'tenant',
  ORGANIZATION: 'organization',
  MEMBER: 'member',
};

/**
 * Entity to tenant scope mapping
 * 
 * GLOBAL entities are system-wide and accessible to all tenants:
 * - SystemSettings, PreferenceField (definitions), TypographyStyle (defaults)
 * - IEditElementTemplate (template library), RoleAccessItem (capability catalog)
 * 
 * TENANT entities are per-tenant (filtered by tenant_id):
 * - Organization, Role, Event, Program, Form, Resource, JobPosting, etc.
 * 
 * ORGANIZATION entities are per-organization within a tenant:
 * - Member, OrganizationContact, Booking (through member), etc.
 * 
 * MEMBER entities are scoped to the authenticated member:
 * - MemberPreferenceValue, MemberCommunicationPreference
 */
export const entityTenantScope = {
  // GLOBAL - System-wide, shared across all tenants
  'Tenant': TENANT_SCOPE.GLOBAL, // Tenants themselves are global (accessed by slug/domain)
  // SystemSettings is TENANT-scoped for proper multi-tenant isolation
  'SystemSettings': TENANT_SCOPE.TENANT,
  'PreferenceField': TENANT_SCOPE.GLOBAL,
  'TypographyStyle': TENANT_SCOPE.GLOBAL,
  'IEditElementTemplate': TENANT_SCOPE.GLOBAL,
  'RoleAccessItem': TENANT_SCOPE.GLOBAL,
  'ButtonStyle': TENANT_SCOPE.GLOBAL,
  'TourGroup': TENANT_SCOPE.GLOBAL,
  'TourStep': TENANT_SCOPE.GLOBAL,
  'MagicLink': TENANT_SCOPE.GLOBAL, // Magic links are looked up by token, not tenant
  
  // TENANT - Per-tenant data (filtered by tenant_id)
  'RedirectMapping': TENANT_SCOPE.TENANT,
  
  // TENANT - Per-tenant data (filtered by tenant_id)
  'Organization': TENANT_SCOPE.TENANT,
  'Role': TENANT_SCOPE.TENANT,
  'TeamMember': TENANT_SCOPE.TENANT,
  'Event': TENANT_SCOPE.TENANT,
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
  'NewsPost': TENANT_SCOPE.TENANT,
  'NavigationItem': TENANT_SCOPE.TENANT,
  'PortalNavigationItem': TENANT_SCOPE.TENANT,
  'PortalMenu': TENANT_SCOPE.TENANT,
  'PageBanner': TENANT_SCOPE.TENANT,
  'Floater': TENANT_SCOPE.TENANT,
  'Award': TENANT_SCOPE.TENANT,
  'AwardClassification': TENANT_SCOPE.TENANT,
  'AwardSublevel': TENANT_SCOPE.TENANT,
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
  'XeroToken': TENANT_SCOPE.TENANT,
  'IEditPage': TENANT_SCOPE.TENANT,
  'IEditPageElement': TENANT_SCOPE.TENANT,
  'GuestWriter': TENANT_SCOPE.TENANT,
  'FormDueDiligenceConfig': TENANT_SCOPE.TENANT,
  'FormSubmissionDueDiligence': TENANT_SCOPE.TENANT,
  
  // ORGANIZATION - Per-organization within a tenant (uses organization_id)
  // Note: Member moved to TENANT scope - members can exist with or without an organization
  'Member': TENANT_SCOPE.TENANT,
  'OrganizationContact': TENANT_SCOPE.ORGANIZATION,
  'OrganizationPreferenceValue': TENANT_SCOPE.ORGANIZATION,
  'Booking': TENANT_SCOPE.ORGANIZATION, // Linked through member's organization
  'ArticleComment': TENANT_SCOPE.ORGANIZATION,
  'ArticleReaction': TENANT_SCOPE.ORGANIZATION,
  'ArticleView': TENANT_SCOPE.ORGANIZATION,
  'CommentReaction': TENANT_SCOPE.ORGANIZATION,
  
  // MEMBER - Scoped to the authenticated member
  'MemberPreferenceValue': TENANT_SCOPE.MEMBER,
  'MemberCommunicationPreference': TENANT_SCOPE.MEMBER,
  'MemberCredentials': TENANT_SCOPE.MEMBER,
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
 * Returns the tenant_id, organization_id, and member_id from the authenticated session
 * Also supports hostname-based tenant resolution for unauthenticated requests
 * 
 * @param {Request} req - Express/Vercel request object
 * @returns {Promise<{tenantId: string|null, organizationId: string|null, memberId: string|null, isAuthenticated: boolean, isSuperAdmin: boolean, tenantFromHost: object|null}>}
 */
export async function getTenantContext(req) {
  // Try hostname-based tenant resolution for public access
  let tenantFromHost = null;
  try {
    const { resolveTenantFromRequest } = await import('./tenantResolver.js');
    tenantFromHost = await resolveTenantFromRequest(req);
  } catch (err) {
    // Tenant resolver may not be available in all contexts
  }

  // Check for tenant_user session first (admin dashboard users)
  const tenantUser = await getSessionTenantUser(req);
  if (tenantUser) {
    // Tenant users may also have an associated member identity (for portal access)
    // Check if there's a memberId in the session for MEMBER-scoped entity access
    let associatedMemberId = null;
    let associatedOrganizationId = null;
    
    // Try to get member from session if available (tenant owner accessing portal)
    const member = await getSessionMember(req);
    if (member) {
      associatedMemberId = member.id;
      associatedOrganizationId = member.organization_id;
    }
    
    return {
      tenantId: tenantUser._sessionTenantId || tenantUser.tenant_id,
      organizationId: associatedOrganizationId, // Include if tenant user has member association
      memberId: associatedMemberId, // Include if tenant user has member association
      tenantUserId: tenantUser.id,
      isAuthenticated: true,
      isSuperAdmin: tenantUser.role === 'super_admin',
      tenantFromHost,
    };
  }
  
  // Check for member session (portal users)
  const member = await getSessionMember(req);
  
  if (!member) {
    return {
      tenantId: tenantFromHost?.id || null,
      organizationId: null,
      memberId: null,
      isAuthenticated: false,
      isSuperAdmin: false,
      tenantFromHost,
    };
  }
  
  // Get tenant_id from the member's organization
  let tenantId = null;
  if (member.organization_id && supabase) {
    const { data: org } = await supabase
      .from('organization')
      .select('tenant_id')
      .eq('id', member.organization_id)
      .single();
    
    if (org) {
      tenantId = org.tenant_id;
    }
  }
  
  // If no tenant from session, use hostname-based tenant
  if (!tenantId && tenantFromHost) {
    tenantId = tenantFromHost.id;
  }
  
  // TODO: Add super-admin detection based on role or specific flag
  // Super admins can bypass tenant restrictions for platform management
  const isSuperAdmin = false; // Will be implemented later
  
  return {
    tenantId,
    organizationId: member.organization_id,
    memberId: member.id,
    isAuthenticated: true,
    isSuperAdmin,
    tenantFromHost,
  };
}

/**
 * Get the tenant filter column for an entity based on its scope
 * 
 * @param {string} entity - Entity name
 * @param {string} scope - Tenant scope from getEntityTenantScope
 * @returns {string} - Column name to filter by
 */
export function getTenantColumn(entity, scope) {
  if (scope === TENANT_SCOPE.MEMBER) {
    return 'member_id';
  }
  if (scope === TENANT_SCOPE.ORGANIZATION) {
    return 'organization_id';
  }
  // TENANT scope uses tenant_id
  return 'tenant_id';
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
  return scope === TENANT_SCOPE.TENANT || scope === TENANT_SCOPE.ORGANIZATION || scope === TENANT_SCOPE.MEMBER;
}
