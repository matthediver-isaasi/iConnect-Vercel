import { sendEmail, replacePlaceholders } from '../../_lib/emailService.js';
import { generatePasswordSetupUrl, hasSetPasswordToken, replaceSetPasswordToken } from '../../_lib/passwordSetupUrl.js';
import { triggerWorkflows, triggerPreferenceWorkflows } from '../../_lib/workflows.js';
import { triggerZohoCrmSync, awaitZohoCrmSyncForResponse } from '../../_lib/zohoCrmSync.js';
import { supabase } from '../../_lib/database.js';
import { getTenantContext, getEntityTenantScope, getTenantColumn, TENANT_SCOPE, checkCrossOrgPermissions, checkCrossMemberPermissions, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { getSession } from '../../_lib/session.js';
import { handleMemberGroupEntityChange } from '../../_lib/memberGroupProjectsAccess.js';
import { dispatchWpWebhook } from '../../_lib/wpWebhook.js';
import { sendBriefNotification } from '../../article-briefs/notify.js';
import { rebuildSearchTextForEntity } from '../../_lib/searchTextBuilder.js';
import { syncBlogPostAuthors } from '../../_lib/blogPostAuthors.js';
import { checkMemberQuota, checkEventQuota } from '../../_lib/planQuota.js';

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

    // Also support simple {{field_id}} format for form values, BUT only
    // consume tokens whose key actually exists in the submission's form
    // values. Previously this stripped every unknown {{token}} to '',
    // which destroyed system tokens like {{set_password_url}} and the
    // {{member.*}} / {{organization.*}} tokens before any downstream
    // resolver could see them. Unknown tokens are now preserved so the
    // generic placeholder helper below (and any future system-token
    // resolver) can attempt to fill them.
    subject = subject.replace(/\{\{(\w+)\}\}/g, (match, fieldId) => {
      return Object.prototype.hasOwnProperty.call(formValues, fieldId)
        ? String(formValues[fieldId] || '')
        : match;
    });
    body = body.replace(/\{\{(\w+)\}\}/g, (match, fieldId) => {
      return Object.prototype.hasOwnProperty.call(formValues, fieldId)
        ? String(formValues[fieldId] || '')
        : match;
    });

    // Resolve member + organization context for the submission so generic
    // [[member.*]] / [[organization.*]] placeholders in the template body
    // are filled in (previously only form-field tokens were substituted,
    // leaving any [[member.first_name]] / [[organization.name]] etc. as
    // literal placeholders in the auto-reply email).
    let memberRow = null;
    let organizationRow = null;
    try {
      // form_submission column is `created_member_id` (see
      // api/forms/send-submission-email.js + scripts/replay-form-submission-org-update.mjs).
      // `created_by_member_id` is the column on the campaign tables — keep it
      // as a defensive secondary fallback in case a caller passes that key,
      // but `created_member_id` is the canonical field for this sender.
      const memberId = submissionData.member_id
        || submissionData.created_member_id
        || submissionData.created_by_member_id
        || null;
      const orgId = submissionData.organization_id
        || submissionData.created_organization_id
        || null;
      if (memberId) {
        const { data: m } = await supabase
          .from('member')
          .select('id, first_name, last_name, email, organization_id')
          .eq('id', memberId)
          .maybeSingle();
        memberRow = m || null;
      }
      const effectiveOrgId = orgId || memberRow?.organization_id || null;
      if (effectiveOrgId) {
        const { data: o } = await supabase
          .from('organization')
          .select('id, name, invoicing_email, phone')
          .eq('id', effectiveOrgId)
          .maybeSingle();
        organizationRow = o || null;
      }
    } catch (lookupErr) {
      console.warn('[FormSubmission] Failed to resolve member/org context for placeholders:', lookupErr.message);
    }

    const recordContext = {
      ...(memberRow ? {
        member_id: memberRow.id,
        member_first_name: memberRow.first_name || '',
        member_last_name: memberRow.last_name || '',
        member_full_name: `${memberRow.first_name || ''} ${memberRow.last_name || ''}`.trim(),
        member_email: memberRow.email || '',
      } : {}),
      ...(organizationRow ? {
        organization_id: organizationRow.id,
        organization_name: organizationRow.name || '',
        organization_invoicing_email: organizationRow.invoicing_email || '',
        organization_phone: organizationRow.phone || '',
      } : {}),
    };

    const placeholderContext = {
      tenantId: formTenantId,
      memberId: memberRow?.id || null,
    };
    subject = replacePlaceholders(subject, 'record', recordContext, placeholderContext);
    body = replacePlaceholders(body, 'record', recordContext, placeholderContext);

    // Mint set_password_url once and reuse for both subject + body.
    if (hasSetPasswordToken(subject, body) && memberRow?.id && memberRow?.email) {
      const baseUrl = process.env.VITE_APP_URL || process.env.APP_URL || '';
      if (baseUrl) {
        const setPasswordUrl = await generatePasswordSetupUrl(memberRow.id, memberRow.email, baseUrl);
        if (setPasswordUrl) {
          body = replaceSetPasswordToken(body, setPasswordUrl);
          subject = replaceSetPasswordToken(subject, setPasswordUrl);
        }
      } else {
        console.warn('[FormSubmission] {{set_password_url}} present but no APP_URL/VITE_APP_URL configured');
      }
    }

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
  'Gallery': 'gallery',
  'GalleryPhoto': 'gallery_photo',
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
  'ResourceView': 'resource_view',
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
  'MemberGroupClassification': 'member_group_classification',
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
  'MembershipTierConfig': 'membership_tier_config',
  'MembershipTierBand': 'membership_tier_band',
  'ForumCategory': 'forum_category',
  'ForumThread': 'forum_thread',
  'ForumPost': 'forum_post',
  'ForumReaction': 'forum_reaction',
  'ForumReport': 'forum_report',
  'ForumModerationLog': 'forum_moderation_log',
  'MemberBookmark': 'member_bookmark',
  'MemberMembershipHistory': 'member_membership_history',
  'MemberMembershipInvoicing': 'member_membership_invoicing',
  'ComplexEvent': 'complex_event',
  'ComplexEventTrack': 'complex_event_track',
  'ComplexEventSession': 'complex_event_session',
  'ComplexEventTicketClass': 'complex_event_ticket_class',
  'ComplexEventBooking': 'complex_event_booking',
  'EventSponsor': 'event_sponsor',
  'EventSponsorCategory': 'event_sponsor_category',
  'EventSponsorAssignment': 'event_sponsor_assignment',
  'ArticleBrief': 'article_brief',
  'ArticleBriefVersion': 'article_brief_version',
  'ArticleBriefComment': 'article_brief_comment',
  'ArticleBriefActivity': 'article_brief_activity',
  'ExternalWriter': 'external_writer',
  'ExternalWriterDocument': 'external_writer_document',
  'CrmTagColor': 'crm_tag_color',
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
  
  const adminOnlyEntities = ['externalwriter', 'externalwriterdocument'];
  if (adminOnlyEntities.includes(entityNorm)) {
    if (!tenantCtx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const isAdmin = await hasAdminAccess(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }

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
    let allowsTenantWideAccess = (entity === 'OrganizationPreferenceValue' || entity === 'ComplexEvent' || entity === 'ComplexEventTrack' || entity === 'ComplexEventSession' || entity === 'ComplexEventTicketClass') && tenantCtx.tenantId;
    
    // MemberPreferenceValue: check role-based permission before granting cross-member access
    if (entity === 'MemberPreferenceValue' && tenantCtx.tenantId && tenantCtx.roleId) {
      const { hasCrossMemberAccess } = await checkCrossMemberPermissions(tenantCtx.roleId);
      if (hasCrossMemberAccess) {
        allowsTenantWideAccess = true;
      }
    }
    
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

    // Booking with single-member context filter: allow cross-org access for
    // viewers with cross-member admin permission (e.g. CRM /members/:id Activity tab).
    //
    // Strictly gated to a SINGLE member identifier to prevent tenant-wide booking
    // harvesting via wildcard / multi-value filters. Allowed shapes:
    //   member_id: "<uuid>"            OR  { eq: "<uuid>" }
    //   attendee_email: "<email>"      OR  { eq: "<email>" }
    //                                  OR  { ilike: "<exact email, no wildcards>" }
    // Any other shape (arrays, `in`, `like`, ilike with `%` / `_`, empty values)
    // does NOT enable tenant-wide access.
    if (
      entity === 'Booking' &&
      effectiveTenantId &&
      !allowsTenantWideAccess &&
      tenantCtx.roleId &&
      parsedFilter
    ) {
      const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
      const containsLikeWildcard = (s) => typeof s === 'string' && /[%_]/.test(s);

      const isStrictSingleMemberId = (v) => {
        if (isNonEmptyString(v)) return true;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          return isNonEmptyString(v.eq);
        }
        return false;
      };

      const isStrictSingleAttendeeEmail = (v) => {
        if (isNonEmptyString(v)) return true;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          if (isNonEmptyString(v.eq)) return true;
          if (isNonEmptyString(v.ilike) && !containsLikeWildcard(v.ilike)) return true;
        }
        return false;
      };

      const hasMemberContextFilter =
        isStrictSingleMemberId(parsedFilter.member_id) ||
        isStrictSingleAttendeeEmail(parsedFilter.attendee_email);

      if (hasMemberContextFilter) {
        const { hasCrossMemberAccess } = await checkCrossMemberPermissions(tenantCtx.roleId);
        if (hasCrossMemberAccess) {
          allowsTenantWideAccess = true;
          console.log('[Entity Access] Booking with single-member filter and cross-member role - allowing cross-org access');
        }
      }
    }
    
    // Store for use in query logic
    tenantCtx.allowsTenantWideAccess = allowsTenantWideAccess;
    
    if (tenantScope === TENANT_SCOPE.ORGANIZATION && !tenantCtx.organizationId && !(isTenantAdmin && tenantCtx.effectiveTenantId) && !allowsTenantWideAccess) {
      return res.status(403).json({ error: 'Member must belong to an organization to access this resource' });
    }
    // For member-scoped entities, require a valid member_id unless allowsTenantWideAccess
    // (e.g. MemberPreferenceValue - access controlled by RBAC page visibility)
    if (tenantScope === TENANT_SCOPE.MEMBER && !tenantCtx.memberId && !allowsTenantWideAccess) {
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
          // When allowsTenantWideAccess, use member_id from request filter (access controlled by RBAC)
          if (tenantCtx.allowsTenantWideAccess) {
            const filterMemberId = tenantCtx.parsedFilter?.member_id;
            const resolvedMemberId = typeof filterMemberId === 'string' ? filterMemberId 
              : filterMemberId?.eq ? filterMemberId.eq 
              : null;
            if (resolvedMemberId) {
              query = query.eq('member_id', resolvedMemberId);
            } else if (tenantCtx.memberId) {
              query = query.eq('member_id', tenantCtx.memberId);
            }
            console.log(`[Entity GET] ${entity} - allowing cross-member access via allowsTenantWideAccess, member_id:`, resolvedMemberId || tenantCtx.memberId);
          } else {
            query = query.eq('member_id', tenantCtx.memberId);
          }
        } else if (tenantScope === TENANT_SCOPE.ORGANIZATION) {
          // Organization-scoped entities filter by organization_id
          // OrganizationPreferenceValue needs tenant-wide access for all users (to view org details)
          // Booking with event_id filter: Allow cross-org access since button visibility is role-controlled
          // Other ORGANIZATION-scoped entities restrict to member's own org unless they're tenant admin
          
          // Use the allowsTenantWideAccess flag computed earlier in the access pre-check
          if (tenantCtx.allowsTenantWideAccess) {
            // SECURITY: tenant-wide access REQUIRES an effective tenant_id. Without it the
            // organization!inner(tenant_id) join below would degrade to filtering by NULL,
            // which would expose rows belonging to orgs with no tenant. Block instead.
            if (!tenantCtx.effectiveTenantId) {
              console.error(`[Entity GET] SECURITY: ${entity} tenant-wide access requested without effectiveTenantId, blocking`);
              return res.status(403).json({ error: 'Invalid tenant context - please log out and log in again' });
            }
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
              
              // For Booking entity, use direct tenant_id filter to include guest bookings with NULL organization_id
              // Other entities still use the organization join approach
              if (entity === 'Booking') {
                const selectClause = expand || '*';
                query = supabase
                  .from(tableName)
                  .select(selectClause)
                  .eq('tenant_id', tenantCtx.effectiveTenantId);
                console.log(`[Entity GET] Booking - using direct tenant_id filter to include guest bookings`);
              } else {
                // For large tenants, use join instead of .in() to avoid query limits
                const selectClause = expand || '*';
                query = supabase
                  .from(tableName)
                  .select(`${selectClause}, organization!inner(tenant_id)`)
                  .eq('organization.tenant_id', tenantCtx.effectiveTenantId);
              }
            }
          } else if (isTenantAdmin && tenantCtx.effectiveTenantId) {
            // Tenant admins can access all orgs within their tenant using a join
            const selectClause = expand || '*';
            // For Booking entity, use direct tenant_id filter to include guest bookings with NULL organization_id
            if (entity === 'Booking') {
              query = supabase
                .from(tableName)
                .select(selectClause)
                .eq('tenant_id', tenantCtx.effectiveTenantId);
              console.log(`[Entity GET] Booking - tenant admin using direct tenant_id filter to include guest bookings`);
            } else {
              query = supabase
                .from(tableName)
                .select(`${selectClause}, organization!inner(tenant_id)`)
                .eq('organization.tenant_id', tenantCtx.effectiveTenantId);
            }
          } else {
            // Members: restrict to their own organization for other ORGANIZATION-scoped entities
            query = query.eq('organization_id', tenantCtx.organizationId);
          }
        } else if (entity === 'Organization') {
          // Organization entity: filter by tenant_id to show all orgs in tenant
          // Or fall back to showing only the member's own org if tenant_id not set
          console.log('[Entity GET] Organization query - tenantCtx.tenantId:', tenantCtx.tenantId, 'type:', typeof tenantCtx.tenantId, 'organizationId:', tenantCtx.organizationId, 'isTenantAdmin:', isTenantAdmin);
          // SECURITY: Prefer effectiveTenantId so admins/members with a resolvable tenant
          // always get a hard tenant_id filter, not a single-org fallback.
          const orgTenantId = tenantCtx.tenantId || tenantCtx.effectiveTenantId;
          if (orgTenantId) {
            query = query.eq('tenant_id', orgTenantId);
            // Use orgTenantId for downstream tenant-scoped lookups (system_settings, preference_field, etc.)
            // so behaviour stays correct when only effectiveTenantId (resolved from organizationId) is available.
            const orgScopeTenantId = orgTenantId;
            
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
                .eq('tenant_id', orgScopeTenantId)
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
                      .eq('tenant_id', orgScopeTenantId)
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
                        .eq('organization.tenant_id', orgScopeTenantId);
                      
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
                .eq('tenant_id', orgScopeTenantId)
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
          } else if (tenantCtx.organizationId) {
            // SECURITY: We have an org but no tenant_id available - restrict strictly to user's own org
            console.log('[Entity GET] Organization - FALLBACK to single org id:', tenantCtx.organizationId);
            query = query.eq('id', tenantCtx.organizationId);
          } else {
            // SECURITY: No tenant_id and no organization_id - block instead of returning unfiltered rows
            console.error('[Entity GET] SECURITY: Organization request without tenant_id or organization_id, blocking');
            return res.status(403).json({ error: 'Invalid tenant context - please log out and log in again' });
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
              'WallOfFameSection', 'WallOfFameCategory', 'WallOfFamePerson',
              'MemberGroup', 'MemberGroupAssignment', 'MemberGroupGuest', 'GuestWriter',
              'CommunicationCategory', 'CommunicationCategoryRole',
              'ForumCategory', 'ForumThread', 'ForumPost', 'ForumReaction', 'ForumReport', 'ForumModerationLog',
              'MemberBookmark', 'MemberMembershipHistory', 'MemberMembershipInvoicing',
              'Role', 'Speaker', 'ResourceView',
              'Award', 'OfflineAward', 'OfflineAwardAssignment', 'EngagementAward', 'EngagementAwardAssignment',
              'OrganisationAward', 'OrganisationAwardAssignment', 'AwardClassification', 'AwardSublevel',
              'DynamicDirectory',
              'IEditPage', 'IEditPageElement',
              'ComplexEvent', 'ComplexEventTrack', 'ComplexEventSession', 'ComplexEventTicketClass', 'ComplexEventBooking',
              'EventSponsor', 'EventSponsorCategory', 'EventSponsorAssignment',
              'ArticleBrief', 'ArticleBriefVersion', 'ArticleBriefComment', 'ArticleBriefActivity',
              'ExternalWriter', 'ExternalWriterDocument',
              'CrmTagColor',
              'Gallery', 'GalleryPhoto', 'CardDeck'
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

      // SECURITY: For IEditPage / IEditPageElement, only members with the
      // `site-builder.page-editor` feature (the same gate used by the
      // Canvas Page Editor itself) may read unpublished/draft rows. Without
      // this check, any authenticated tenant member could fetch draft
      // canvas_design payloads via the generic entity API by hitting
      // `/api/entities/IEditPage?filter={"slug":"…"}` — which would also
      // back-door the Canvas Editor live-preview iframe's `?_canvasPreview`
      // flag. Tenant users (admin dashboard) keep full access.
      if (entity === 'IEditPage' && !tenantCtx.tenantUserId) {
        const allowDrafts = tenantCtx.roleId
          ? await hasFeatureAccess(tenantCtx.roleId, 'site-builder.page-editor')
          : false;
        if (!allowDrafts) {
          query = query.eq('status', 'published');
        }
      } else if (entity === 'IEditPageElement' && !tenantCtx.tenantUserId) {
        const allowDrafts = tenantCtx.roleId
          ? await hasFeatureAccess(tenantCtx.roleId, 'site-builder.page-editor')
          : false;
        if (!allowDrafts) {
          // Restrict to elements belonging to published pages in the tenant.
          let publishedQuery = supabase
            .from('i_edit_page')
            .select('id')
            .eq('status', 'published');
          if (tenantCtx.tenantId) publishedQuery = publishedQuery.eq('tenant_id', tenantCtx.tenantId);
          const { data: publishedPages } = await publishedQuery;
          const ids = (publishedPages || []).map((p) => p.id);
          if (ids.length === 0) return res.json([]);
          query = query.in('page_id', ids);
        }
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

      // CardDeck: normalize and cap the links array (max 10 rows of { text, url })
      if (entityNorm === 'carddeck' && 'links' in sanitizedBody) {
        const raw = Array.isArray(sanitizedBody.links) ? sanitizedBody.links : [];
        const cleaned = raw
          .map(l => ({
            text: typeof l?.text === 'string' ? l.text.trim() : '',
            url: typeof l?.url === 'string' ? l.url.trim() : ''
          }))
          .filter(l => l.text && l.url)
          .slice(0, 10);
        sanitizedBody.links = cleaned;
      }

      // BlogPost co-authors (Task #1222): `authors` is not a column on blog_post;
      // pop it here and sync the blog_post_author join table after insert.
      let blogPostAuthorsPayload;
      if (entityNorm === 'blogpost' && 'authors' in sanitizedBody) {
        blogPostAuthorsPayload = sanitizedBody.authors;
        delete sanitizedBody.authors;
      }

      // Apply tenant context for tenant-scoped entities
      // SECURITY: Force-set tenant_id/organization_id/member_id from session to prevent tenant injection
      if (shouldApplyTenantFilter && tenantCtx.isAuthenticated) {
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          // Member-scoped entities: force member_id to current member
          // When allowsTenantWideAccess, allow the request-specified member_id (access controlled by RBAC)
          if (tenantCtx.allowsTenantWideAccess && sanitizedBody.member_id) {
            // Keep the member_id from the request body
          } else {
            sanitizedBody.member_id = tenantCtx.memberId;
          }
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
          
          const entitiesWithoutTenantId = ['ArticleComment', 'ArticleReaction', 'ArticleView', 'CommentReaction'];
          if (resolvedTenantId && !entitiesWithoutTenantId.includes(entity)) {
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
            'MemberGroup', 'MemberGroupAssignment', 'MemberGroupGuest', 'GuestWriter',
            'CommunicationCategory', 'CommunicationCategoryRole',
            'ForumCategory', 'ForumThread', 'ForumPost', 'ForumReaction', 'ForumReport', 'ForumModerationLog',
            'MemberBookmark', 'MemberMembershipHistory', 'MemberMembershipInvoicing',
            'Role', 'Speaker', 'ResourceView',
            'Award', 'OfflineAward', 'OfflineAwardAssignment', 'EngagementAward', 'EngagementAwardAssignment',
            'OrganisationAward', 'OrganisationAwardAssignment', 'AwardClassification', 'AwardSublevel',
            'DynamicDirectory',
            'IEditPage', 'IEditPageElement',
            'ComplexEvent', 'ComplexEventTrack', 'ComplexEventSession', 'ComplexEventTicketClass', 'ComplexEventBooking',
            'EventSponsor', 'EventSponsorCategory', 'EventSponsorAssignment',
            'ArticleBrief', 'ArticleBriefVersion', 'ArticleBriefComment', 'ArticleBriefActivity',
            'ExternalWriter', 'ExternalWriterDocument',
            'CrmTagColor',
            'Gallery', 'GalleryPhoto', 'CardDeck'
          ];
          if (!entitiesWithoutOrgId.includes(entity)) {
            const entitiesWithExplicitOrgId = ['Member', 'Voucher', 'VoucherTransaction', 'TrainingFundTransaction'];
            const entitiesAllowingNullOrg = ['DiscountCode'];
            if (entitiesAllowingNullOrg.includes(entity)) {
              if (sanitizedBody.organization_id) {
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
                console.log(`[Entity POST] Preserving organization_id ${sanitizedBody.organization_id} from request for ${entity} creation`);
              }
            } else if (entitiesWithExplicitOrgId.includes(entity) && sanitizedBody.organization_id) {
              console.log(`[Entity POST] Preserving organization_id ${sanitizedBody.organization_id} from request for ${entity} creation`);
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
      if ((entityNorm === 'member' || entityNorm === 'teammember' || entityNorm === 'magiclink' || entityNorm === 'externalwriter') && sanitizedBody.email) {
        sanitizedBody.email = sanitizedBody.email.toLowerCase();
      }

      if (entityNorm === 'externalwriterdocument' && sanitizedBody.external_writer_id && sanitizedBody.tenant_id) {
        const { data: writer } = await supabase
          .from('external_writer')
          .select('id')
          .eq('id', sanitizedBody.external_writer_id)
          .eq('tenant_id', sanitizedBody.tenant_id)
          .single();
        if (!writer) {
          return res.status(403).json({ error: 'External writer does not belong to your tenant' });
        }
      }

      if (entityNorm === 'externalwriter' && sanitizedBody.email && sanitizedBody.tenant_id) {
        const { data: existingMember } = await supabase
          .from('member')
          .select('id')
          .eq('tenant_id', sanitizedBody.tenant_id)
          .ilike('email', sanitizedBody.email)
          .not('email', 'ilike', 'deleted_%@deleted.local')
          .limit(1);
        if (existingMember && existingMember.length > 0) {
          return res.status(409).json({ error: 'This email belongs to an existing member' });
        }
      }

      // SECURITY: Self-join enforcement for MemberGroupAssignment.
      // Non-admin members may only create assignments that satisfy the
      // group's self-join configuration; admins (tenant users or members
      // with admin role) keep unrestricted access for the assign UI.
      if (entityNorm === 'membergroupassignment' && tenantCtx.isAuthenticated) {
        const isAdmin = await hasAdminAccess(tenantCtx);
        if (!isAdmin) {
          if (!sanitizedBody.group_id) {
            return res.status(400).json({ error: 'group_id is required' });
          }
          if (sanitizedBody.guest_id) {
            return res.status(403).json({ error: 'Members cannot self-join as guests' });
          }
          if (!tenantCtx.memberId || sanitizedBody.member_id !== tenantCtx.memberId) {
            return res.status(403).json({ error: 'You may only join groups for yourself' });
          }
          if (sanitizedBody.expires_at) {
            return res.status(403).json({ error: 'Self-join assignments cannot have an expiry date' });
          }

          const effectiveTenantId = tenantCtx.effectiveTenantId || tenantCtx.tenantId;
          const { data: group, error: groupErr } = await supabase
            .from('member_group')
            .select('id, tenant_id, is_active, allow_self_join, default_self_join_role, roles')
            .eq('id', sanitizedBody.group_id)
            .single();

          if (groupErr || !group) {
            return res.status(404).json({ error: 'Group not found' });
          }
          if (effectiveTenantId && group.tenant_id && group.tenant_id !== effectiveTenantId) {
            return res.status(403).json({ error: 'Group does not belong to your tenant' });
          }
          if (group.is_active === false) {
            return res.status(403).json({ error: 'This group is not active' });
          }
          if (!group.allow_self_join) {
            return res.status(403).json({ error: 'This group is not open for self-join' });
          }
          if (!group.default_self_join_role) {
            return res.status(403).json({ error: 'This group has no default self-join role configured' });
          }
          if (sanitizedBody.group_role !== group.default_self_join_role) {
            return res.status(403).json({ error: 'Self-join role must match the group default role' });
          }
          if (Array.isArray(group.roles) && !group.roles.includes(group.default_self_join_role)) {
            return res.status(403).json({ error: 'Group default role is no longer valid' });
          }

          const { data: existingAssignment } = await supabase
            .from('member_group_assignment')
            .select('id')
            .eq('group_id', sanitizedBody.group_id)
            .eq('member_id', tenantCtx.memberId)
            .limit(1);
          if (existingAssignment && existingAssignment.length > 0) {
            return res.status(409).json({ error: 'You are already a member of this group' });
          }
        }
      }

      // Plan quota enforcement (Task #1026): block member/event creation when
      // the tenant has hit its plan limit. Skipped for sample seed rows so
      // onboarding seeding is never blocked.
      if (tenantCtx.isAuthenticated && !sanitizedBody.is_sample) {
        const quotaTenantId = sanitizedBody.tenant_id || tenantCtx.tenantId || tenantCtx.effectiveTenantId;
        if (quotaTenantId) {
          if (entityNorm === 'member') {
            const check = await checkMemberQuota(quotaTenantId);
            if (!check.ok) return res.status(check.status).json(check.body);
          } else if (entityNorm === 'event' || entityNorm === 'complexevent') {
            const check = await checkEventQuota(quotaTenantId);
            if (!check.ok) return res.status(check.status).json(check.body);
          }
        }
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
      // Holds the in-flight Zoho CRM sync Promise (if any) so we can
      // await its outcome at the end and surface the result in the
      // response — same toast-debugging pattern as the PATCH handler.
      let zohoCrmSyncPromise = null;
      if ((entityNorm === 'organization' || entityNorm === 'member' || entityNorm === 'jobposting') && data) {
        const entityType = entityNorm === 'jobposting' ? 'job_posting' : entityNorm;
        console.log(`[Entity POST] Triggering workflows for ${entityType}:${data.id}, tenant_id=${data.tenant_id}, data keys:`, Object.keys(data));
        triggerWorkflows(entityType, data.id, null, data, 'record_create', baseUrl).catch(err => {
          console.error('[Entity POST] Workflow error:', err);
        });
        if ((entityType === 'member' || entityType === 'organization') && data.tenant_id) {
          zohoCrmSyncPromise = triggerZohoCrmSync(data.tenant_id, entityType, data.id, { action: 'create' });
        }
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
          if (data.tenant_id) {
            triggerZohoCrmSync(data.tenant_id, entityType, entityId, { action: 'preference_change' });
          }
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

      if (entityNorm === 'blogpost' && data && data.tenant_id) {
        dispatchWpWebhook(data.tenant_id, 'article.created', data.id);
      }

      // BlogPost co-authors (Task #1222): sync the join table after insert.
      if (entityNorm === 'blogpost' && data && blogPostAuthorsPayload !== undefined) {
        try {
          await syncBlogPostAuthors(supabase, data.id, data.tenant_id || tenantCtx.tenantId, blogPostAuthorsPayload);
        } catch (err) {
          console.error('[Entity POST] BlogPost author sync error:', err.message || err);
        }
      }

      const searchTextEntities = ['blogpost', 'newspost', 'event', 'resource', 'ieditpage', 'ieditpageelement', 'complexevent', 'complexeventsession', 'complexeventtrack'];
      if (searchTextEntities.includes(entityNorm) && data && supabase) {
        rebuildSearchTextForEntity(supabase, entity, data, data.id).catch(err => {
          console.error('[Entity POST] Search text rebuild error:', err);
        });
      }

      if (entityNorm === 'articlebrief' && data && data.tenant_id) {
        supabase.from('article_brief_activity').insert({
          article_brief_id: data.id,
          action: 'brief_created',
          description: `Brief created: ${data.title || 'Untitled'}`,
          performed_by: data.created_by || null,
          metadata: { title: data.title, priority: data.priority, status: data.status },
          tenant_id: data.tenant_id
        }).then(() => {}).catch(err => {
          console.error('[Entity POST] ArticleBrief activity log error:', err);
        });
      }

      if (entityNorm === 'articlebriefcomment' && data && data.tenant_id && data.article_brief_id) {
        sendBriefNotification({
          tenantId: data.tenant_id,
          briefId: data.article_brief_id,
          eventType: 'comment_added',
          performedById: data.created_by || tenantCtx.memberId || null,
          metadata: { comment_preview: (data.comment_text || '').substring(0, 200) },
        }).catch(err => {
          console.error('[Entity POST] Brief comment notification error:', err);
        });
      }

      if ((entityNorm === 'membergroup' || entityNorm === 'membergroupassignment') && data) {
        try {
          const _session = await getSession(req);
          const _actorIdentityId = _session?.data?.identityId || null;
          await handleMemberGroupEntityChange({
            entityNorm,
            action: 'create',
            data,
            beforeData: null,
            actorIdentityId: _actorIdentityId,
          });
        } catch (err) {
          console.error('[Entity POST] member-group projects hook failed:', err.message || err);
        }
      }

      // Await the in-flight Zoho CRM sync (with a short timeout) so we
      // can return its outcome — see PATCH handler for the full
      // toast-debugging rationale.
      let zohoCrmSyncResult = null;
      if (zohoCrmSyncPromise) {
        try {
          zohoCrmSyncResult = await awaitZohoCrmSyncForResponse(zohoCrmSyncPromise);
        } catch (err) {
          console.error('[Entity POST] Zoho sync await threw:', err);
        }
      }

      // If there are pending workflow confirmations or a sync result, include them in the response
      if (pendingWorkflowConfirmations.length > 0 || zohoCrmSyncResult) {
        return res.status(201).json({
          ...data,
          ...(pendingWorkflowConfirmations.length > 0 && { _pendingWorkflowConfirmations: pendingWorkflowConfirmations }),
          ...(zohoCrmSyncResult && { _zohoCrmSync: zohoCrmSyncResult })
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
