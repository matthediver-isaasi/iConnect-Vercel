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
      .select('submission_email_template_id, submission_email_recipient, fields')
      .eq('id', formId)
      .single();

    if (!form || !form.submission_email_template_id) return;

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

    // Send the email
    const result = await sendEmail({
      to: recipient,
      subject: subject,
      html: body,
      from: template.from_email,
      replyTo: template.reply_to
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
          if (tenantCtx.tenantId) {
            query = query.eq('tenant_id', tenantCtx.tenantId);
          } else if (tenantCtx.organizationId) {
            // Fallback: use organization_id during migration period
            // Only for tables that still have organization_id column
            const entitiesWithoutOrgId = [
              'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
              'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form'
            ];
            if (!entitiesWithoutOrgId.includes(entity)) {
              query = query.eq('organization_id', tenantCtx.organizationId);
            }
            // For entities without organization_id, we need tenant_id - 
            // if we reach here without it, the query will return all data
            // which is a temporary state during migration
          }
          // If neither tenantId nor organizationId is available (tenant admin case),
          // skip the filter - the security check above already verified the user is authorized
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
          sanitizedBody.organization_id = tenantCtx.organizationId;
        } else if (entity === 'Organization') {
          // Creating organizations: set tenant_id if available
          if (tenantCtx.tenantId) {
            sanitizedBody.tenant_id = tenantCtx.tenantId;
          }
        } else if (tenantScope === TENANT_SCOPE.TENANT) {
          // Tenant-scoped entities: force tenant_id from session
          if (tenantCtx.tenantId) {
            sanitizedBody.tenant_id = tenantCtx.tenantId;
          }
          // Only set organization_id for entities that still have that column
          // These entities have been fully migrated to tenant_id only (no organization_id column):
          const entitiesWithoutOrgId = [
            'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
            'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form'
          ];
          if (!entitiesWithoutOrgId.includes(entity)) {
            sanitizedBody.organization_id = tenantCtx.organizationId;
          }
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
        triggerWorkflows(entityType, data.id, null, data, 'record_create', baseUrl).catch(err => {
          console.error('[Entity POST] Workflow error:', err);
        });
      }
      
      // Also trigger workflows when preference values are created
      const isPreferenceValueEntity = entityNorm === 'organizationpreferencevalue' || entityNorm === 'memberpreferencevalue';
      if (isPreferenceValueEntity && data) {
        const entityType = entityNorm === 'organizationpreferencevalue' ? 'organization' : 'member';
        const entityId = data.organization_id || data.member_id;
        const fieldId = data.field_id;
        
        console.log(`[Entity POST] Preference value created - entityId: ${entityId}, fieldId: ${fieldId}, value: ${data.value}`);
        
        if (entityId && fieldId) {
          triggerPreferenceWorkflows(entityType, entityId, fieldId, data.value, baseUrl).catch(err => {
            console.error('[Entity POST] Preference workflow error:', err);
          });
        }
      }

      // Send email on FormSubmission creation (non-blocking)
      if (entityNorm === 'formsubmission' && data) {
        sendFormSubmissionEmail(data).catch(err => {
          console.error('[Entity POST] Form submission email error:', err);
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
