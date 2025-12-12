import { createClient } from '@supabase/supabase-js';
import { sendEmail, replacePlaceholders } from '../../_lib/emailService.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Inline workflow evaluation to avoid module import issues in Vercel
async function triggerWorkflows(entityType, entityId, beforeData, afterData, triggerType) {
  if (!supabase) return;
  
  try {
    const { data: workflows } = await supabase
      .from('workflow')
      .select('*')
      .eq('entity_type', entityType)
      .eq('is_active', true);

    if (!workflows || workflows.length === 0) return;
    
    console.log(`[Workflows] Evaluating ${workflows.length} workflows for ${entityType}:${entityId}`);

    for (const workflow of workflows) {
      let triggerMatches = false;
      
      if (workflow.trigger_type === 'record_update' && triggerType === 'field_change') {
        triggerMatches = true;
      } else if (workflow.trigger_type === 'record_create' && triggerType === 'record_create') {
        triggerMatches = true;
      } else if (workflow.trigger_type === 'field_change' && triggerType === 'field_change') {
        const cfg = workflow.trigger_config;
        if (cfg && cfg.field_id) {
          // Skip custom field workflows here - they are handled by triggerPreferenceWorkflows
          // when the OrganizationPreferenceValue/MemberPreferenceValue is updated
          if (cfg.field_type === 'custom') {
            console.log(`[Workflows] Skipping custom field workflow "${workflow.name}" - handled by preference value update`);
            continue;
          }
          
          // Only handle core field changes here
          const before = String(beforeData?.[cfg.field_id] ?? '');
          const after = String(afterData?.[cfg.field_id] ?? '');
          const target = String(cfg.value ?? '');
          
          console.log(`[Workflows] Check ${workflow.name}: field=${cfg.field_id}, type=${cfg.field_type}, before="${before}", after="${after}", target="${target}", op=${cfg.operator}`);
          
          switch (cfg.operator) {
            case 'equals': triggerMatches = after.toLowerCase() === target.toLowerCase(); break;
            case 'changed': triggerMatches = before !== after; break;
            case 'changed_to': 
              triggerMatches = before !== after && after.toLowerCase() === target.toLowerCase();
              break;
            default: triggerMatches = false;
          }
          
          console.log(`[Workflows] Trigger match for ${workflow.name}: ${triggerMatches}`);
        }
      }

      if (!triggerMatches) continue;

      // Check trigger_mode: if 'once_per_record', skip if already executed for this entity
      if (workflow.trigger_mode === 'once_per_record') {
        const { data: existingLogs } = await supabase
          .from('workflow_log')
          .select('id')
          .eq('workflow_id', workflow.id)
          .eq('entity_type', entityType)
          .eq('entity_id', entityId)
          .limit(1);
        
        if (existingLogs && existingLogs.length > 0) {
          console.log(`[Workflows] Skipping "${workflow.name}" - trigger_mode=once_per_record and already executed for entity ${entityId}`);
          continue;
        }
      }

      console.log(`[Workflows] Executing workflow: ${workflow.name} (trigger_mode=${workflow.trigger_mode || 'every_time'})`);

      // Execute actions
      const results = [];
      for (const action of (workflow.actions || [])) {
        if (action.type === 'update_field' && action.config?.field_type === 'core') {
          const table = entityType === 'organization' ? 'organization' : 'member';
          await supabase.from(table).update({ [action.config.field_id]: action.config.value }).eq('id', entityId);
          results.push({ action_type: 'update_field', status: 'success' });
        } else if (action.type === 'send_email') {
          console.log(`[Workflows] send_email action config:`, JSON.stringify(action.config, null, 2));
          
          let subject, body, fromEmail, replyTo;
          
          // Check if using template mode
          const useTemplateMode = (action.config?.mode === 'template' || action.config?.template_id) && action.config?.template_id;
          if (useTemplateMode) {
            console.log(`[Workflows] Using template mode, fetching template: ${action.config.template_id}`);
            const { data: template, error: templateError } = await supabase
              .from('email_template')
              .select('*')
              .eq('id', action.config.template_id)
              .single();
            
            console.log(`[Workflows] Template fetch result:`, template ? 'found' : 'not found', templateError ? templateError.message : '');
            
            if (!template || template.is_active === false) {
              console.log(`[Workflows] Email template ${action.config.template_id} not found or inactive`);
              results.push({ 
                action_type: 'send_email', 
                status: 'failed',
                error: 'Email template not found or inactive'
              });
              continue;
            }
            
            subject = template.subject || '';
            body = template.body || '';
            fromEmail = template.from_email;
            replyTo = template.reply_to;
            console.log(`[Workflows] Template loaded - subject: "${subject}", body length: ${body?.length}`);
          } else {
            subject = action.config?.subject || '';
            body = action.config?.body || '';
            console.log(`[Workflows] Using custom email mode`);
          }
          
          const to = replacePlaceholders(action.config.to, entityType, afterData);
          subject = replacePlaceholders(subject, entityType, afterData);
          body = replacePlaceholders(body, entityType, afterData);
          
          console.log(`[Workflows] Sending email - to: "${to}", subject: "${subject}", body length: ${body?.length}`);
          
          const emailResult = await sendEmail({ to, subject, html: body, from: fromEmail, replyTo });
          console.log(`[Workflows] Email result:`, JSON.stringify(emailResult));
          
          results.push({ 
            action_type: 'send_email', 
            status: emailResult.success ? 'success' : 'failed',
            messageId: emailResult.messageId,
            error: emailResult.error,
            template_id: action.config?.template_id
          });
        }
      }

      // Log execution
      await supabase.from('workflow_log').insert({
        workflow_id: workflow.id,
        entity_type: entityType,
        entity_id: entityId,
        trigger_data: { before: beforeData, after: afterData, trigger_type: triggerType },
        actions_executed: results,
        status: 'success'
      });
      
      console.log(`[Workflows] Logged execution for ${workflow.name}`);
    }
  } catch (err) {
    console.error('[Workflows] Error:', err.message, err.stack);
  }
}

