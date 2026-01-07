import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  console.log('[Redirect Resolve] Request received:', { 
    method: req.method, 
    query: req.query,
    supabaseConfigured: !!supabase 
  });

  if (!supabase) {
    console.error('[Redirect Resolve] Supabase not configured');
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { path } = req.query;
    
    if (!path || typeof path !== 'string') {
      console.log('[Redirect Resolve] Missing path parameter');
      return res.status(400).json({ error: 'Path parameter is required' });
    }

    // Original path for preserving case in redirects, normalized for trailing slashes
    const originalPath = path.replace(/\/+$/, '') || '/';
    // Lowercase version for case-insensitive comparisons
    const normalizedPath = originalPath.toLowerCase();

    console.log('[Redirect Resolve] Processing path:', { 
      rawPath: path, 
      originalPath, 
      normalizedPath 
    });

    const { data: mappings, error } = await supabase
      .from('redirect_mapping')
      .select('*')
      .eq('is_active', true)
      .order('priority', { ascending: true });

    if (error) {
      console.error('[Redirect Resolve] Database error:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('[Redirect Resolve] Found mappings:', { 
      count: mappings?.length || 0,
      mappings: mappings?.map(m => ({ 
        source: m.source_pattern, 
        target: m.target_url, 
        type: m.match_type,
        active: m.is_active 
      }))
    });

    if (!mappings || mappings.length === 0) {
      console.log('[Redirect Resolve] No active mappings found');
      return res.json({ found: false });
    }

    for (const mapping of mappings) {
      // Normalize source pattern: ensure leading slash, remove trailing slashes
      let sourcePattern = (mapping.source_pattern || '').replace(/\/+$/, '') || '/';
      if (sourcePattern !== '/' && !sourcePattern.startsWith('/')) {
        sourcePattern = '/' + sourcePattern;
      }
      const sourcePatternLower = sourcePattern.toLowerCase();
      
      console.log('[Redirect Resolve] Checking mapping:', {
        rawSource: mapping.source_pattern,
        normalizedSource: sourcePattern,
        sourcePatternLower,
        normalizedPath,
        matchType: mapping.match_type,
        wouldMatchExact: normalizedPath === sourcePatternLower,
        wouldMatchPrefix: normalizedPath.startsWith(sourcePatternLower)
      });

      if (mapping.match_type === 'exact') {
        // Exact match (case-insensitive)
        if (normalizedPath === sourcePatternLower) {
          console.log('[Redirect Resolve] EXACT MATCH FOUND:', {
            source: mapping.source_pattern,
            target: mapping.target_url,
            statusCode: mapping.status_code || 301
          });
          return res.json({
            found: true,
            target_url: mapping.target_url,
            status_code: mapping.status_code || 301
          });
        }
      } else if (mapping.match_type === 'prefix') {
        // Prefix/wildcard match (case-insensitive comparison)
        if (normalizedPath.startsWith(sourcePatternLower)) {
          // Preserve original case in remaining path
          const remainingPath = originalPath.slice(sourcePattern.length);
          let targetUrl = mapping.target_url;
          
          // If target URL ends with *, append the remaining path (preserving case)
          if (targetUrl.endsWith('*')) {
            targetUrl = targetUrl.slice(0, -1) + remainingPath;
          }
          
          console.log('[Redirect Resolve] PREFIX MATCH FOUND:', {
            source: mapping.source_pattern,
            target: targetUrl,
            statusCode: mapping.status_code || 301
          });
          return res.json({
            found: true,
            target_url: targetUrl,
            status_code: mapping.status_code || 301
          });
        }
      } else if (mapping.match_type === 'regex') {
        // Regex match (case-insensitive by default)
        try {
          const regex = new RegExp(mapping.source_pattern, 'i');
          if (regex.test(originalPath)) {
            // Use original path for replacement to preserve case
            const targetUrl = originalPath.replace(regex, mapping.target_url);
            console.log('[Redirect Resolve] REGEX MATCH FOUND:', {
              source: mapping.source_pattern,
              target: targetUrl,
              statusCode: mapping.status_code || 301
            });
            return res.json({
              found: true,
              target_url: targetUrl,
              status_code: mapping.status_code || 301
            });
          }
        } catch (regexError) {
          console.warn('[Redirect Resolve] Invalid regex pattern:', mapping.source_pattern, regexError);
        }
      }
    }

    console.log('[Redirect Resolve] No matching redirect found for path:', normalizedPath);
    return res.json({ found: false });

  } catch (error) {
    console.error('[Redirect Resolve] Unexpected error:', error);
    res.status(500).json({ error: 'Failed to resolve redirect' });
  }
}
