import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { path } = req.query;
    
    if (!path || typeof path !== 'string') {
      return res.status(400).json({ error: 'Path parameter is required' });
    }

    // Original path for preserving case in redirects, normalized for trailing slashes
    const originalPath = path.replace(/\/+$/, '') || '/';
    // Lowercase version for case-insensitive comparisons
    const normalizedPath = originalPath.toLowerCase();

    const { data: mappings, error } = await supabase
      .from('redirect_mapping')
      .select('*')
      .eq('is_active', true)
      .order('priority', { ascending: true });

    if (error) {
      console.error('Error fetching redirect mappings:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!mappings || mappings.length === 0) {
      return res.json({ found: false });
    }

    for (const mapping of mappings) {
      const sourcePattern = (mapping.source_pattern || '').replace(/\/+$/, '') || '/';
      const sourcePatternLower = sourcePattern.toLowerCase();
      
      if (mapping.match_type === 'exact') {
        // Exact match (case-insensitive)
        if (normalizedPath === sourcePatternLower) {
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
            return res.json({
              found: true,
              target_url: targetUrl,
              status_code: mapping.status_code || 301
            });
          }
        } catch (regexError) {
          console.warn(`Invalid regex pattern: ${mapping.source_pattern}`, regexError);
        }
      }
    }

    return res.json({ found: false });

  } catch (error) {
    console.error('Redirect resolve error:', error);
    res.status(500).json({ error: 'Failed to resolve redirect' });
  }
}
