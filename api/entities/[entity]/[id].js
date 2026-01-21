import { triggerWorkflows, triggerPreferenceWorkflows } from '../../_lib/workflows.js';
import { invalidateMemberSessions, getSessionMember } from '../../_lib/session.js';
import { supabase } from '../../_lib/database.js';
import { getTenantContext, getEntityTenantScope, getTenantColumn, TENANT_SCOPE, checkMemberCrmPermissions } from '../../_lib/tenantContext.js';

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

export default async function handler(req, res) {
  const { entity, id } = req.query;
  console.log(`[Entity ${req.method}] Incoming request: entity="${entity}", id="${id}"`);
  
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tableName = getTableName(entity);

  // Get tenant context from session
  const tenantCtx = await getTenantContext(req);
  const tenantScope = getEntityTenantScope(entity);
  
  // Determine if tenant filtering should be applied
  const shouldApplyTenantFilter = tenantScope !== TENANT_SCOPE.GLOBAL;
  
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
    // For member-scoped entities, require a valid member_id
    if (tenantScope === TENANT_SCOPE.MEMBER && !tenantCtx.memberId) {
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
      
      // Apply tenant isolation filter for single-entity GET (always applied for non-global entities)
      if (shouldApplyTenantFilter) {
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          query = query.eq('member_id', tenantCtx.memberId);
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
        } else if (tenantScope === TENANT_SCOPE.TENANT) {
          // Tenant-scoped entities: filter by tenant_id or fall back to organization_id
          // These entities have been fully migrated to tenant_id only (no organization_id column):
          const entitiesWithoutOrgId = [
            'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
            'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'ResourceCategory', 'Resource',
            'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField'
          ];
          if (tenantCtx.tenantId) {
            query = query.eq('tenant_id', tenantCtx.tenantId);
          } else if (!entitiesWithoutOrgId.includes(entity) && tenantCtx.organizationId) {
            query = query.eq('organization_id', tenantCtx.organizationId);
          }
        }
      }
      
      const { data, error } = await query.single();

      if (error) {
        if (error.code === 'PGRST116') return res.status(404).json({ error: 'Not found' });
        return res.status(500).json({ error: error.message });
      }
      return res.json(data);

    } else if (req.method === 'PATCH') {
      console.log(`[Entity PATCH] Entity: "${entity}", ID: ${id}, Body:`, JSON.stringify(req.body));
      
      // Normalize entity name for comparison (handles both PascalCase and slug-case)
      const entityNormalized = entity.replace(/[-_]/g, '').toLowerCase();
      console.log(`[Entity PATCH] Normalized entity: "${entityNormalized}"`);
      
      // For Organization/Member/JobPosting, fetch before data for workflow evaluation
      let beforeData = null;
      const isWorkflowEntity = entityNormalized === 'organization' || entityNormalized === 'member' || entityNormalized === 'jobposting';
      const isPreferenceValueEntity = entityNormalized === 'organizationpreferencevalue' || entityNormalized === 'memberpreferencevalue';
      
      console.log(`[Entity PATCH] isPreferenceValueEntity: ${isPreferenceValueEntity}`);
      
      if (isWorkflowEntity) {
        try {
          let beforeQuery = supabase
            .from(tableName)
            .select('*')
            .eq('id', id);
          
          // Apply tenant filter to beforeData fetch (always applied for non-global entities)
          if (shouldApplyTenantFilter) {
            if (tenantScope === TENANT_SCOPE.MEMBER) {
              beforeQuery = beforeQuery.eq('member_id', tenantCtx.memberId);
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
                'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
                'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'ResourceCategory', 'Resource',
                'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField'
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
      const sanitizedBody = { ...req.body };
      const uuidFields = ['role_id', 'organization_id', 'member_id', 'parent_id', 'form_id', 'event_id', 
                          'category_id', 'template_id', 'workflow_id', 'speaker_id', 'created_by', 'updated_by'];
      for (const field of uuidFields) {
        if (field in sanitizedBody && sanitizedBody[field] === '') {
          sanitizedBody[field] = null;
        }
      }
      
      // SECURITY: Strip tenant linkage fields from PATCH body to prevent tenant reassignment attacks
      // tenant_id, organization_id and member_id should never be changed via PATCH
      if (shouldApplyTenantFilter) {
        delete sanitizedBody.tenant_id;
        delete sanitizedBody.organization_id;
        delete sanitizedBody.member_id;
      }

      // Normalize email to lowercase for member, team_member, and magic_link entities
      // Use normalized entity name (already computed above) to handle both PascalCase and slug-case variants
      if ((entityNormalized === 'member' || entityNormalized === 'teammember' || entityNormalized === 'magiclink') && sanitizedBody.email) {
        sanitizedBody.email = sanitizedBody.email.toLowerCase();
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

      // Build PATCH query with tenant isolation
      let patchQuery = supabase
        .from(tableName)
        .update(sanitizedBody)
        .eq('id', id);
      
      // Apply tenant filter to ensure user can only update records in their tenant (always applied for non-global entities)
      if (shouldApplyTenantFilter) {
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          patchQuery = patchQuery.eq('member_id', tenantCtx.memberId);
        } else if (tenantScope === TENANT_SCOPE.ORGANIZATION) {
          // For organization-scoped entities:
          // - Tenant users (tenantUserId present) can access any org in their tenant
          // - Members with CRM permissions can access any org in their tenant
          // - Regular members can only access their own organization
          
          // Check if this is a tenant_user (has tenantUserId) or a member with CRM permissions
          let hasCrossOrgAccess = !!tenantCtx.tenantUserId;
          
          if (!hasCrossOrgAccess && tenantCtx.memberId) {
            // Check if member has CRM permissions via their role
            const sessionMember = await getSessionMember(req);
            if (sessionMember?.role_id) {
              const { hasCrmAccess } = await checkMemberCrmPermissions(sessionMember.role_id);
              hasCrossOrgAccess = hasCrmAccess;
              console.log(`[Entity PATCH] CRM permission check: roleId=${sessionMember.role_id}, hasCrmAccess=${hasCrmAccess}`);
            }
          }
          
          console.log(`[Entity PATCH] ORGANIZATION scope: organizationId=${tenantCtx.organizationId}, tenantId=${tenantCtx.tenantId}, hasCrossOrgAccess=${hasCrossOrgAccess}`);
          
          if (hasCrossOrgAccess && tenantCtx.tenantId) {
            // User has cross-org access: verify the entity's organization belongs to their tenant
            console.log(`[Entity PATCH] Cross-org access path - fetching entity ${id} from ${tableName}`);
            const { data: entityRecord, error: entityError } = await supabase
              .from(tableName)
              .select('organization_id')
              .eq('id', id)
              .single();
            
            console.log(`[Entity PATCH] Entity lookup result: data=${JSON.stringify(entityRecord)}, error=${JSON.stringify(entityError)}`);
            
            if (!entityRecord?.organization_id) {
              return res.status(404).json({ error: 'Entity not found' });
            }
            
            // Verify the organization belongs to the tenant
            const { data: org, error: orgError } = await supabase
              .from('organization')
              .select('tenant_id')
              .eq('id', entityRecord.organization_id)
              .single();
            
            console.log(`[Entity PATCH] Org lookup result: org.tenant_id=${org?.tenant_id}, tenantCtx.tenantId=${tenantCtx.tenantId}, match=${org?.tenant_id === tenantCtx.tenantId}`);
            
            if (!org || org.tenant_id !== tenantCtx.tenantId) {
              return res.status(403).json({ error: 'Access denied - organization not in your tenant' });
            }
            
            // Organization verified, filter by its id
            console.log(`[Entity PATCH] Verification passed - adding filter organization_id=${entityRecord.organization_id}`);
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
        } else if (tenantScope === TENANT_SCOPE.TENANT) {
          const entitiesWithoutOrgId = [
            'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
            'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'ResourceCategory', 'Resource',
            'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField'
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
        if (error.code === 'PGRST116') return res.status(404).json({ error: 'Not found or access denied' });
        return res.status(500).json({ error: error.message });
      }

      // SECURITY: If login_enabled was changed to false for a member, invalidate all their sessions
      if (entityNormalized === 'member' && sanitizedBody.login_enabled === false) {
        console.log(`[Entity PATCH] Member login disabled - invalidating sessions for member ${id}`);
        await invalidateMemberSessions(id);
      }

      // Derive base URL for workflow email placeholders
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      let host = req.headers['x-forwarded-host'] || req.headers.host || '';
      
      // Fallback to VERCEL_URL or configured APP_URL if host is missing
      if (!host && process.env.VERCEL_URL) {
        host = process.env.VERCEL_URL;
      }
      
      const baseUrl = host ? `${protocol}://${host}` : (process.env.APP_URL || '');
      console.log(`[Entity PATCH] Derived baseUrl: "${baseUrl}"`);

      // Trigger workflow evaluation and check for pending confirmations
      let pendingWorkflowConfirmations = [];
      if (isWorkflowEntity && data) {
        const entityType = entityNormalized === 'jobposting' ? 'job_posting' : entityNormalized;
        try {
          const workflowResult = await triggerWorkflows(entityType, id, beforeData, data, 'field_change', baseUrl);
          if (workflowResult?.pendingConfirmations?.length > 0) {
            pendingWorkflowConfirmations = workflowResult.pendingConfirmations;
            console.log(`[Entity PATCH] ${pendingWorkflowConfirmations.length} workflow(s) pending confirmation`);
          }
        } catch (err) {
          console.error('[Entity PATCH] Workflow error:', err);
        }
      }
      
      // Also trigger workflows when preference values are updated
      if (isPreferenceValueEntity && data) {
        const entityType = entityNormalized === 'organizationpreferencevalue' ? 'organization' : 'member';
        const entityId = data.organization_id || data.member_id;
        const fieldId = data.field_id;
        
        // Log what was in the request vs what's in the response
        console.log(`[Entity PATCH] Preference PATCH - req.body.value: "${req.body.value}", data.value: "${data.value}"`);
        console.log(`[Entity PATCH] Preference value updated - entityId: ${entityId}, fieldId: ${fieldId}, value: ${data.value}`);
        console.log(`[Entity PATCH] Full data returned:`, JSON.stringify(data));
        
        // Use req.body.value (what was sent) rather than data.value (what was returned)
        // This ensures we check against the NEW value being set
        const newValue = req.body.value !== undefined ? req.body.value : data.value;
        console.log(`[Entity PATCH] newValue to use: "${newValue}"`);
        
        if (entityId && fieldId) {
          console.log(`[Entity PATCH] Calling triggerPreferenceWorkflows with entityType=${entityType}, entityId=${entityId}, fieldId=${fieldId}, value=${newValue}`);
          // Await the workflow trigger to ensure it completes before returning
          try {
            const prefResult = await triggerPreferenceWorkflows(entityType, entityId, fieldId, newValue, baseUrl);
            console.log(`[Entity PATCH] triggerPreferenceWorkflows completed`);
            // Add any pending confirmations from preference workflows
            if (prefResult?.pendingConfirmations?.length > 0) {
              pendingWorkflowConfirmations.push(...prefResult.pendingConfirmations);
            }
          } catch (err) {
            console.error('[Entity PATCH] Preference workflow error:', err);
          }
        } else {
          console.log(`[Entity PATCH] SKIPPING workflow - missing entityId (${entityId}) or fieldId (${fieldId})`);
        }
      } else {
        console.log(`[Entity PATCH] Not a preference value entity or no data: isPreferenceValueEntity=${isPreferenceValueEntity}, data=${!!data}`);
      }

      // If there are pending workflow confirmations, include them in the response
      if (pendingWorkflowConfirmations.length > 0) {
        return res.json({
          ...data,
          _pendingWorkflowConfirmations: pendingWorkflowConfirmations
        });
      }

      return res.json(data);

    } else if (req.method === 'DELETE') {
      // Handle cascade deletion for entities with foreign key relationships
      
      // First, verify tenant access to this entity before deleting (always applied for non-global entities)
      if (shouldApplyTenantFilter) {
        let verifyQuery = supabase.from(tableName).select('id').eq('id', id);
        
        if (tenantScope === TENANT_SCOPE.MEMBER) {
          verifyQuery = verifyQuery.eq('member_id', tenantCtx.memberId);
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
            'PortalMenu', 'PortalNavigationItem', 'NavigationItem', 'PageBanner', 'Floater',
            'FormDueDiligenceConfig', 'FormSubmissionDueDiligence', 'Form', 'ResourceCategory', 'Resource',
            'FileRepository', 'FileRepositoryFolder', 'Event', 'NewsPost', 'SystemSettings', 'PreferenceField'
          ];
          if (tenantCtx.tenantId) {
            verifyQuery = verifyQuery.eq('tenant_id', tenantCtx.tenantId);
          } else if (!entitiesWithoutOrgId.includes(entity) && tenantCtx.organizationId) {
            verifyQuery = verifyQuery.eq('organization_id', tenantCtx.organizationId);
          }
        }
        
        const { data: verifyData, error: verifyError } = await verifyQuery.single();
        if (verifyError || !verifyData) {
          return res.status(404).json({ error: 'Not found or access denied' });
        }
      }
      
      // Check if Role has members assigned - if so, reassign them to default role before deletion
      if (entity === 'Role') {
        // Protect system roles from deletion
        const { data: roleToDelete } = await supabase
          .from('role')
          .select('name, is_system')
          .eq('id', id)
          .single();
        
        if (roleToDelete?.is_system === true) {
          return res.status(403).json({ error: 'System roles cannot be deleted' });
        }

        const { count: memberCount, error: countError } = await supabase
          .from('member')
          .select('*', { count: 'exact', head: true })
          .eq('role_id', id);

        if (countError) {
          console.error('[Role Delete] Error counting members:', countError);
        } else if (memberCount && memberCount > 0) {
          console.log(`[Role Delete] Role ${id} has ${memberCount} members assigned, will reassign to default role`);
          
          // Find the default role
          const { data: allRoles, error: rolesError } = await supabase
            .from('role')
            .select('id, name, is_default');
          
          if (rolesError) {
            console.error('[Role Delete] Error fetching roles:', rolesError);
            return res.status(500).json({ error: 'Failed to fetch roles for reassignment' });
          }
          
          const defaultRole = allRoles?.find(r => r.is_default === true && r.id !== id);
          
          if (!defaultRole) {
            console.error('[Role Delete] No default role found for reassignment');
            return res.status(400).json({ 
              error: 'Cannot delete this role: no default role available for member reassignment. Please mark another role as default first.'
            });
          }
          
          // Reassign all members from this role to the default role
          const { error: reassignError } = await supabase
            .from('member')
            .update({ role_id: defaultRole.id })
            .eq('role_id', id);
          
          if (reassignError) {
            console.error('[Role Delete] Error reassigning members:', reassignError);
            return res.status(500).json({ error: 'Failed to reassign members to default role' });
          }
          
          console.log(`[Role Delete] Reassigned ${memberCount} members from role ${id} to default role ${defaultRole.name} (${defaultRole.id})`);
        }
      }

      if (entity === 'Event') {
        // First delete any bookings associated with this event
        const { error: bookingDeleteError } = await supabase
          .from('booking')
          .delete()
          .eq('event_id', id);

        if (bookingDeleteError) {
          console.error('Error deleting event bookings:', bookingDeleteError);
          // Continue anyway - there might not be any bookings
        } else {
          console.log(`[Event Delete] Deleted associated bookings for event ${id}`);
        }
      }

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
      if (entity === 'Member') {
        console.log(`[Member Delete] Starting anonymization and cleanup for member ${id}`);
        
        // SECURITY: Invalidate all sessions for this member FIRST to force immediate logout
        const sessionResult = await invalidateMemberSessions(id);
        console.log(`[Member Delete] Session invalidation result:`, sessionResult);
        
        // Delete from member-related tables (personal data, preferences, activity)
        const deleteTables = [
          { table: 'member_resource_category', column: 'member_id' },
          { table: 'member_group_assignment', column: 'member_id' },
          { table: 'member_group_guest', column: 'member_id' },
          { table: 'member_preference_value', column: 'member_id' },
          { table: 'member_communication_preference', column: 'member_id' },
          { table: 'magic_link', column: 'member_id' },
          { table: 'member_credentials', column: 'member_id' },
          { table: 'article_follow', column: 'follower_member_id' },
          { table: 'article_follow', column: 'followed_member_id' },
          { table: 'article_comment', column: 'member_id' },
          { table: 'article_view', column: 'member_id' },
          { table: 'article_reaction', column: 'member_id' },
          { table: 'comment_reaction', column: 'member_id' },
          { table: 'form_submission', column: 'member_id' },
          { table: 'support_ticket_response', column: 'member_id' },
          { table: 'support_ticket', column: 'member_id' },
          { table: 'workflow_log', column: 'member_id' },
          { table: 'organization_note', column: 'author_member_id' },
        ];
        
        for (const { table, column } of deleteTables) {
          const { error: deleteError } = await supabase
            .from(table)
            .delete()
            .eq(column, id);
          
          if (deleteError) {
            console.log(`[Member Delete] Note: Could not delete from ${table}.${column}: ${deleteError.message}`);
          } else {
            console.log(`[Member Delete] Deleted records from ${table} where ${column} = ${id}`);
          }
        }
        
        // Anonymize the member record - clear ALL personal data but keep id
        // Based on actual schema/Member.json columns
        const { error: anonymizeError } = await supabase
          .from('member')
          .update({
            email: `deleted_${id}@deleted.local`,
            first_name: 'Deleted',
            last_name: 'Member',
            handle: null,
            job_title: null,
            biography: null,
            profile_photo_url: null,
            login_enabled: false,
            show_in_directory: false,
          })
          .eq('id', id);
        
        if (anonymizeError) {
          console.error(`[Member Delete] Error anonymizing member ${id}:`, anonymizeError);
          return res.status(500).json({ error: 'Failed to anonymize member data' });
        }
        
        console.log(`[Member Delete] Successfully anonymized member ${id} and deleted related data`);
        return res.json({ success: true, message: 'Member data anonymized and related records deleted' });
      }

      // Special handling for Organization: delete all members and their related data first
      if (entity === 'Organization') {
        console.log(`[Organization Delete] Starting cascade delete for organization ${id}`);
        
        // First, get all members belonging to this organization
        const { data: members, error: membersError } = await supabase
          .from('member')
          .select('id')
          .eq('organization_id', id);
        
        if (membersError) {
          console.error('[Organization Delete] Error fetching members:', membersError);
          return res.status(500).json({ error: 'Failed to fetch organization members' });
        }
        
        const memberIds = (members || []).map(m => m.id);
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
            { table: 'magic_link', column: 'member_id' },
            { table: 'member_credentials', column: 'member_id' },
            { table: 'article_follow', column: 'follower_member_id' },
            { table: 'article_follow', column: 'followed_member_id' },
            { table: 'article_comment', column: 'member_id' },
            { table: 'article_view', column: 'member_id' },
            { table: 'article_reaction', column: 'member_id' },
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

      const { error } = await supabase
        .from(tableName)
        .delete()
        .eq('id', id);

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Entity error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
