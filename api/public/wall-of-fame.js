import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const type = req.query.type;

    if (type === 'sections') {
      const { data: sections, error } = await supabase
        .from('wall_of_fame_section')
        .select('id, name, description, is_active, display_order')
        .eq('tenant_id', tenant.id)
        .eq('is_active', true)
        .order('display_order', { ascending: true });

      if (error) {
        console.error('[Public WallOfFame] Sections query error:', error);
        return res.status(500).json({ error: 'Failed to fetch sections' });
      }

      return res.status(200).json(sections || []);
    }

    if (type === 'categories') {
      const sectionId = req.query.section_id;
      
      let query = supabase
        .from('wall_of_fame_category')
        .select('id, name, description, section_id, is_active, display_order')
        .eq('tenant_id', tenant.id)
        .eq('is_active', true)
        .order('display_order', { ascending: true });

      if (sectionId) {
        query = query.eq('section_id', sectionId);
      }

      const { data: categories, error } = await query;

      if (error) {
        console.error('[Public WallOfFame] Categories query error:', error);
        return res.status(500).json({ error: 'Failed to fetch categories' });
      }

      return res.status(200).json(categories || []);
    }

    if (type === 'people') {
      const categoryId = req.query.category_id;
      
      let query = supabase
        .from('wall_of_fame_person')
        .select(`
          id,
          first_name,
          last_name,
          job_title,
          secondary_job_title,
          secondary_organisation,
          biography,
          profile_photo_url,
          email,
          linkedin_url,
          category_id,
          is_active,
          display_order
        `)
        .eq('tenant_id', tenant.id)
        .eq('is_active', true)
        .order('display_order', { ascending: true });

      if (categoryId) {
        query = query.eq('category_id', categoryId);
      }

      const { data: people, error } = await query;

      if (error) {
        console.error('[Public WallOfFame] People query error:', error);
        return res.status(500).json({ error: 'Failed to fetch people' });
      }

      return res.status(200).json(people || []);
    }

    return res.status(400).json({ error: 'Invalid type parameter. Use sections, categories, or people' });
  } catch (error) {
    console.error('[Public WallOfFame] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
