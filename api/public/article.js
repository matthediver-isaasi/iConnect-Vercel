import { createClient } from '@supabase/supabase-js';

// Public API endpoint for fetching a single article by slug and author handle
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

    const { slug, authorHandle } = req.query;

    if (!slug) {
      return res.status(400).json({ error: 'Article slug is required' });
    }

    let article = null;

    if (authorHandle && authorHandle !== 'guest') {
      const { data: member } = await supabase
        .from('member')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('handle', authorHandle)
        .single();

      if (member) {
        const { data: foundArticle } = await supabase
          .from('blog_post')
          .select(`
            id,
            title,
            slug,
            summary,
            content,
            feature_image_url,
            published_date,
            author_id,
            guest_writer_id,
            status,
            subcategories,
            tags,
            seo_title,
            seo_description
          `)
          .eq('tenant_id', tenant.id)
          .eq('status', 'published')
          .eq('author_id', member.id)
          .or(`slug.eq.${slug},slug.like.${slug}-by-%`)
          .single();

        article = foundArticle;
      }
    } else if (authorHandle === 'guest') {
      const { data: foundArticle } = await supabase
        .from('blog_post')
        .select(`
          id,
          title,
          slug,
          summary,
          content,
          feature_image_url,
          published_date,
          author_id,
          guest_writer_id,
          status,
          subcategories,
          tags,
          seo_title,
          seo_description
        `)
        .eq('tenant_id', tenant.id)
        .eq('status', 'published')
        .not('guest_writer_id', 'is', null)
        .or(`slug.eq.${slug},slug.like.${slug}-by-%`)
        .single();

      article = foundArticle;
    } else {
      const { data: foundArticle } = await supabase
        .from('blog_post')
        .select(`
          id,
          title,
          slug,
          summary,
          content,
          feature_image_url,
          published_date,
          author_id,
          guest_writer_id,
          status,
          subcategories,
          tags,
          seo_title,
          seo_description
        `)
        .eq('tenant_id', tenant.id)
        .eq('status', 'published')
        .or(`slug.eq.${slug},slug.like.${slug}-by-%`)
        .single();

      article = foundArticle;
    }

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    let author = null;
    let guestWriter = null;

    if (article.author_id) {
      const { data: member } = await supabase
        .from('member')
        .select('id, first_name, last_name, handle, profile_image_url, job_title, short_bio, linkedin_profile_url, email')
        .eq('id', article.author_id)
        .single();

      if (member) {
        author = {
          id: member.id,
          name: `${member.first_name || ''} ${member.last_name || ''}`.trim(),
          handle: member.handle,
          profilePicture: member.profile_image_url,
          jobTitle: member.job_title,
          shortBio: member.short_bio,
          linkedinUrl: member.linkedin_profile_url,
          email: member.email
        };
      }
    }

    if (article.guest_writer_id) {
      const { data: gw } = await supabase
        .from('guest_writer')
        .select('id, full_name, profile_image_url, bio, linkedin_url')
        .eq('id', article.guest_writer_id)
        .single();

      if (gw) {
        guestWriter = {
          id: gw.id,
          name: gw.full_name,
          profilePicture: gw.profile_image_url,
          bio: gw.bio,
          linkedinUrl: gw.linkedin_url
        };
      }
    }

    res.json({
      article,
      author,
      guestWriter
    });
  } catch (error) {
    console.error('[Public Article] Error:', error);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
}
