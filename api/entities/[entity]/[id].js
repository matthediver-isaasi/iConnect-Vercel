import { createClient } from '@supabase/supabase-js';
import { triggerWorkflows, triggerPreferenceWorkflows } from '../../_lib/workflows.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Entity name to Supabase table mapping (singular names for Base44 compatibility)
const entityToTable = {
  'Member': 'member',
  'Organization': 'organization',
  'Event': 'event',
  'ZohoToken': 'zoho_token',
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
};

const getTableName = (entity) => entityToTable[entity] || entity.toLowerCase().replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const { entity, id } = req.query;
  const tableName = getTableName(entity);

  try {
    if (req.method === 'GET') {
      const { expand } = req.query;
      const { data, error } = await supabase
        .from(tableName)
        .select(expand || '*')
        .eq('id', id)
        .single();

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
      
      // For Organization/Member, fetch before data for workflow evaluation
      let beforeData = null;
      const isWorkflowEntity = entityNormalized === 'organization' || entityNormalized === 'member';
      const isPreferenceValueEntity = entityNormalized === 'organizationpreferencevalue' || entityNormalized === 'memberpreferencevalue';
      
      console.log(`[Entity PATCH] isPreferenceValueEntity: ${isPreferenceValueEntity}`);
      
      if (isWorkflowEntity) {
        try {
          const { data: existingData } = await supabase
            .from(tableName)
            .select('*')
            .eq('id', id)
            .single();
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

      const { data, error } = await supabase
        .from(tableName)
        .update(sanitizedBody)
        .eq('id', id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });

      // Derive base URL for workflow email placeholders
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      let host = req.headers['x-forwarded-host'] || req.headers.host || '';
      
      // Fallback to VERCEL_URL or configured APP_URL if host is missing
      if (!host && process.env.VERCEL_URL) {
        host = process.env.VERCEL_URL;
      }
      
      const baseUrl = host ? `${protocol}://${host}` : (process.env.APP_URL || '');
      console.log(`[Entity PATCH] Derived baseUrl: "${baseUrl}"`);

      // Trigger workflow evaluation (non-blocking)
      if (isWorkflowEntity && data) {
        const entityType = entity.toLowerCase();
        triggerWorkflows(entityType, id, beforeData, data, 'field_change', baseUrl).catch(err => {
          console.error('[Entity PATCH] Workflow error:', err);
        });
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
            await triggerPreferenceWorkflows(entityType, entityId, fieldId, newValue, baseUrl);
            console.log(`[Entity PATCH] triggerPreferenceWorkflows completed`);
          } catch (err) {
            console.error('[Entity PATCH] Preference workflow error:', err);
          }
        } else {
          console.log(`[Entity PATCH] SKIPPING workflow - missing entityId (${entityId}) or fieldId (${fieldId})`);
        }
      } else {
        console.log(`[Entity PATCH] Not a preference value entity or no data: isPreferenceValueEntity=${isPreferenceValueEntity}, data=${!!data}`);
      }

      return res.json(data);

    } else if (req.method === 'DELETE') {
      // Handle cascade deletion for entities with foreign key relationships
      
      // Check if Role has members assigned - if so, reassign them to default role before deletion
      if (entity === 'Role') {
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
