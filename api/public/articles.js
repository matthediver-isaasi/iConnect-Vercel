import { createClient } from '@supabase/supabase-js';

function getTenantSlugFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts[0];
  }
  return null;
}

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
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const tenantSlug = req.query.tenant || getTenantSlugFromHost(host);

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant not specified' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name')
      .eq('slug', tenantSlug)
      .eq('status', 'active')
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: articles, error } = await supabase
      .from('blog_post')
      .select(`
        id,
        title,
        slug,
        summary,
        feature_image_url,
        published_date,
        author_id,
        guest_writer_id,
        status,
        subcategories,
        tags,
        read_time_minutes,
        is_featured
      `)
      .eq('tenant_id', tenant.id)
      .eq('status', 'published')
      .order('published_date', { ascending: false });

    if (error) {
      console.error('[Public Articles] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch articles' });
    }

    const authorIds = [...new Set((articles || []).filter(a => a.author_id).map(a => a.author_id))];
    const guestWriterIds = [...new Set((articles || []).filter(a => a.guest_writer_id).map(a => a.guest_writer_id))];

    let authorData = {};
    let guestWriterData = {};

    if (authorIds.length > 0) {
      const { data: members } = await supabase
        .from('member')
        .select('id, first_name, last_name, handle, blog_handle, profile_picture_url')
        .in('id', authorIds);

      if (members) {
        members.forEach(m => {
          authorData[m.id] = {
            name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
            handle: m.handle || m.blog_handle,
            profilePicture: m.profile_picture_url
          };
        });
      }
    }

    if (guestWriterIds.length > 0) {
      const { data: guestWriters } = await supabase
        .from('guest_writer')
        .select('id, full_name, profile_image_url')
        .in('id', guestWriterIds);

      if (guestWriters) {
        guestWriters.forEach(gw => {
          guestWriterData[gw.id] = {
            name: gw.full_name,
            profilePicture: gw.profile_image_url
          };
        });
      }
    }

    res.json({
      articles: articles || [],
      authors: authorData,
      guestWriters: guestWriterData
    });
  } catch (error) {
    console.error('[Public Articles] Error:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
}
