import { sendEmail } from '../../_lib/emailService.js';
import { triggerWorkflows, triggerPreferenceWorkflows } from '../../_lib/workflows.js';
import { supabase } from '../../_lib/database.js';
import { getTenantContext, getEntityTenantScope, getTenantColumn, TENANT_SCOPE } from '../../_lib/tenantContext.js';

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
    if (tenantScope === TENANT_SCOPE.ORGANIZATION && !tenantCtx.organizationId && !(isTenantAdmin && tenantCtx.tenantId)) {
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
          // Tenant admins can access all orgs within their tenant using a join
          if (isTenantAdmin && tenantCtx.tenantId) {
            // Use inner join with organization table to filter by tenant_id
            // This scales better than fetching org IDs and using IN clause
            const selectClause = expand || '*';
            // Rebuild query with join - add organization join for tenant filtering
            query = supabase
              .from(tableName)
              .select(`${selectClause}, organization!inner(tenant_id)`)
              .eq('organization.tenant_id', tenantCtx.tenantId);
          } else {
            query = query.eq('organization_id', tenantCtx.organizationId);
          }
        } else if (entity === 'Organization') {
          // Organization entity: filter by tenant_id to show all orgs in tenant
          // Or fall back to showing only the member's own org if tenant_id not set
          if (tenantCtx.tenantId) {
            query = query.eq('tenant_id', tenantCtx.tenantId);
          } else {
            query = query.eq('id', tenantCtx.organizationId);
          }
        } else if (tenantScope === TENANT_SCOPE.TENANT) {
          // Tenant-scoped entities filter by tenant_id (or organization_id during migration)
          console.log(`[Entity GET] Tenant-scoped entity ${entity}, tenantCtx.tenantId:`, tenantCtx.tenantId, 'isTenantAdmin:', isTenantAdmin);
          if (tenantCtx.tenantId) {
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
              'EmailTemplate', 'Workflow', 'WorkflowLog', 'ButtonStyle'
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

      if (filter) {
        const filterObj = JSON.parse(filter);
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
          // Organization-scoped entities: force organization_id from session
          // For tenant admins, preserve the organization_id from request if valid
          if (tenantCtx.organizationId) {
            sanitizedBody.organization_id = tenantCtx.organizationId;
          } else if (tenantCtx.tenantId && sanitizedBody.organization_id) {
            // Tenant admin: verify the provided organization_id belongs to their tenant
            const { data: org } = await supabase
              .from('organization')
              .select('tenant_id')
              .eq('id', sanitizedBody.organization_id)
              .single();
            
            if (!org || org.tenant_id !== tenantCtx.tenantId) {
              return res.status(403).json({ error: 'Organization does not belong to your tenant' });
            }
            // Keep the organization_id from request - it's validated
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
            'EmailTemplate', 'Workflow', 'WorkflowLog', 'ButtonStyle'
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
