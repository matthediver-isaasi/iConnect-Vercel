import { createClient } from '@supabase/supabase-js';
import { getSession } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const MEMBER_CORE_FIELDS = [
  { key: 'first_name', label: 'First Name', type: 'text' },
  { key: 'last_name', label: 'Last Name', type: 'text' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'mobile', label: 'Mobile', type: 'text' },
  { key: 'landline', label: 'Landline', type: 'text' },
  { key: 'job_title', label: 'Job Title', type: 'text' },
  { key: 'biography', label: 'Biography', type: 'text' },
  { key: 'linkedin_url', label: 'LinkedIn URL', type: 'url' },
  { key: 'website_url', label: 'Website URL', type: 'url' },
  { key: 'profile_image_url', label: 'Profile Image URL', type: 'url' },
  { key: 'login_enabled', label: 'Login Enabled', type: 'boolean' },
  { key: 'login_disabled_reason', label: 'Login Disabled Reason', type: 'text' },
  { key: 'show_in_directory', label: 'Show in Directory', type: 'boolean' },
  { key: 'external_id', label: 'External ID', type: 'text' },
  { key: 'created_on', label: 'Created On', type: 'date' },
  { key: 'role_id', label: 'Role', type: 'role_lookup' },
  { key: 'role_effective_from', label: 'Effective From', type: 'date' },
  { key: 'organization_id', label: 'Organisation Name', type: 'organization_lookup' },
  { key: '__add_note__', label: 'Add Note', type: 'note' },
];

const ORGANIZATION_CORE_FIELDS = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'slug', label: 'Slug', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'website_url', label: 'Website', type: 'url' },
  { key: 'logo_url', label: 'Logo URL', type: 'url' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'address', label: 'Address', type: 'text' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'postcode', label: 'Postcode', type: 'text' },
  { key: 'external_id', label: 'External ID', type: 'text' },
  { key: 'is_active', label: 'Is Active', type: 'boolean' },
  { key: 'created_at', label: 'Created At', type: 'date' },
  { key: 'twitter_url', label: 'Twitter URL', type: 'url' },
  { key: 'linkedin_url', label: 'LinkedIn URL', type: 'url' },
  { key: 'facebook_url', label: 'Facebook URL', type: 'url' },
  { key: 'instagram_url', label: 'Instagram URL', type: 'url' },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    const entityType = req.query.entity || 'member';
    console.log('[Import Fields] Fetching fields for entity:', entityType);
    
    const coreFields = entityType === 'organization' 
      ? ORGANIZATION_CORE_FIELDS 
      : MEMBER_CORE_FIELDS;
    
    const { data: customFields, error } = await supabase
      .from('preference_field')
      .select('id, name, label, field_type, entity_scope')
      .eq('entity_scope', entityType)
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    
    if (error) {
      console.error('[Import Fields] Error fetching custom fields:', error);
    }
    
    // Fetch communication categories for member imports
    let communicationFields = [];
    if (entityType === 'member') {
      const { data: commCategories, error: commError } = await supabase
        .from('communication_category')
        .select('id, name, description')
        .eq('is_active', true)
        .order('display_order', { ascending: true });
      
      if (commError) {
        console.error('[Import Fields] Error fetching communication categories:', commError);
      }
      
      communicationFields = (commCategories || []).map(c => ({
        key: `comm:${c.id}`,
        label: c.name,
        description: c.description,
        type: 'boolean',
        scope: 'communication',
        categoryId: c.id
      }));
    }
    
    res.json({
      core: coreFields.map(f => ({ ...f, scope: 'core' })),
      custom: (customFields || []).map(f => ({
        key: `custom:${f.id}`,
        label: f.label || f.name,
        type: f.field_type || 'text',
        scope: 'custom',
        preferenceFieldId: f.id
      })),
      communication: communicationFields
    });
  } catch (error) {
    console.error('[Import Fields] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to get fields' });
  }
}
