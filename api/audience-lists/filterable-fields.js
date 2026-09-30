import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

const CORE_MEMBER_FIELDS = [
  { key: 'first_name', label: 'First Name', data_type: 'text' },
  { key: 'last_name', label: 'Last Name', data_type: 'text' },
  { key: 'email', label: 'Email', data_type: 'text' },
  { key: 'job_title', label: 'Job Title', data_type: 'text' },
  { key: 'role_id', label: 'Role', data_type: 'text' },
  { key: 'login_enabled', label: 'Login Enabled', data_type: 'boolean' },
  { key: 'communications_opted_out_all', label: 'Opted Out of All Comms', data_type: 'boolean' },
];

const CORE_ORG_FIELDS = [
  { key: 'name', label: 'Name', data_type: 'text' },
  { key: 'status', label: 'Status', data_type: 'text' },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  try {
    const { data: prefFields, error } = await supabase
      .from('preference_field')
      .select('id, name, label, field_type, options, entity_scope, is_active')
      .eq('tenant_id', tenantContext.tenantId)
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) {
      console.error('[FilterableFields] Error fetching preference fields:', error);
      return res.status(500).json({ error: error.message });
    }

    const memberCustomFields = (prefFields || [])
      .filter(f => f.entity_scope === 'member')
      .map(f => ({
        key: f.id,
        label: f.label || f.name,
        data_type: f.field_type,
        field_type: 'custom',
        options: f.options,
      }));

    const orgCustomFields = (prefFields || [])
      .filter(f => f.entity_scope === 'organization')
      .map(f => ({
        key: f.id,
        label: f.label || f.name,
        data_type: f.field_type,
        field_type: 'custom',
        options: f.options,
      }));

    return res.json({
      member: {
        core: CORE_MEMBER_FIELDS.map(f => ({ ...f, field_type: 'core' })),
        custom: memberCustomFields,
      },
      organization: {
        core: CORE_ORG_FIELDS.map(f => ({ ...f, field_type: 'core' })),
        custom: orgCustomFields,
      },
      event: {
        core: [
          { key: 'attended_event', label: 'Attended Event', data_type: 'event_id', field_type: 'core' },
        ],
        custom: [],
      },
    });
  } catch (err) {
    console.error('[FilterableFields] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
