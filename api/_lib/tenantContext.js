/**
 * Tenant Context for Multi-Tenant Isolation
 * 
 * This module defines tenant scoping rules and provides helpers
 * for enforcing data isolation between tenants.
 * 
 * IMPORTANT: Data Scoping Rules
 * =============================
 * All application data MUST be scoped to tenant_id unless it is platform-level
 * data that applies to all tenants (GLOBAL scope).
 * 
 * - Use tenant_id for data isolation, NOT organization_id
 * - organization_id is ONLY for sub-filtering within a tenant (e.g., org-specific contacts)
 * - Data without proper tenant_id scoping will leak across tenants
 * 
 * Multi-tenancy hierarchy:
 * - TENANT: The SaaS subscribing company (top level) - ALL data must be scoped here
 * - ORGANIZATION: Sub-entities within a tenant (member companies) - NOT for primary isolation
 * - MEMBER: Individual people associated with organizations
 */

import { getSessionMember, getSessionTenantUser } from './session.js';
import { supabase } from './database.js';
import { isResourceExcluded } from './roleVisibility.js';

/**
 * Entity tenant scope classifications:
 * - GLOBAL: Platform-level data shared across all tenants (system defaults, templates)
 * - TENANT: Per-tenant data, MUST be filtered by tenant_id (this is the default and correct scope)
 * - ORGANIZATION: Sub-filtering within a tenant by organization_id (NOT for primary isolation)
 * - MEMBER: Scoped to member's own data within their tenant
 * 
 * IMPORTANT: organization_id scoping is DEPRECATED for primary data isolation.
 * All new entities should use TENANT scope with tenant_id filtering.
 * ORGANIZATION scope should only be used for data that genuinely needs
 * sub-filtering by organization within a tenant (e.g., org contacts, org preferences).
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
 * GLOBAL entities are platform-level data accessible to all tenants:
 * - TypographyStyle (defaults), IEditElementTemplate (template library)
 * - RoleAccessItem (capability catalog), ButtonStyle (styling defaults)
 * 
 * TENANT entities are per-tenant (filtered by tenant_id) - THIS IS THE DEFAULT:
 * - Organization, Role, Event, Program, Form, FormSubmission, Resource, JobPosting, etc.
 * - ALL business data should be TENANT-scoped for proper isolation
 * 
 * ORGANIZATION entities are for sub-filtering within a tenant (NOT primary isolation):
 * - OrganizationContact, OrganizationPreferenceValue (org-specific data only)
 * - NOTE: Do NOT use ORGANIZATION scope for new entities - use TENANT scope instead
 * 
 * MEMBER entities are scoped to the authenticated member's own data:
 * - MemberPreferenceValue, MemberCommunicationPreference
 */
