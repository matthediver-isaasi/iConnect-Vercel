import { triggerWorkflows, triggerPreferenceWorkflows } from '../../_lib/workflows.js';
import { triggerZohoCrmSync, awaitZohoCrmSyncForResponse } from '../../_lib/zohoCrmSync.js';
import { invalidateMemberSessions } from '../../_lib/session.js';
import { supabase } from '../../_lib/database.js';
import { getTenantContext, getEntityTenantScope, getTenantColumn, TENANT_SCOPE, checkCrossOrgPermissions, checkCrossMemberPermissions, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { stripProtectedOrgBalanceFields } from '../../_lib/protectedOrgFields.js';
import { stripMemberPauseFields } from '../../_lib/memberPause.js';
import { isAdminOnlyEntity } from '../../_lib/adminOnlyEntities.js';
import { isEventFamilyEntity, authorizeGroupAdminEventWrite } from '../../_lib/groupAdminEventWrite.js';
import { checkBadgeWriteAccess } from '../../_lib/badgeAccess.js';
import { isResourceEntity, authorizeGroupAdminResourceWrite } from '../../_lib/groupAdminResourceWrite.js';
import { normalizeTenantFormResourceTarget } from '../../_lib/resourceFormTarget.js';
import { isMemberGroupAssignmentEntity, authorizeMemberGroupAdminAssignmentChange } from '../../_lib/groupAdminAssignmentLeave.js';
import { getCallerGroupManageAccess, canManageGroup } from '../../_lib/memberGroupAdminAccess.js';
import { getSession } from '../../_lib/session.js';
import { getSessionPlatformOwner } from '../../_lib/platformSession.js';
import { handleMemberGroupEntityChange } from '../../_lib/memberGroupProjectsAccess.js';
import { handleMemberGroupForumChange, filterForumReadRows } from '../../_lib/memberGroupForumAccess.js';
import { recordMemberGroupActivity, resolveActorEmail } from '../../_lib/memberGroupActivity.js';
import { dispatchWpWebhook } from '../../_lib/wpWebhook.js';
import { rebuildSearchTextForEntity } from '../../_lib/searchTextBuilder.js';
import { reindexMemberContentEntitySafe, deleteMemberContentEntitySafe } from '../../_lib/memberContentReindexHook.js';
import { syncBlogPostAuthors } from '../../_lib/blogPostAuthors.js';
import { sendBriefNotification } from '../../article-briefs/notify.js';
import { sendSupportNotification } from '../../support/notify.js';
import { getAccountingProvider } from '../../_lib/accountingProvider.js';
import { pruneSpeakerIdsFromReferences } from '../../_lib/speakerReferences.js';
import { assessAiCodePagePublishGate } from '../../_lib/aiCodeActions.js';
import { getTrustedBaseUrlForTenant } from '../../_lib/publicBaseUrl.js';
import { isCategoryRestricted, hasSubcategoryRestrictions, isCategoryVisibleToViewer, filterCategorySubcategoriesForViewer, getSubcategoryExclusionMap } from '../../_lib/resourceCategoryAccess.js';

// Entity name to Supabase table mapping (singular names for Base44 compatibility)
import { anonymizeMember } from '../../_lib/memberAnonymize.js';
import { isReservedPageSlug, reservedPageSlugMessage } from '../../../shared/memberAliases.js';
import { validatePortalMenuRecord } from '../../../shared/portalMenuLinks.js';
import { hasManagedJobProvenance, stripManagedJobProvenance } from '../../_lib/jobFeedOwnership.js';
import {
  isCorePreferenceField,
  isCorePreferenceValueEntity,
  isCustomObjectFieldWrite,
  isCustomObjectStorageEntity,
  loadCorePreferenceValueBeforeUpdate,
} from '../../_lib/customObjectApiBoundary.js';
import { authorizeGenericCommunicationPreferenceAccess } from '../../_lib/communicationPreferenceGenericAccess.js';
import {
  validateAutomaticMembershipSettings,
  fetchAllowedCustomFieldIdsByScope,
  buildFieldMeta,
  roleExistsInGroup,
  authorizeAutomaticMembershipPolicyWrite,
} from '../../_lib/automaticMembership.js';
import {
  isSpeakerMemberUniqueViolation,
  validateSpeakerMemberLink,
} from '../../_lib/speakerMemberLink.js';
import { validateFormAccessPolicy } from '../../_lib/formAccessPolicy.js';
import { authorizeAndCheckTeamRoleAssignment, validateAssignableRoleIds } from '../../_lib/teamRoleAssignment.js';
import { checkRoleMutationAccess } from '../../_lib/roleMutationAccess.js';
import { remapGroupRolePolicy } from '../../../client/src/lib/memberGroupRoleNames.js';
import { createFormRelationshipService, FormRelationshipError } from '../../_lib/formRelationshipOptions.js';
import { validateRepeatableRowSubmission } from '../../_lib/formRepeatableRowValidation.js';
import {
  preserveFormNotListedLabelSnapshots,
  snapshotFormNotListedLabels,
} from '../../../shared/formNotListedChoice.js';
import {
  StructuredActionContractError,
  validateStructuredActionsContract,
} from '../../_lib/formStructuredActions.js';
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
  'FormSubmissionSavedView': 'form_submission_saved_view',
  'NewsPost': 'news_post',
  'SupportTicket': 'support_ticket',
  'SupportTicketResponse': 'support_ticket_response',
  'PortalNavigationItem': 'portal_navigation_item',
  'MemberGroup': 'member_group',
  'MemberGroupAssignment': 'member_group_assignment',
  'MemberGroupActivity': 'member_group_activity',
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
  'OrganizationGroupPreferenceValue': 'organization_group_preference_value',
  'Speaker': 'speaker',
  'TypographyStyle': 'typography_style',
  'InstalledFont': 'installed_font',
  'EventAgendaItem': 'event_agenda_item',
  'EventCostLine': 'event_cost_line',
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
  'HelpArticle': 'help_article',
};

const getTableName = (entity) => entityToTable[entity] || entity.toLowerCase().replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');

