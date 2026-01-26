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

  // Validate tenantId
  if (!tenantId || tenantId === 'undefined') {
    console.error('[meeting-templates] Invalid tenantId:', tenantId);
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('meeting_template')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });

      if (error) {
        console.error('[meeting-templates] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch meeting templates' });
      }

      return res.json({ templates: data || [] });
    } catch (err) {
      console.error('[meeting-templates] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { name, description, duration_minutes, meeting_type, is_active, buffer_before_minutes, buffer_after_minutes, sort_order, email_template_id, max_days_ahead } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }

      // Validate max_days_ahead
      const validatedMaxDays = parseInt(max_days_ahead) || 30;
      if (validatedMaxDays < 1 || validatedMaxDays > 365) {
        return res.status(400).json({ error: 'Booking window must be between 1 and 365 days' });
      }

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const { data: existing } = await supabase
        .from('meeting_template')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('slug', slug)
        .single();

      const finalSlug = existing ? `${slug}-${Date.now()}` : slug;

      const { data, error } = await supabase
        .from('meeting_template')
        .insert({
          tenant_id: tenantId,
          slug: finalSlug,
          name,
          description: description || null,
          duration_minutes: duration_minutes || 30,
          meeting_type: meeting_type || 'phone',
          is_active: is_active !== false,
          buffer_before_minutes: buffer_before_minutes || 0,
          buffer_after_minutes: buffer_after_minutes || 0,
          sort_order: sort_order || 0,
          email_template_id: email_template_id || null,
          max_days_ahead: validatedMaxDays
        })
        .select()
        .single();

      if (error) {
        console.error('[meeting-templates] Insert error:', error);
        return res.status(500).json({ error: 'Failed to create meeting template' });
      }

      return res.status(201).json({ template: data });
    } catch (err) {
      console.error('[meeting-templates] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
