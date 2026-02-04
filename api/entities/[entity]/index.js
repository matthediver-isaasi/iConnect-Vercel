import { sendEmail } from '../../_lib/emailService.js';
import { triggerWorkflows, triggerPreferenceWorkflows } from '../../_lib/workflows.js';
import { supabase } from '../../_lib/database.js';
import { getTenantContext, getEntityTenantScope, getTenantColumn, TENANT_SCOPE, checkCrossOrgPermissions } from '../../_lib/tenantContext.js';

// Send email on form submission if configured
async function sendFormSubmissionEmail(submissionData) {
  if (!supabase) return;
  
  try {
    const formId = submissionData.form_id;
    if (!formId) return;

    // Fetch the form to check if it has email template configured
    const { data: form } = await supabase
      .from('form')
      .select('submission_email_template_id, submission_email_recipient, fields, tenant_id')
      .eq('id', formId)
      .single();

    if (!form || !form.submission_email_template_id) return;
    
    const formTenantId = form.tenant_id;

    // Fetch the email template
    const { data: template } = await supabase
      .from('email_template')
      .select('*')
      .eq('id', form.submission_email_template_id)
      .single();

    if (!template || template.is_active === false) {
      console.log('[FormSubmission] Email template not found or inactive');
      return;
    }

    // Determine recipient
    let recipient = form.submission_email_recipient || '';
    const formValues = submissionData.form_values || {};
    
    // Replace {{field_id}} placeholders with form values
    recipient = recipient.replace(/\{\{(\w+)\}\}/g, (_, fieldId) => {
      return formValues[fieldId] || '';
    });

    if (!recipient || !recipient.includes('@')) {
      console.log('[FormSubmission] No valid recipient configured');
      return;
    }

    // Replace placeholders in subject and body with form values
    let subject = template.subject || 'Form Submission';
    let body = template.body || '';

    // Replace form field placeholders
    for (const [fieldId, value] of Object.entries(formValues)) {
      const placeholder = new RegExp(`\\{\\{form\\.${fieldId}\\}\\}`, 'gi');
      subject = subject.replace(placeholder, String(value || ''));
      body = body.replace(placeholder, String(value || ''));
    }

    // Also support simple {{field_id}} format for form values
    subject = subject.replace(/\{\{(\w+)\}\}/g, (_, fieldId) => {
      return String(formValues[fieldId] || '');
    });
    body = body.replace(/\{\{(\w+)\}\}/g, (_, fieldId) => {
      return String(formValues[fieldId] || '');
    });

    // Send the email with tenant context for proper email domain
    const result = await sendEmail({
      to: recipient,
      subject: subject,
      html: body,
      from: template.from_email,
      replyTo: template.reply_to,
      tenantId: formTenantId
    });

    console.log(`[FormSubmission] Email sent to ${recipient}:`, result.success ? 'success' : result.error);
  } catch (err) {
    console.error('[FormSubmission] Email error:', err.message);
  }
}