export default async function handler(req, res) {
  const { entity, id } = req.query;
  console.log(`[Entity ${req.method}] Incoming request: entity="${entity}", id="${id}"`);
  
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tableName = getTableName(entity);

  // Get tenant context from session
  const tenantCtx = await getTenantContext(req);

  const genericPreferenceAccessError = await authorizeGenericCommunicationPreferenceAccess(
    entity,
    tenantCtx,
    { hasAdminAccess },
    req.method,
  );
  if (genericPreferenceAccessError) {
    return res
      .status(genericPreferenceAccessError.status)
      .json({ error: genericPreferenceAccessError.error });
  }

  // Stale-tab guard: session tenant differs from the intended tenant for this request
  if (tenantCtx.tenantMismatch) {
    return res.status(409).json({
      error: 'Your browser session has switched to a different organisation. Reload this tab to continue.',
      code: 'TENANT_CONTEXT_CHANGED',
    });
  }

  const tenantScope = getEntityTenantScope(entity);
  
  // Determine if tenant filtering should be applied
  const shouldApplyTenantFilter = tenantScope !== TENANT_SCOPE.GLOBAL;
  
  let allowsTenantWideAccess = false;

  const entityNorm = entity.replace(/[-_]/g, '').toLowerCase();
  if (entityNorm === 'role' && req.method !== 'GET') {
    const roleAccess = await checkRoleMutationAccess(tenantCtx, hasAdminAccess);
    if (!roleAccess.ok) {
      return res.status(roleAccess.status).json({ error: roleAccess.error });
    }
  }
  if (isCustomObjectStorageEntity(entityNorm)) {
    return res.status(403).json({
      error: 'Custom Object data must be accessed through the Custom Object service',
    });
  }
  if (isAdminOnlyEntity(entityNorm)) {
    if (!tenantCtx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const isAdmin = await hasAdminAccess(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }

  // Protect the server-owned organisation member disclosure policy on update.
  if (req.method === 'PATCH' || req.method === 'PUT') {
    let writesViewMembersPolicy = entityNorm === 'dynamicdirectory'
      && Object.prototype.hasOwnProperty.call(req.body || {}, 'view_members_role_ids');
    if (entityNorm === 'systemsettings') {
      writesViewMembersPolicy = req.body?.setting_key === 'org_directory_view_members_role_ids';
      if (!writesViewMembersPolicy) {
        const { data: existingSetting } = await supabase
          .from('system_settings')
          .select('setting_key')
          .eq('id', id)
          .eq('tenant_id', tenantCtx.tenantId)
          .limit(1);
        writesViewMembersPolicy =
          existingSetting?.[0]?.setting_key === 'org_directory_view_members_role_ids';
      }
    }
    if (writesViewMembersPolicy) {
      const canManage = await hasAdminAccess(tenantCtx)
        || (
          tenantCtx.roleId
          && await hasFeatureAccess(
            tenantCtx.roleId,
            entityNorm === 'systemsettings'
              ? 'membership.organisation-directory-settings'
              : 'page_DynamicDirectoryManagement'
          )
        );
      if (!canManage) {
        return res.status(403).json({ error: 'Directory settings access required' });
      }
    }
  }

  // SECURITY (Task #3330): survey version snapshots and normalised survey
  // answers are server-authoritative records. Writes go ONLY through the
  // publish endpoint / public submission endpoint (service role); reads are
  // admin-gated (reporting surfaces).
  // Task #3331: event survey assignments are written ONLY via the guarded
  // /api/surveys/event-assignments endpoint (archive-not-delete, token
  // generation, cross-tenant event checks). Generic API is read-only,
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

  // SECURITY: organisation-group custom field values are written ONLY via the
  // guarded /api/entities/organization-group-preference-value/upsert endpoint
  // (admin check + group/field tenant-and-scope validation). Generic API is
  // read-only, admin-gated.
  if (entityNorm === 'organizationgrouppreferencevalue') {
    if (req.method !== 'GET') {
      return res.status(403).json({ error: 'Group custom field values must be written via the upsert endpoint' });
    }
    if (!tenantCtx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const isAdmin = await hasAdminAccess(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }

  // SECURITY: custom field DEFINITIONS are admin-managed. Reads stay open to
  // authenticated members (directory/profile surfaces render field metadata),
  // but update/delete require admin — the Custom Fields page gate is
  // client-side only and is not an authorization boundary.
  if (entityNorm === 'preferencefield' && req.method !== 'GET') {
    if (!tenantCtx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const isAdmin = await hasAdminAccess(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (req.method === 'PATCH' && isCustomObjectFieldWrite(req.body)) {
      return res.status(403).json({
        error: 'Custom Object fields must be managed through the Custom Object service',
      });
    }

    let objectFieldQuery = supabase
      .from('preference_field')
      .select('entity_scope')
      .eq('id', id);
    if (tenantCtx.tenantId) {
      objectFieldQuery = objectFieldQuery.eq('tenant_id', tenantCtx.tenantId);
    }
    const { data: existingField, error: existingFieldError } = await objectFieldQuery.maybeSingle();
    if (existingFieldError) {
      console.error('[PreferenceField] Custom Object boundary lookup failed:', existingFieldError.message);
      return res.status(500).json({ error: 'Failed to validate field ownership' });
    }
    if (existingField?.entity_scope === 'custom_object') {
      return res.status(403).json({
        error: 'Custom Object fields must be managed through the Custom Object service',
      });
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
  //  - reads require a logged-in user, and non-owners are restricted to
  //    published rows so drafts return 404. (Task #2199)
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
  
  // For non-global entities, require authentication and valid tenant context
  if (shouldApplyTenantFilter) {
    if (!tenantCtx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // For tenant-scoped entities, require a valid tenant_id or organization_id
    if (tenantScope === TENANT_SCOPE.TENANT && !tenantCtx.tenantId && !tenantCtx.organizationId) {
      return res.status(403).json({ error: 'Member must belong to an organization to access this resource' });
    }
    // For organization-scoped entities, require a valid organization_id OR tenant_id (tenant owners can access all orgs in their tenant)
    if (tenantScope === TENANT_SCOPE.ORGANIZATION && !tenantCtx.organizationId && !tenantCtx.tenantId) {
      return res.status(403).json({ error: 'Member must belong to an organization to access this resource' });
    }
    // For member-scoped entities, check role-based cross-member access
    if ((entity === 'OrganizationPreferenceValue' || entity === 'ComplexEvent' || entity === 'ComplexEventTrack' || entity === 'ComplexEventSession' || entity === 'ComplexEventTicketClass') && tenantCtx.tenantId) {
      allowsTenantWideAccess = true;
    }
    if (entity === 'MemberPreferenceValue' && tenantCtx.tenantId && tenantCtx.roleId) {
      const { hasCrossMemberAccess } = await checkCrossMemberPermissions(tenantCtx.roleId);
      if (hasCrossMemberAccess) {
        allowsTenantWideAccess = true;
      }
    }
    if (tenantScope === TENANT_SCOPE.MEMBER && !tenantCtx.memberId && !allowsTenantWideAccess) {
      return res.status(403).json({ error: 'Invalid member context' });
    }
  }

  try {
    if (req.method === 'GET') {
      const { expand } = req.query;
      let query = supabase
        .from(tableName)
        .select(expand || '*')
        .eq('id', id);

      if (entityNorm === 'preferencefield') {
        query = query.or('entity_scope.is.null,entity_scope.neq.custom_object');
      }

      // Help Center: non-owner by-id reads are restricted to published rows so a
      // draft slug/id returns 404 rather than exposing unpublished content. (Task #2199)
      if (restrictHelpToPublished) {
        query = query.eq('status', 'published');
      }

      // Apply tenant isolation filter for single-entity GET (always applied for non-global entities)
      if (shouldApplyTenantFilter) {
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          if (allowsTenantWideAccess) {
            // Access controlled by RBAC - no member_id filter needed for by-ID access
          } else {
            query = query.eq('member_id', tenantCtx.memberId);
          }
        } else if (tenantScope === TENANT_SCOPE.ORGANIZATION) {
          // Tenant admins can access any org in their tenant via inner join filter
          // Regular members can only access their own organization
          if (tenantCtx.tenantId) {
            query = query.eq('organization.tenant_id', tenantCtx.tenantId);
          } else if (tenantCtx.organizationId) {
            query = query.eq('organization_id', tenantCtx.organizationId);
          }
        } else if (entity === 'Organization') {
          // Organization entity: verify belongs to same tenant or is member's org
          if (tenantCtx.tenantId) {
            query = query.eq('tenant_id', tenantCtx.tenantId);
          } else {
            query = query.eq('id', tenantCtx.organizationId);
          }
        } else if (entityNorm === 'formsubmissionsavedview') {
          // Task #1414: personal saved views are addressable only by their owner.
          if (!tenantCtx.memberId) return res.status(404).json({ error: 'Not found' });
          if (tenantCtx.tenantId) query = query.eq('tenant_id', tenantCtx.tenantId);
          query = query.eq('member_id', tenantCtx.memberId);
        } else if (tenantScope === TENANT_SCOPE.TENANT) {
          // Tenant-scoped entities: filter by tenant_id or fall back to organization_id
          // These entities have been fully migrated to tenant_id only (no organization_id column):
          const entitiesWithoutOrgId = [
            'MemberGroupClassification',
            'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
            'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'ResourceCategory', 'Resource',
            'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField',
            'ButtonStyle', 'TypographyStyle', 'BlogPost',
            'CommunicationCategory', 'CommunicationCategoryRole',
            'ForumCategory', 'ForumThread', 'ForumPost', 'ForumReaction', 'ForumReport', 'ForumModerationLog',
            'MemberBookmark', 'Role', 'Speaker', 'ResourceView',
            'Award', 'OfflineAward', 'OfflineAwardAssignment', 'EngagementAward', 'EngagementAwardAssignment',
            'OrganisationAward', 'OrganisationAwardAssignment', 'AwardClassification', 'AwardSublevel', 'Badge',
            'DynamicDirectory',
            'IEditPage', 'IEditPageElement', 'IEditPageFolder',
            'ComplexEvent', 'ComplexEventTrack', 'ComplexEventSession', 'ComplexEventTicketClass',
            'EventSponsor', 'EventSponsorCategory', 'EventSponsorAssignment', 'EventSurveyAssignment',
            'ArticleBrief', 'ArticleBriefVersion', 'ArticleBriefComment', 'ArticleBriefActivity',
            'ExternalWriter', 'ExternalWriterDocument',
            'CrmTagColor',
            'Gallery', 'GalleryPhoto', 'CardDeck',
            'MemberGroupActivity', 'Microsite', 'InstalledFont',
            'EventAgendaItem', 'EventCostLine', 'OrganizationGroup', 'OrganizationGroupPreferenceValue'
          ];
          if (tenantCtx.tenantId) {
            query = query.eq('tenant_id', tenantCtx.tenantId);
          } else if (!entitiesWithoutOrgId.includes(entity) && tenantCtx.organizationId) {
            query = query.eq('organization_id', tenantCtx.organizationId);
          }
        }
      }
      
      // SECURITY: Mirror the IEditPage / IEditPageElement draft gate from
      // the list endpoint. Without `site-builder.page-editor`, members can
      // only fetch published pages by id (and elements that belong to
      // published pages). Tenant users (admin dashboard) keep full access.
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
          const { data: elementRow } = await supabase
            .from('i_edit_page_element')
            .select('page_id')
            .eq('id', id)
            .single();
          if (!elementRow?.page_id) return res.status(404).json({ error: 'Not found' });
          const { data: parentPage } = await supabase
            .from('i_edit_page')
            .select('status')
            .eq('id', elementRow.page_id)
            .single();
          if (parentPage?.status !== 'published') {
            return res.status(404).json({ error: 'Not found' });
          }
        }
      }

      const { data, error } = await query.single();

      if (error) {
        if (error.code === 'PGRST116') return res.status(404).json({ error: 'Not found' });
        return res.status(500).json({ error: error.message });
      }

      if (isCorePreferenceValueEntity(entityNorm)) {
        try {
          const allowed = await isCorePreferenceField({
            supabase,
            tenantId: tenantCtx.effectiveTenantId || tenantCtx.tenantId,
            fieldId: data?.field_id,
          });
          if (!allowed) return res.status(404).json({ error: 'Not found' });
        } catch (boundaryError) {
          console.error('[Entity GET by id] Preference value field boundary failed:', boundaryError.message);
          return res.status(500).json({ error: 'Failed to validate custom field ownership' });
        }
      }

      // SECURITY (Task #1421): group-linked forum categories/threads/posts are
      // private to their group's members. Deny by-id access to non-privileged
      // callers who are not in the owning group. Mirrors the list-endpoint guard.
      if ((entityNorm === 'forumcategory' || entityNorm === 'forumthread' || entityNorm === 'forumpost') && data) {
        const isPrivileged = !!tenantCtx.tenantUserId || (tenantCtx.roleId
          ? await hasFeatureAccess(tenantCtx.roleId, 'forum.management')
          : false);
        const [allowed] = await filterForumReadRows({
          entityNorm,
          rows: [data],
          memberId: tenantCtx.memberId,
          isPrivileged,
        });
        if (!allowed) return res.status(404).json({ error: 'Not found' });
      }

      // SECURITY (Task #3306): role-restricted resource categories are hidden
      // from excluded member roles. Non-privileged by-id reads get a 404,
      // mirroring the list-endpoint filter in index.js.
      if (entityNorm === 'resourcecategory' && data
          && (isCategoryRestricted(data) || hasSubcategoryRestrictions(data))) {
        const isPrivileged = !!tenantCtx.tenantUserId
          || await hasAdminAccess(tenantCtx)
          || (tenantCtx.roleId
            ? await hasFeatureAccess(tenantCtx.roleId, 'content.resource-management')
            : false);
        const viewer = { roleId: tenantCtx.roleId, isPrivileged };
        if (!isCategoryVisibleToViewer(data, viewer)) {
          return res.status(404).json({ error: 'Not found' });
        }
        if (!isPrivileged) {
          // Task #3320: hide role-excluded subcategory names and strip the
          // access-control fields for non-privileged readers.
          data.subcategories = filterCategorySubcategoriesForViewer(data, viewer).subcategories;
          delete data.excluded_role_ids;
          delete data.subcategory_excluded_role_ids;
        }
      }

      // SECURITY (Task #3100): internal notes on support ticket conversations
      // are staff-only. Non-staff by-id reads get a 404, mirroring the
      // list-endpoint filter in index.js.
      if (entityNorm === 'supportticketresponse' && data && data.is_internal_note === true) {
        const isStaff = !!tenantCtx.tenantUserId
          || await hasAdminAccess(tenantCtx)
          || (tenantCtx.roleId
            ? await hasFeatureAccess(tenantCtx.roleId, 'support.management')
            : false);
        if (!isStaff) return res.status(404).json({ error: 'Not found' });
      }
      return res.json(data);

    } else if (req.method === 'PATCH') {
      // Normalize entity name for comparison (handles both PascalCase and slug-case)
      const entityNormalized = entity.replace(/[-_]/g, '').toLowerCase();

      // Feed-owned job postings are updated only by their synchronizer. Keeping
      // this guard in the entity API prevents stale clients from entering an
      // imported job into native approval, payment, ownership or editing flows.
      if (entityNormalized === 'jobposting') {
        if (hasManagedJobProvenance(req.body)) {
          return res.status(403).json({ error: 'External job provenance is managed by the feed synchronizer' });
        }
        let externalQuery = supabase
          .from('job_posting')
          .select('external_source')
          .eq('id', id);
        if (tenantCtx.tenantId) externalQuery = externalQuery.eq('tenant_id', tenantCtx.tenantId);
        const { data: externalJob } = await externalQuery.maybeSingle();
        if (externalJob?.external_source) {
          return res.status(403).json({ error: 'External job postings are managed by their feed and cannot be edited' });
        }
      }
      
      // SECURITY (Task #3306): excluded_role_ids is an access-control field on
      // resource categories. Only admins / resource managers may change it —
      // otherwise any member could lift or impose category restrictions.
      if (entityNormalized === 'resourcecategory'
          && req.body && (Object.prototype.hasOwnProperty.call(req.body, 'excluded_role_ids')
            || Object.prototype.hasOwnProperty.call(req.body, 'subcategory_excluded_role_ids'))) {
        const canManage = !!tenantCtx.tenantUserId
          || await hasAdminAccess(tenantCtx)
          || (tenantCtx.roleId
            ? await hasFeatureAccess(tenantCtx.roleId, 'content.resource-management')
            : false);
        if (!canManage) {
          return res.status(403).json({ error: 'Not authorized to change resource category access' });
        }
      }

      // INTEGRITY (Task #3419): an agenda line cannot be re-pointed at another
      // event via PATCH — if event_id is supplied it must match the row's own
      // parent (which the tenant filter below already scopes to the caller).
      if (entityNormalized === 'eventagendaitem'
          && req.body && Object.prototype.hasOwnProperty.call(req.body, 'event_id')) {
        const { data: existingLine } = await supabase
          .from('event_agenda_item')
          .select('id, event_id, tenant_id')
          .eq('id', id)
          .single();
        if (!existingLine
            || !tenantCtx.tenantId || existingLine.tenant_id !== tenantCtx.tenantId) {
          return res.status(404).json({ error: 'Record not found' });
        }
        if (req.body.event_id !== existingLine.event_id) {
          return res.status(400).json({ error: 'Agenda items cannot be moved to a different event' });
        }
      }

      // SECURITY (survey integrity): survey responses are server-authoritative
      // and immutable — scored answers, identity/anonymity fields and version
      // pointers are written only by the submission RPC. Block generic PATCH
      // of any FormSubmission whose persisted form is a survey (form looked up
      // server-side, tenant-scoped; never trust the request body).
      if (entityNormalized === 'formsubmission') {
        const serverOwnedPaymentFields = [
          'payment_status',
          'payment_provider',
          'payment_reference',
          'payment_amount',
          'payment_currency',
          'payment_meta',
          'payment_paid_at',
        ];
        if (serverOwnedPaymentFields.some((field) => (
          Object.prototype.hasOwnProperty.call(req.body || {}, field)
        ))) {
          return res.status(403).json({
            error: 'Form payment state can only be changed by the payment service',
          });
        }
        const { data: subRow, error: subRowError } = await supabase
          .from('form_submission')
          .select('form_id, submission_data')
          .eq('id', id)
          .eq('tenant_id', tenantCtx.tenantId)
          .maybeSingle();
        if (subRowError) {
          console.error('[Entity PATCH] FormSubmission lookup failed:', subRowError);
          return res.status(500).json({ error: 'Failed to validate submission' });
        }
        if (!subRow) {
          return res.status(400).json({ error: 'Invalid form submission' });
        }
        if (subRow?.form_id) {
          const { data: subForm, error: subFormError } = await supabase
            .from('form')
            .select('id, tenant_id, form_type, fields')
            .eq('id', subRow.form_id)
            .eq('tenant_id', tenantCtx.tenantId)
            .maybeSingle();
          if (subFormError) {
            console.error('[Entity PATCH] FormSubmission form lookup failed:', subFormError);
            return res.status(500).json({ error: 'Failed to validate submission' });
          }
          if (!subForm) {
            return res.status(400).json({ error: 'Invalid form submission' });
          }
          if (subForm?.form_type === 'survey') {
            return res.status(403).json({ error: 'Survey responses are immutable and cannot be edited' });
          }
          if (Object.prototype.hasOwnProperty.call(req.body || {}, 'submission_data')) {
            // Supabase updates replace a JSONB column rather than deep-merging
            // it. Merge the row and PATCH at the column level, then validate
            // exactly the submission_data replacement that will be stored.
            const effectiveSubmission = { ...subRow, ...req.body };
            const effectiveSubmissionData = effectiveSubmission.submission_data;
            if (!effectiveSubmissionData || typeof effectiveSubmissionData !== 'object'
                || Array.isArray(effectiveSubmissionData)) {
              return res.status(400).json({ error: 'Invalid relationship selection' });
            }
            try {
              await validateRepeatableRowSubmission({
                db: supabase,
                tenantId: subForm.tenant_id,
                form: subForm,
                submissionData: effectiveSubmissionData,
              });
              await createFormRelationshipService({
                db: supabase,
                tenantId: subForm.tenant_id,
              }).validateSubmission({
                form: subForm,
                submissionData: effectiveSubmissionData,
              });
            } catch (error) {
              if (error instanceof FormRelationshipError && error.status < 500) {
                return res.status(400).json({ error: 'Invalid relationship selection' });
              }
              console.error('[Entity PATCH] FormSubmission relationship validation failed:', error);
              return res.status(500).json({ error: 'Failed to validate submission' });
            }
            sanitizedBody.submission_data = preserveFormNotListedLabelSnapshots(
              snapshotFormNotListedLabels(subForm.fields || [], effectiveSubmissionData),
              subRow.submission_data,
            );
          }
        } else {
          return res.status(400).json({ error: 'Invalid form submission' });
        }
      }

      // For Organization/Member/JobPosting, fetch before data for workflow evaluation
      // Also fetch before data for ArticleBrief to track key field changes in activity log
      let beforeData = null;
      const isWorkflowEntity = entityNormalized === 'organization' || entityNormalized === 'member' || entityNormalized === 'jobposting';
      const isArticleBrief = entityNormalized === 'articlebrief';
      const isPreferenceValueEntity = entityNormalized === 'organizationpreferencevalue' || entityNormalized === 'memberpreferencevalue';
      
      let prefValueBefore = undefined;
      let prefValueFieldId = undefined;
      if (isPreferenceValueEntity) {
        try {
          const previousPreferenceValue = await loadCorePreferenceValueBeforeUpdate({
            supabase,
            tableName,
            id,
          });
          prefValueBefore = previousPreferenceValue.value;
          prefValueFieldId = previousPreferenceValue.fieldId;
        } catch (e) {
          console.error('[Entity PATCH] Error fetching preference value before data:', e);
          if (e?.code === 'PGRST116') {
            return res.status(404).json({ error: 'Preference value not found' });
          }
          return res.status(500).json({ error: 'Failed to load preference value for update' });
        }
      }

      const isMemberGroupProjectsEntity = entityNormalized === 'membergroup' || entityNormalized === 'membergroupassignment';
      const isSupportTicketEntity = entityNormalized === 'supportticket';

      if (isWorkflowEntity || isArticleBrief || isMemberGroupProjectsEntity || isSupportTicketEntity) {
        try {
          let beforeQuery = supabase
            .from(tableName)
            .select('*')
            .eq('id', id);
          
          // Apply tenant filter to beforeData fetch (always applied for non-global entities)
          if (shouldApplyTenantFilter) {
            if (tenantScope === TENANT_SCOPE.MEMBER) {
              if (!allowsTenantWideAccess) {
                beforeQuery = beforeQuery.eq('member_id', tenantCtx.memberId);
              }
            } else if (tenantScope === TENANT_SCOPE.ORGANIZATION) {
              beforeQuery = beforeQuery.eq('organization_id', tenantCtx.organizationId);
            } else if (entity === 'Organization') {
              if (tenantCtx.tenantId) {
                beforeQuery = beforeQuery.eq('tenant_id', tenantCtx.tenantId);
              } else {
                beforeQuery = beforeQuery.eq('id', tenantCtx.organizationId);
              }
            } else if (tenantScope === TENANT_SCOPE.TENANT) {
              const entitiesWithoutOrgId = [
                'MemberGroupClassification',
                'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
                'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'ResourceCategory', 'Resource',
                'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField',
                'ButtonStyle', 'TypographyStyle', 'BlogPost',
                'CommunicationCategory', 'CommunicationCategoryRole',
                'ForumCategory', 'ForumThread', 'ForumPost', 'ForumReaction', 'ForumReport', 'ForumModerationLog',
                'MemberBookmark', 'Role', 'Speaker', 'ResourceView',
                'Award', 'OfflineAward', 'OfflineAwardAssignment', 'EngagementAward', 'EngagementAwardAssignment',
                'OrganisationAward', 'OrganisationAwardAssignment', 'AwardClassification', 'AwardSublevel', 'Badge',
                'DynamicDirectory',
                'IEditPage', 'IEditPageElement', 'IEditPageFolder',
                'ComplexEvent', 'ComplexEventTrack', 'ComplexEventSession',
                'EventSponsor', 'EventSponsorCategory', 'EventSponsorAssignment', 'EventSurveyAssignment',
                'ArticleBrief', 'ArticleBriefVersion', 'ArticleBriefComment', 'ArticleBriefActivity',
                'ExternalWriter', 'ExternalWriterDocument',
                'CrmTagColor',
                'Gallery', 'GalleryPhoto', 'CardDeck',
                'MemberGroupActivity', 'Microsite', 'InstalledFont',
            'EventAgendaItem', 'EventCostLine', 'OrganizationGroup', 'OrganizationGroupPreferenceValue'
              ];
              if (tenantCtx.tenantId) {
                beforeQuery = beforeQuery.eq('tenant_id', tenantCtx.tenantId);
              } else if (!entitiesWithoutOrgId.includes(entity) && tenantCtx.organizationId) {
                beforeQuery = beforeQuery.eq('organization_id', tenantCtx.organizationId);
              }
            }
          }
          
          const { data: existingData } = await beforeQuery.single();
          beforeData = existingData;
        } catch (e) {
          console.error('[Entity PATCH] Error fetching before data:', e);
        }
      }

      // Sanitize empty strings to null for UUID fields to avoid "invalid input syntax for type uuid" errors
      // Only modify fields that are already present in the request body
      const sanitizedBody = entityNormalized === 'jobposting'
        ? stripManagedJobProvenance(req.body)
        : { ...req.body };
      const uuidFields = ['role_id', 'organization_id', 'organization_group_id', 'member_id', 'parent_id', 'form_id', 'event_id', 'related_event_id',
                          'category_id', 'template_id', 'workflow_id', 'speaker_id', 'created_by', 'updated_by'];
      for (const field of uuidFields) {
        if (field in sanitizedBody && sanitizedBody[field] === '') {
          sanitizedBody[field] = null;
        }
      }

      if (isCorePreferenceValueEntity(entityNormalized)) {
        try {
          const allowed = await isCorePreferenceField({
            supabase,
            tenantId: tenantCtx.effectiveTenantId || tenantCtx.tenantId,
            fieldId: sanitizedBody.field_id || prefValueFieldId,
          });
          if (!allowed) {
            return res.status(400).json({
              error: 'Core preference values require a core custom field from the same tenant',
            });
          }
        } catch (boundaryError) {
          console.error('[Entity PATCH] Preference value field boundary failed:', boundaryError.message);
          return res.status(500).json({ error: 'Failed to validate custom field ownership' });
        }
      }

      if (entityNormalized === 'form' && Object.prototype.hasOwnProperty.call(sanitizedBody, 'access_policy')) {
        const validation = await validateFormAccessPolicy({
          supabase,
          tenantId: tenantCtx.tenantId,
          policy: sanitizedBody.access_policy,
        });
        if (!validation.ok) return res.status(422).json({ error: validation.error, code: 'INVALID_FORM_ACCESS_POLICY' });
        sanitizedBody.access_policy = validation.policy;
      }

      if (entityNormalized === 'form' && Object.prototype.hasOwnProperty.call(sanitizedBody, 'structured_actions')) {
        try {
          let persistedFields = sanitizedBody.fields;
          if (!Array.isArray(persistedFields)) {
            const { data: formFields, error: formFieldsError } = await supabase
              .from('form')
              .select('fields')
              .eq('id', id)
              .eq('tenant_id', tenantCtx.tenantId)
              .maybeSingle();
            if (formFieldsError || !formFields) {
              return res.status(404).json({ error: 'Form not found' });
            }
            persistedFields = formFields.fields || [];
          }
          sanitizedBody.structured_actions = validateStructuredActionsContract(
            sanitizedBody.structured_actions,
            persistedFields,
          ) || { version: 1, actions: [] };
        } catch (error) {
          if (error instanceof StructuredActionContractError) {
            return res.status(422).json({
              error: error.message,
              code: error.code,
              details: error.details,
            });
          }
          throw error;
        }
      }

      if (entityNormalized === 'portalmenu'
          && ['link_type', 'url', 'open_in_new_tab'].some(
            (field) => Object.prototype.hasOwnProperty.call(sanitizedBody, field)
          )) {
        let existingPortalMenuQuery = supabase
          .from(tableName)
          .select('link_type, url, open_in_new_tab')
          .eq('id', id);
        if (tenantCtx.tenantId) {
          existingPortalMenuQuery = existingPortalMenuQuery.eq('tenant_id', tenantCtx.tenantId);
        }
        const { data: existingPortalMenu, error: existingPortalMenuError } =
          await existingPortalMenuQuery.maybeSingle();
        if (existingPortalMenuError) {
          console.error('[Entity PATCH] PortalMenu validation lookup failed:', existingPortalMenuError);
          return res.status(500).json({ error: 'Failed to validate portal menu destination' });
        }
        if (!existingPortalMenu) {
          return res.status(404).json({ error: 'Portal menu item not found' });
        }

        const portalMenuValidation = validatePortalMenuRecord({
          ...existingPortalMenu,
          ...sanitizedBody,
        });
        if (!portalMenuValidation.isValid) {
          return res.status(400).json({ error: portalMenuValidation.error });
        }
        if ('link_type' in sanitizedBody) {
          sanitizedBody.link_type = portalMenuValidation.linkType;
        }
        if ('link_type' in sanitizedBody || 'url' in sanitizedBody) {
          sanitizedBody.url = portalMenuValidation.url;
        }
        if ('link_type' in sanitizedBody || 'open_in_new_tab' in sanitizedBody) {
          sanitizedBody.open_in_new_tab = portalMenuValidation.openInNewTab;
        }
      }

      // SECURITY (Task #3330): survey publication is server-authoritative.
      // Clients may never flip survey_settings.status to 'published' via the
      // generic Form update — only /api/forms/publish-survey does (it creates
      // the version snapshot). Editing a published survey's fields/rules via
      // this path reverts it to draft, so the live config can never drift
      // from the snapshot while publicly serving.
      // Audit log is SERVER-authored and append-only: never accept a
      // client-supplied survey_audit_log on ANY Form PATCH (an audit-only
      // payload could otherwise erase/fabricate lifecycle history).
      if (entityNormalized === 'form') {
        const hadAuditKey = Object.prototype.hasOwnProperty.call(sanitizedBody, 'survey_audit_log');
        delete sanitizedBody.survey_audit_log;
        if (hadAuditKey && Object.keys(sanitizedBody).length === 0) {
          // Audit-only payload: nothing legitimate left to update.
          return res.status(400).json({ error: 'survey_audit_log is server-managed and cannot be updated directly' });
        }
      }
      if (entityNormalized === 'form'
          && (Object.prototype.hasOwnProperty.call(sanitizedBody, 'survey_settings')
            || Object.prototype.hasOwnProperty.call(sanitizedBody, 'fields')
            || Object.prototype.hasOwnProperty.call(sanitizedBody, 'visibility_rules')
            || Object.prototype.hasOwnProperty.call(sanitizedBody, 'pages')
            || Object.prototype.hasOwnProperty.call(sanitizedBody, 'form_type'))) {
        const { data: existingForm } = await supabase
          .from('form')
          .select('form_type, survey_settings, survey_audit_log')
          .eq('id', id)
          .maybeSingle();
        const isSurveyTarget = existingForm?.form_type === 'survey' || sanitizedBody.form_type === 'survey';
        if (isSurveyTarget) {
          const currentStatus = existingForm?.survey_settings?.status || 'draft';
          const requestedStatus = sanitizedBody.survey_settings?.status;
          if (requestedStatus === 'published' && currentStatus !== 'published') {
            return res.status(400).json({ error: 'Surveys are published via the publish endpoint, not a direct status update' });
          }
          // ANY config or settings mutation on a published survey reverts it
          // to draft (fields, rules, pages, AND survey_settings — e.g.
          // flipping response_identity after publication). The only allowed
          // published-state transition here is archiving.
          const touchesConfig = ['fields', 'visibility_rules', 'pages', 'survey_settings', 'form_type'].some(
            (k) => Object.prototype.hasOwnProperty.call(sanitizedBody, k)
          );
          if (currentStatus === 'published' && touchesConfig && requestedStatus !== 'archived') {
            sanitizedBody.survey_settings = {
              ...(existingForm?.survey_settings || {}),
              ...(sanitizedBody.survey_settings && typeof sanitizedBody.survey_settings === 'object' ? sanitizedBody.survey_settings : {}),
              status: 'draft'
            };
          }
          // Server-authored audit entries for lifecycle transitions.
          const priorAudit = Array.isArray(existingForm?.survey_audit_log) ? existingForm.survey_audit_log : [];
          const auditAppend = [];
          if (requestedStatus === 'archived' && currentStatus !== 'archived') {
            auditAppend.push({ action: 'archive', at: new Date().toISOString(), actor: tenantCtx?.memberId || null });
          } else if (touchesConfig) {
            auditAppend.push({ action: 'edit', at: new Date().toISOString(), actor: tenantCtx?.memberId || null });
          }
          if (auditAppend.length > 0) {
            sanitizedBody.survey_audit_log = [...priorAudit, ...auditAppend];
          }
        }
      }

      // Task #3320: when a resource category's subcategories list changes,
      // prune per-role exclusion entries for subcategories that no longer
      // exist so settings can't orphan. Renames go through the dedicated
      // rename function (which carries entries over); this handles removals.
      // Best-effort: environments without the column (42703) skip silently.
      if (entityNormalized === 'resourcecategory'
          && Object.prototype.hasOwnProperty.call(sanitizedBody, 'subcategories')
          && !Object.prototype.hasOwnProperty.call(sanitizedBody, 'subcategory_excluded_role_ids')) {
        try {
          const { data: currentCat, error: curErr } = await supabase
            .from(tableName)
            .select('subcategory_excluded_role_ids')
            .eq('id', id)
            .single();
          if (!curErr && currentCat) {
            const map = getSubcategoryExclusionMap(currentCat);
            const nextSubs = new Set(
              (Array.isArray(sanitizedBody.subcategories) ? sanitizedBody.subcategories : [])
                .filter((s) => typeof s === 'string')
            );
            const pruned = {};
            let removed = false;
            for (const [name, roleIds] of Object.entries(map)) {
              if (nextSubs.has(name)) pruned[name] = roleIds;
              else removed = true;
            }
            if (removed) sanitizedBody.subcategory_excluded_role_ids = pruned;
          }
        } catch (pruneErr) {
          console.warn('[Entity PATCH] resource_category subcategory exclusion prune skipped:', pruneErr?.message);
        }
      }

      // BlogPost co-authors (Task #1222): `authors` is not a column on blog_post;
      // pop it here and sync the blog_post_author join table after update. Absent
      // (e.g. auto-save) means "no change" — the join table is left untouched.
      let blogPostAuthorsPayload;
      if (entityNormalized === 'blogpost' && 'authors' in sanitizedBody) {
        blogPostAuthorsPayload = sanitizedBody.authors;
        delete sanitizedBody.authors;
      }

      // CardDeck: normalize and cap the links array (max 10 rows of { text, url })
      if (entityNormalized === 'carddeck' && 'links' in sanitizedBody) {
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
      
      // SECURITY: Strip tenant linkage fields from PATCH body to prevent tenant reassignment attacks
      // tenant_id and member_id should never be changed via PATCH
      // organization_id is allowed for specific tenant-scoped entities where it's a reference field.
      // Member (Task #1312): admins may detach a member from their organisation
      // ("No Organisation") or move them between organisations — but only within
      // the same tenant. Tenant safety for non-null targets is enforced below.
      const entitiesAllowingOrgReassign = ['Voucher', 'VoucherTransaction', 'DiscountCode', 'Member'];
      const entitiesAllowingMemberReassign = ['discountcode', 'speaker'];
      if (shouldApplyTenantFilter) {
        delete sanitizedBody.tenant_id;
        if (!entitiesAllowingOrgReassign.includes(entity)) {
          delete sanitizedBody.organization_id;
        }
        if (!entitiesAllowingMemberReassign.includes(entityNormalized)) {
          delete sanitizedBody.member_id;
        }
      }

      // Training fund balances are ledger-backed: every change must go
      // through a path that writes a training_fund_transaction row
      // atomically (RPCs / the admin adjust endpoint). Strip them from
      // generic Organization updates so no client code can bypass the ledger.
      if (entityNormalized === 'organization') {
        const strippedBalanceFields = stripProtectedOrgBalanceFields(sanitizedBody);
        if (strippedBalanceFields.length > 0) {
          console.warn(`[Entity API] Stripped protected training fund balance field(s) from Organization update ${id}: ${strippedBalanceFields.join(', ')}`);
        }
        // SECURITY: an organisation may only be assigned to an Organisation
        // Group belonging to the same tenant. Clearing (null) is always allowed.
        if ('organization_group_id' in sanitizedBody && sanitizedBody.organization_group_id) {
          const orgTenantId = beforeData?.tenant_id || tenantCtx?.tenantId || null;
          if (!orgTenantId) {
            return res.status(400).json({ error: 'Tenant context required to assign an organisation group' });
          }
          const { data: targetGroup, error: targetGroupError } = await supabase
            .from('organization_group')
            .select('id, tenant_id')
            .eq('id', sanitizedBody.organization_group_id)
            .single();
          if (targetGroupError || !targetGroup || targetGroup.tenant_id !== orgTenantId) {
            return res.status(403).json({ error: 'Organisation group not found in this tenant' });
          }
        }
      }

      // SECURITY (Task #3586): membership pause state changes only via the
      // admin pause/resume endpoint (which also handles sessions, GoCardless
      // and notes). Strip pause fields from generic Member updates.
      if (entityNormalized === 'member') {
        const strippedPauseFields = stripMemberPauseFields(sanitizedBody);
        if (strippedPauseFields.length > 0) {
          console.warn(`[Entity API] Stripped protected membership pause field(s) from Member update ${id}: ${strippedPauseFields.join(', ')}`);
        }
      }

      // SECURITY (Task #1312): When reassigning a member to a non-null organisation,
      // verify the target organisation belongs to the same tenant as the member.
      // Clearing the link (null) is always permitted.
      if (entityNormalized === 'member' && 'organization_id' in sanitizedBody && sanitizedBody.organization_id) {
        const memberTenantId = beforeData?.tenant_id || tenantCtx?.tenantId || null;
        if (!memberTenantId) {
          return res.status(400).json({ error: 'Tenant context required to reassign a member to an organisation' });
        }
        const { data: targetOrg, error: targetOrgError } = await supabase
          .from('organization')
          .select('id, tenant_id')
          .eq('id', sanitizedBody.organization_id)
          .single();
        if (targetOrgError || !targetOrg || targetOrg.tenant_id !== memberTenantId) {
          return res.status(403).json({ error: 'Organisation not found in this tenant' });
        }
      }

      // SECURITY (Task #3667): when assigning a manual group to a member (no-org
      // scenario), verify the target group belongs to the same tenant.
      // Clearing (null) is always permitted.
      if (entityNormalized === 'member' && 'organization_group_id' in sanitizedBody && sanitizedBody.organization_group_id) {
        const memberTenantId = beforeData?.tenant_id || tenantCtx?.tenantId || null;
        if (!memberTenantId) {
          return res.status(400).json({ error: 'Tenant context required to assign a member group' });
        }
        const { data: targetGroup, error: targetGroupError } = await supabase
          .from('organization_group')
          .select('id, tenant_id')
          .eq('id', sanitizedBody.organization_group_id)
          .single();
        if (targetGroupError || !targetGroup || targetGroup.tenant_id !== memberTenantId) {
          return res.status(403).json({ error: 'Organisation group not found in this tenant' });
        }
      }

      // Normalize email to lowercase for member, team_member, magic_link, and external_writer entities
      // Use normalized entity name (already computed above) to handle both PascalCase and slug-case variants
      if ((entityNormalized === 'member' || entityNormalized === 'teammember' || entityNormalized === 'magiclink' || entityNormalized === 'externalwriter') && sanitizedBody.email) {
        sanitizedBody.email = sanitizedBody.email.toLowerCase();
      }

      if (entityNormalized === 'externalwriter' && sanitizedBody.email) {
        const tenantId = tenantCtx?.tenantId;
        if (tenantId) {
          const { data: existingMember } = await supabase
            .from('member')
            .select('id')
            .eq('tenant_id', tenantId)
            .ilike('email', sanitizedBody.email)
            .not('email', 'ilike', 'deleted_%@deleted.local')
            .limit(1);
          if (existingMember && existingMember.length > 0) {
            return res.status(409).json({ error: 'This email belongs to an existing member' });
          }
          const { data: existingWriter } = await supabase
            .from('external_writer')
            .select('id')
            .eq('tenant_id', tenantId)
            .ilike('email', sanitizedBody.email)
            .neq('id', id)
            .limit(1);
          if (existingWriter && existingWriter.length > 0) {
            return res.status(409).json({ error: 'An external writer with this email already exists' });
          }
        }
      }

      const isSpeakerMemberLinkUpdate = entityNormalized === 'speaker'
        && Object.prototype.hasOwnProperty.call(sanitizedBody, 'member_id');
      if (isSpeakerMemberLinkUpdate) {
        const canManageSpeakerLinks = await hasAdminAccess(tenantCtx)
          || (tenantCtx.roleId
            ? await hasFeatureAccess(tenantCtx.roleId, 'events.speakers')
            : false);
        if (!canManageSpeakerLinks) {
          return res.status(403).json({ error: 'Speaker Management access required' });
        }
      }
      if (isSpeakerMemberLinkUpdate && sanitizedBody.member_id) {
        const linkValidation = await validateSpeakerMemberLink({
          db: supabase,
          tenantId: tenantCtx.tenantId,
          memberId: sanitizedBody.member_id,
          excludeSpeakerId: id,
        });
        if (!linkValidation.ok) {
          return res.status(linkValidation.status).json(linkValidation.body);
        }
      }

      // SECURITY: Protect system canvas pages (slug='login') from slug/title mutation
      // and enforce that publishing a login canvas page requires a login-form block.
      if (entity === 'IEditPage') {
        // Task #3371: static "AI generated" page content is immutable via the
        // API — static_html/static_css are sanitized+scoped at store time by
        // platform tooling only. Metadata (title/slug/status/chrome) stays
        // manageable; content fields are silently dropped like other
        // server-owned fields. builder_type is immutable after creation for
        // every page class (a DB trigger raises on change; stripping it here
        // keeps the API's contract explicit and its errors friendly).
        delete sanitizedBody.static_html;
        delete sanitizedBody.static_css;
        delete sanitizedBody.builder_type;
        // Task #3638: normalise slugs server-side so raw API callers can't
        // mint case-variant duplicates or bypass the reserved check.
        if (sanitizedBody.slug !== undefined && sanitizedBody.slug !== null) {
          sanitizedBody.slug = String(sanitizedBody.slug).trim().toLowerCase();
        }
        const needsSlugCheck = sanitizedBody.slug !== undefined || sanitizedBody.title !== undefined
          || sanitizedBody.microsite_id !== undefined;
        const isPublishing = sanitizedBody.status === 'published';
        if (needsSlugCheck || isPublishing) {
          const { data: existingPage } = await supabase
            .from('i_edit_page')
            .select('slug, title, canvas_design, builder_type, tenant_id, microsite_id')
            .eq('id', id)
            .maybeSingle();
          // Task #3638: reserved-route and duplicate slug enforcement on the
          // FINAL {slug, microsite_id} pair — a microsite-only PATCH can move
          // a page onto the default site (or into a scope with a duplicate)
          // without touching the slug, so validate whenever either changes.
          // Microsite pages serve at /{prefix}/{slug} and never collide with
          // top-level routes, so the reserved check only applies when the
          // page ends up on the default site.
          const slugChanging = sanitizedBody.slug !== undefined && sanitizedBody.slug !== existingPage?.slug;
          const micrositeChanging = sanitizedBody.microsite_id !== undefined
            && (sanitizedBody.microsite_id ?? null) !== (existingPage?.microsite_id ?? null);
          if (slugChanging || micrositeChanging) {
            const finalSlug = String(
              (sanitizedBody.slug !== undefined ? sanitizedBody.slug : existingPage?.slug) || ''
            ).toLowerCase();
            const targetMicrositeId = sanitizedBody.microsite_id !== undefined
              ? (sanitizedBody.microsite_id ?? null)
              : (existingPage?.microsite_id ?? null);
            if (!targetMicrositeId && isReservedPageSlug(finalSlug)) {
              return res.status(400).json({ error: reservedPageSlugMessage(finalSlug) });
            }
            if (existingPage?.tenant_id && finalSlug) {
              let dupQuery = supabase
                .from('i_edit_page')
                .select('id')
                .eq('tenant_id', existingPage.tenant_id)
                .eq('slug', finalSlug)
                .neq('id', id)
                .limit(1);
              dupQuery = targetMicrositeId
                ? dupQuery.eq('microsite_id', targetMicrositeId)
                : dupQuery.is('microsite_id', null);
              const { data: dupRows, error: dupError } = await dupQuery;
              if (dupError) {
                console.error('[IEditPage] Duplicate-slug check failed:', dupError.message);
                return res.status(500).json({ error: 'Failed to validate slug uniqueness' });
              }
              if (dupRows && dupRows.length > 0) {
                return res.status(409).json({ error: 'Another page already uses this slug' });
              }
            }
          }
          if (existingPage?.slug === 'login') {
            // Block slug/title edits
            if (sanitizedBody.slug !== undefined && sanitizedBody.slug !== 'login') {
              return res.status(403).json({ error: 'The login system page slug cannot be changed' });
            }
            delete sanitizedBody.slug;
            delete sanitizedBody.title;
            // Require a login-form block when publishing
            if (isPublishing && existingPage.builder_type === 'canvas') {
              const design = sanitizedBody.canvas_design || existingPage.canvas_design;
              const blocks = (design?.root?.sections || []).flatMap(s => s.children || []);
              const hasLoginBlock = blocks.some(b => b.type === 'login-form');
              if (!hasLoginBlock) {
                return res.status(422).json({
                  error: 'Cannot publish the login page without a Login Form block. Add a Login Form block in CanvasBuilder first.',
                  code: 'login_page_missing_login_block',
                });
              }
            }
          }
        }
      }

      // SECURITY: Protect system roles from being renamed or having is_system flag changed
      if (entityNormalized === 'role' && (sanitizedBody.name !== undefined || sanitizedBody.is_system !== undefined)) {
        const { data: existingRole } = await supabase
          .from('role')
          .select('name, is_system')
          .eq('id', id)
          .single();
        
        if (existingRole?.is_system === true) {
          // Prevent renaming system roles
          if (sanitizedBody.name !== undefined && sanitizedBody.name !== existingRole.name) {
            return res.status(403).json({ error: 'System roles cannot be renamed' });
          }
          // Prevent changing is_system flag
          delete sanitizedBody.is_system;
        }
      }

      if (entityNormalized === 'role'
        && Object.prototype.hasOwnProperty.call(sanitizedBody, 'assignable_role_ids')) {
        const assignable = await validateAssignableRoleIds({
          supabase,
          tenantId: tenantCtx.tenantId,
          roleIds: sanitizedBody.assignable_role_ids,
        });
        if (!assignable.ok) {
          return res.status(assignable.status).json({ error: assignable.error });
        }
        sanitizedBody.assignable_role_ids = assignable.roleIds;
      }

      if (entityNormalized === 'member'
        && (Object.prototype.hasOwnProperty.call(sanitizedBody, 'role_id')
          || Object.prototype.hasOwnProperty.call(sanitizedBody, 'role_effective_from'))) {
        const assignment = await authorizeAndCheckTeamRoleAssignment({
          supabase,
          tenantCtx,
          memberId: id,
          destinationRoleId: Object.prototype.hasOwnProperty.call(sanitizedBody, 'role_id')
            ? sanitizedBody.role_id
            : beforeData?.role_id,
          effectiveFrom: sanitizedBody.role_effective_from,
          hasAdminAccess,
          hasFeatureAccess,
        });
        if (!assignment.ok) {
          return res.status(assignment.status).json({ error: assignment.error });
        }
      }

      // Task #1519: Group-Admin event-write authorization + guardrails on update.
      // Non-tenant-admin callers may only edit events/children for groups they
      // administer, within the free/no-zoom/audience guardrails. Tenant admins
      // pass through unchanged.
      if (isEventFamilyEntity(entity)) {
        const { data: existingRow } = await supabase
          .from(tableName)
          .select('*')
          .eq('id', id)
          .maybeSingle();
        const authz = await authorizeGroupAdminEventWrite({
          entity,
          op: 'update',
          body: sanitizedBody,
          existingRow: existingRow || null,
          tenantCtx,
          req,
        });
        if (!authz.ok) {
          console.warn(`[Entity PATCH] Group-admin event-write denied: entity="${entity}" id="${id}" status=${authz.status || 403} reason="${authz.error}" tenantId=${tenantCtx.tenantId} organizationId=${tenantCtx.organizationId} memberId=${tenantCtx.memberId} roleId=${tenantCtx.roleId}`);
          return res.status(authz.status || 403).json({ error: authz.error });
        }
        // Replace the update payload with the guardrailed version. For tenant
        // admins authorizeGroupAdminEventWrite returns the SAME object reference
        // it was given, so clearing sanitizedBody first would empty authz.body
        // too and leave an empty `{}` update (matches zero rows -> PGRST116 ->
        // 404, the bug this fixes). Only clear+reassign when authz.body is a
        // distinct (guardrailed) object.
        const guardedBody = authz.body || {};
        if (guardedBody !== sanitizedBody) {
          for (const k of Object.keys(sanitizedBody)) delete sanitizedBody[k];
          Object.assign(sanitizedBody, guardedBody);
        }
      }

      // Task #1588: Group-Admin resource-write authorization on update. Non-admin
      // callers may only edit a Resource that belongs to a group they administer;
      // tenant admins pass through unchanged.
      if (isResourceEntity(entity)) {
        const { data: existingRow } = await supabase
          .from(tableName)
          .select('id, member_group_id, tenant_id, resource_type, target_url')
          .eq('id', id)
          .maybeSingle();
        const formTargetValidation = await normalizeTenantFormResourceTarget({
          supabase,
          tenantId: tenantCtx.tenantId || tenantCtx.effectiveTenantId,
          resourceBody: sanitizedBody,
          existingResource: existingRow || null,
        });
        if (!formTargetValidation.ok) {
          return res.status(formTargetValidation.status || 400).json({
            error: formTargetValidation.error,
          });
        }
        const authz = await authorizeGroupAdminResourceWrite({
          op: 'update',
          existingRow: existingRow || null,
          body: sanitizedBody,
          tenantCtx,
        });
        if (!authz.ok) {
          return res.status(authz.status || 403).json({ error: authz.error });
        }
      }

      // Group-admin cosmetic content editing: non-tenant-admin callers may
      // PATCH a member_group ONLY when they are an active group admin of that
      // group, the group's `group_admins_can_edit_content` flag is on, and the
      // payload touches nothing beyond the whitelisted cosmetic fields
      // (header image + description texts — never the name). Tenant admins
      // pass through unchanged.
      if (entityNormalized === 'membergroup') {
        const isTenantAdminCaller = !!tenantCtx.tenantUserId || await hasAdminAccess(tenantCtx);
        if (!isTenantAdminCaller) {
          const GROUP_ADMIN_EDITABLE_FIELDS = ['header_image_url', 'description', 'who_is_it_for', 'about_the_group'];
          const access = await getCallerGroupManageAccess(req);
          if (access.error || !canManageGroup(access, id)) {
            return res.status(403).json({ error: 'You do not have permission to edit this group.' });
          }
          const { data: groupRow } = await supabase
            .from('member_group')
            .select('*')
            .eq('id', id)
            .eq('tenant_id', tenantCtx.tenantId)
            .maybeSingle();
          if (!groupRow) {
            return res.status(404).json({ error: 'Not found' });
          }
          if (groupRow.group_admins_can_edit_content !== true) {
            return res.status(403).json({ error: 'Group admins are not allowed to edit this group\'s content.' });
          }
          const disallowed = Object.keys(sanitizedBody).filter((k) => !GROUP_ADMIN_EDITABLE_FIELDS.includes(k));
          if (disallowed.length > 0) {
            return res.status(403).json({
              error: `Group admins may only edit the header image and description texts. Not allowed: ${disallowed.join(', ')}`,
            });
          }
          if (Object.keys(sanitizedBody).length === 0) {
            return res.status(400).json({ error: 'No editable fields supplied' });
          }
        }
      }

      // Task #1595: Never leave a member group without an active admin. Reject a
      // PATCH that demotes the group's only active admin — either toggling
      // is_group_admin off or setting an expires_at that puts it in the past.
      if (isMemberGroupAssignmentEntity(entity)
        && ('is_group_admin' in sanitizedBody || 'expires_at' in sanitizedBody)) {
        const { data: existingAssignment } = await supabase
          .from(tableName)
          .select('id, member_id, group_id, is_group_admin, expires_at')
          .eq('id', id)
          .maybeSingle();
        const demoteAuthz = await authorizeMemberGroupAdminAssignmentChange({
          op: 'update',
          existingRow: existingAssignment || null,
          patch: sanitizedBody,
          tenantCtx,
        });
        if (!demoteAuthz.ok) {
          return res
            .status(demoteAuthz.status || 409)
            .json({ error: demoteAuthz.error, ...(demoteAuthz.code && { code: demoteAuthz.code }) });
        }
      }

      if (entityNormalized === 'membergroup' && tenantCtx.tenantId) {
        const policyAuth = authorizeAutomaticMembershipPolicyWrite({
          body: sanitizedBody,
          isAdmin: await hasAdminAccess(tenantCtx),
        });
        if (!policyAuth.ok) {
          return res.status(policyAuth.status).json({ error: policyAuth.error });
        }
        // Reconciliation state is written only by the trigger/worker.
        for (const key of [
          'automatic_membership_generation',
          'automatic_membership_sync_status',
          'automatic_membership_last_synced_at',
          'automatic_membership_match_count',
          'automatic_membership_sync_error',
          'automatic_membership_cursor',
        ]) {
          delete sanitizedBody[key];
        }
        const amRelevantFields = [
          'automatic_membership_enabled', 'automatic_membership_role',
          'automatic_membership_filter_groups', 'roles',
        ];
        const patchTouchesAm = amRelevantFields.some(f => f in sanitizedBody);
        if (patchTouchesAm) {
          const { data: currentGroupRow, error: cgErr } = await supabase
            .from('member_group')
            .select('automatic_membership_enabled, automatic_membership_role, automatic_membership_filter_groups, roles')
            .eq('id', id)
            .eq('tenant_id', tenantCtx.tenantId)
            .maybeSingle();

          if (cgErr) {
            console.error('[Entity PATCH] member_group auto-membership lookup error:', cgErr.message);
            return res.status(500).json({ error: 'Failed to load group for automatic membership validation' });
          }

          if (currentGroupRow) {
            const effectiveRow = { ...currentGroupRow, ...sanitizedBody };
            const scopeResult = await fetchAllowedCustomFieldIdsByScope(supabase, tenantCtx.tenantId);
            const fieldMeta = buildFieldMeta(scopeResult);
            const roleCheck = (role) => roleExistsInGroup(role, effectiveRow.roles || []);
            const amValidation = await validateAutomaticMembershipSettings(effectiveRow, {
              allowedCustomFieldIdsByScope: scopeResult,
              fieldMeta,
              roleExists: roleCheck,
            });
            if (!amValidation.ok) {
              return res.status(422).json({ error: amValidation.error });
            }

            // DB trigger increments generation and resets sync fields when
            // enabled/role/filter_groups changes — we don't need to set these
            // explicitly; the trigger handles it atomically.
            // We do NOT set automatic_membership_sync_status here because:
            //   a) the trigger already does it
            //   b) setting it here could race with the trigger on the same row
          }
        }
      }

      // Any assignment change through the authenticated entity API is a manual
      // exception. Automation is the only writer allowed to retain the
      // automatic provenance, so a role/admin/expiry amendment is preserved.
      if (isMemberGroupAssignmentEntity(entity)) {
        sanitizedBody.assignment_source = 'manual';
      }

      // AI Design Studio V2 publish gate (Task #2906): a canvas page cannot
      // flip to "published" while any placed V2 composition still has
      // unresolved data-ai-action links — those would render as dead ends on
      // the public site. 409 carries the blockers for the editor UI.
      if (tableName === 'i_edit_page' && sanitizedBody.status === 'published') {
        try {
          const gate = await assessAiCodePagePublishGate(supabase, tenantCtx.tenantId, id);
          if (!gate.ok) {
            return res.status(409).json({
              error: 'This page has AI-designed links that are not connected to real content yet. Resolve them in the AI panel before publishing.',
              code: 'AI_UNRESOLVED_ACTIONS',
              blockers: gate.blockers.slice(0, 20),
            });
          }
        } catch (err) {
          // Fail-open: a gate infrastructure error must not brick publishing.
          console.error('[Entity PATCH] AI publish gate check failed:', err.message || err);
        }
      }

      // Support ticket CSAT + auto-close lifecycle fields: keep resolved_at /
      // closed_reason / warning tracking consistent with status transitions.
      // (Satisfaction rating fields are set by the rating endpoints, not here.)
      if (isSupportTicketEntity && beforeData && typeof sanitizedBody.status === 'string' && sanitizedBody.status !== beforeData.status) {
        if (sanitizedBody.status === 'resolved') {
          sanitizedBody.resolved_at = new Date().toISOString();
          sanitizedBody.auto_close_warning_sent_at = null;
          sanitizedBody.closed_reason = null;
        } else if (sanitizedBody.status === 'closed') {
          if (!sanitizedBody.closed_reason) sanitizedBody.closed_reason = 'manual';
        } else {
          // Reopened (open / in_progress): clear resolution lifecycle state
          sanitizedBody.resolved_at = null;
          sanitizedBody.auto_close_warning_sent_at = null;
          sanitizedBody.closed_reason = null;
        }
      }

      // Build PATCH query with tenant isolation
      let patchQuery = supabase
        .from(tableName)
        .update(sanitizedBody)
        .eq('id', id);
      
      // Apply tenant filter to ensure user can only update records in their tenant (always applied for non-global entities)
      if (shouldApplyTenantFilter) {
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          if (!allowsTenantWideAccess) {
            patchQuery = patchQuery.eq('member_id', tenantCtx.memberId);
          }
        } else if (tenantScope === TENANT_SCOPE.ORGANIZATION) {
          // For organization-scoped entities:
          // - Members with organization management permissions (admin.organizations) can access any org in their tenant
          // - Regular members can only access their own organization
          // Access is purely role-based - tenant owners are provisioned with Super Admin role which includes org access
          
          let hasCrossOrgAccess = false;
          
          if (tenantCtx.roleId) {
            const { hasCrossOrgAccess: hasAccess } = await checkCrossOrgPermissions(tenantCtx.roleId);
            hasCrossOrgAccess = hasAccess;
          }
          
          if (hasCrossOrgAccess && tenantCtx.tenantId) {
            // User has cross-org access: verify the entity's organization belongs to their tenant
            const { data: entityRecord, error: entityError } = await supabase
              .from(tableName)
              .select('organization_id')
              .eq('id', id)
              .single();
            
            if (!entityRecord?.organization_id) {
              console.warn(`[Entity PATCH] Org-scoped record has no organization_id (-> 404): entity="${entity}" id="${id}" method=${req.method} tenantId=${tenantCtx.tenantId} organizationId=${tenantCtx.organizationId} memberId=${tenantCtx.memberId} roleId=${tenantCtx.roleId}`);
              return res.status(404).json({ error: 'Entity not found' });
            }
            
            // Verify the organization belongs to the tenant
            const { data: org, error: orgError } = await supabase
              .from('organization')
              .select('tenant_id')
              .eq('id', entityRecord.organization_id)
              .single();
            
            if (!org || org.tenant_id !== tenantCtx.tenantId) {
              return res.status(403).json({ error: 'Access denied - organization not in your tenant' });
            }
            
            // Organization verified, filter by its id
            patchQuery = patchQuery.eq('organization_id', entityRecord.organization_id);
          } else if (tenantCtx.organizationId) {
            // Regular member without CRM access: can only access their own organization's data
            patchQuery = patchQuery.eq('organization_id', tenantCtx.organizationId);
          }
        } else if (entity === 'Organization') {
          if (tenantCtx.tenantId) {
            patchQuery = patchQuery.eq('tenant_id', tenantCtx.tenantId);
          } else {
            patchQuery = patchQuery.eq('id', tenantCtx.organizationId);
          }
        } else if (entityNorm === 'formsubmissionsavedview') {
          // Task #1415: a member may only update (rename / overwrite) their own saved filter views.
          if (!tenantCtx.memberId) {
            console.warn(`[Entity PATCH] FormSubmissionSavedView update without member context (-> 404): entity="${entity}" id="${id}" method=${req.method} tenantId=${tenantCtx.tenantId} organizationId=${tenantCtx.organizationId} memberId=${tenantCtx.memberId} roleId=${tenantCtx.roleId}`);
            return res.status(404).json({ error: 'Not found or access denied' });
          }
          if (tenantCtx.tenantId) patchQuery = patchQuery.eq('tenant_id', tenantCtx.tenantId);
          patchQuery = patchQuery.eq('member_id', tenantCtx.memberId);
        } else if (tenantScope === TENANT_SCOPE.TENANT) {
          const entitiesWithoutOrgId = [
            'MemberGroupClassification',
            'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
            'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'ResourceCategory', 'Resource',
            'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField',
            'ButtonStyle', 'TypographyStyle', 'BlogPost',
            'CommunicationCategory', 'CommunicationCategoryRole',
            'ForumCategory', 'ForumThread', 'ForumPost', 'ForumReaction', 'ForumReport', 'ForumModerationLog',
            'MemberBookmark', 'Role', 'Speaker', 'ResourceView',
            'Award', 'OfflineAward', 'OfflineAwardAssignment', 'EngagementAward', 'EngagementAwardAssignment',
            'OrganisationAward', 'OrganisationAwardAssignment', 'AwardClassification', 'AwardSublevel', 'Badge',
            'DynamicDirectory',
            'IEditPage', 'IEditPageElement', 'IEditPageFolder',
            'ComplexEvent', 'ComplexEventTrack', 'ComplexEventSession', 'ComplexEventTicketClass',
            'EventSponsor', 'EventSponsorCategory', 'EventSponsorAssignment', 'EventSurveyAssignment',
            'ArticleBrief', 'ArticleBriefVersion', 'ArticleBriefComment', 'ArticleBriefActivity',
            'ExternalWriter', 'ExternalWriterDocument',
            'CrmTagColor',
            'Gallery', 'GalleryPhoto', 'CardDeck',
            'MemberGroupActivity', 'Microsite', 'InstalledFont',
            'EventAgendaItem', 'EventCostLine', 'OrganizationGroup', 'OrganizationGroupPreferenceValue'
          ];
          if (tenantCtx.tenantId) {
            patchQuery = patchQuery.eq('tenant_id', tenantCtx.tenantId);
          } else if (!entitiesWithoutOrgId.includes(entity) && tenantCtx.organizationId) {
            patchQuery = patchQuery.eq('organization_id', tenantCtx.organizationId);
          }
        }
      }
      
      const { data, error } = await patchQuery.select().single();

      if (error) {
        if (error.code === 'PGRST116') {
          // Zero rows matched the tenant-scoped update filter. This is almost
          // always a tenant-context mismatch (resolved tenantId != row tenant_id)
          // or the record simply not existing. Log it so the otherwise-silent
          // 404 is greppable in production.
          console.warn(`[Entity PATCH] Update matched no rows (PGRST116 -> 404): entity="${entity}" id="${id}" method=${req.method} tenantScope=${tenantScope} tenantId=${tenantCtx.tenantId} organizationId=${tenantCtx.organizationId} memberId=${tenantCtx.memberId} roleId=${tenantCtx.roleId}`);
          return res.status(404).json({ error: 'Not found or access denied' });
        }
        if (tableName === 'speaker' && isSpeakerMemberUniqueViolation(error)) {
          return res.status(409).json({
            error: 'This member is already linked to another speaker',
            code: 'DUPLICATE_SPEAKER_MEMBER',
          });
        }
        if (error.code === '23514' && String(error.message || '').startsWith('ROLE_CAPACITY_EXCEEDED:')) {
          return res.status(409).json({
            error: String(error.message).replace(/^ROLE_CAPACITY_EXCEEDED:\s*/, ''),
          });
        }
        return res.status(500).json({ error: error.message });
      }

      // Group roles are canonical references in form access policies. A group
      // save may change spelling or merge case variants, so rewrite matching
      // policy references to the canonical surviving names. References to
      // removed roles stay in place and make the policy fail closed rather
      // than silently broadening it to any group member. Both reads and writes
      // are tenant-scoped.
      if (entityNormalized === 'membergroup'
          && Object.prototype.hasOwnProperty.call(sanitizedBody, 'roles')
          && data?.tenant_id) {
        const pageSize = 500;
        for (let from = 0; ; from += pageSize) {
          const { data: formRows, error: formLoadError } = await supabase
            .from('form')
            .select('id, access_policy')
            .eq('tenant_id', data.tenant_id)
            .not('access_policy', 'is', null)
            .order('id', { ascending: true })
            .range(from, from + pageSize - 1);
          if (formLoadError) {
            console.error('[Entity PATCH] Failed to load form group-role policies:', formLoadError.message);
            return res.status(500).json({ error: 'Group updated, but form access policies could not be synchronized' });
          }

          for (const formRow of formRows || []) {
            const nextPolicy = remapGroupRolePolicy(formRow.access_policy, id, data.roles || []);
            if (nextPolicy === formRow.access_policy) continue;
            const { error: formUpdateError } = await supabase
              .from('form')
              .update({ access_policy: nextPolicy })
              .eq('id', formRow.id)
              .eq('tenant_id', data.tenant_id);
            if (formUpdateError) {
              console.error(
                `[Entity PATCH] Failed to synchronize form ${formRow.id} group-role policy:`,
                formUpdateError.message
              );
              return res.status(500).json({ error: 'Group updated, but form access policies could not be synchronized' });
            }
          }

          if (!formRows || formRows.length < pageSize) break;
        }
      }

      // SECURITY: If login_enabled was changed to false for a member, invalidate all their sessions
      if (entityNormalized === 'member' && sanitizedBody.login_enabled === false) {
        await invalidateMemberSessions(id);
      }

      // Mirror PO edits on Booking / ProgramTicketTransaction into the matching Xero invoice.
      let xeroPoSyncResult = null;
      const isBookingPoUpdate =
        (entityNormalized === 'booking' || entityNormalized === 'programtickettransaction')
        && Object.prototype.hasOwnProperty.call(sanitizedBody, 'purchase_order_number')
        && typeof sanitizedBody.purchase_order_number === 'string'
        && sanitizedBody.purchase_order_number.trim() !== '';

      if (isBookingPoUpdate && data) {
        const trimmedPo = sanitizedBody.purchase_order_number.trim();
        let appTenantIdForXero = data.tenant_id || tenantCtx.tenantId || null;

        // Legacy rows may not carry tenant_id; fall back via organization then member.
        if (!appTenantIdForXero) {
          if (data.organization_id) {
            const { data: orgRow } = await supabase
              .from('organization')
              .select('tenant_id')
              .eq('id', data.organization_id)
              .single();
            appTenantIdForXero = orgRow?.tenant_id || null;
          }
          if (!appTenantIdForXero && data.member_id) {
            const { data: memberRow } = await supabase
              .from('member')
              .select('tenant_id')
              .eq('id', data.member_id)
              .single();
            appTenantIdForXero = memberRow?.tenant_id || null;
          }
        }

        // Booking groups share one Xero invoice — fall back to a tenant-scoped
        // group lookup when the patched row itself doesn't carry it, and apply
        // the PO across the whole group so attendees stay in sync.
        let xeroInvoiceIdForPush = data.xero_invoice_id || null;
        if (
          !xeroInvoiceIdForPush
          && entityNormalized === 'booking'
          && data.booking_group_reference
          && appTenantIdForXero
        ) {
          const { data: groupInvoiceRow } = await supabase
            .from('booking')
            .select('xero_invoice_id')
            .eq('booking_group_reference', data.booking_group_reference)
            .eq('tenant_id', appTenantIdForXero)
            .not('xero_invoice_id', 'is', null)
            .limit(1)
            .maybeSingle();
          xeroInvoiceIdForPush = groupInvoiceRow?.xero_invoice_id || null;

          if (xeroInvoiceIdForPush) {
            await supabase
              .from('booking')
              .update({ purchase_order_number: trimmedPo, po_to_follow: false })
              .eq('booking_group_reference', data.booking_group_reference)
              .eq('tenant_id', appTenantIdForXero);
          }
        }

        try {
          const _provider = await getAccountingProvider(appTenantIdForXero);
          xeroPoSyncResult = await _provider.pushPurchaseOrder({
            appTenantId: appTenantIdForXero,
            xeroInvoiceId: xeroInvoiceIdForPush,
            purchaseOrderNumber: trimmedPo,
            contextLabel: `Entity ${entity} ${id} PO update`,
          });
        } catch (provErr) {
          xeroPoSyncResult = { xeroUpdated: false, xeroError: provErr.message };
        }
      }

      if (isMemberGroupProjectsEntity && data) {
        try {
          const _session = await getSession(req);
          const _actorIdentityId = _session?.data?.identityId || null;
          await handleMemberGroupEntityChange({
            entityNorm: entityNormalized,
            action: 'update',
            data,
            beforeData,
            actorIdentityId: _actorIdentityId,
          });
        } catch (err) {
          console.error('[Entity PATCH] member-group projects hook failed:', err.message || err);
        }
        try {
          await handleMemberGroupForumChange({ entityNorm: entityNormalized, data, beforeData });
        } catch (err) {
          console.error('[Entity PATCH] member-group forum hook failed:', err.message || err);
        }
      }

      // Derive base URL for workflow email placeholders (never the raw
      // VERCEL_URL deployment domain — Task #3384). Cross-checked against
      // the record's tenant so a typo'd wildcard subdomain can't leak into
      // emailed links (Task #3387).
      const baseUrl = await getTrustedBaseUrlForTenant(req, supabase, data?.tenant_id || beforeData?.tenant_id || null);

      // Trigger workflow evaluation and check for pending confirmations
      let pendingWorkflowConfirmations = [];
      let workflowReverts = [];
      // Holds the in-flight Zoho CRM sync Promise (if any) so we can
      // await its outcome AFTER workflows finish, then surface the result
      // back in the PATCH response for the toast layer.
      let zohoCrmSyncPromise = null;
      if (isWorkflowEntity && data) {
        const entityType = entityNormalized === 'jobposting' ? 'job_posting' : entityNormalized;
        try {
          if ((entityType === 'member' || entityType === 'organization') && (data.tenant_id || beforeData?.tenant_id)) {
            zohoCrmSyncPromise = triggerZohoCrmSync(data.tenant_id || beforeData.tenant_id, entityType, id, { action: 'update' });
          }
          const workflowResult = await triggerWorkflows(entityType, id, beforeData, data, 'field_change', baseUrl);
          if (workflowResult?.pendingConfirmations?.length > 0) {
            pendingWorkflowConfirmations = workflowResult.pendingConfirmations;
          }
          if (workflowResult?.reverts?.length > 0) {
            workflowReverts = workflowResult.reverts;
          }
        } catch (err) {
          console.error('Workflow error:', err);
        }
      }
      
      if (isPreferenceValueEntity && data) {
        const entityType = entityNormalized === 'organizationpreferencevalue' ? 'organization' : 'member';
        const entityId = data.organization_id || data.member_id;
        const fieldId = data.field_id;
        
        const newValue = req.body.value !== undefined ? req.body.value : data.value;
        const prevValue = prefValueBefore;
        
        if (entityId && fieldId) {
          if (data.tenant_id || beforeData?.tenant_id) {
            triggerZohoCrmSync(data.tenant_id || beforeData.tenant_id, entityType, entityId, { action: 'preference_change' });
          }
          try {
            const prefResult = await triggerPreferenceWorkflows(entityType, entityId, fieldId, newValue, baseUrl, prevValue);
            if (prefResult?.pendingConfirmations?.length > 0) {
              pendingWorkflowConfirmations.push(...prefResult.pendingConfirmations);
            }
            if (prefResult?.reverts?.length > 0) {
              workflowReverts.push(...prefResult.reverts);
            }
          } catch (err) {
            console.error('Preference workflow error:', err);
          }
        }
      }

      // If a workflow reverted the trigger field, re-fetch the entity to get the reverted data
      let responseData = data;
      if (workflowReverts.length > 0) {
        const { data: refreshedData } = await supabase
          .from(tableName)
          .select('*')
          .eq('id', id)
          .single();
        if (refreshedData) {
          responseData = refreshedData;
        }
      }

      if (entity === 'BlogPost' && responseData && tenantCtx.tenantId) {
        dispatchWpWebhook(tenantCtx.tenantId, 'article.updated', id);
      }

      // BlogPost co-authors (Task #1222): sync the join table after update.
      if (entityNormalized === 'blogpost' && blogPostAuthorsPayload !== undefined) {
        try {
          const authorTenantId = (responseData && responseData.tenant_id) || (data && data.tenant_id) || tenantCtx.tenantId;
          await syncBlogPostAuthors(supabase, id, authorTenantId, blogPostAuthorsPayload);
        } catch (err) {
          console.error('[Entity PATCH] BlogPost author sync error:', err.message || err);
        }
      }

      const searchTextEntities = ['blogpost', 'newspost', 'event', 'resource', 'ieditpage', 'ieditpageelement', 'complexevent', 'complexeventsession', 'complexeventtrack'];
      if (searchTextEntities.includes(entityNormalized) && supabase) {
        if ((entityNormalized === 'ieditpageelement') && beforeData && data && beforeData.page_id && data.page_id && beforeData.page_id !== data.page_id) {
          rebuildSearchTextForEntity(supabase, 'IEditPage', null, beforeData.page_id).catch(err => {
            console.error('[Entity PATCH] Search text rebuild error (old parent page):', err);
          });
        }
        if ((entityNormalized === 'complexeventsession' || entityNormalized === 'complexeventtrack') && beforeData && data && beforeData.complex_event_id && data.complex_event_id && beforeData.complex_event_id !== data.complex_event_id) {
          rebuildSearchTextForEntity(supabase, 'ComplexEvent', null, beforeData.complex_event_id).catch(err => {
            console.error('[Entity PATCH] Search text rebuild error (old parent event):', err);
          });
        }
        rebuildSearchTextForEntity(supabase, entity, responseData || data, id).catch(err => {
          console.error('[Entity PATCH] Search text rebuild error:', err);
        });
      }

      // Task #2363: keep the Member AI Knowledge Assistant index fresh on edit.
      if (['BlogPost', 'NewsPost', 'Event', 'Resource', 'ComplexEvent'].includes(entity) && (responseData || data) && supabase) {
        reindexMemberContentEntitySafe(entity, responseData || data).catch(() => {});
      }

      // Support ticket resolved: notify the submitter with resolution notes +
      // one-click satisfaction rating links (fire-and-forget, never blocks the response).
      if (isSupportTicketEntity && data && beforeData
        && beforeData.status !== 'resolved' && data.status === 'resolved') {
        const supportTenantId = data.tenant_id || tenantCtx.tenantId;
        if (supportTenantId) {
          sendSupportNotification({
            tenantId: supportTenantId,
            ticketId: id,
            eventType: 'ticket_resolved',
            performedByMemberId: tenantCtx.memberId || null,
            metadata: { resolution_notes_present: !!data.resolution_notes },
          }).catch(err => {
            console.error('[Entity PATCH] SupportTicket resolved notification error:', err);
          });
        }
      }

      if (isArticleBrief && data && beforeData && tenantCtx.tenantId) {
        try {
          const activities = [];
          const performedBy = tenantCtx.memberId || null;

          if (beforeData.status !== data.status) {
            let action = 'status_changed';
            if (data.status === 'approved') action = 'approved';
            else if (data.status === 'rejected') action = 'rejected';

            activities.push({
              article_brief_id: id,
              action,
              description: `Status changed from ${beforeData.status} to ${data.status}`,
              performed_by: performedBy,
              metadata: { old_status: beforeData.status, new_status: data.status },
              tenant_id: tenantCtx.tenantId
            });
          }

          if (beforeData.assigned_writer_id !== data.assigned_writer_id) {
            activities.push({
              article_brief_id: id,
              action: 'writer_assigned',
              description: data.assigned_writer_id
                ? 'Writer assigned'
                : 'Writer unassigned',
              performed_by: performedBy,
              metadata: {
                old_writer_id: beforeData.assigned_writer_id || null,
                new_writer_id: data.assigned_writer_id || null
              },
              tenant_id: tenantCtx.tenantId
            });
          }

          if (activities.length > 0) {
            await supabase.from('article_brief_activity').insert(activities);
          }

          if (beforeData.status !== data.status) {
            const newStatus = data.status;
            let eventType = null;
            if (newStatus === 'changes_requested') {
              eventType = 'status_changed_to_changes_requested';
            }
            if (eventType) {
              sendBriefNotification({
                tenantId: tenantCtx.tenantId,
                briefId: id,
                eventType,
                performedById: tenantCtx.memberId,
                metadata: { old_status: beforeData.status, new_status: newStatus },
              }).catch(err => console.error('[Entity PATCH] Brief notification error:', err));
            }
          }

          if (beforeData.assigned_writer_id !== data.assigned_writer_id && data.assigned_writer_id) {
            sendBriefNotification({
              tenantId: tenantCtx.tenantId,
              briefId: id,
              eventType: 'writer_assigned',
              performedById: tenantCtx.memberId,
              metadata: {},
            }).catch(err => console.error('[Entity PATCH] Brief notification error:', err));
          }

          const briefContentFields = {
            title: 'Title', summary: 'Summary', instructions: 'Instructions',
            target_audience: 'Target Audience', tone_guidance: 'Tone Guidance',
            contributor_type: 'Contributor Type', word_count_target: 'Word Count',
            deadline: 'Deadline', priority: 'Priority', category: 'Category',
            notes: 'Notes', review_owner_id: 'Review Owner',
            case_study_content: 'Case Study', case_study_images: 'Case Study Images',
            case_study_permissions: 'Case Study Permissions',
          };
          const changedFields = [];
          for (const [field, label] of Object.entries(briefContentFields)) {
            if (data[field] !== undefined && JSON.stringify(beforeData[field]) !== JSON.stringify(data[field])) {
              changedFields.push(label);
            }
          }
          const statusChanged = beforeData.status !== data.status;
          const writerChanged = beforeData.assigned_writer_id !== data.assigned_writer_id;
          if (changedFields.length > 0 && !statusChanged && !writerChanged) {
            sendBriefNotification({
              tenantId: tenantCtx.tenantId,
              briefId: id,
              eventType: 'brief_updated',
              performedById: tenantCtx.memberId,
              metadata: { changed_fields: changedFields },
            }).catch(err => console.error('[Entity PATCH] Brief update notification error:', err));
          }
        } catch (actErr) {
          console.error('[Entity PATCH] Error creating ArticleBrief activity:', actErr);
        }
      }

      // Await the in-flight Zoho CRM sync (with a short timeout) so we
      // can return its outcome in the response. Lets the toast layer
      // surface success/failure/timeout immediately to the user — useful
      // for debugging without round-tripping through the sync log page.
      let zohoCrmSyncResult = null;
      if (zohoCrmSyncPromise) {
        try {
          zohoCrmSyncResult = await awaitZohoCrmSyncForResponse(zohoCrmSyncPromise);
        } catch (err) {
          console.error('[Entity PATCH] Zoho sync await threw:', err);
        }
      }

      if (pendingWorkflowConfirmations.length > 0 || workflowReverts.length > 0 || zohoCrmSyncResult || xeroPoSyncResult) {
        return res.json({
          ...responseData,
          ...(pendingWorkflowConfirmations.length > 0 && { _pendingWorkflowConfirmations: pendingWorkflowConfirmations }),
          ...(workflowReverts.length > 0 && { _workflowReverts: workflowReverts }),
          ...(zohoCrmSyncResult && { _zohoCrmSync: zohoCrmSyncResult }),
          ...(xeroPoSyncResult && {
            _xeroPoSync: {
              xeroUpdated: xeroPoSyncResult.xeroUpdated,
              xeroError: xeroPoSyncResult.xeroError,
              skipped: xeroPoSyncResult.skipped || false,
            }
          })
        });
      }

      return res.json(responseData);

    } else if (req.method === 'DELETE') {
      // Handle cascade deletion for entities with foreign key relationships

      // SECURITY (survey integrity): survey responses cannot be deleted via
      // the generic entity API — see the PATCH guard above.
      {
        const entityNormalizedDel = entity.replace(/[-_]/g, '').toLowerCase();
        if (entityNormalizedDel === 'jobposting') {
          let externalQuery = supabase
            .from('job_posting')
            .select('external_source')
            .eq('id', id);
          if (tenantCtx.tenantId) externalQuery = externalQuery.eq('tenant_id', tenantCtx.tenantId);
          const { data: externalJob } = await externalQuery.maybeSingle();
          if (externalJob?.external_source) {
            return res.status(403).json({ error: 'External job postings are managed by their feed and cannot be deleted' });
          }
        }
        if (entityNormalizedDel === 'formsubmission') {
          const { data: subRow } = await supabase
            .from('form_submission')
            .select('form_id')
            .eq('id', id)
            .eq('tenant_id', tenantCtx.tenantId)
            .maybeSingle();
          if (subRow?.form_id) {
            const { data: subForm } = await supabase
              .from('form')
              .select('form_type')
              .eq('id', subRow.form_id)
              .eq('tenant_id', tenantCtx.tenantId)
              .maybeSingle();
            if (subForm?.form_type === 'survey') {
              return res.status(403).json({ error: 'Survey responses are immutable and cannot be deleted' });
            }
          }
        }
      }

      // SECURITY: Prevent deletion of system canvas pages (slug='login').
      if (entity === 'IEditPage') {
        const { data: pageToDelete } = await supabase
          .from('i_edit_page')
          .select('slug')
          .eq('id', id)
          .maybeSingle();
        if (pageToDelete?.slug === 'login') {
          return res.status(403).json({ error: 'The login system page cannot be deleted' });
        }
      }

      // Task #2549: block removing an installed font that is a base (always-on)
      // font, or that is still referenced by a typography style or a
      // nav/portal/branding font setting. The stored value being compared is
      // the CSS font-stack (installed_font.font_stack), which is exactly what
      // typography_style.font_family and the *FontFamily branding fields store.
      if (entity === 'InstalledFont') {
        const { data: fontRow } = await supabase
          .from('installed_font')
          .select('id, tenant_id, label, font_stack, is_base')
          .eq('id', id)
          .maybeSingle();
        if (fontRow) {
          if (fontRow.is_base) {
            return res.status(409).json({
              error: `"${fontRow.label}" is a base font and cannot be removed.`,
              code: 'font_is_base',
            });
          }
          const stack = fontRow.font_stack;
          const fontTenantId = fontRow.tenant_id;
          const usedBy = [];

          const { data: typoUses } = await supabase
            .from('typography_style')
            .select('name')
            .eq('tenant_id', fontTenantId)
            .eq('font_family', stack)
            .limit(5);
          if (typoUses && typoUses.length) {
            const names = typoUses.map((t) => t.name).filter(Boolean).join(', ');
            usedBy.push(names ? `typography styles (${names})` : 'a typography style');
          }

          const { data: tenantRow } = await supabase
            .from('tenant')
            .select('header_config, branding_config')
            .eq('id', fontTenantId)
            .maybeSingle();
          const hc = tenantRow?.header_config || {};
          const bc = tenantRow?.branding_config || {};
          if (hc.topNavFontFamily === stack) usedBy.push('the top navigation font');
          if (hc.secondaryBar && hc.secondaryBar.fontFamily === stack) usedBy.push('the secondary bar font');
          if (bc.basePortalFont === stack) usedBy.push('the portal base font');

          const { data: micrositeUses } = await supabase
            .from('microsite')
            .select('name, header_config')
            .eq('tenant_id', fontTenantId);
          if (Array.isArray(micrositeUses)) {
            for (const ms of micrositeUses) {
              const mhc = ms.header_config || {};
              if (mhc.topNavFontFamily === stack || (mhc.secondaryBar && mhc.secondaryBar.fontFamily === stack)) {
                usedBy.push(`microsite "${ms.name}"`);
              }
            }
          }

          if (usedBy.length) {
            return res.status(409).json({
              error: `"${fontRow.label}" can't be removed because it's still used by ${usedBy.join(', ')}. Change those to another font first.`,
              code: 'font_in_use',
              usedBy,
            });
          }
        }
      }

      // Block the legacy unsafe Event / ComplexEvent delete path. Direct deletion
      // hard-deletes bookings without refunds, credit notes, voucher/training-fund
      // reinstatement, Zoom unregistration, or attendee notifications. All callers
      // (admin UI, SDK, automations) must go through the dedicated endpoints which
      // run the cancellation flow first via deleteEventWithCancellations.
      if (entity === 'Event' || entity === 'ComplexEvent') {
        const safeEndpoint = entity === 'Event'
          ? `/api/events/${id}/delete-with-cancellations`
          : `/api/complex-events/${id}/delete-with-cancellations`;
        console.warn(`[Entity DELETE] Refusing legacy ${entity} delete for ${id}; caller must use ${safeEndpoint}`);
        return res.status(409).json({
          error: 'Direct event deletion is disabled. Use the safe cancellation endpoint instead.',
          code: 'use_delete_with_cancellations',
          endpoint: safeEndpoint,
        });
      }

      // Task #1588: Group-Admin resource-delete authorization. Non-admin callers
      // may only delete a Resource that belongs to a group they administer;
      // tenant admins pass through unchanged.
      if (isResourceEntity(entity)) {
        const { data: existingRow } = await supabase
          .from(tableName)
          .select('id, member_group_id, tenant_id')
          .eq('id', id)
          .maybeSingle();
        const authz = await authorizeGroupAdminResourceWrite({
          op: 'delete',
          existingRow: existingRow || null,
          tenantCtx,
        });
        if (!authz.ok) {
          return res.status(authz.status || 403).json({ error: authz.error });
        }
      }

      // Tasks #1592 / #1595: Never leave a member group without an active admin.
      // Reject deleting the group's only active admin assignment — whether the
      // caller is removing their OWN assignment (self-leave) or a tenant admin
      // is removing someone else's via the group management screens.
      if (isMemberGroupAssignmentEntity(entity)) {
        const { data: existingAssignment } = await supabase
          .from(tableName)
          .select('id, member_id, group_id, is_group_admin, expires_at')
          .eq('id', id)
          .maybeSingle();
        const leaveAuthz = await authorizeMemberGroupAdminAssignmentChange({
          op: 'delete',
          existingRow: existingAssignment || null,
          tenantCtx,
        });
        if (!leaveAuthz.ok) {
          return res
            .status(leaveAuthz.status || 409)
            .json({ error: leaveAuthz.error, ...(leaveAuthz.code && { code: leaveAuthz.code }) });
        }

        // Enforce allow_members_to_leave=false.
        // Only blocks non-admin members removing their own assignment.
        if (existingAssignment && existingAssignment.group_id && tenantCtx.isAuthenticated) {
          const isAdminDel = await hasAdminAccess(tenantCtx);
          const isSelfDel  = !!(tenantCtx.memberId && existingAssignment.member_id === tenantCtx.memberId);
          if (!isAdminDel && isSelfDel) {
            const { data: grpForLeave, error: grpLeaveErr } = await supabase
              .from('member_group')
              .select('allow_members_to_leave')
              .eq('id', existingAssignment.group_id)
              .eq('tenant_id', tenantCtx.tenantId)
              .maybeSingle();
            if (grpLeaveErr) {
              console.error('[Entity DELETE] allow_members_to_leave lookup error:', grpLeaveErr.message);
              return res.status(500).json({ error: 'Failed to verify group leave policy' });
            }
            if (grpForLeave && grpForLeave.allow_members_to_leave === false) {
              return res.status(403).json({ error: 'Members are not allowed to leave this group.' });
            }
          }
        }
      }

      // First, verify tenant access to this entity before deleting (always applied for non-global entities)
      if (shouldApplyTenantFilter) {
        let verifyQuery = supabase.from(tableName).select('id').eq('id', id);
        
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          if (!allowsTenantWideAccess) {
            verifyQuery = verifyQuery.eq('member_id', tenantCtx.memberId);
          }
        } else if (tenantScope === TENANT_SCOPE.ORGANIZATION) {
          verifyQuery = verifyQuery.eq('organization_id', tenantCtx.organizationId);
        } else if (entity === 'Organization') {
          if (tenantCtx.tenantId) {
            verifyQuery = verifyQuery.eq('tenant_id', tenantCtx.tenantId);
          } else {
            verifyQuery = verifyQuery.eq('id', tenantCtx.organizationId);
          }
        } else if (tenantScope === TENANT_SCOPE.TENANT) {
          const entitiesWithoutOrgId = [
            'MemberGroupClassification',
            'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
            'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'ResourceCategory', 'Resource',
            'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField',
            'ButtonStyle', 'TypographyStyle', 'BlogPost',
            'CommunicationCategory', 'CommunicationCategoryRole',
            'ForumCategory', 'ForumThread', 'ForumPost', 'ForumReaction', 'ForumReport', 'ForumModerationLog',
            'MemberBookmark', 'Role', 'Speaker', 'ResourceView',
            'Award', 'OfflineAward', 'OfflineAwardAssignment', 'EngagementAward', 'EngagementAwardAssignment',
            'OrganisationAward', 'OrganisationAwardAssignment', 'AwardClassification', 'AwardSublevel', 'Badge',
            'DynamicDirectory',
            'IEditPage', 'IEditPageElement', 'IEditPageFolder',
            'ComplexEvent', 'ComplexEventTrack', 'ComplexEventSession', 'ComplexEventTicketClass',
            'EventSponsor', 'EventSponsorCategory', 'EventSponsorAssignment', 'EventSurveyAssignment',
            'ArticleBrief', 'ArticleBriefVersion', 'ArticleBriefComment', 'ArticleBriefActivity',
            'ExternalWriter', 'ExternalWriterDocument',
            'CrmTagColor',
            'Gallery', 'GalleryPhoto', 'CardDeck',
            'MemberGroupActivity', 'Microsite', 'InstalledFont',
            'EventAgendaItem', 'EventCostLine', 'OrganizationGroup', 'OrganizationGroupPreferenceValue'
          ];
          if (tenantCtx.tenantId) {
            verifyQuery = verifyQuery.eq('tenant_id', tenantCtx.tenantId);
          } else if (!entitiesWithoutOrgId.includes(entity) && tenantCtx.organizationId) {
            verifyQuery = verifyQuery.eq('organization_id', tenantCtx.organizationId);
          }
        }

        // Task #1414: a member may only delete their own saved filter views.
        if (entityNorm === 'formsubmissionsavedview') {
          if (!tenantCtx.memberId) {
            return res.status(404).json({ error: 'Not found or access denied' });
          }
          verifyQuery = verifyQuery.eq('member_id', tenantCtx.memberId);
        }
        
        const { data: verifyData, error: verifyError } = await verifyQuery.single();
        if (verifyError || !verifyData) {
          return res.status(404).json({ error: 'Not found or access denied' });
        }
      }
      
      // Check if Role has members assigned - if so, reassign them to default role before deletion
      if (entity === 'Role') {
        // Look up the role being deleted (need tenant_id so reassignment stays
        // tenant-scoped — never read or write member rows from another tenant).
        const { data: roleToDelete, error: roleLookupError } = await supabase
          .from('role')
          .select('name, is_system, tenant_id')
          .eq('id', id)
          .maybeSingle();

        if (roleLookupError) {
          console.error('[Role Delete] Error looking up role:', roleLookupError);
          return res.status(500).json({ error: 'Failed to look up role for deletion' });
        }

        if (!roleToDelete) {
          return res.status(404).json({ error: 'Role not found' });
        }

        if (roleToDelete.is_system === true) {
          return res.status(403).json({ error: 'System roles cannot be deleted' });
        }

        const roleTenantId = roleToDelete.tenant_id;

        // Refuse to delete a role with no tenant_id: every reassignment query
        // below must be tenant-scoped, and an unscoped fallback would be a
        // cross-tenant write hazard. Tenant-owned roles always have tenant_id.
        if (!roleTenantId) {
          console.error('[Role Delete] Refusing to delete role with no tenant_id:', id);
          return res.status(400).json({
            error: 'Cannot delete this role: role has no tenant_id, so members cannot be safely reassigned.'
          });
        }

        // Count only members in the same tenant as the role being deleted.
        const { count: memberCount, error: countError } = await supabase
          .from('member')
          .select('*', { count: 'exact', head: true })
          .eq('role_id', id)
          .eq('tenant_id', roleTenantId);

        if (countError) {
          console.error('[Role Delete] Error counting members:', countError);
        } else if (memberCount && memberCount > 0) {
          console.log(`[Role Delete] Role ${id} (tenant ${roleTenantId}) has ${memberCount} members assigned, will reassign`);

          // Find the default role within the SAME tenant — never another tenant's default.
          let fallbackRoleId = null;
          const { data: tenantRoles, error: rolesError } = await supabase
            .from('role')
            .select('id, name, is_default')
            .eq('tenant_id', roleTenantId);

          if (rolesError) {
            console.error('[Role Delete] Error fetching tenant roles:', rolesError);
            return res.status(500).json({ error: 'Failed to fetch roles for reassignment' });
          }

          const defaultRole = tenantRoles?.find(r => r.is_default === true && r.id !== id);
          if (defaultRole) {
            fallbackRoleId = defaultRole.id;
            console.log(`[Role Delete] Resolved tenant default role for reassignment: ${defaultRole.name} (${defaultRole.id})`);
          } else {
            console.warn(`[Role Delete] No default role in tenant ${roleTenantId}; affected members will be set to role_id=NULL`);
          }

          // Reassign affected members. WHERE is scoped to the same tenant in
          // addition to the role_id filter, so cross-tenant members are never
          // touched even if role_id were ever non-unique.
          const { error: reassignError } = await supabase
            .from('member')
            .update({ role_id: fallbackRoleId })
            .eq('role_id', id)
            .eq('tenant_id', roleTenantId);

          if (reassignError) {
            console.error('[Role Delete] Error reassigning members:', reassignError);
            return res.status(500).json({ error: 'Failed to reassign members from deleted role' });
          }

          console.log(`[Role Delete] Reassigned ${memberCount} members from role ${id} to ${fallbackRoleId ?? 'NULL'} within tenant ${roleTenantId}`);
        }

        const roleFkDeleteTables = [
          'role_organization_field_permission',
          'role_member_field_permission',
          'communication_category_role',
        ];

        for (const table of roleFkDeleteTables) {
          const { error: fkError } = await supabase
            .from(table)
            .delete()
            .eq('role_id', id);

          if (fkError) {
            console.error(`[Role Delete] Error deleting ${table} records for role ${id}:`, fkError.message);
          } else {
            console.log(`[Role Delete] Deleted ${table} records for role ${id}`);
          }
        }

        const roleNullifyTables = [
          { table: 'discount_code', column: 'role_id' },
          { table: 'form', column: 'default_member_role_id' },
          { table: 'fundraising_campaign', column: 'member_role_id' },
          { table: 'team_member', column: 'role_id' },
        ];

        for (const { table, column } of roleNullifyTables) {
          const { error: nullError } = await supabase
            .from(table)
            .update({ [column]: null })
            .eq(column, id);

          if (nullError) {
            console.error(`[Role Delete] Error nullifying ${table}.${column} for role ${id}:`, nullError.message);
          } else {
            console.log(`[Role Delete] Nullified ${table}.${column} references to role ${id}`);
          }
        }
      }

      // NOTE: Event / ComplexEvent deletes are short-circuited above with a 409
      // and routed through deleteEventWithCancellations. The legacy block that
      // hard-deleted bookings here has been removed.

      if (entity === 'BlogPost') {
        // First get all comment IDs for this blog post
        const { data: comments } = await supabase
          .from('article_comment')
          .select('id')
          .eq('article_id', id);
        
        // Delete comment reactions for all comments on this blog post
        if (comments && comments.length > 0) {
          const commentIds = comments.map(c => c.id);
          const { error: commentReactionsError } = await supabase
            .from('comment_reaction')
            .delete()
            .in('comment_id', commentIds);
          if (commentReactionsError) console.error('Error deleting comment reactions:', commentReactionsError);
        }

        // Delete related comments
        const { error: commentsError } = await supabase
          .from('article_comment')
          .delete()
          .eq('article_id', id);
        if (commentsError) console.error('Error deleting blog comments:', commentsError);

        // Delete related reactions
        const { error: reactionsError } = await supabase
          .from('article_reaction')
          .delete()
          .eq('article_id', id);
        if (reactionsError) console.error('Error deleting blog reactions:', reactionsError);

        // Delete related views
        const { error: viewsError } = await supabase
          .from('article_view')
          .delete()
          .eq('article_id', id);
        if (viewsError) console.error('Error deleting blog views:', viewsError);

        console.log(`[BlogPost Delete] Deleted related records for blog post ${id}`);
      }

      if (entity === 'CommunicationCategory') {
        // Delete associated role assignments
        const { error: rolesError } = await supabase
          .from('communication_category_role')
          .delete()
          .eq('category_id', id);
        if (rolesError) console.error('Error deleting category role assignments:', rolesError);

        // Delete associated member preferences
        const { error: prefsError } = await supabase
          .from('member_communication_preference')
          .delete()
          .eq('category_id', id);
        if (prefsError) console.error('Error deleting member preferences:', prefsError);

        console.log(`[CommunicationCategory Delete] Deleted related records for category ${id}`);
      }

      // Special handling for Member: anonymize personal data and delete from related tables
      // but keep the member record for financial audit trail (bookings, tickets, etc.)
      // The actual logic lives in api/_lib/memberAnonymize.js so the admin
      // merge flow (api/admin/members/merge.js) can reuse it unchanged.
      if (entity === 'Member') {
        const result = await anonymizeMember(id);
        if (!result.success) {
          return res.status(500).json({ error: result.error || 'Failed to anonymize member data' });
        }
        return res.json({ success: true, message: 'Member data anonymized and related records deleted' });
      }

      // Special handling for Organization: delete all members and their related data first
      if (entity === 'Organization') {
        console.log(`[Organization Delete] Starting cascade delete for organization ${id}`);
        
        // Check if this is a primary organization (created during tenant provisioning)
        const { data: orgCheck, error: orgCheckError } = await supabase
          .from('organization')
          .select('is_primary, name')
          .eq('id', id)
          .eq('tenant_id', tenantCtx.tenantId)
          .single();
        
        if (orgCheckError) {
          console.error('[Organization Delete] Error checking organization:', orgCheckError);
          return res.status(500).json({ error: 'Failed to verify organization' });
        }
        
        if (orgCheck?.is_primary === true) {
          console.log(`[Organization Delete] Blocked deletion of primary organization "${orgCheck.name}"`);
          return res.status(403).json({ 
            error: 'Cannot delete primary organization',
            message: 'This organization was created with your workspace and cannot be deleted. You can rename it or create additional organizations.'
          });
        }
        
        // First, get all members belonging to this organization
        const { data: members, error: membersError } = await supabase
          .from('member')
          .select('id, email')
          .eq('organization_id', id);
        
        if (membersError) {
          console.error('[Organization Delete] Error fetching members:', membersError);
          return res.status(500).json({ error: 'Failed to fetch organization members' });
        }
        
        const memberIds = (members || []).map(m => m.id);
        const memberEmails = (members || [])
          .map(m => (m.email ? m.email.toLowerCase() : null))
          .filter(Boolean);
        console.log(`[Organization Delete] Found ${memberIds.length} members to delete`);
        
        // SECURITY: Invalidate all sessions for all members in this organization
        if (memberIds.length > 0) {
          console.log(`[Organization Delete] Invalidating sessions for ${memberIds.length} members`);
          for (const memberId of memberIds) {
            await invalidateMemberSessions(memberId);
          }
        }
        
        // Anonymize member-related data for all members in this organization
        // (mirrors standalone member delete - keeps member records for audit trail)
        if (memberIds.length > 0) {
          const memberDeleteTables = [
            { table: 'member_resource_category', column: 'member_id' },
            { table: 'member_group_assignment', column: 'member_id' },
            { table: 'member_group_guest', column: 'member_id' },
            { table: 'member_preference_value', column: 'member_id' },
            { table: 'member_communication_preference', column: 'member_id' },
            { table: 'member_credentials', column: 'member_id' },
            { table: 'article_follow', column: 'follower_member_id' },
            { table: 'article_follow', column: 'followed_member_id' },
            { table: 'article_comment', column: 'author_member_id' },
            { table: 'comment_reaction', column: 'member_id' },
            { table: 'form_submission', column: 'member_id' },
            { table: 'support_ticket_response', column: 'member_id' },
            { table: 'support_ticket', column: 'member_id' },
            { table: 'workflow_log', column: 'member_id' },
          ];
          
          for (const { table, column } of memberDeleteTables) {
            const { error: deleteError } = await supabase
              .from(table)
              .delete()
              .in(column, memberIds);
            
            if (deleteError) {
              console.log(`[Organization Delete] Note: Could not delete from ${table}.${column}: ${deleteError.message}`);
            } else {
              console.log(`[Organization Delete] Deleted records from ${table} for ${memberIds.length} members`);
            }
          }

          // Nullify member references that should be preserved (history kept, just unlinked)
          const memberNullifyTables = [
            { table: 'form_submission', column: 'created_member_id' },
          ];
          for (const { table, column } of memberNullifyTables) {
            const { error: nullifyError } = await supabase
              .from(table)
              .update({ [column]: null })
              .in(column, memberIds);
            if (nullifyError) {
              console.log(`[Organization Delete] Note: Could not nullify ${table}.${column}: ${nullifyError.message}`);
            } else {
              console.log(`[Organization Delete] Nullified ${table}.${column} references for ${memberIds.length} members`);
            }
          }

          // article_view and article_reaction track members via user_identifier+is_member
          // (no member_id column). Only delete member rows; leave guest rows alone.
          for (const memberTrackedTable of ['article_view', 'article_reaction']) {
            const { error: deleteError } = await supabase
              .from(memberTrackedTable)
              .delete()
              .eq('is_member', true)
              .in('user_identifier', memberIds);

            if (deleteError) {
              console.log(`[Organization Delete] Note: Could not delete from ${memberTrackedTable}: ${deleteError.message}`);
            } else {
              console.log(`[Organization Delete] Deleted member records from ${memberTrackedTable} for ${memberIds.length} members`);
            }
          }
          
          // magic_link is keyed by email, not member_id - clean up by email
          if (memberEmails.length > 0) {
            const { error: magicLinkError } = await supabase
              .from('magic_link')
              .delete()
              .in('email', memberEmails);
            if (magicLinkError) {
              console.log(`[Organization Delete] Note: Could not delete from magic_link.email: ${magicLinkError.message}`);
            } else {
              console.log(`[Organization Delete] Deleted magic_link rows for ${memberEmails.length} member emails`);
            }
          }
          
          // Anonymize members instead of deleting (preserves FKs in bookings, transactions, etc.)
          for (const memberId of memberIds) {
            const { error: anonymizeError } = await supabase
              .from('member')
              .update({
                email: `deleted_${memberId}@deleted.local`,
                first_name: 'Deleted',
                last_name: 'Member',
                handle: null,
                job_title: null,
                biography: null,
                profile_photo_url: null,
                login_enabled: false,
                show_in_directory: false,
                organization_id: null, // Unlink from organization
              })
              .eq('id', memberId);
            
            if (anonymizeError) {
              console.log(`[Organization Delete] Note: Could not anonymize member ${memberId}: ${anonymizeError.message}`);
            }
          }
          
          console.log(`[Organization Delete] Anonymized ${memberIds.length} members`);
        }
        
        // Delete organization-related data
        const orgDeleteTables = [
          { table: 'organization_preference_value', column: 'organization_id' },
          { table: 'organization_note', column: 'organization_id' },
        ];
        
        for (const { table, column } of orgDeleteTables) {
          const { error: deleteError } = await supabase
            .from(table)
            .delete()
            .eq(column, id);
          
          if (deleteError) {
            console.log(`[Organization Delete] Note: Could not delete from ${table}.${column}: ${deleteError.message}`);
          } else {
            console.log(`[Organization Delete] Deleted records from ${table} where ${column} = ${id}`);
          }
        }
        
        // Nullify organization references in other tables (don't delete, just unlink)
        const nullifyTables = [
          { table: 'form_submission', column: 'organization_id' },
          { table: 'form_submission', column: 'created_organization_id' },
          { table: 'booking', column: 'organization_id' },
          { table: 'job_posting', column: 'posted_by_organization_id' },
          { table: 'discount_code', column: 'organization_id' },
          { table: 'voucher', column: 'organization_id' },
        ];
        
        for (const { table, column } of nullifyTables) {
          const { error: nullifyError } = await supabase
            .from(table)
            .update({ [column]: null })
            .eq(column, id);
          
          if (nullifyError) {
            console.log(`[Organization Delete] Note: Could not nullify ${table}.${column}: ${nullifyError.message}`);
          } else {
            console.log(`[Organization Delete] Nullified ${table}.${column} references`);
          }
        }
        
        // Finally delete the organization
        const { error: deleteOrgError } = await supabase
          .from('organization')
          .delete()
          .eq('id', id);
        
        if (deleteOrgError) {
          console.error('[Organization Delete] Error deleting organization:', deleteOrgError);
          return res.status(500).json({ error: `Failed to delete organization: ${deleteOrgError.message}` });
        }
        
        console.log(`[Organization Delete] Successfully deleted organization ${id} and all related data`);
        return res.json({ 
          success: true, 
          message: `Organization deleted. ${memberIds.length} members were anonymized and unlinked.` 
        });
      }

      // Speaker (Task #1509): prune this speaker's id from every event and
      // complex-event session that references it, so no event is left pointing
      // at a non-existent speaker. Scoped to the speaker's own tenant.
      if (entity === 'Speaker' && tenantCtx.tenantId) {
        try {
          const prune = await pruneSpeakerIdsFromReferences(supabase, {
            tenantId: tenantCtx.tenantId,
            speakerIds: id,
          });
          if (prune.errors.length > 0) {
            console.error(`[Speaker Delete] Reference prune errors for ${id}:`, prune.errors);
          } else {
            console.log(`[Speaker Delete] Pruned references for ${id}: ${prune.eventsUpdated} event(s), ${prune.sessionsUpdated} session(s)`);
          }
        } catch (pruneErr) {
          console.error(`[Speaker Delete] Error pruning references for ${id}:`, pruneErr);
        }
      }

      // Task #1595: Deleting a whole MemberGroup must remove its assignments
      // first. member_group_assignment.group_id is the only NO ACTION FK to
      // member_group (all other references cascade/set null at the DB level),
      // so the group delete would otherwise fail. Doing this server-side keeps
      // group deletion atomic and means the client no longer loop-deletes
      // assignments — which would trip the last-group-admin guard on the
      // group's only admin.
      if (entity === 'MemberGroup') {
        const { error: childError } = await supabase
          .from('member_group_assignment')
          .delete()
          .eq('group_id', id);
        if (childError) {
          console.error(`[MemberGroup Delete] Error deleting assignments for group ${id}:`, childError.message);
          return res.status(500).json({ error: `Failed to delete group assignments: ${childError.message}` });
        }
        console.log(`[MemberGroup Delete] Removed assignments for group ${id}`);
      }

      console.log(`[Entity DELETE] About to delete from ${tableName} where id=${id}`);
      const { data: deleteData, error, count } = await supabase
        .from(tableName)
        .delete()
        .eq('id', id)
        .select();

      if (error) {
        console.error(`[Entity DELETE] Error deleting ${tableName} id=${id}:`, error.message, error.details, error.hint, error.code);
        return res.status(500).json({ error: error.message });
      }

      const rowsDeleted = deleteData ? deleteData.length : 0;
      console.log(`[Entity DELETE] Delete result for ${tableName} id=${id}: ${rowsDeleted} row(s) deleted`);

      if (rowsDeleted === 0) {
        console.warn(`[Entity DELETE] WARNING: Delete returned 0 rows for ${tableName} id=${id}. Row may still exist (trigger cancellation or row not found).`);
        return res.status(404).json({ error: 'Record not found or could not be deleted' });
      }

      if (entity === 'BlogPost' && tenantCtx.tenantId) {
        dispatchWpWebhook(tenantCtx.tenantId, 'article.deleted', id);
      }

      if (supabase && deleteData && deleteData.length > 0) {
        const deletedRecord = deleteData[0];
        const _entityNormDel = entity.replace(/[-_]/g, '').toLowerCase();
        if (_entityNormDel === 'membergroup' || _entityNormDel === 'membergroupassignment') {
          try {
            const _session = await getSession(req);
            const _actorIdentityId = _session?.data?.identityId || null;
            await handleMemberGroupEntityChange({
              entityNorm: _entityNormDel,
              action: 'delete',
              data: null,
              beforeData: deletedRecord,
              actorIdentityId: _actorIdentityId,
            });
          } catch (err) {
            console.error('[Entity DELETE] member-group projects hook failed:', err.message || err);
          }
          try {
            await handleMemberGroupForumChange({ entityNorm: _entityNormDel, data: null, beforeData: deletedRecord });
          } catch (err) {
            console.error('[Entity DELETE] member-group forum hook failed:', err.message || err);
          }
          if (_entityNormDel === 'membergroupassignment' && deletedRecord.member_id && deletedRecord.group_id && deletedRecord.tenant_id) {
            try {
              const { data: grp } = await supabase.from('member_group').select('name').eq('id', deletedRecord.group_id).maybeSingle();
              const actorEmail = await resolveActorEmail(tenantCtx.memberId, supabase);
              await recordMemberGroupActivity({
                memberId: deletedRecord.member_id,
                groupId: deletedRecord.group_id,
                groupName: grp?.name || '(unknown group)',
                action: 'left',
                actorEmail,
                tenantId: deletedRecord.tenant_id,
                supabaseClient: supabase,
              });
            } catch (err) {
              console.error('[Entity DELETE] member-group activity record failed:', err.message || err);
            }
          }
        }
        if (entity === 'IEditPageElement' && deletedRecord.page_id) {
          rebuildSearchTextForEntity(supabase, 'IEditPage', null, deletedRecord.page_id).catch(err => {
            console.error('[Entity DELETE] Search text rebuild error for page:', err);
          });
        }
        if (entity === 'ComplexEventSession' && deletedRecord.complex_event_id) {
          rebuildSearchTextForEntity(supabase, 'ComplexEvent', null, deletedRecord.complex_event_id).catch(err => {
            console.error('[Entity DELETE] Search text rebuild error for complex event:', err);
          });
        }
        if (entity === 'ComplexEventTrack' && deletedRecord.complex_event_id) {
          rebuildSearchTextForEntity(supabase, 'ComplexEvent', null, deletedRecord.complex_event_id).catch(err => {
            console.error('[Entity DELETE] Search text rebuild error for complex event:', err);
          });
        }
      }

      // Task #2363: drop Member AI Knowledge Assistant chunks for deleted content.
      if (['BlogPost', 'NewsPost', 'Event', 'Resource', 'ComplexEvent'].includes(entity) && supabase) {
        deleteMemberContentEntitySafe(entity, id).catch(() => {});
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Entity error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
