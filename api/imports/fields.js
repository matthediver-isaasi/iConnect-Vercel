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
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'job_title', label: 'Job Title', type: 'text' },
  { key: 'department', label: 'Department', type: 'text' },
  { key: 'bio', label: 'Bio', type: 'text' },
  { key: 'linkedin_url', label: 'LinkedIn URL', type: 'url' },
  { key: 'twitter_url', label: 'Twitter URL', type: 'url' },
  { key: 'profile_image', label: 'Profile Image URL', type: 'url' },
  { key: 'membership_status', label: 'Membership Status', type: 'text' },
  { key: 'membership_type', label: 'Membership Type', type: 'text' },
  { key: 'membership_start_date', label: 'Membership Start Date', type: 'date' },
  { key: 'membership_end_date', label: 'Membership End Date', type: 'date' },
  { key: 'login_enabled', label: 'Login Enabled', type: 'boolean' },
  { key: 'show_in_directory', label: 'Show in Directory', type: 'boolean' },
];

const ORGANIZATION_CORE_FIELDS = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'slug', label: 'Slug', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'website', label: 'Website', type: 'url' },
  { key: 'logo_url', label: 'Logo URL', type: 'url' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'address', label: 'Address', type: 'text' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'postal_code', label: 'Postal Code', type: 'text' },
  { key: 'membership_status', label: 'Membership Status', type: 'text' },
  { key: 'membership_type', label: 'Membership Type', type: 'text' },
  { key: 'membership_start_date', label: 'Membership Start Date', type: 'date' },
  { key: 'membership_end_date', label: 'Membership End Date', type: 'date' },
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
    const { data: customFields, error } = await supabase
      .from('preference_field')
      .select('id, field_key, label, field_type, entity_scope')
      .order('label');
    
    if (error) {
      console.error('[Import Fields] Error fetching custom fields:', error);
    }
    
    const memberCustomFields = (customFields || [])
      .filter(f => f.entity_scope === 'member')
      .map(f => ({
        key: `custom:${f.field_key}`,
        label: f.label || f.field_key,
        type: f.field_type || 'text',
        isCustom: true,
        preferenceFieldId: f.id
      }));
    
    const organizationCustomFields = (customFields || [])
      .filter(f => f.entity_scope === 'organization')
      .map(f => ({
        key: `custom:${f.field_key}`,
        label: f.label || f.field_key,
        type: f.field_type || 'text',
        isCustom: true,
        preferenceFieldId: f.id
      }));
    
    res.json({
      core: MEMBER_CORE_FIELDS,
      custom: memberCustomFields,
      organization: {
        core: ORGANIZATION_CORE_FIELDS,
        custom: organizationCustomFields
      }
    });
  } catch (error) {
    console.error('[Import Fields] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to get fields' });
  }
}