// Entity name to Supabase table mapping (singular names for Base44 compatibility)
const entityToTable = {
  'Tenant': 'tenant',
  'Member': 'member',
  'Organization': 'organization',
  'Event': 'event',
  'Booking': 'booking',
  'ProgramTicketTransaction': 'program_ticket_transaction',
  'MagicLink': 'magic_link',
  'OrganizationContact': 'organization_contact',
  'Program': 'program',
  'Voucher': 'voucher',
  'XeroToken': 'xero_token',
  'BlogPost': 'blog_post',
  'Role': 'role',
  'TeamMember': 'team_member',
  'DiscountCode': 'discount_code',
  'DiscountCodeUsage': 'discount_code_usage',
  'SystemSettings': 'system_settings',
  'TourGroup': 'tour_group',
  'TourStep': 'tour_step',
  'Resource': 'resource',
  'ResourceCategory': 'resource_category',
  'FileRepository': 'file_repository',
  'ResourceAuthorSettings': 'resource_author_settings',
  'JobPosting': 'job_posting',
  'PageBanner': 'page_banner',
  'IEditPage': 'i_edit_page',
  'IEditPageElement': 'i_edit_page_element',
  'IEditElementTemplate': 'i_edit_element_template',
  'ResourceFolder': 'resource_folder',
  'FileRepositoryFolder': 'file_repository_folder',
  'NavigationItem': 'navigation_item',
  'ArticleCategory': 'article_category',
  'ArticleComment': 'article_comment',
  'CommentReaction': 'comment_reaction',
  'ArticleReaction': 'article_reaction',
  'ArticleView': 'article_view',
  'ButtonStyle': 'button_style',
  'Award': 'award',
  'OfflineAward': 'offline_award',
  'OfflineAwardAssignment': 'offline_award_assignment',
  'EngagementAward': 'engagement_award',
  'EngagementAwardAssignment': 'engagement_award_assignment',
  'OrganisationAward': 'organisation_award',
  'OrganisationAwardAssignment': 'organisation_award_assignment',
  'WallOfFameSection': 'wall_of_fame_section',
  'WallOfFameCategory': 'wall_of_fame_category',
  'WallOfFamePerson': 'wall_of_fame_person',
  'Floater': 'floater',
  'Form': 'form',
  'EmailTemplate': 'email_template',
  'FormSubmission': 'form_submission',
  'NewsPost': 'news_post',
  'SupportTicket': 'support_ticket',
  'SupportTicketResponse': 'support_ticket_response',
  'PortalNavigationItem': 'portal_navigation_item',
  'MemberGroup': 'member_group',
  'MemberGroupAssignment': 'member_group_assignment',
  'GuestWriter': 'guest_writer',
  'PortalMenu': 'portal_menu',
  'AwardClassification': 'award_classification',
  'AwardSublevel': 'award_sublevel',
  'MemberGroupGuest': 'member_group_guest',
  'MemberCredentials': 'member_credentials',
  'PageVisibility': 'page_visibility',
  'CommunicationCategory': 'communication_category',
  'CommunicationCategoryRole': 'communication_category_role',
  'MemberCommunicationPreference': 'member_communication_preference',
  'PreferenceField': 'preference_field',
  'MemberPreferenceValue': 'member_preference_value',
  'OrganizationPreferenceValue': 'organization_preference_value',
  'Speaker': 'speaker',
  'TypographyStyle': 'typography_style',
  'CardDeck': 'card_deck',
  'DynamicDirectory': 'dynamic_directory',
  'TrainingFundTransaction': 'training_fund_transaction',
  'VoucherTransaction': 'voucher_transaction',
  'Workflow': 'workflow',
  'WorkflowLog': 'workflow_log',
  'RoleAccessItem': 'role_access_item',
  'RedirectMapping': 'redirect_mapping',
  'FormDueDiligenceConfig': 'form_due_diligence_config',
  'FormSubmissionDueDiligence': 'form_submission_due_diligence',
  'ContractDocument': 'contract_document',
  'ContractSigner': 'contract_signer',
  'ContractReminder': 'contract_reminder',
  'EmailCampaign': 'email_campaign',
  'EmailCampaignRecipient': 'email_campaign_recipient',
  'EmailLinkClick': 'email_link_click',
  'EmailEvent': 'email_event',
  'EmailUnsubscribe': 'email_unsubscribe',
};

const getTableName = (entity) => entityToTable[entity] || entity.toLowerCase().replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');

