import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  buildPageSearchText,
  buildBlogPostSearchText,
  buildNewsPostSearchText,
  buildEventSearchText,
  buildResourceSearchText,
  buildComplexEventSearchText,
  updateSearchText
} from '../_lib/searchTextBuilder.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const tenantCtx = await getTenantContext(req, supabase);
    if (!tenantCtx?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const tenantId = tenantCtx.tenantId;
    const counts = { pages: 0, blogPosts: 0, newsPosts: 0, events: 0, resources: 0, complexEvents: 0 };
    const errors = [];
    const batchSize = 100;

    let offset = 0;
    while (true) {
      const { data: pages } = await supabase
        .from('i_edit_page')
        .select('id')
        .eq('tenant_id', tenantId)
        .range(offset, offset + batchSize - 1);

      if (!pages || pages.length === 0) break;

      for (const page of pages) {
        try {
          const searchText = await buildPageSearchText(supabase, page.id);
          await updateSearchText(supabase, 'i_edit_page', page.id, searchText);
          counts.pages++;
        } catch (err) {
          errors.push({ type: 'page', id: page.id, error: err.message });
        }
      }

      if (pages.length < batchSize) break;
      offset += batchSize;
    }

    offset = 0;
    while (true) {
      const { data: posts } = await supabase
        .from('blog_post')
        .select('id, title, summary, content')
        .eq('tenant_id', tenantId)
        .range(offset, offset + batchSize - 1);

      if (!posts || posts.length === 0) break;

      for (const post of posts) {
        try {
          const searchText = buildBlogPostSearchText(post);
          await updateSearchText(supabase, 'blog_post', post.id, searchText);
          counts.blogPosts++;
        } catch (err) {
          errors.push({ type: 'blogPost', id: post.id, error: err.message });
        }
      }

      if (posts.length < batchSize) break;
      offset += batchSize;
    }

    offset = 0;
    while (true) {
      const { data: posts } = await supabase
        .from('news_post')
        .select('id, title, summary, content')
        .eq('tenant_id', tenantId)
        .range(offset, offset + batchSize - 1);

      if (!posts || posts.length === 0) break;

      for (const post of posts) {
        try {
          const searchText = buildNewsPostSearchText(post);
          await updateSearchText(supabase, 'news_post', post.id, searchText);
          counts.newsPosts++;
        } catch (err) {
          errors.push({ type: 'newsPost', id: post.id, error: err.message });
        }
      }

      if (posts.length < batchSize) break;
      offset += batchSize;
    }

    offset = 0;
    while (true) {
      const { data: events } = await supabase
        .from('event')
        .select('id, title, description, summary, location')
        .eq('tenant_id', tenantId)
        .range(offset, offset + batchSize - 1);

      if (!events || events.length === 0) break;

      for (const event of events) {
        try {
          const searchText = buildEventSearchText(event);
          await updateSearchText(supabase, 'event', event.id, searchText);
          counts.events++;
        } catch (err) {
          errors.push({ type: 'event', id: event.id, error: err.message });
        }
      }

      if (events.length < batchSize) break;
      offset += batchSize;
    }

    offset = 0;
    while (true) {
      const { data: resources } = await supabase
        .from('resource')
        .select('id, title, description')
        .eq('tenant_id', tenantId)
        .range(offset, offset + batchSize - 1);

      if (!resources || resources.length === 0) break;

      for (const resource of resources) {
        try {
          const searchText = buildResourceSearchText(resource);
          await updateSearchText(supabase, 'resource', resource.id, searchText);
          counts.resources++;
        } catch (err) {
          errors.push({ type: 'resource', id: resource.id, error: err.message });
        }
      }

      if (resources.length < batchSize) break;
      offset += batchSize;
    }

    offset = 0;
    while (true) {
      const { data: complexEvents } = await supabase
        .from('complex_event')
        .select('id')
        .eq('tenant_id', tenantId)
        .range(offset, offset + batchSize - 1);

      if (!complexEvents || complexEvents.length === 0) break;

      for (const ce of complexEvents) {
        try {
          const searchText = await buildComplexEventSearchText(supabase, ce.id);
          await updateSearchText(supabase, 'complex_event', ce.id, searchText);
          counts.complexEvents++;
        } catch (err) {
          errors.push({ type: 'complexEvent', id: ce.id, error: err.message });
        }
      }

      if (complexEvents.length < batchSize) break;
      offset += batchSize;
    }

    return res.json({
      success: true,
      tenantId,
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('[BackfillSearchText] Error:', error);
    return res.status(500).json({ error: 'Backfill failed', details: error.message });
  }
}
