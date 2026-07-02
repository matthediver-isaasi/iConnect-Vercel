import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext || !tenantContext.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const tenantId = tenantContext.tenantId;

  if (req.method === 'GET') {
    try {
      const { data: profiles, error } = await supabase
        .from('agent_availability_profile')
        .select('*')
        .eq('tenant_id', tenantId);

      if (error) {
        console.error('[availability-profiles] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch profiles' });
      }

      return res.json({ profiles: profiles || [] });
    } catch (err) {
      console.error('[availability-profiles] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { identity_id, ...profileData } = req.body;

      if (!identity_id) {
        return res.status(400).json({ error: 'identity_id is required' });
      }

      if (profileData.default_slot_minutes && (profileData.default_slot_minutes < 5 || profileData.default_slot_minutes > 480)) {
        return res.status(400).json({ error: 'Slot duration must be between 5 and 480 minutes' });
      }
      if (profileData.buffer_minutes !== undefined && (profileData.buffer_minutes < 0 || profileData.buffer_minutes > 120)) {
        return res.status(400).json({ error: 'Buffer must be between 0 and 120 minutes' });
      }
      if (profileData.working_hours && typeof profileData.working_hours !== 'object') {
        return res.status(400).json({ error: 'Invalid working_hours format' });
      }

      const { data: existing } = await supabase
        .from('agent_availability_profile')
        .select('id')
        .eq('identity_id', identity_id)
        .eq('tenant_id', tenantId)
        .single();

      let result;
      if (existing) {
        const { data, error } = await supabase
          .from('agent_availability_profile')
          .update({
            is_active: profileData.is_active,
            timezone: profileData.timezone,
            default_slot_minutes: profileData.default_slot_minutes,
            buffer_minutes: profileData.buffer_minutes,
            working_hours: profileData.working_hours,
            booking_title: profileData.booking_title,
            booking_description: profileData.booking_description
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (error) {
          console.error('[availability-profiles] Update error:', error);
          return res.status(500).json({ error: 'Failed to update profile' });
        }
        result = data;
      } else {
        const { data, error } = await supabase
          .from('agent_availability_profile')
          .insert({
            tenant_id: tenantId,
            identity_id: identity_id,
            is_active: profileData.is_active ?? true,
            timezone: profileData.timezone || 'Europe/London',
            default_slot_minutes: profileData.default_slot_minutes || 30,
            buffer_minutes: profileData.buffer_minutes || 15,
            working_hours: profileData.working_hours,
            booking_title: profileData.booking_title || 'Book a Meeting',
            booking_description: profileData.booking_description || ''
          })
          .select()
          .single();

        if (error) {
          console.error('[availability-profiles] Insert error:', error);
          return res.status(500).json({ error: 'Failed to create profile' });
        }
        result = data;
      }

      return res.json({ profile: result });
    } catch (err) {
      console.error('[availability-profiles] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
