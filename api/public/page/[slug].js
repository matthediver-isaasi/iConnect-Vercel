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
    console.log('[Public Page Slug] Request for slug:', slug);
    
    const tenant = await resolveTenantFromRequest(req);
    console.log('[Public Page Slug] Tenant resolved:', tenant ? { id: tenant.id, slug: tenant.slug } : null);
    
    if (!tenant) {
      console.log('[Public Page Slug] Tenant not found');
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

    console.log('[Public Page Slug] Page lookup:', { 
      found: !!page, 
      pageId: page?.id,
      pageSlug: page?.slug,
      error: pageError?.message || pageError?.code || null 
    });

    if (pageError || !page) {
      console.log('[Public Page Slug] Page not found:', { slug, tenantId: tenant.id, error: pageError });
      return res.status(404).json({ error: 'Page not found or not published' });
    }

    console.log('[Public Page Slug] Fetching elements for page_id:', page.id);
    
    const { data: elements, error: elementsError } = await supabase
      .from('i_edit_page_element')
      .select('*')
      .eq('page_id', page.id)
      .order('display_order', { ascending: true });

    console.log('[Public Page Slug] Elements result:', { 
      count: elements?.length || 0, 
      error: elementsError ? JSON.stringify(elementsError) : null 
    });

    if (elementsError) {
      console.error('[Public Page Slug] Error fetching elements:', JSON.stringify(elementsError));
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
