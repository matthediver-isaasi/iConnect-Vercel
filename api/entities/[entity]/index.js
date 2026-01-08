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
  // TENANT/HYBRID/MEMBER entities require authentication and scoping
  const shouldApplyTenantFilter = tenantScope !== TENANT_SCOPE.GLOBAL;
  
  // For non-global entities, require authentication
  if (shouldApplyTenantFilter && !tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    if (req.method === 'GET') {
      // List entities
      const { filter, sort, limit, offset, expand } = req.query;
      let query = supabase.from(tableName).select(expand || '*');
      
      // Apply tenant isolation filter
      if (shouldApplyTenantFilter && tenantCtx.organizationId) {
        const tenantColumn = getTenantColumn(entity);
        
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          // Member-scoped entities filter by member_id
          query = query.eq(tenantColumn, tenantCtx.memberId);
        } else if (entity === 'Organization') {
          // Organization entity: only return the member's own organization
          query = query.eq('id', tenantCtx.organizationId);
        } else {
          // Tenant-scoped entities filter by organization_id
          query = query.eq(tenantColumn, tenantCtx.organizationId);
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
      // Automatically set organization_id or member_id based on session
      if (shouldApplyTenantFilter && tenantCtx.isAuthenticated) {
        const tenantColumn = getTenantColumn(entity);
        
        if (tenantScope === TENANT_SCOPE.MEMBER && tenantCtx.memberId) {
          // Member-scoped entities: ensure member_id is set to current member
          if (!sanitizedBody[tenantColumn]) {
            sanitizedBody[tenantColumn] = tenantCtx.memberId;
          }
        } else if (tenantScope === TENANT_SCOPE.TENANT || tenantScope === TENANT_SCOPE.HYBRID) {
          // Tenant-scoped entities: ensure organization_id is set
          if (!sanitizedBody[tenantColumn] && tenantCtx.organizationId && entity !== 'Organization') {
            sanitizedBody[tenantColumn] = tenantCtx.organizationId;
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
