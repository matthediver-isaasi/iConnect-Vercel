import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionResult = await getSession(req);
  if (!sessionResult?.data) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = sessionResult.data;
  if (!session.tenantId || !session.identityId) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const tenantId = session.tenantId;
  const identityId = session.identityId;

  if (req.method === 'GET') {
    try {
      const { data: profile, error } = await supabase
        .from('agent_availability_profile')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('identity_id', identityId)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('[Availability] Database error:', error);
        return res.status(500).json({ error: 'Failed to fetch availability' });
      }

      const { data: identity } = await supabase
        .from('tenant_identity')
        .select('booking_slug, first_name, last_name, email')
        .eq('id', identityId)
        .single();

      return res.json({
        profile: profile || null,
        bookingSlug: identity?.booking_slug,
        agentName: identity ? `${identity.first_name || ''} ${identity.last_name || ''}`.trim() || identity.email : null
      });
    } catch (err) {
      console.error('[Availability] Error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    try {
      const {
        is_active,
        timezone,
        default_slot_minutes,
        buffer_minutes,
        working_hours,
        booking_title,
        booking_description
      } = req.body;

      const { data: existing } = await supabase
        .from('agent_availability_profile')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('identity_id', identityId)
        .single();

      const profileData = {
        tenant_id: tenantId,
        identity_id: identityId,
        ...(is_active !== undefined && { is_active }),
        ...(timezone && { timezone }),
        ...(default_slot_minutes && { default_slot_minutes }),
        ...(buffer_minutes !== undefined && { buffer_minutes }),
        ...(working_hours && { working_hours }),
        ...(booking_title !== undefined && { booking_title }),
        ...(booking_description !== undefined && { booking_description })
      };

      let result;
      if (existing) {
        const { data, error } = await supabase
          .from('agent_availability_profile')
          .update(profileData)
          .eq('id', existing.id)
          .select()
          .single();
        
        if (error) throw error;
        result = data;
      } else {
        const { data, error } = await supabase
          .from('agent_availability_profile')
          .insert(profileData)
          .select()
          .single();
        
        if (error) throw error;
        result = data;
      }

      return res.json({ profile: result });
    } catch (err) {
      console.error('[Availability] Save error:', err);
      return res.status(500).json({ error: 'Failed to save availability' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
