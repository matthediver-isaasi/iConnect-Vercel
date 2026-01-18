import { supabase } from '../../_lib/database.js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { slug } = req.query;
  
  if (!slug) {
    return res.status(400).json({ error: 'Page slug required' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);
    
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: page, error: pageError } = await supabase
      .from('i_edit_page')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('slug', slug)
      .eq('status', 'published')
      .in('layout_type', ['public', 'hybrid'])
      .single();

    if (pageError || !page) {
      return res.status(404).json({ error: 'Page not found or not published' });
    }

    const { data: elements, error: elementsError } = await supabase
      .from('i_edit_page_element')
      .select('*')
      .eq('page_id', page.id)
      .order('display_order', { ascending: true });

    if (elementsError) {
      console.error('[Public Page] Error fetching elements:', elementsError);
      return res.status(500).json({ error: 'Failed to fetch page elements' });
    }

    return res.status(200).json({
      success: true,
      page,
      elements: elements || []
    });

  } catch (error) {
    console.error('[Public Page] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch page' });
  }
}
