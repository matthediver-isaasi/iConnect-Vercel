import { supabase } from '../../_lib/database.js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

// Collect every top-level symbol id referenced by a canvas design so we can
// embed the resolved symbol designs alongside the page payload. Keeping this
// scoped to the requested page preserves the privacy guarantee: only symbols
// actually used by this published page are ever returned.
function collectSymbolIds(design, out) {
  if (!design || typeof design !== 'object') return;
  const sections = design.root?.sections || [];
  for (const section of sections) {
    const children = section?.children || [];
    for (const b of children) {
      if (b?.type === 'symbol' && b?.content?.symbolId) {
        out.add(b.content.symbolId);
      }
    }
  }
}

async function resolveTenantFromSlug(tenantSlug) {
  if (!tenantSlug || !supabase) return null;
  
  const { data, error } = await supabase
    .from('tenant')
    .select('id, name, slug, domain, status, logo_url, header_logo_url, favicon_url, primary_color, settings')
    .eq('slug', tenantSlug)
    .eq('status', 'active')
    .single();
  
  if (error || !data) {
    console.log('[Public Page Slug] Tenant slug lookup failed:', { tenantSlug, error: error?.message });
    return null;
  }
  
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { slug, tenant: tenantParam } = req.query;
  
  if (!slug) {
    return res.status(400).json({ error: 'Page slug required' });
  }

  try {
    console.log('[Public Page Slug] Request for slug:', slug, 'tenantParam:', tenantParam);
    
    // Try hostname-based resolution first, then fall back to query parameter
    let tenant = await resolveTenantFromRequest(req);
    
    if (!tenant && tenantParam) {
      console.log('[Public Page Slug] Hostname resolution failed, trying query param:', tenantParam);
      tenant = await resolveTenantFromSlug(tenantParam);
    }
    
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
      .in('layout_type', ['public', 'hybrid', 'public_no_chrome', 'public_header_only', 'public_footer_only'])
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

    // Canvas Builder pages have no i_edit_page_element rows — their layout
    // lives in canvas_design on the page row itself. Skip the element query
    // entirely to avoid an unnecessary round trip on every public request.
    if (page.builder_type === 'canvas') {
      // Embed the full designs of every symbol referenced by this page so the
      // public renderer can resolve symbol children from a single page-scoped
      // request — no dependency on the cross-page published-symbol allow-list
      // or a separately-cached endpoint. Only symbols used by THIS published
      // page are returned, preserving the unpublished-content privacy guard.
      const symbolIds = new Set();
      collectSymbolIds(page.canvas_design, symbolIds);
      let symbols = [];
      if (symbolIds.size > 0) {
        const { data: symbolRows, error: symbolsErr } = await supabase
          .from('canvas_symbol')
          .select('id, name, design, updated_at')
          .eq('tenant_id', tenant.id)
          .in('id', Array.from(symbolIds));
        if (symbolsErr) {
          console.error('[Public Page Slug] Failed to load symbols:', JSON.stringify(symbolsErr));
        } else {
          symbols = symbolRows || [];
        }
      }
      // Always revalidate so a fresh publish or symbol edit is reflected
      // immediately — never serve a stale page/symbol payload from the edge.
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      return res.status(200).json({
        success: true,
        page,
        elements: [],
        symbols,
      });
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