export const entityTenantScope = {
  // GLOBAL - System-wide, shared across all tenants
  'Tenant': TENANT_SCOPE.GLOBAL, // Tenants themselves are global (accessed by slug/domain)
  // SystemSettings is TENANT-scoped for proper multi-tenant isolation
  'SystemSettings': TENANT_SCOPE.TENANT,
  'PreferenceField': TENANT_SCOPE.TENANT, // Custom field definitions are per-tenant
  'TypographyStyle': TENANT_SCOPE.GLOBAL,
  'IEditElementTemplate': TENANT_SCOPE.GLOBAL,
  'RoleAccessItem': TENANT_SCOPE.GLOBAL,
  'MagicLink': TENANT_SCOPE.GLOBAL, // Magic links are looked up by token, not tenant
  
  // TENANT - Button styles are per-tenant for custom branding
  'ButtonStyle': TENANT_SCOPE.TENANT,
  
  // TENANT - Tour configuration is per-tenant
  'TourGroup': TENANT_SCOPE.TENANT,
  'TourStep': TENANT_SCOPE.TENANT,
  
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
  
  // CONTRACT SIGNING - Contract documents with signature requirements
  'ContractDocument': TENANT_SCOPE.TENANT,
  'ContractSigner': TENANT_SCOPE.TENANT,
  'ContractReminder': TENANT_SCOPE.TENANT,
  
  // ORGANIZATION - Per-organization within a tenant (uses organization_id)
  // Note: Member moved to TENANT scope - members can exist with or without an organization
  'Member': TENANT_SCOPE.TENANT,
  'OrganizationContact': TENANT_SCOPE.ORGANIZATION,
  'OrganizationPreferenceValue': TENANT_SCOPE.ORGANIZATION,
  'Booking': TENANT_SCOPE.ORGANIZATION, // Linked through member's organization
  'ArticleComment': TENANT_SCOPE.TENANT,
  'ArticleReaction': TENANT_SCOPE.TENANT,
  'ArticleView': TENANT_SCOPE.TENANT,
  'CommentReaction': TENANT_SCOPE.TENANT,
  
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
  console.log('[TenantContext] About to call getSessionTenantUser');
  const tenantUser = await getSessionTenantUser(req);
  console.log('[TenantContext] getSessionTenantUser returned:', tenantUser ? 'tenant_user found' : 'null');
  if (tenantUser) {
    // Tenant users may also have an associated member identity (for portal access)
    // Check if there's a memberId in the session for MEMBER-scoped entity access
    let associatedMemberId = null;
    let associatedOrganizationId = null;
    let associatedRoleId = null;
    
    // Try to get member from session if available (tenant owner accessing portal)
    const member = await getSessionMember(req);
    if (member) {
      associatedMemberId = member.id;
      associatedOrganizationId = member.organization_id;
      associatedRoleId = member.role_id;
    }
    
    return {
      tenantId: tenantUser._sessionTenantId || tenantUser.tenant_id,
      organizationId: associatedOrganizationId, // Include if tenant user has member association
      memberId: associatedMemberId, // Include if tenant user has member association
      roleId: associatedRoleId, // Include role_id for permission checks
      tenantUserId: tenantUser.id,
      isAuthenticated: true,
      isSuperAdmin: tenantUser.role === 'super_admin',
      tenantFromHost,
    };
  }
  
  // Check for member session (portal users)
  console.log('[TenantContext] Checking for member session...');
  const member = await getSessionMember(req);
  
  if (!member) {
    console.log('[TenantContext] No member found, returning unauthenticated context');
    return {
      tenantId: tenantFromHost?.id || null,
      organizationId: null,
      memberId: null,
      isAuthenticated: false,
      isSuperAdmin: false,
      tenantFromHost,
    };
  }
  
  console.log('[TenantContext] Member found:', { memberId: member.id, organizationId: member.organization_id });
  
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
    console.log('[TenantContext] Tenant from organization:', tenantId);
  }
  
  // If no tenant from session, use hostname-based tenant
  if (!tenantId && tenantFromHost) {
    tenantId = tenantFromHost.id;
    console.log('[TenantContext] Using tenant from host:', tenantId);
  }
  
  // TODO: Add super-admin detection based on role or specific flag
  // Super admins can bypass tenant restrictions for platform management
  const isSuperAdmin = false; // Will be implemented later
  
  return {
    tenantId,
    organizationId: member.organization_id,
    memberId: member.id,
    roleId: member.role_id, // Include role_id for permission checks
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

/**
 * Check if a member has cross-organization CRM access based on their role
 * Cross-org access allows editing organization-scoped data for any organization within the tenant
 * 
 * This is a targeted permission for organization management, NOT member editing.
 * admin_can_edit_members only grants member-level operations, not cross-org data access.
 * 
 * @param {string|null} roleId - The member's role_id
 * @returns {Promise<{hasCrossOrgAccess: boolean, isAdmin: boolean}>}
 */
export async function checkCrossOrgPermissions(roleId) {
  if (!roleId || !supabase) {
    return { hasCrossOrgAccess: false, isAdmin: false };
  }
  
  try {
    const { data: role, error } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', roleId)
      .single();
    
    if (error || !role) {
      return { hasCrossOrgAccess: false, isAdmin: false };
    }
    
    const excludedFeatures = role.excluded_features || [];
    
    // Admin access: role-management is NOT excluded (Super Admin or equivalent)
    const isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');
    
    // Cross-org access: can access organization management page
    // NOTE: admin_can_edit_members is for member-level operations only, NOT cross-org access
    const canAccessOrganizations = !isResourceExcluded(excludedFeatures, 'admin.organizations');
    
    // Has cross-org access only if admin OR can access organization management
    const hasCrossOrgAccess = isAdmin || canAccessOrganizations;
    
    return { hasCrossOrgAccess, isAdmin };
  } catch (err) {
    console.error('Error checking cross-org permissions:', err);
    return { hasCrossOrgAccess: false, isAdmin: false };
  }
}