// Trigger workflows when a preference field value changes
async function triggerPreferenceWorkflows(entityType, entityId, fieldId, value) {
  if (!supabase) return;
  
  try {
    const { data: workflows } = await supabase
      .from('workflow')
      .select('*')
      .eq('entity_type', entityType)
      .eq('trigger_type', 'field_change')
      .eq('is_active', true);

    if (!workflows || workflows.length === 0) return;
    
    console.log(`[Workflows] Evaluating ${workflows.length} workflows for ${entityType} preference field ${fieldId}, incoming value="${value}"`);

    for (const workflow of workflows) {
      const cfg = workflow.trigger_config;
      console.log(`[Workflows] Checking workflow "${workflow.name}": cfg.field_id=${cfg?.field_id}, our fieldId=${fieldId}, cfg.field_type=${cfg?.field_type}`);
      
      if (!cfg || cfg.field_type !== 'custom' || cfg.field_id !== fieldId) {
        console.log(`[Workflows] Skipping - field mismatch or not custom field`);
        continue;
      }
      
      const target = String(cfg.value ?? '');
      const actual = String(value ?? '');
      let triggerMatches = false;
      
      console.log(`[Workflows] Comparing: actual="${actual}" vs target="${target}", operator=${cfg.operator}`);
      
      switch (cfg.operator) {
        case 'equals': triggerMatches = actual.toLowerCase() === target.toLowerCase(); break;
        case 'changed_to': triggerMatches = actual.toLowerCase() === target.toLowerCase(); break;
        case 'is_not_empty': triggerMatches = actual !== ''; break;
        default: triggerMatches = false;
      }
      
      console.log(`[Workflows] Result: triggerMatches=${triggerMatches}`);
      
      if (!triggerMatches) continue;
      
      // Check trigger_mode: if 'once_per_record', skip if already executed for this entity
      if (workflow.trigger_mode === 'once_per_record') {
        const { data: existingLogs } = await supabase
          .from('workflow_log')
          .select('id')
          .eq('workflow_id', workflow.id)
          .eq('entity_type', entityType)
          .eq('entity_id', entityId)
          .limit(1);
        
        if (existingLogs && existingLogs.length > 0) {
          console.log(`[Workflows] Skipping "${workflow.name}" - trigger_mode=once_per_record and already executed for entity ${entityId}`);
          continue;
        }
      }
      
      console.log(`[Workflows] Executing workflow: ${workflow.name} (trigger_mode=${workflow.trigger_mode || 'every_time'})`);

      const results = [];
      for (const action of (workflow.actions || [])) {
        if (action.type === 'update_field' && action.config?.field_type === 'core') {
          const table = entityType === 'organization' ? 'organization' : 'member';
          await supabase.from(table).update({ [action.config.field_id]: action.config.value }).eq('id', entityId);
          results.push({ action_type: 'update_field', status: 'success' });
        } else if (action.type === 'send_email') {
          // Fetch full entity data for placeholder replacement
          const table = entityType === 'organization' ? 'organization' : 'member';
          const { data: entityData } = await supabase.from(table).select('*').eq('id', entityId).single();
          
          console.log(`[Workflows] send_email action config:`, JSON.stringify(action.config, null, 2));
          
          let subject, body, fromEmail, replyTo;
          
          // Check if using template mode (also support legacy workflows that have template_id but no mode)
          const useTemplateMode = (action.config?.mode === 'template' || action.config?.template_id) && action.config?.template_id;
          if (useTemplateMode) {
            console.log(`[Workflows] Using template mode, fetching template: ${action.config.template_id}`);
            // Fetch template at runtime
            const { data: template, error: templateError } = await supabase
              .from('email_template')
              .select('*')
              .eq('id', action.config.template_id)
              .single();
            
            console.log(`[Workflows] Template fetch result:`, template ? 'found' : 'not found', templateError ? templateError.message : '');
            
            if (!template || template.is_active === false) {
              console.log(`[Workflows] Email template ${action.config.template_id} not found or inactive`);
              results.push({ 
                action_type: 'send_email', 
                status: 'failed',
                error: 'Email template not found or inactive'
              });
              continue;
            }
            
            subject = template.subject || '';
            body = template.body || '';
            fromEmail = template.from_email;
            replyTo = template.reply_to;
            console.log(`[Workflows] Template loaded - subject: "${subject}", body length: ${body?.length}, from: ${fromEmail}`);
          } else {
            // Custom email mode - use inline subject/body
            subject = action.config?.subject || '';
            body = action.config?.body || '';
            console.log(`[Workflows] Using custom email mode`);
          }
          
          const to = replacePlaceholders(action.config.to, entityType, entityData || {});
          subject = replacePlaceholders(subject, entityType, entityData || {});
          body = replacePlaceholders(body, entityType, entityData || {});
          
          console.log(`[Workflows] Sending email - to: "${to}", subject: "${subject}", body length: ${body?.length}`);
          
          const emailResult = await sendEmail({ to, subject, html: body, from: fromEmail, replyTo });
          console.log(`[Workflows] Email result:`, JSON.stringify(emailResult));
          
          results.push({ 
            action_type: 'send_email', 
            status: emailResult.success ? 'success' : 'failed',
            messageId: emailResult.messageId,
            error: emailResult.error,
            template_id: action.config?.template_id
          });
        }
      }

      await supabase.from('workflow_log').insert({
        workflow_id: workflow.id,
        entity_type: entityType,
        entity_id: entityId,
        trigger_data: { 
          field_id: fieldId, 
          value: value, 
          trigger_type: 'field_change'
        },
        actions_executed: results,
        status: 'success'
      });
      
      console.log(`[Workflows] Logged execution for ${workflow.name}`);
    }
  } catch (err) {
    console.error('[Workflows] Preference Error:', err.message, err.stack);
  }
}

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
  'Workflow': 'workflow',
  'WorkflowLog': 'workflow_log',
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

      const { data, error } = await supabase
        .from(tableName)
        .update(req.body)
        .eq('id', id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });

      // Trigger workflow evaluation (non-blocking)
      if (isWorkflowEntity && data) {
        const entityType = entity.toLowerCase();
        triggerWorkflows(entityType, id, beforeData, data, 'field_change').catch(err => {
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
            await triggerPreferenceWorkflows(entityType, entityId, fieldId, newValue);
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
