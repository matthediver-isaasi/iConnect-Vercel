import { sendEmail, replacePlaceholders } from '../../_lib/emailService.js';
import { generatePasswordSetupUrl, hasSetPasswordToken, replaceSetPasswordToken } from '../../_lib/passwordSetupUrl.js';
import { triggerWorkflows, triggerPreferenceWorkflows, recheckRecordCreateWorkflows } from '../../_lib/workflows.js';
import { triggerZohoCrmSync, awaitZohoCrmSyncForResponse } from '../../_lib/zohoCrmSync.js';
import { supabase } from '../../_lib/database.js';
import { stripProtectedOrgBalanceFields } from '../../_lib/protectedOrgFields.js';
import { getTenantContext, getEntityTenantScope, getTenantColumn, TENANT_SCOPE, checkCrossOrgPermissions, checkCrossMemberPermissions, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { isAdminOnlyEntity } from '../../_lib/adminOnlyEntities.js';
import { isEventFamilyEntity, authorizeGroupAdminEventWrite } from '../../_lib/groupAdminEventWrite.js';
import { checkBadgeWriteAccess } from '../../_lib/badgeAccess.js';
import { isResourceEntity, applyGroupResourceSubcategoryDefaults } from '../../_lib/groupAdminResourceWrite.js';
import { resolveSubmitControl } from '../../_lib/formSubmitControl.js';
import { rulesUseLmicOperators } from '../../_lib/formLmicConditions.js';
import { getSession } from '../../_lib/session.js';
import { getSessionPlatformOwner } from '../../_lib/platformSession.js';
import { handleMemberGroupEntityChange } from '../../_lib/memberGroupProjectsAccess.js';
import { handleMemberGroupForumChange, filterForumReadRows } from '../../_lib/memberGroupForumAccess.js';
import { handleMemberGroupFilesChange } from '../../_lib/memberGroupFilesAccess.js';
import { recordMemberGroupActivity, resolveActorEmail } from '../../_lib/memberGroupActivity.js';
import { dispatchWpWebhook } from '../../_lib/wpWebhook.js';
import { sendBriefNotification } from '../../article-briefs/notify.js';
import { sendSupportNotification, resolveAreaAssignee } from '../../support/notify.js';
import { rebuildSearchTextForEntity } from '../../_lib/searchTextBuilder.js';
import { reindexMemberContentEntitySafe } from '../../_lib/memberContentReindexHook.js';
import { syncBlogPostAuthors } from '../../_lib/blogPostAuthors.js';
import { checkMemberQuota, checkEventQuota } from '../../_lib/planQuota.js';
import { filterInternalNotesForViewer } from '../../_lib/supportTicketQueues.js';
import { isCategoryRestricted, hasSubcategoryRestrictions, filterCategoriesForViewer, filterCategorySubcategoriesForViewer, stripCategoryAccessFields } from '../../_lib/resourceCategoryAccess.js';
import { sendSubmissionEmailsGuarded } from '../../_lib/formSubmissionEmails.js';
import { getTrustedBaseUrlForTenant } from '../../_lib/publicBaseUrl.js';

/**
 * Task #3100: support staff = tenant users (admin dashboard), tenant admins,
 * or members whose role grants `support.management`. Mirrors the recipient
 * eligibility logic in api/support/notify.js. Used to gate internal notes.
 */
async function isSupportStaff(tenantCtx) {
  if (tenantCtx.tenantUserId) return true;
  if (await hasAdminAccess(tenantCtx)) return true;
  if (tenantCtx.roleId) {
    return await hasFeatureAccess(tenantCtx.roleId, 'support.management');
  }
  return false;
}

// Send email on form submission if configured.
// Task #3190: now delegates to the shared api/_lib/formSubmissionEmails.js
// sender, so the generic entity-API path supports the new `submission_emails`
// array (multi-email, conditions, field-reference recipients, placeholders,
// invoice attachment) as well as the legacy single-email fields, and records
// a durable per-submission outcome. The shared sender's atomic claim on
// form_submission.submission_email_state guarantees exactly-once even if a
// client-side call to /api/forms/send-submission-email also fires.
async function sendFormSubmissionEmail(submissionData) {
  if (!supabase) return;

  try {
    const formId = submissionData.form_id;
    if (!formId) return;

    // Fetch the full form row (email config + fields + tenant context).
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('*, tenant_id')
      .eq('id', formId)
      .single();

    if (formError || !form) {
      console.log('[FormSubmission] Form not found for submission email:', formId, formError?.message);
      return;
    }

    // FormSubmission rows created via the entity API store values in
    // submission_data; some legacy callers pass form_values instead.
    const formValues = submissionData.form_values || submissionData.submission_data || {};

    const baseUrl = process.env.VITE_APP_URL || process.env.APP_URL || '';

    const result = await sendSubmissionEmailsGuarded({
      supabase,
      form,
      formValues,
      fields: form.fields || [],
      submissionId: submissionData.id || null,
      createdMemberId: submissionData.member_id
        || submissionData.created_member_id
        || submissionData.created_by_member_id
        || null,
      createdOrganizationId: submissionData.organization_id
        || submissionData.created_organization_id
        || null,
      baseUrl,
      trigger: 'entity-api',
      allowUnguarded: false,
    });

    console.log('[FormSubmission] Submission emails processed:', JSON.stringify({
      success: result.success,
      skipped: result.skipped || false,
      reason: result.reason || null,
      emails: (result.emails || []).length,
    }));
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
  'OrganizationGroup': 'organization_group',
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
  'IEditPageFolder': 'i_edit_page_folder',
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
  'SurveyVersion': 'survey_version',
  'EventSurveyAssignment': 'event_survey_assignment',
  'SurveyAnswer': 'survey_answer',
  'EmailTemplate': 'email_template',
  'FormSubmission': 'form_submission',
  'NewsPost': 'news_post',
  'SupportTicket': 'support_ticket',
  'SupportTicketResponse': 'support_ticket_response',
  'PortalNavigationItem': 'portal_navigation_item',
  'MemberGroup': 'member_group',
  'MemberGroupAssignment': 'member_group_assignment',
  'MemberGroupActivity': 'member_group_activity',
  'ComplexEventSessionCheckin': 'complex_event_session_checkin',
  'MemberGroupClassification': 'member_group_classification',
  'GuestWriter': 'guest_writer',
  'PortalMenu': 'portal_menu',
  'AwardClassification': 'award_classification',
  'Badge': 'badge',
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
  'InstalledFont': 'installed_font',
  'CardDeck': 'card_deck',
  'DynamicDirectory': 'dynamic_directory',
  'TrainingFundTransaction': 'training_fund_transaction',
  'TrainingFundPurchase': 'training_fund_purchase',
  'VoucherTransaction': 'voucher_transaction',
  'Workflow': 'workflow',
  'WorkflowLog': 'workflow_log',
  'RoleAccessItem': 'role_access_item',
  'RedirectMapping': 'redirect_mapping',
  'Microsite': 'microsite',
  'FormDueDiligenceConfig': 'form_due_diligence_config',
  'FormSubmissionDueDiligence': 'form_submission_due_diligence',
  'FormSubmissionEmail': 'form_submission_email',
  'FormSubmissionSavedView': 'form_submission_saved_view',
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
  'EventAgendaItem': 'event_agenda_item',
  'EventCostLine': 'event_cost_line',
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
  'MemberInboxFolder': 'member_inbox_folder',
  'MemberInboxMessageState': 'member_inbox_message_state',
  'Vacancy': 'vacancy',
  'VacancyApplication': 'vacancy_application',
  'VacancyAward': 'vacancy_award',
  'VacancyDecline': 'vacancy_decline',
  'VacancyDecisionEmail': 'vacancy_decision_email',
  'HelpArticle': 'help_article',
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

  // Stale-tab guard: session tenant differs from the intended tenant for this request
  if (tenantCtx.tenantMismatch) {
    return res.status(409).json({
      error: 'Your browser session has switched to a different organisation. Reload this tab to continue.',
      code: 'TENANT_CONTEXT_CHANGED',
    });
  }

  const tenantScope = getEntityTenantScope(entity);
  
  // Determine if tenant filtering should be applied
  // GLOBAL entities are accessible without authentication
  // TENANT/ORGANIZATION/MEMBER entities require authentication and scoping
  const shouldApplyTenantFilter = tenantScope !== TENANT_SCOPE.GLOBAL;
  
  // For non-global entities, require authentication and valid tenant context
  // Tenant users (admins) can access tenant-scoped AND organization-scoped entities via tenantId
  const isTenantAdmin = !!tenantCtx.tenantUserId;
  
  if (isAdminOnlyEntity(entityNorm)) {
    if (!tenantCtx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const isAdmin = await hasAdminAccess(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }

  // SECURITY (Task #3330): survey version snapshots and normalised survey
  // answers are server-authoritative records. Writes go ONLY through the
  // publish endpoint / public submission endpoint (service role); reads are
  // admin-gated (reporting surfaces).
  // Task #3331: event survey assignments are created/updated ONLY via the
  // guarded /api/surveys/event-assignments endpoint (token generation,
  // cross-tenant event checks, archive-not-delete). Generic API is read-only,
  // admin-gated.
  if (entityNorm === 'surveyversion' || entityNorm === 'surveyanswer' || entityNorm === 'eventsurveyassignment') {
    if (req.method !== 'GET') {
      return res.status(403).json({ error: 'Survey records are managed server-side and cannot be written directly' });
    }
    if (!tenantCtx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const isAdmin = await hasAdminAccess(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }

  // Badge library (Task #3282): writes gated by the admin.badges RBAC key
  // (tenant users bypass); reads stay available to authenticated tenant
  // members so future surfaces can display badges.
  if (entityNorm === 'badge' && req.method !== 'GET') {
    const access = await checkBadgeWriteAccess(tenantCtx);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }
  }

  // Help Center articles are GLOBAL (identical content across tenants). GLOBAL
  // entities skip tenant filtering, so access MUST be enforced explicitly here:
  //  - writes MUST be a platform owner (dedicated editor uses /api/platform/*);
  //  - reads require a logged-in user (identical content for every tenant), and
  //    non-owners are restricted to published rows so drafts never leak. (Task #2199)
  let restrictHelpToPublished = false;
  if (entityNorm === 'helparticle') {
    const platformOwner = await getSessionPlatformOwner(req);
    if (req.method !== 'GET') {
      if (!platformOwner) {
        return res.status(403).json({ error: 'Platform owner access required' });
      }
    } else if (!platformOwner) {
      const _session = await getSession(req);
      const isLoggedIn = !!(_session?.data?.memberId || _session?.data?.identityId);
      if (!isLoggedIn) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      restrictHelpToPublished = true;
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
      // Opt-in exact total count (gated by ?count=exact). When requested, the
      // response shape becomes { data, count } instead of a bare array so
      // paginated callers can compute the total number of pages. Existing
      // callers that don't pass the flag are unaffected.
      const wantsCount = req.query.count === 'exact';
      let query = supabase
        .from(tableName)
        .select(expand || '*', wantsCount ? { count: 'exact' } : undefined);
      
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
              'MemberGroupClassification',
              'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
              'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'FormSubmission', 'ResourceCategory', 'Resource',
              'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField',
              'EmailTemplate', 'Workflow', 'WorkflowLog', 'ButtonStyle', 'TypographyStyle',
              'ArticleComment', 'ArticleReaction', 'ArticleView', 'CommentReaction', 'BlogPost',
              'WallOfFameSection', 'WallOfFameCategory', 'WallOfFamePerson',
              'MemberGroup', 'MemberGroupAssignment', 'MemberGroupGuest', 'GuestWriter',
              'CommunicationCategory', 'CommunicationCategoryRole',
              'ForumCategory', 'ForumThread', 'ForumPost', 'ForumReaction', 'ForumReport', 'ForumModerationLog',
              'MemberBookmark', 'MemberMembershipHistory', 'MemberMembershipInvoicing',
              'Role', 'Speaker', 'ResourceView',
              'Award', 'OfflineAward', 'OfflineAwardAssignment', 'EngagementAward', 'EngagementAwardAssignment',
              'OrganisationAward', 'OrganisationAwardAssignment', 'AwardClassification', 'AwardSublevel', 'Badge',
              'DynamicDirectory',
              'IEditPage', 'IEditPageElement', 'IEditPageFolder',
              'ComplexEvent', 'ComplexEventTrack', 'ComplexEventSession', 'ComplexEventTicketClass', 'ComplexEventBooking',
              'EventSponsor', 'EventSponsorCategory', 'EventSponsorAssignment', 'EventSurveyAssignment',
              'ArticleBrief', 'ArticleBriefVersion', 'ArticleBriefComment', 'ArticleBriefActivity',
              'ExternalWriter', 'ExternalWriterDocument',
              'CrmTagColor',
              'Vacancy', 'VacancyApplication', 'VacancyAward', 'VacancyDecline', 'VacancyDecisionEmail',
              'Gallery', 'GalleryPhoto', 'CardDeck',
              'MemberGroupActivity', 'ComplexEventSessionCheckin', 'Microsite', 'InstalledFont',
              'EventAgendaItem', 'EventCostLine', 'OrganizationGroup'
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
      
      // Task #1414: personal saved filter views are visible only to the member
      // that created them (tenant isolation is applied above by tenant_id).
      if (entityNorm === 'formsubmissionsavedview') {
        if (!tenantCtx.memberId) return res.json([]);
        query = query.eq('member_id', tenantCtx.memberId);
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
      let filterObj = tenantCtx.parsedFilter || (filter ? (() => {
        try { return JSON.parse(filter); } catch { return null; }
      })() : null);

      // Help Center: non-owner reads are forced to published-only, overriding
      // whatever status the client requested so drafts never leak. (Task #2199)
      if (restrictHelpToPublished) {
        filterObj = { ...(filterObj || {}), status: 'published' };
      }

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

      const { data, error, count } = await query;
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
      
      // SECURITY (Task #1421): group-linked forum categories/threads/posts are
      // private to that group's members. The query above is only tenant-scoped,
      // so trim group-private rows for non-privileged callers. Tenant admins and
      // members with `forum.management` keep full access (admin ForumManagement).
      if (entityNorm === 'forumcategory' || entityNorm === 'forumthread' || entityNorm === 'forumpost') {
        const isPrivileged = !!tenantCtx.tenantUserId || (tenantCtx.roleId
          ? await hasFeatureAccess(tenantCtx.roleId, 'forum.management')
          : false);
        const filtered = await filterForumReadRows({
          entityNorm,
          rows: data || [],
          memberId: tenantCtx.memberId,
          isPrivileged,
        });
        if (wantsCount) {
          // The DB-level `count` ignores both the row limit AND the group-private
          // filtering applied above. filterForumReadRows is all-or-nothing per
          // owning category, so a result set that survives filtering is fully
          // accessible and its count is safe to expose; a set that was entirely
          // filtered out (or genuinely empty) must report 0 so we never leak the
          // size of a group-private category to a non-member.
          const safeCount = filtered && filtered.length > 0 ? (count ?? 0) : 0;
          return res.json({ data: filtered || [], count: safeCount });
        }
        return res.json(filtered || []);
      }

      // SECURITY (Task #3306): resource categories can be restricted to member
      // roles via excluded_role_ids. Trim restricted categories from list reads
      // for non-privileged member callers so they never appear in filters or
      // pickers. Categories with no exclusions are untouched (current behaviour).
      if (entityNorm === 'resourcecategory') {
        const rows = data || [];
        // Task #3320: subcategory-level exclusions also count as restrictions.
        const anyRestricted = rows.some((c) => isCategoryRestricted(c) || hasSubcategoryRestrictions(c));
        let visibleRows = rows;
        if (anyRestricted) {
          const isPrivileged = !!tenantCtx.tenantUserId
            || await hasAdminAccess(tenantCtx)
            || (tenantCtx.roleId
              ? await hasFeatureAccess(tenantCtx.roleId, 'content.resource-management')
              : false);
          const viewer = { roleId: tenantCtx.roleId, isPrivileged };
          visibleRows = filterCategoriesForViewer(rows, viewer);
          if (!isPrivileged) {
            // Non-privileged members never see role-excluded subcategory names
            // or the exclusion data itself (Task #3320).
            visibleRows = visibleRows.map((c) =>
              stripCategoryAccessFields(filterCategorySubcategoriesForViewer(c, viewer)));
          }
        }
        if (wantsCount) {
          // The DB `count` ignores post-filtering. When the page holds the
          // complete result set (offset 0 and fewer rows than the effective
          // limit — the normal case, category tables are tiny) the visible
          // length is EXACT. Otherwise return the visible length as a
          // conservative lower bound: it never overstates, so count-based
          // pagination can't fabricate phantom pages of restricted rows.
          const offsetNum = offset ? parseInt(offset) : 0;
          const effLimit = limit ? parseInt(limit) : 1000; // PostgREST default cap
          const complete = offsetNum === 0 && rows.length < effLimit;
          const safeCount = complete
            ? visibleRows.length
            : Math.max(visibleRows.length, 0);
          return res.json({ data: visibleRows, count: safeCount });
        }
        return res.json(visibleRows);
      }

      // SECURITY (Task #3100): internal notes on support ticket conversations
      // are staff-only. Filter them out server-side for non-staff callers so
      // members never receive them, regardless of client behaviour.
      if (entityNorm === 'supportticketresponse') {
        const staff = await isSupportStaff(tenantCtx);
        const visibleRows = filterInternalNotesForViewer(data || [], staff);
        if (wantsCount) {
          return res.json({ data: visibleRows, count: visibleRows.length });
        }
        return res.json(visibleRows);
      }

      if (wantsCount) {
        return res.json({ data: data || [], count: count ?? 0 });
      }

      return res.json(data || []);

    } else if (req.method === 'POST') {
      // Create entity
      console.log(`POST to ${tableName}:`, JSON.stringify(req.body));
      
      // Sanitize empty strings to null for UUID fields to avoid "invalid input syntax for type uuid" errors
      // Only modify fields that are already present in the request body
      const sanitizedBody = { ...req.body };
      const uuidFields = ['role_id', 'organization_id', 'organization_group_id', 'member_id', 'parent_id', 'form_id', 'event_id', 'related_event_id',
                          'category_id', 'template_id', 'workflow_id', 'speaker_id', 'created_by', 'updated_by',
                          'organisation_award_id', 'offline_award_id', 'engagement_award_id', 'award_id'];
      for (const field of uuidFields) {
        if (field in sanitizedBody && sanitizedBody[field] === '') {
          sanitizedBody[field] = null;
        }
      }

      // SECURITY (Task #3371): the static "AI generated" page class stores
      // pre-sanitized HTML/CSS on the page row. Those fields are only ever
      // written through platform tooling (api/_lib/staticPageContent.js —
      // sanitize + scope at store time); the generic API refuses to create
      // ai_static pages or accept their content fields.
      if (entityNorm === 'ieditpage') {
        if (sanitizedBody.builder_type === 'ai_static') {
          return res.status(403).json({
            error: 'AI-generated static pages are created via platform tooling only',
          });
        }
        delete sanitizedBody.static_html;
        delete sanitizedBody.static_css;
      }

      // Training fund balances are ledger-backed: every change must go
      // through a path that writes a training_fund_transaction row
      // atomically (RPCs / the admin adjust endpoint). Strip them from
      // generic Organization creates so no client code can bypass the ledger.
      if (entityNorm === 'organization') {
        const stripped = stripProtectedOrgBalanceFields(sanitizedBody);
        if (stripped.length > 0) {
          console.warn(`[Entity API] Stripped protected training fund balance field(s) from Organization create: ${stripped.join(', ')}`);
        }
        // SECURITY: an organisation may only be assigned to an Organisation
        // Group belonging to the same tenant (null = ungrouped is fine).
        if (sanitizedBody.organization_group_id) {
          const effectiveTenantId = tenantCtx.tenantId || tenantCtx.effectiveTenantId;
          if (!effectiveTenantId) {
            return res.status(403).json({ error: 'Tenant context required to assign an organisation group' });
          }
          const { data: targetGroup } = await supabase
            .from('organization_group')
            .select('id, tenant_id')
            .eq('id', sanitizedBody.organization_group_id)
            .single();
          if (!targetGroup || targetGroup.tenant_id !== effectiveTenantId) {
            return res.status(403).json({ error: 'Organisation group not found in this tenant' });
          }
        }
      }

      // SECURITY (Task #3330): survey submissions must go through the public
      // form-submission endpoint — the only path that validates answers
      // against the published version snapshot, computes scores server-side,
      // writes normalised survey_answer rows and enforces anonymity/dedupe.
      // Direct generic FormSubmission creation would bypass all of it.
      if (entityNorm === 'formsubmission' && sanitizedBody.form_id) {
        const { data: targetForm } = await supabase
          .from('form')
          .select('form_type')
          .eq('id', sanitizedBody.form_id)
          .eq('tenant_id', tenantCtx.tenantId)
          .maybeSingle();
        if (targetForm?.form_type === 'survey') {
          return res.status(400).json({
            error: 'Survey responses must be submitted via the public form submission endpoint'
          });
        }
      }

      // SECURITY (Task #3330): surveys are created draft-only — 'published'
      // status exists ONLY via the publish endpoint (which snapshots a
      // version). A directly-created "published" survey would serve publicly
      // with no snapshot to score against.
      if (entityNorm === 'form' && sanitizedBody.form_type === 'survey'
          && sanitizedBody.survey_settings && typeof sanitizedBody.survey_settings === 'object'
          && sanitizedBody.survey_settings.status === 'published') {
        sanitizedBody.survey_settings = { ...sanitizedBody.survey_settings, status: 'draft' };
      }
      // Audit log is SERVER-authored: ignore any client-supplied history and
      // start surveys with a single server-written create entry.
      if (entityNorm === 'form') {
        delete sanitizedBody.survey_audit_log;
        if (sanitizedBody.form_type === 'survey') {
          sanitizedBody.survey_audit_log = [
            { action: 'create', at: new Date().toISOString(), actor: tenantCtx?.memberId || null }
          ];
        }
      }

      // SupportTicket: ensure created_date is always populated at creation time
      // so the card on SupportManagement never shows "Date not recorded".
      if (entityNorm === 'supportticket' && !sanitizedBody.created_date) {
        sanitizedBody.created_date = new Date().toISOString();
      }

      // SECURITY (Task #3306): excluded_role_ids is an access-control field on
      // resource categories. Only admins / resource managers may set it at
      // creation time — mirrors the PATCH guard in [id].js.
      if (entityNorm === 'resourcecategory'
          && (Object.prototype.hasOwnProperty.call(sanitizedBody, 'excluded_role_ids')
            || Object.prototype.hasOwnProperty.call(sanitizedBody, 'subcategory_excluded_role_ids'))) {
        const canManage = !!tenantCtx.tenantUserId
          || await hasAdminAccess(tenantCtx)
          || (tenantCtx.roleId
            ? await hasFeatureAccess(tenantCtx.roleId, 'content.resource-management')
            : false);
        if (!canManage) {
          return res.status(403).json({ error: 'Not authorized to set resource category access' });
        }
      }

      // INTEGRITY (Task #3419, opened up in Task #3512): agenda lines may
      // attach to any regular (non-complex) event in the caller's own tenant.
      // Complex events are blocked implicitly: they live in complex_event, so
      // the event-table lookup 404s. Also require a start_date.
      if (entityNorm === 'eventagendaitem') {
        if (!sanitizedBody.event_id) {
          return res.status(400).json({ error: 'event_id is required for agenda items' });
        }
        if (!sanitizedBody.start_date) {
          return res.status(400).json({ error: 'start_date is required for agenda items' });
        }
        const { data: parentEvent, error: parentErr } = await supabase
          .from('event')
          .select('id, tenant_id')
          .eq('id', sanitizedBody.event_id)
          .single();
        if (parentErr || !parentEvent
            || !tenantCtx.tenantId || parentEvent.tenant_id !== tenantCtx.tenantId) {
          return res.status(404).json({ error: 'Event not found' });
        }
      }

      // SECURITY (Task #3100): only support staff may create internal notes.
      // Internal notes are always admin responses; non-staff callers are
      // rejected outright rather than silently downgraded.
      if (entityNorm === 'supportticketresponse' && sanitizedBody.is_internal_note === true) {
        const staff = await isSupportStaff(tenantCtx);
        if (!staff) {
          return res.status(403).json({ error: 'Only support staff can create internal notes' });
        }
        sanitizedBody.is_admin_response = true;
      }

      // Resource (Task #1701): auto-tag a group-created resource with its
      // group's linked subcategories when the caller didn't supply any, so it
      // surfaces tenant-wide under the matching filter.
      if (isResourceEntity(entity)) {
        await applyGroupResourceSubcategoryDefaults(sanitizedBody);
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

      // MemberGroupAssignment terms agreement: `terms_agreed` is not a column on
      // member_group_assignment; pop it here and use it for self-join enforcement.
      let memberGroupTermsAgreed = false;
      if (entityNorm === 'membergroupassignment' && 'terms_agreed' in sanitizedBody) {
        memberGroupTermsAgreed = sanitizedBody.terms_agreed === true;
        delete sanitizedBody.terms_agreed;
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

          // Some MEMBER-scoped tables also carry a required tenant_id column
          // (e.g. member_inbox_folder, member_inbox_message_state). For those,
          // force tenant_id from the session so the insert satisfies the NOT NULL
          // constraint and can never be pointed at another tenant. MEMBER-scoped
          // entities WITHOUT a tenant_id column are intentionally excluded so we
          // never send a spurious tenant_id and break their inserts.
          const memberEntitiesWithTenantId = ['MemberInboxFolder', 'MemberInboxMessageState'];
          if (memberEntitiesWithTenantId.includes(entity) && tenantCtx.tenantId) {
            sanitizedBody.tenant_id = tenantCtx.tenantId;
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
            'MemberGroupClassification',
            'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
            'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'FormSubmission', 'ResourceCategory', 'Resource',
            'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField',
            'EmailTemplate', 'Workflow', 'WorkflowLog', 'ButtonStyle', 'TypographyStyle',
            'ArticleComment', 'ArticleReaction', 'ArticleView', 'CommentReaction', 'BlogPost',
            'WallOfFameSection', 'WallOfFameCategory', 'WallOfFamePerson',
            'MemberGroup', 'MemberGroupAssignment', 'MemberGroupGuest', 'GuestWriter',
            'CommunicationCategory', 'CommunicationCategoryRole',
            'ForumCategory', 'ForumThread', 'ForumPost', 'ForumReaction', 'ForumReport', 'ForumModerationLog',
            'MemberBookmark', 'MemberMembershipHistory', 'MemberMembershipInvoicing',
            'Role', 'Speaker', 'ResourceView',
            'Award', 'OfflineAward', 'OfflineAwardAssignment', 'EngagementAward', 'EngagementAwardAssignment',
            'OrganisationAward', 'OrganisationAwardAssignment', 'AwardClassification', 'AwardSublevel', 'Badge',
            'DynamicDirectory',
            'IEditPage', 'IEditPageElement', 'IEditPageFolder',
            'ComplexEvent', 'ComplexEventTrack', 'ComplexEventSession', 'ComplexEventTicketClass', 'ComplexEventBooking',
            'EventSponsor', 'EventSponsorCategory', 'EventSponsorAssignment', 'EventSurveyAssignment',
            'ArticleBrief', 'ArticleBriefVersion', 'ArticleBriefComment', 'ArticleBriefActivity',
            'ExternalWriter', 'ExternalWriterDocument',
            'CrmTagColor',
            'Vacancy', 'VacancyApplication', 'VacancyAward', 'VacancyDecline', 'VacancyDecisionEmail',
            'Gallery', 'GalleryPhoto', 'CardDeck',
            'SupportTicket', 'SupportTicketResponse', 'Microsite', 'InstalledFont',
            'EventAgendaItem', 'EventCostLine', 'OrganizationGroup'
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

      // Task #1414: saved filter views are personal — force ownership to the
      // requesting member and never persist an organization_id (no such column).
      if (entityNorm === 'formsubmissionsavedview') {
        if (!tenantCtx.memberId) {
          return res.status(403).json({ error: 'Member context required to save a view' });
        }
        sanitizedBody.member_id = tenantCtx.memberId;
        delete sanitizedBody.organization_id;
      }

      // Task #1536: expressing interest in a vacancy is personal — force the
      // applicant to the requesting member (no spoofing), and reject duplicate
      // applications for the same vacancy by the same member.
      if (entityNorm === 'vacancyapplication') {
        if (!tenantCtx.memberId) {
          return res.status(403).json({ error: 'Member context required to express interest' });
        }
        sanitizedBody.member_id = tenantCtx.memberId;
        if (!sanitizedBody.vacancy_id) {
          return res.status(400).json({ error: 'vacancy_id is required' });
        }
        const { data: existingApp } = await supabase
          .from('vacancy_application')
          .select('id')
          .eq('vacancy_id', sanitizedBody.vacancy_id)
          .eq('member_id', tenantCtx.memberId)
          .maybeSingle();
        if (existingApp) {
          return res.status(409).json({ error: 'You have already expressed interest in this vacancy' });
        }
      }

      // Task #1550: awarding a vacancy position is performed by a group admin —
      // force the recorded "awarded by" to the requesting member (no spoofing)
      // and reject awarding the same member the same vacancy twice.
      if (entityNorm === 'vacancyaward') {
        if (!tenantCtx.memberId) {
          return res.status(403).json({ error: 'Member context required to award a position' });
        }
        sanitizedBody.awarded_by_member_id = tenantCtx.memberId;
        if (!sanitizedBody.vacancy_id) {
          return res.status(400).json({ error: 'vacancy_id is required' });
        }
        if (!sanitizedBody.awarded_member_id) {
          return res.status(400).json({ error: 'awarded_member_id is required' });
        }
        const { data: existingAward } = await supabase
          .from('vacancy_award')
          .select('id')
          .eq('vacancy_id', sanitizedBody.vacancy_id)
          .eq('awarded_member_id', sanitizedBody.awarded_member_id)
          .maybeSingle();
        if (existingAward) {
          return res.status(409).json({ error: 'This member has already been awarded this vacancy' });
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
      
      // FormSubmission duplicate guard (Task: stop double authenticated
      // submissions): the canvas/iEdit form block sends the same per-session
      // idempotency_key the public endpoint uses. If a submission with the
      // same (form_id, idempotency_key) already exists, return the ORIGINAL
      // row as a normal success (201) instead of creating a second one — the
      // unique partial index on (form_id, idempotency_key) makes this
      // race-proof via the 23505 handling on the insert below.
      let formSubmissionIdemKey = null;
      if (entityNorm === 'formsubmission') {
        const rawKey = sanitizedBody.idempotency_key;
        formSubmissionIdemKey =
          (typeof rawKey === 'string' && rawKey.trim().length >= 8 && rawKey.trim().length <= 128)
            ? rawKey.trim()
            : null;
        if (formSubmissionIdemKey) {
          sanitizedBody.idempotency_key = formSubmissionIdemKey;
          if (sanitizedBody.form_id) {
            let idemLookup = supabase
              .from('form_submission')
              .select('*')
              .eq('form_id', sanitizedBody.form_id)
              .eq('idempotency_key', formSubmissionIdemKey);
            if (sanitizedBody.tenant_id) {
              idemLookup = idemLookup.eq('tenant_id', sanitizedBody.tenant_id);
            }
            const { data: existing, error: idemErr } = await idemLookup.maybeSingle();
            if (idemErr && idemErr.code !== '42703') {
              console.error('[Entity POST] FormSubmission idempotency lookup failed:', idemErr);
              return res.status(500).json({ error: 'Failed to validate submission' });
            }
            if (existing) {
              console.log('[Entity POST] FormSubmission duplicate idempotency key — returning original row', existing.id);
              // `duplicate: true` marker lets the client skip re-running
              // post-submit side effects (confirmation emails, entity
              // pipelines) for the collapsed second attempt.
              return res.status(201).json({ ...existing, duplicate: true });
            }
          }
        } else if ('idempotency_key' in sanitizedBody) {
          // Malformed key: drop it rather than persisting junk.
          delete sanitizedBody.idempotency_key;
        }

        // Conditional-logic submit control (Task #3474): the authenticated
        // embedded/canvas form flow creates form_submission rows through this
        // entity API (not api/public/form-submission.js), so the STORED
        // form rules must also be enforced here BEFORE the insert. The client
        // disables the Submit button with the same shared evaluator, so this
        // only fires when the UI was bypassed.
        if (sanitizedBody.form_id) {
          const { data: submitControlForm, error: submitControlFormError } = await supabase
            .from('form')
            .select('visibility_rules, tenant_id')
            .eq('id', sanitizedBody.form_id)
            .maybeSingle();
          if (submitControlFormError) {
            console.error('[Entity POST] FormSubmission submit-control rules lookup failed:', submitControlFormError);
            return res.status(500).json({ error: 'Failed to validate submission rules' });
          }
          // Task #3477: LMIC operators compare against the tenant's STORED
          // LMIC list so submit rules can't be bypassed.
          const submitControlOptions = {};
          if (rulesUseLmicOperators(submitControlForm?.visibility_rules)) {
            const { loadTenantLmicCodes } = await import('../../_lib/tenantLmicCodes.js');
            submitControlOptions.lmicCodes = await loadTenantLmicCodes(supabase, submitControlForm?.tenant_id);
          }
          const submitControl = resolveSubmitControl(
            submitControlForm?.visibility_rules,
            sanitizedBody.submission_data || {},
            submitControlOptions
          );
          if (submitControl.disabled) {
            return res.status(400).json({
              error: submitControl.message || 'This form cannot be submitted with the current answers.',
              code: 'SUBMIT_DISABLED_BY_RULE',
            });
          }
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
            .select('id, tenant_id, is_active, allow_self_join, self_join_closed, default_self_join_role, roles, terms_of_reference')
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
          if (group.self_join_closed === true) {
            return res.status(403).json({ error: 'Self-join registrations for this group are currently closed' });
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
          if (group.terms_of_reference && group.terms_of_reference.trim() && !memberGroupTermsAgreed) {
            return res.status(403).json({ error: 'You must agree to the terms of reference to join this group' });
          }

        }

        // Duplicate-assignment guard: runs for ALL callers (admin and non-admin)
        // so the admin assign UI cannot create a second assignment for the same
        // member or guest in the same group. The DB unique indexes are the final
        // backstop; this check gives a cleaner 409 before the insert.
        if (sanitizedBody.group_id) {
          let dupQuery = supabase
            .from('member_group_assignment')
            .select('id')
            .eq('group_id', sanitizedBody.group_id)
            .limit(1);

          if (sanitizedBody.guest_id) {
            dupQuery = dupQuery.eq('guest_id', sanitizedBody.guest_id);
          } else if (sanitizedBody.member_id) {
            dupQuery = dupQuery.eq('member_id', sanitizedBody.member_id);
          }

          if (sanitizedBody.guest_id || sanitizedBody.member_id) {
            const { data: dupRows } = await dupQuery;
            if (dupRows && dupRows.length > 0) {
              const msg = isAdmin
                ? 'This member is already assigned to this group'
                : 'You are already a member of this group';
              return res.status(409).json({ error: msg });
            }
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

      // Task #1519: Group-Admin event-write authorization + guardrails.
      // For Event/ComplexEvent (and their children) writes by a non-tenant-admin
      // caller, restrict to administered groups and enforce free/no-zoom/audience
      // guardrails. Tenant admins pass through unchanged.
      if (isEventFamilyEntity(entity)) {
        const authz = await authorizeGroupAdminEventWrite({
          entity,
          op: 'create',
          body: sanitizedBody,
          tenantCtx,
          req,
        });
        if (!authz.ok) {
          return res.status(authz.status || 403).json({ error: authz.error });
        }
        Object.assign(sanitizedBody, authz.body);
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
          // Race-safe FormSubmission idempotency backstop: two concurrent
          // requests with the same key both pass the pre-check above; the
          // unique partial index on (form_id, idempotency_key) rejects the
          // loser here. Return the winner's row as a normal success so the
          // client's submit flow completes cleanly.
          if (tableName === 'form_submission' && formSubmissionIdemKey && sanitizedBody.form_id) {
            let winnerLookup = supabase
              .from('form_submission')
              .select('*')
              .eq('form_id', sanitizedBody.form_id)
              .eq('idempotency_key', formSubmissionIdemKey);
            if (sanitizedBody.tenant_id) {
              winnerLookup = winnerLookup.eq('tenant_id', sanitizedBody.tenant_id);
            }
            const { data: winner, error: winnerErr } = await winnerLookup.maybeSingle();
            if (winner) {
              console.log('[Entity POST] FormSubmission concurrent duplicate (unique violation) — returning original row', winner.id);
              // Same `duplicate: true` marker as the pre-check branch so the
              // client skips duplicate post-submit side effects.
              return res.status(201).json({ ...winner, duplicate: true });
            }
            console.error('[Entity POST] FormSubmission unique violation but original row not found:', winnerErr);
            return res.status(500).json({ error: 'Failed to save submission' });
          }
          // Race-safe backstop: two concurrent admin assigns beat the app-level
          // duplicate check; the DB partial unique indexes catch it here.
          if (
            error.message?.includes('uq_member_group_assignment_member') ||
            error.message?.includes('uq_member_group_assignment_guest') ||
            tableName === 'member_group_assignment'
          ) {
            return res.status(409).json({
              error: 'This member is already assigned to this group',
              code: 'DUPLICATE_ASSIGNMENT',
            });
          }
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

      // Derive base URL for workflow email placeholders (never the raw
      // VERCEL_URL deployment domain — Task #3384). Cross-checked against
      // the record's tenant so a typo'd wildcard subdomain can't leak into
      // emailed links (Task #3387).
      const baseUrl = await getTrustedBaseUrlForTenant(req, supabase, data?.tenant_id || null);
      console.log(`[Entity POST] Derived baseUrl: "${baseUrl}"`);
      console.log(`[Entity POST] Request headers:`, JSON.stringify({
        'x-forwarded-proto': req.headers['x-forwarded-proto'],
        'x-forwarded-host': req.headers['x-forwarded-host'],
        'host': req.headers.host
      }));

      // Trigger workflow evaluation for new Organization/Member/JobPosting (non-blocking)
      //
      // Custom-field values do NOT arrive in this request: the admin UI
      // creates the member/organization here, then saves each custom field
      // with separate MemberPreferenceValue / OrganizationPreferenceValue
      // POSTs afterwards. So record_create workflows whose conditions
      // reference custom fields evaluate against empty values here and log a
      // 'skipped' row. Task 3197: those workflows are re-checked when the
      // preference values for the just-created record arrive (see the
      // recheckRecordCreateWorkflows call in the preference-value branch
      // below), with a no-duplicate guard for all trigger modes.
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

          // Task 3197: if this preference value belongs to a just-created
          // member/organization (admin UI create dialog saves custom fields
          // AFTER the record POST), re-evaluate record_create workflows whose
          // custom-field conditions saw empty values at create time. The
          // helper only re-checks never-executed workflows for records
          // created within the last few minutes, so nothing fires twice.
          try {
            await recheckRecordCreateWorkflows(entityType, entityId, baseUrl);
          } catch (err) {
            console.error('[Entity POST] record_create re-check error:', err);
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

      // Task #2363: keep the Member AI Knowledge Assistant index fresh on save.
      if (['blogpost', 'newspost', 'event', 'resource', 'complexevent'].includes(entityNorm) && data && supabase) {
        reindexMemberContentEntitySafe(entity, data).catch(() => {});
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

      // Support ticket: auto-assign from area config, then notify
      if (entityNorm === 'supportticket' && data && data.tenant_id) {
        const autoAssignAndNotify = async () => {
          // Only auto-assign when the ticket has an area and no explicit assignee
          if (data.area && !data.assigned_to) {
            try {
              const assigneeId = await resolveAreaAssignee(data.tenant_id, data.area);
              if (assigneeId) {
                const { error: updateErr } = await supabase
                  .from('support_ticket')
                  .update({ assigned_to: assigneeId })
                  .eq('id', data.id);
                if (updateErr) {
                  console.error('[Entity POST] SupportTicket auto-assign update failed:', updateErr.message);
                } else {
                  console.log(`[Entity POST] SupportTicket ${data.id} auto-assigned to member ${assigneeId} via area "${data.area}"`);
                }
              }
            } catch (err) {
              console.error('[Entity POST] SupportTicket auto-assign error:', err);
            }
          }
          await sendSupportNotification({
            tenantId: data.tenant_id,
            ticketId: data.id,
            eventType: 'new_ticket',
            performedByMemberId: tenantCtx.memberId || null,
            metadata: {},
          });
        };
        autoAssignAndNotify().catch(err => {
          console.error('[Entity POST] SupportTicket auto-assign/notification error:', err);
        });
      }

      // Task #3100: internal notes are staff-only context — they must never
      // trigger member notifications (no email, no member inbox item).
      if (entityNorm === 'supportticketresponse' && data && data.ticket_id && data.is_internal_note !== true) {
        // Resolve tenant_id for the response (stored on the ticket, not the response row)
        const resolveAndNotify = async () => {
          let responseTenantId = data.tenant_id || null;
          if (!responseTenantId) {
            const { data: ticket } = await supabase
              .from('support_ticket')
              .select('tenant_id')
              .eq('id', data.ticket_id)
              .maybeSingle();
            responseTenantId = ticket?.tenant_id || null;
          }
          if (!responseTenantId) return;

          const isAdminResponse = data.is_admin_response === true;
          const replyExcerpt = (data.message || '').substring(0, 300);

          await sendSupportNotification({
            tenantId: responseTenantId,
            ticketId: data.ticket_id,
            eventType: isAdminResponse ? 'admin_reply' : 'user_reply',
            performedByMemberId: tenantCtx.memberId || null,
            metadata: { reply_excerpt: replyExcerpt, responder_name: data.responder_name || '' },
          });
        };
        resolveAndNotify().catch(err => {
          console.error('[Entity POST] SupportTicketResponse notification error:', err);
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
        try {
          await handleMemberGroupForumChange({ entityNorm, data, beforeData: null });
        } catch (err) {
          console.error('[Entity POST] member-group forum hook failed:', err.message || err);
        }
        try {
          await handleMemberGroupFilesChange({ entityNorm, data, beforeData: null });
        } catch (err) {
          console.error('[Entity POST] member-group files hook failed:', err.message || err);
        }
        if (entityNorm === 'membergroupassignment' && data.member_id && data.group_id && data.tenant_id) {
          try {
            const { data: grp } = await supabase.from('member_group').select('name').eq('id', data.group_id).maybeSingle();
            const actorEmail = await resolveActorEmail(tenantCtx.memberId, supabase);
            await recordMemberGroupActivity({
              memberId: data.member_id,
              groupId: data.group_id,
              groupName: grp?.name || '(unknown group)',
              action: 'joined',
              actorEmail,
              tenantId: data.tenant_id,
              supabaseClient: supabase,
            });
          } catch (err) {
            console.error('[Entity POST] member-group activity record failed:', err.message || err);
          }
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