// Check if a member is deleted (anonymized) based on email pattern
const isDeletedMember = (member) => {
  if (!member || !member.email) return false;
  return /^deleted_[a-f0-9-]+@deleted\.local$/i.test(member.email);
};

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const { entity } = req.query;
  const tableName = getTableName(entity);
  const entityNorm = entity.replace(/[-_]/g, '').toLowerCase();

  // Get tenant context from session
  const tenantCtx = await getTenantContext(req);
  const tenantScope = getEntityTenantScope(entity);
  
  // Determine if tenant filtering should be applied
  // GLOBAL entities are accessible without authentication
  // TENANT/ORGANIZATION/MEMBER entities require authentication and scoping
  const shouldApplyTenantFilter = tenantScope !== TENANT_SCOPE.GLOBAL;
  
  // For non-global entities, require authentication and valid tenant context
  // Tenant users (admins) can access tenant-scoped AND organization-scoped entities via tenantId
  const isTenantAdmin = !!tenantCtx.tenantUserId;
  
  if (shouldApplyTenantFilter) {
    if (!tenantCtx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // For tenant-scoped entities, require a valid tenant_id OR organization_id OR tenant admin status
    // Note: tenantId may be null during migration period while tenant_id columns are backfilled
    // For now, fall back to organization_id filtering if tenant_id is not available
    // Tenant admins can access if authenticated even without explicit tenantId (will be resolved below)
    if (tenantScope === TENANT_SCOPE.TENANT && !tenantCtx.tenantId && !tenantCtx.organizationId && !isTenantAdmin) {
      return res.status(403).json({ error: 'Member must belong to an organization to access this resource' });
    }
    // For organization-scoped entities, require a valid organization_id OR tenant admin with tenantId
    // Exceptions that allow tenant-wide access:
    // - OrganizationPreferenceValue: for viewing org details on the /organisations page
    // - Booking with event_id filter: for viewing all event attendees (access controlled by RBAC button visibility)
    let allowsTenantWideAccess = entity === 'OrganizationPreferenceValue' && tenantCtx.tenantId;
    
    // Resolve tenantId from organization if not present (for migration period)
    // Do this once, outside of entity-specific logic
    let effectiveTenantId = tenantCtx.tenantId;
    if (!effectiveTenantId && tenantCtx.organizationId) {
      const { data: org } = await supabase
        .from('organization')
        .select('tenant_id')
        .eq('id', tenantCtx.organizationId)
        .single();
      if (org?.tenant_id) {
        effectiveTenantId = org.tenant_id;
        console.log('[Entity Access] Resolved tenant_id from organization:', effectiveTenantId);
      }
    }
    // Store for use in query logic
    tenantCtx.effectiveTenantId = effectiveTenantId;
    
    // Pre-parse filter for access checks (will reuse later for query filtering)
    let parsedFilter = null;
    const filter = req.query?.filter;
    if (filter) {
      if (typeof filter === 'string') {
        try {
          parsedFilter = JSON.parse(filter);
        } catch (e) {
          // Not valid JSON, skip
        }
      } else if (typeof filter === 'object') {
        parsedFilter = filter;
      }
    }
    // Store for reuse in query logic
    tenantCtx.parsedFilter = parsedFilter;
    
    // Check if this is a Booking query with event_id filter
    if (entity === 'Booking' && effectiveTenantId && parsedFilter?.event_id) {
      const eventIdFilter = parsedFilter.event_id;
      // Accept any truthy event_id value: string, object with eq/in, or array
      if (typeof eventIdFilter === 'string' || 
          (typeof eventIdFilter === 'object' && eventIdFilter !== null && 
           (eventIdFilter.eq || eventIdFilter.in || Array.isArray(eventIdFilter)))) {
        allowsTenantWideAccess = true;
        console.log('[Entity Access] Booking with event_id filter - allowing cross-org access');
      }
    }
    
    // Store for use in query logic
    tenantCtx.allowsTenantWideAccess = allowsTenantWideAccess;
    
    if (tenantScope === TENANT_SCOPE.ORGANIZATION && !tenantCtx.organizationId && !(isTenantAdmin && tenantCtx.effectiveTenantId) && !allowsTenantWideAccess) {
      return res.status(403).json({ error: 'Member must belong to an organization to access this resource' });
    }
    // For member-scoped entities, require a valid member_id (tenant admins can't bypass this)
    if (tenantScope === TENANT_SCOPE.MEMBER && !tenantCtx.memberId) {
      return res.status(403).json({ error: 'Invalid member context' });
    }
  }

  try {
    if (req.method === 'GET') {
      // List entities
      const { filter, sort, limit, offset, expand } = req.query;
      let query = supabase.from(tableName).select(expand || '*');
      
      // Apply tenant isolation filter (always applied for non-global entities)
      if (shouldApplyTenantFilter) {
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          // Member-scoped entities filter by member_id
          query = query.eq('member_id', tenantCtx.memberId);
        } else if (tenantScope === TENANT_SCOPE.ORGANIZATION) {
          // Organization-scoped entities filter by organization_id
          // OrganizationPreferenceValue needs tenant-wide access for all users (to view org details)
          // Booking with event_id filter: Allow cross-org access since button visibility is role-controlled
          // Other ORGANIZATION-scoped entities restrict to member's own org unless they're tenant admin
          
          // Use the allowsTenantWideAccess flag computed earlier in the access pre-check
          if (tenantCtx.allowsTenantWideAccess) {
            // Allow cross-org access within tenant for:
            // - OrganizationPreferenceValue: viewing org details
            // - Booking with event_id filter: viewing event attendees (access controlled by RBAC)
            
            // Check if request already has a specific organization_id filter
            // Use the already-parsed filter from tenantCtx to avoid double-parsing
            let requestedOrgId = null;
            let requestedOrgIds = null;
            const filterObj = tenantCtx.parsedFilter;
            if (filterObj?.organization_id) {
              const orgFilter = filterObj.organization_id;
              // Handle different filter formats: 'uuid', {eq: 'uuid'}, ['uuid'], {in: [...]}
              if (typeof orgFilter === 'string') {
                requestedOrgId = orgFilter;
              } else if (orgFilter.eq) {
                requestedOrgId = orgFilter.eq;
              } else if (Array.isArray(orgFilter)) {
                if (orgFilter.length === 1) {
                  requestedOrgId = orgFilter[0];
                } else if (orgFilter.length > 1) {
                  requestedOrgIds = orgFilter;
                }
              } else if (orgFilter.in && Array.isArray(orgFilter.in)) {
                if (orgFilter.in.length === 1) {
                  requestedOrgId = orgFilter.in[0];
                } else if (orgFilter.in.length > 1) {
                  requestedOrgIds = orgFilter.in;
                }
              }
            }
            
            if (requestedOrgId) {
              // Single org filter - validate it belongs to the tenant
              const { data: org, error: orgError } = await supabase
                .from('organization')
                .select('tenant_id')
                .eq('id', requestedOrgId)
                .single();
              
              if (orgError || !org || org.tenant_id !== tenantCtx.effectiveTenantId) {
                console.log(`[Entity GET] ${entity} - requested org ${requestedOrgId} not in tenant, returning empty`);
                return res.json([]);
              }
              
              // Use the specific org filter directly - no need to fetch all orgs
              console.log(`[Entity GET] ${entity} - using specific org filter: ${requestedOrgId}`);
              query = query.eq('organization_id', requestedOrgId);
            } else if (requestedOrgIds && requestedOrgIds.length > 0) {
              // Multiple org IDs filter - validate all belong to the tenant
              const { data: validOrgs, error: orgsError } = await supabase
                .from('organization')
                .select('id')
                .eq('tenant_id', tenantCtx.effectiveTenantId)
                .in('id', requestedOrgIds);
              
              if (orgsError) {
                console.error(`[Entity GET] ${entity} - error validating orgs:`, orgsError);
              }
              
              const validOrgIds = (validOrgs || []).map(o => o.id);
              console.log(`[Entity GET] ${entity} - validated ${validOrgIds.length}/${requestedOrgIds.length} requested orgs`);
              
              if (validOrgIds.length === 0) {
                return res.json([]);
              }
              
              query = query.in('organization_id', validOrgIds);
            } else {
              // No specific org filter - fetch all tenant orgs (for listing all orgs' preference values)
              console.log(`[Entity GET] ${entity} - allowing cross-org access via allowsTenantWideAccess, tenantId:`, tenantCtx.effectiveTenantId);
              
              // For large tenants, use join instead of .in() to avoid query limits
              const selectClause = expand || '*';
              query = supabase
                .from(tableName)
                .select(`${selectClause}, organization!inner(tenant_id)`)
                .eq('organization.tenant_id', tenantCtx.effectiveTenantId);
            }
          } else if (isTenantAdmin && tenantCtx.effectiveTenantId) {
            // Tenant admins can access all orgs within their tenant using a join
            const selectClause = expand || '*';
            query = supabase
              .from(tableName)
              .select(`${selectClause}, organization!inner(tenant_id)`)
              .eq('organization.tenant_id', tenantCtx.effectiveTenantId);
          } else {
            // Members: restrict to their own organization for other ORGANIZATION-scoped entities
            query = query.eq('organization_id', tenantCtx.organizationId);
          }
        } else if (entity === 'Organization') {
          // Organization entity: filter by tenant_id to show all orgs in tenant
          // Or fall back to showing only the member's own org if tenant_id not set
          console.log('[Entity GET] Organization query - tenantCtx.tenantId:', tenantCtx.tenantId, 'type:', typeof tenantCtx.tenantId, 'organizationId:', tenantCtx.organizationId, 'isTenantAdmin:', isTenantAdmin);
          if (tenantCtx.tenantId) {
            query = query.eq('tenant_id', tenantCtx.tenantId);
            
            // Check if user is fetching their own organization specifically (by ID filter)
            // If so, skip directory filtering - users should always be able to see their own org
            let isFetchingOwnOrg = false;
            if (tenantCtx.organizationId) {
              if (filter) {
                try {
                  const filterObj = JSON.parse(filter);
                  // Handle various filter formats: {id: 'xxx'}, {id: {eq: 'xxx'}}, {id: ['xxx']}
                  const filterId = filterObj.id;
                  if (filterId === tenantCtx.organizationId) {
                    isFetchingOwnOrg = true;
                  } else if (typeof filterId === 'object' && filterId !== null) {
                    if (filterId.eq === tenantCtx.organizationId) {
                      isFetchingOwnOrg = true;
                    } else if (Array.isArray(filterId) && filterId.includes(tenantCtx.organizationId)) {
                      isFetchingOwnOrg = true;
                    } else if (Array.isArray(filterId.in) && filterId.in.includes(tenantCtx.organizationId)) {
                      isFetchingOwnOrg = true;
                    }
                  }
                } catch (e) {
                  // Ignore parse errors, proceed with normal filtering
                }
              }
              if (isFetchingOwnOrg) {
                console.log('[Entity GET] Organization - user fetching own org, skipping directory filters');
              }
            }
            
            // Apply directory filtering for non-admin users (application_status and excluded orgs)
            // Skip directory filtering when user is fetching their own organization
            // Also skip when skipDirectoryFilters=true is passed (for CRM page) - requires tenant admin or org management access
            let skipDirectoryFilters = isTenantAdmin;
            if (!skipDirectoryFilters && req.query.skipDirectoryFilters === 'true' && tenantCtx.roleId) {
              // Check if user's role has access to organizations management (CRM)
              const { hasCrossOrgAccess } = await checkCrossOrgPermissions(tenantCtx.roleId);
              skipDirectoryFilters = hasCrossOrgAccess;
            }
            if (!skipDirectoryFilters && !isFetchingOwnOrg) {
              // Check for org_directory_allowed_application_statuses setting
              const { data: statusSetting } = await supabase
                .from('system_settings')
                .select('setting_value')
                .eq('tenant_id', tenantCtx.tenantId)
                .eq('setting_key', 'org_directory_allowed_application_statuses')
                .single();
              
              if (statusSetting?.setting_value) {
                try {
                  const allowedStatuses = JSON.parse(statusSetting.setting_value);
                  if (Array.isArray(allowedStatuses) && allowedStatuses.length > 0) {
                    // Find the application_status preference field
                    const { data: statusField } = await supabase
                      .from('preference_field')
                      .select('id')
                      .eq('tenant_id', tenantCtx.tenantId)
                      .eq('name', 'application_status')
                      .eq('entity_scope', 'organization')
                      .single();
                    
                    if (statusField?.id) {
                      // Get org IDs that have matching application_status
                      // Join with organization table to ensure tenant isolation
                      const { data: matchingOrgValues } = await supabase
                        .from('organization_preference_value')
                        .select('organization_id, value, organization!inner(tenant_id)')
                        .eq('field_id', statusField.id)
                        .eq('organization.tenant_id', tenantCtx.tenantId);
                      
                      // Filter to orgs with allowed status values
                      const allowedOrgIds = (matchingOrgValues || [])
                        .filter(pv => {
                          let val = pv.value;
                          // Parse JSON if needed
                          if (typeof val === 'string') {
                            const trimmed = val.trim();
                            if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
                              try { val = JSON.parse(trimmed); } catch {}
                            }
                          }
                          // Extract value from {value, label} objects
                          if (typeof val === 'object' && val !== null && !Array.isArray(val) && val.value !== undefined) {
                            val = val.value;
                          }
                          // Check if value matches allowed statuses
                          if (Array.isArray(val)) {
                            return val.some(v => allowedStatuses.includes(typeof v === 'object' ? v.value : v));
                          }
                          return allowedStatuses.includes(val);
                        })
                        .map(pv => pv.organization_id);
                      
                      // Always include the user's own organization in the allowed list
                      // Users should always be able to see their own org, regardless of directory filtering
                      if (tenantCtx.organizationId && !allowedOrgIds.includes(tenantCtx.organizationId)) {
                        allowedOrgIds.push(tenantCtx.organizationId);
                        console.log('[Entity GET] Organization - added own org to allowed list:', tenantCtx.organizationId);
                      }
                      
                      console.log('[Entity GET] Organization - filtering by application_status, allowed org count:', allowedOrgIds.length);
                      
                      if (allowedOrgIds.length === 0) {
                        // No orgs match the status filter - return empty
                        return res.json([]);
                      }
                      query = query.in('id', allowedOrgIds);
                    }
                  }
                } catch (e) {
                  console.error('[Entity GET] Error parsing allowed_application_statuses:', e);
                }
              }
              
              // Check for org_directory_excluded_orgs setting
              const { data: excludedSetting } = await supabase
                .from('system_settings')
                .select('setting_value')
                .eq('tenant_id', tenantCtx.tenantId)
                .eq('setting_key', 'org_directory_excluded_orgs')
                .single();
              
              if (excludedSetting?.setting_value) {
                try {
                  const excludedOrgIds = JSON.parse(excludedSetting.setting_value);
                  // Validate UUIDs and filter out any invalid entries
                  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                  let validExcludedIds = excludedOrgIds.filter(id => typeof id === 'string' && uuidRegex.test(id));
                  
                  // Never exclude the user's own organization
                  if (tenantCtx.organizationId && validExcludedIds.includes(tenantCtx.organizationId)) {
                    validExcludedIds = validExcludedIds.filter(id => id !== tenantCtx.organizationId);
                    console.log('[Entity GET] Organization - removed own org from exclusion list');
                  }
                  
                  if (Array.isArray(validExcludedIds) && validExcludedIds.length > 0) {
                    console.log('[Entity GET] Organization - excluding orgs:', validExcludedIds.length);
                    // Use Supabase's proper array syntax for NOT IN with UUIDs
                    query = query.not('id', 'in', `(${validExcludedIds.map(id => `"${id}"`).join(',')})`);
                  }
                } catch (e) {
                  console.error('[Entity GET] Error parsing excluded_orgs:', e);
                }
              }
            }
          } else {
            console.log('[Entity GET] Organization - FALLBACK to single org id:', tenantCtx.organizationId);
            query = query.eq('id', tenantCtx.organizationId);
          }
        } else if (tenantScope === TENANT_SCOPE.TENANT) {
          // Tenant-scoped entities filter by tenant_id (or organization_id during migration)
          console.log(`[Entity GET] Tenant-scoped entity ${entity}, tenantCtx.tenantId:`, tenantCtx.tenantId, 'isTenantAdmin:', isTenantAdmin);
          
          // Special handling for entities that filter through blog_post (article_id -> blog_post.tenant_id)
          // These tables don't have tenant_id directly, so we filter by article_id in tenant's blog posts
          const entitiesFilteredByArticle = ['ArticleReaction', 'ArticleView', 'ArticleComment'];
          if (entitiesFilteredByArticle.includes(entity) && tenantCtx.tenantId) {
            // First get all blog post IDs for this tenant, then filter by those
            const { data: tenantPosts, error: postsError } = await supabase
              .from('blog_post')
              .select('id')
              .eq('tenant_id', tenantCtx.tenantId);
            
            if (postsError) {
              console.error(`Error fetching tenant blog posts for ${entity}:`, postsError);
              return res.status(500).json({ error: 'Failed to fetch tenant articles' });
            }
            
            const articleIds = (tenantPosts || []).map(p => p.id);
            if (articleIds.length === 0) {
              // No articles for this tenant, return empty array
              return res.json([]);
            }
            
            query = query.in('article_id', articleIds);
          } else if (entity === 'CommentReaction' && tenantCtx.tenantId) {
            // CommentReaction filters through comment_id -> article_comment -> blog_post -> tenant_id
            const { data: tenantPosts, error: postsError2 } = await supabase
              .from('blog_post')
              .select('id')
              .eq('tenant_id', tenantCtx.tenantId);
            
            if (postsError2) {
              console.error('Error fetching tenant blog posts for CommentReaction:', postsError2);
              return res.status(500).json({ error: 'Failed to fetch tenant articles' });
            }
            
            const articleIds = (tenantPosts || []).map(p => p.id);
            if (articleIds.length === 0) {
              return res.json([]);
            }
            
            const { data: tenantComments, error: commentsError } = await supabase
              .from('article_comment')
              .select('id')
              .in('article_id', articleIds);
            
            if (commentsError) {
              console.error('Error fetching tenant comments for CommentReaction:', commentsError);
              return res.status(500).json({ error: 'Failed to fetch tenant comments' });
            }
            
            const commentIds = (tenantComments || []).map(c => c.id);
            if (commentIds.length === 0) {
              return res.json([]);
            }
            
            query = query.in('comment_id', commentIds);
          } else if (tenantCtx.tenantId) {
            query = query.eq('tenant_id', tenantCtx.tenantId);
          } else if (isTenantAdmin) {
            // SECURITY: Tenant admins MUST have tenantId set - reject query if missing
            console.error(`[Entity GET] SECURITY: Tenant admin missing tenantId for ${entity}, blocking query`);
            return res.status(403).json({ error: 'Invalid tenant context - please log out and log in again' });
          } else if (tenantCtx.organizationId) {
            // Fallback: use organization_id during migration period
            // Only for tables that still have organization_id column
            const entitiesWithoutOrgId = [
              'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
              'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'FormSubmission', 'ResourceCategory', 'Resource',
              'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField',
              'EmailTemplate', 'Workflow', 'WorkflowLog', 'ButtonStyle',
              'ArticleComment', 'ArticleReaction', 'ArticleView', 'CommentReaction', 'BlogPost',
              'WallOfFameSection', 'WallOfFameCategory', 'WallOfFamePerson'
            ];
            if (entitiesWithoutOrgId.includes(entity)) {
              // SECURITY: Entities without organization_id column MUST have tenant_id - block access if missing
              console.error(`[Entity GET] SECURITY: Entity ${entity} requires tenant_id but none available, blocking query`);
              return res.status(403).json({ error: 'Invalid tenant context - tenant_id required for this entity' });
            } else {
              query = query.eq('organization_id', tenantCtx.organizationId);
            }
          } else {
            // SECURITY: No tenant_id and no organization_id - block access
            console.error(`[Entity GET] SECURITY: No tenant context available for ${entity}, blocking query`);
            return res.status(403).json({ error: 'Invalid tenant context - please log out and log in again' });
          }
        }
      }
      
      // For Member entity, exclude deleted/anonymized members at the query level
      // This ensures pagination works correctly
      if (entityNorm === 'member') {
        query = query.not('email', 'ilike', 'deleted_%@deleted.local');
      }

      // Use pre-parsed filter from tenantCtx if available, otherwise parse now
      const filterObj = tenantCtx.parsedFilter || (filter ? (() => {
        try { return JSON.parse(filter); } catch { return null; }
      })() : null);
      
      if (filterObj) {
        Object.entries(filterObj).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            query = query.in(key, value);
          } else if (typeof value === 'object' && value !== null) {
            if ('eq' in value) query = query.eq(key, value.eq);
            if ('neq' in value) query = query.neq(key, value.neq);
            if ('gt' in value) query = query.gt(key, value.gt);
            if ('gte' in value) query = query.gte(key, value.gte);
            if ('lt' in value) query = query.lt(key, value.lt);
            if ('lte' in value) query = query.lte(key, value.lte);
            if ('like' in value) query = query.like(key, value.like);
            if ('ilike' in value) query = query.ilike(key, value.ilike);
            if ('is' in value) query = query.is(key, value.is);
            if ('in' in value) query = query.in(key, value.in);
          } else {
            query = query.eq(key, value);
          }
        });
      }

      if (sort) {
        const sortObj = JSON.parse(sort);
        Object.entries(sortObj).forEach(([key, direction]) => {
          query = query.order(key, { ascending: direction === 'asc' });
        });
      }

      if (limit) query = query.limit(parseInt(limit));
      if (offset) query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit || '100') - 1);

      const { data, error } = await query;
      if (error) {
        console.error(`Entity list error for ${entity} (table: ${tableName}):`, error);
        return res.status(500).json({ 
          error: error.message, 
          details: error.details,
          hint: error.hint,
          code: error.code,
          table: tableName
        });
      }
      
      return res.json(data || []);

    } else if (req.method === 'POST') {
      // Create entity
      console.log(`POST to ${tableName}:`, JSON.stringify(req.body));
      
      // Sanitize empty strings to null for UUID fields to avoid "invalid input syntax for type uuid" errors
      // Only modify fields that are already present in the request body
      const sanitizedBody = { ...req.body };
      const uuidFields = ['role_id', 'organization_id', 'member_id', 'parent_id', 'form_id', 'event_id', 
                          'category_id', 'template_id', 'workflow_id', 'speaker_id', 'created_by', 'updated_by',
                          'organisation_award_id', 'offline_award_id', 'engagement_award_id', 'award_id'];
      for (const field of uuidFields) {
        if (field in sanitizedBody && sanitizedBody[field] === '') {
          sanitizedBody[field] = null;
        }
      }
      
      // Apply tenant context for tenant-scoped entities
      // SECURITY: Force-set tenant_id/organization_id/member_id from session to prevent tenant injection
      if (shouldApplyTenantFilter && tenantCtx.isAuthenticated) {
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          // Member-scoped entities: always force member_id to current member
          sanitizedBody.member_id = tenantCtx.memberId;
        } else if (tenantScope === TENANT_SCOPE.ORGANIZATION) {
          // Organization-scoped entities: check role-based cross-org permissions
          // Only members with appropriate role permissions can specify a different organization_id
          let hasCrossOrgAccess = false;
          
          if (tenantCtx.roleId) {
            const { hasCrossOrgAccess: hasAccess } = await checkCrossOrgPermissions(tenantCtx.roleId);
            hasCrossOrgAccess = hasAccess;
          }
          
          if (sanitizedBody.organization_id && sanitizedBody.organization_id !== tenantCtx.organizationId) {
            // User is trying to create for a different organization
            if (!hasCrossOrgAccess) {
              return res.status(403).json({ error: 'You do not have permission to access other organizations' });
            }
            // User has cross-org access: validate the provided organization_id belongs to their tenant
            const effectiveTenantId = tenantCtx.tenantId || tenantCtx.effectiveTenantId;
            if (!effectiveTenantId) {
              return res.status(403).json({ error: 'Unable to verify organization ownership' });
            }
            const { data: org } = await supabase
              .from('organization')
              .select('tenant_id')
              .eq('id', sanitizedBody.organization_id)
              .single();
            
            if (!org || org.tenant_id !== effectiveTenantId) {
              return res.status(403).json({ error: 'Organization does not belong to your tenant' });
            }
            // Keep the organization_id from request - it's validated
          } else if (tenantCtx.organizationId) {
            // No org_id in request or same as member's org: use member's own organization
            sanitizedBody.organization_id = tenantCtx.organizationId;
          } else if (!sanitizedBody.organization_id) {
            return res.status(400).json({ error: 'organization_id is required for this entity' });
          }
        } else if (entity === 'Organization') {
          // Creating organizations: set tenant_id if available
          if (tenantCtx.tenantId) {
            sanitizedBody.tenant_id = tenantCtx.tenantId;
          }
        } else if (tenantScope === TENANT_SCOPE.TENANT) {
          // Tenant-scoped entities: force tenant_id from session
          let resolvedTenantId = tenantCtx.tenantId;
          
          // For Member entity, if no tenant_id but organization_id is provided,
          // resolve tenant_id from the organization to ensure proper tenant scoping
          if (!resolvedTenantId && entity === 'Member' && sanitizedBody.organization_id) {
            const { data: org } = await supabase
              .from('organization')
              .select('tenant_id')
              .eq('id', sanitizedBody.organization_id)
              .single();
            if (org?.tenant_id) {
              resolvedTenantId = org.tenant_id;
              console.log(`[Entity POST] Resolved tenant_id ${resolvedTenantId} from organization ${sanitizedBody.organization_id}`);
            }
          }
          
          if (resolvedTenantId) {
            sanitizedBody.tenant_id = resolvedTenantId;
          }
          
          // Only set organization_id for entities that still have that column
          // These entities have been fully migrated to tenant_id only (no organization_id column):
          const entitiesWithoutOrgId = [
            'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
            'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'FormSubmission', 'ResourceCategory', 'Resource',
            'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField',
            'EmailTemplate', 'Workflow', 'WorkflowLog', 'ButtonStyle',
            'ArticleComment', 'ArticleReaction', 'ArticleView', 'CommentReaction', 'BlogPost',
            'WallOfFameSection', 'WallOfFameCategory', 'WallOfFamePerson',
            'MemberGroup', 'MemberGroupAssignment', 'MemberGroupGuest'
          ];
          if (!entitiesWithoutOrgId.includes(entity)) {
            // For Member entity, preserve the organization_id from request body if provided
            // This allows tenant admins to create members for specific organizations
            if (entity === 'Member' && sanitizedBody.organization_id) {
              // Keep the organization_id from the request - don't overwrite it
              console.log(`[Entity POST] Preserving organization_id ${sanitizedBody.organization_id} from request for Member creation`);
            } else if (tenantCtx.organizationId) {
              sanitizedBody.organization_id = tenantCtx.organizationId;
            }
          }
        }
      }
      
      // SPECIAL CASE: FormSubmission can be created by unauthenticated users (public/embedded forms)
      // Derive tenant_id from hostname or from the parent Form's tenant_id
      if (entityNorm === 'formsubmission' && !sanitizedBody.tenant_id) {
        let resolvedTenantId = null;
        
        // First try: use tenant from hostname (subdomain resolution)
        if (tenantCtx.tenantId) {
          resolvedTenantId = tenantCtx.tenantId;
          console.log(`[Entity POST] FormSubmission: Using tenant_id ${resolvedTenantId} from hostname`);
        }
        
        // Fallback: derive from the parent Form's tenant_id
        if (!resolvedTenantId && sanitizedBody.form_id) {
          const { data: form } = await supabase
            .from('form')
            .select('tenant_id')
            .eq('id', sanitizedBody.form_id)
            .single();
          if (form?.tenant_id) {
            resolvedTenantId = form.tenant_id;
            console.log(`[Entity POST] FormSubmission: Resolved tenant_id ${resolvedTenantId} from form ${sanitizedBody.form_id}`);
          }
        }
        
        if (resolvedTenantId) {
          sanitizedBody.tenant_id = resolvedTenantId;
        } else {
          console.error(`[Entity POST] SECURITY: FormSubmission missing tenant_id and unable to resolve from hostname or form`);
          return res.status(403).json({ error: 'Unable to determine tenant context for form submission' });
        }
      }
      
      // Normalize email to lowercase for member, team_member, and magic_link entities
      // Use normalized entity name to handle both PascalCase and slug-case variants
      if ((entityNorm === 'member' || entityNorm === 'teammember' || entityNorm === 'magiclink') && sanitizedBody.email) {
        sanitizedBody.email = sanitizedBody.email.toLowerCase();
      }
      
      const { data, error } = await supabase
        .from(tableName)
        .insert(sanitizedBody)
        .select()
        .single();

      if (error) {
        console.error(`Error inserting into ${tableName}:`, error);
        
        // Handle unique constraint violations with user-friendly messages
        if (error.code === '23505') {
          // Check if it's the member email uniqueness constraint
          if (error.message?.includes('member_email_tenant_unique') || 
              (tableName === 'member' && error.message?.includes('email'))) {
            return res.status(409).json({ 
              error: 'A member with this email already exists in this tenant',
              code: 'DUPLICATE_EMAIL'
            });
          }
          // Generic unique constraint violation
          return res.status(409).json({ 
            error: 'A record with these values already exists',
            code: 'DUPLICATE_RECORD'
          });
        }
        
        return res.status(500).json({ error: error.message, details: error.details, hint: error.hint, code: error.code });
      }

      // Derive base URL for workflow email placeholders
      // On Vercel, use VERCEL_URL env var as fallback
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      let host = req.headers['x-forwarded-host'] || req.headers.host || '';
      
      // Fallback to VERCEL_URL or configured app URL if host is missing
      if (!host && process.env.VERCEL_URL) {
        host = process.env.VERCEL_URL;
      }
      
      const baseUrl = host ? `${protocol}://${host}` : (process.env.APP_URL || '');
      console.log(`[Entity POST] Derived baseUrl: "${baseUrl}" (protocol: ${protocol}, host: ${host})`);
      console.log(`[Entity POST] Request headers:`, JSON.stringify({
        'x-forwarded-proto': req.headers['x-forwarded-proto'],
        'x-forwarded-host': req.headers['x-forwarded-host'],
        'host': req.headers.host
      }));

      // Trigger workflow evaluation for new Organization/Member/JobPosting (non-blocking)
      if ((entityNorm === 'organization' || entityNorm === 'member' || entityNorm === 'jobposting') && data) {
        const entityType = entityNorm === 'jobposting' ? 'job_posting' : entityNorm;
        console.log(`[Entity POST] Triggering workflows for ${entityType}:${data.id}, tenant_id=${data.tenant_id}, data keys:`, Object.keys(data));
        triggerWorkflows(entityType, data.id, null, data, 'record_create', baseUrl).catch(err => {
          console.error('[Entity POST] Workflow error:', err);
        });
      }
      
      // Also trigger workflows when preference values are created
      const isPreferenceValueEntity = entityNorm === 'organizationpreferencevalue' || entityNorm === 'memberpreferencevalue';
      let pendingWorkflowConfirmations = [];
      
      if (isPreferenceValueEntity && data) {
        const entityType = entityNorm === 'organizationpreferencevalue' ? 'organization' : 'member';
        const entityId = data.organization_id || data.member_id;
        const fieldId = data.field_id;
        
        console.log(`[Entity POST] Preference value created - entityId: ${entityId}, fieldId: ${fieldId}, value: ${data.value}`);
        
        if (entityId && fieldId) {
          try {
            const prefResult = await triggerPreferenceWorkflows(entityType, entityId, fieldId, data.value, baseUrl);
            if (prefResult?.pendingConfirmations?.length > 0) {
              pendingWorkflowConfirmations.push(...prefResult.pendingConfirmations);
            }
          } catch (err) {
            console.error('[Entity POST] Preference workflow error:', err);
          }
        }
      }

      // Send email on FormSubmission creation (non-blocking)
      if (entityNorm === 'formsubmission' && data) {
        sendFormSubmissionEmail(data).catch(err => {
          console.error('[Entity POST] Form submission email error:', err);
        });
      }

      // If there are pending workflow confirmations, include them in the response
      if (pendingWorkflowConfirmations.length > 0) {
        return res.status(201).json({
          ...data,
          _pendingWorkflowConfirmations: pendingWorkflowConfirmations
        });
      }

      return res.status(201).json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Entity error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
