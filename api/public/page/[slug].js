import { supabase } from '../../_lib/database.js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import { resolveMicrositeByPrefix } from '../../_lib/microsites.js';
import {
  projectMemberOnlyGuest,
} from '../../../shared/canvasMemberOnly.js';
import {
  resolveCanvasViewer,
  setMemberContentCacheHeaders,
} from '../../_lib/canvasMemberOnly.js';

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

export function buildPublicCanvasPagePayload(page, symbols = [], viewer = {}) {
  const allowMemberOnlyContent = viewer.allowMemberOnlyContent === true;
  return {
    page: allowMemberOnlyContent ? page : projectMemberOnlyGuest(page),
    symbols: allowMemberOnlyContent
      ? symbols
      : symbols.map((symbol) => projectMemberOnlyGuest(symbol)),
  };
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

export function createPublicPageHandler({
  db = supabase,
  resolveTenant = resolveTenantFromRequest,
  resolveMicrosite = resolveMicrositeByPrefix,
  resolveViewer = resolveCanvasViewer,
} = {}) {
  return async function handler(req, res) {
  // This endpoint may return either a member projection or a guest
  // projection. Never allow an intermediary to share either response.
  setMemberContentCacheHeaders(res, { includeHost: true });

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!db) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { slug, tenant: tenantParam } = req.query;
  
  if (!slug) {
    return res.status(400).json({ error: 'Page slug required' });
  }

  try {
    console.log('[Public Page Slug] Request for slug:', slug, 'tenantParam:', tenantParam);
    
    // Try hostname-based resolution first, then fall back to query parameter
    let tenant = await resolveTenant(req);
    
    if (!tenant && tenantParam) {
      console.log('[Public Page Slug] Hostname resolution failed, trying query param:', tenantParam);
      tenant = await resolveTenantFromSlug(tenantParam);
    }
    
    console.log('[Public Page Slug] Tenant resolved:', tenant ? { id: tenant.id, slug: tenant.slug } : null);
    
    if (!tenant) {
      console.log('[Public Page Slug] Tenant not found');
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Task #2426: microsite scoping. With `?microsite=prefix` only pages
    // assigned to that microsite resolve; without it, microsite pages must
    // NOT resolve at their bare /{slug} URL (they live at /{prefix}/{slug}).
    const micrositePrefix = typeof req.query.microsite === 'string' ? req.query.microsite.trim() : '';
    let microsite = null;
    if (micrositePrefix) {
      microsite = await resolveMicrosite(db, tenant.id, micrositePrefix);
      if (!microsite) {
        return res.status(404).json({ error: 'Microsite not found' });
      }
    }

    let pageQuery = db
      .from('i_edit_page')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('slug', slug)
      .eq('status', 'published')
      .in('layout_type', ['public', 'hybrid', 'public_no_chrome', 'public_header_only', 'public_footer_only']);
    if (microsite) {
      pageQuery = pageQuery.eq('microsite_id', microsite.id);
    }
    // Login is an optional system page: no matching row is a normal absence,
    // while a database failure must remain distinguishable from that absence.
    const { data: page, error: pageError } = slug === 'login'
      ? await pageQuery.maybeSingle()
      : await pageQuery.single();

    console.log('[Public Page Slug] Page lookup:', { 
      found: !!page, 
      pageId: page?.id,
      pageSlug: page?.slug,
      microsite: microsite?.path_prefix || null,
      error: pageError?.message || pageError?.code || null 
    });

    if (pageError) {
      if (slug === 'login') {
        console.error('[Public Page Slug] Failed to fetch login page:', JSON.stringify(pageError));
        return res.status(500).json({ error: 'Failed to fetch page' });
      }
      console.log('[Public Page Slug] Page not found:', { slug, tenantId: tenant.id, error: pageError });
      return res.status(404).json({ error: 'Page not found or not published' });
    }

    if (!page) {
      console.log('[Public Page Slug] Page not found:', { slug, tenantId: tenant.id });
      return res.status(404).json({ error: 'Page not found or not published' });
    }

    const viewer = await resolveViewer(req, tenant.id);

    // Default (non-prefixed) path: a page assigned to a microsite is only
    // served under its prefix. Checked in JS (not SQL) so legacy databases
    // without the microsite_id column keep working unchanged.
    if (!microsite && page.microsite_id) {
      console.log('[Public Page Slug] Page belongs to a microsite; 404 at bare slug:', { slug, micrositeId: page.microsite_id });
      return res.status(404).json({ error: 'Page not found or not published' });
    }

    // Static AI-generated pages (Task #3371): the whole body lives on the
    // page row (static_html sanitized + static_css scoped at store time), so
    // there are no element rows to fetch. Return the row as-is — the client
    // renders static_html/static_css verbatim inside chrome.
    if (page.builder_type === 'ai_static') {
      return res.status(200).json({
        success: true,
        page: buildPublicCanvasPagePayload(page, [], viewer).page,
        elements: [],
      });
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
        const { data: symbolRows, error: symbolsErr } = await db
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
      const pagePayload = buildPublicCanvasPagePayload(page, symbols, viewer);
      return res.status(200).json({
        success: true,
        page: pagePayload.page,
        elements: [],
        symbols: pagePayload.symbols,
      });
    }

    console.log('[Public Page Slug] Fetching elements for page_id:', page.id);

    const { data: elements, error: elementsError } = await db
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
      page: buildPublicCanvasPagePayload(page, [], viewer).page,
      elements: elements || []
    });

  } catch (error) {
    console.error('[Public Page] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch page' });
  }
  };
}

export default createPublicPageHandler();
