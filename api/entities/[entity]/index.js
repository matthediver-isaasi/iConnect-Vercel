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

  const { entity } = req.query;
  const tableName = getTableName(entity);

  try {
    if (req.method === 'GET') {
      // List entities
      const { filter, sort, limit, offset, expand } = req.query;
      let query = supabase.from(tableName).select(expand || '*');

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
      const { data, error } = await supabase
        .from(tableName)
        .insert(req.body)
        .select()
        .single();

      if (error) {
        console.error(`Error inserting into ${tableName}:`, error);
        return res.status(500).json({ error: error.message, details: error.details, hint: error.hint, code: error.code });
      }
      return res.status(201).json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Entity error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
