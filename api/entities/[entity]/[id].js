import { createClient } from '@supabase/supabase-js';

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
      const { data, error } = await supabase
        .from(tableName)
        .update(req.body)
        .eq('id', id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
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
