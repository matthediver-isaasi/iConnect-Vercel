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

const VALID_TYPES = ['pages', 'blog_posts', 'news_posts', 'events', 'resources', 'complex_events'];

async function backfillPages(supabase, tenantId) {
  const results = { count: 0, errors: [] };
  const batchSize = 50;
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
        results.count++;
      } catch (err) {
        results.errors.push({ id: page.id, error: err.message });
      }
    }

    if (pages.length < batchSize) break;
    offset += batchSize;
  }

  return results;
}

async function backfillBlogPosts(supabase, tenantId) {
  const results = { count: 0, errors: [] };
  const batchSize = 100;
  let offset = 0;

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
        results.count++;
      } catch (err) {
        results.errors.push({ id: post.id, error: err.message });
      }
    }

    if (posts.length < batchSize) break;
    offset += batchSize;
  }

  return results;
}

async function backfillNewsPosts(supabase, tenantId) {
  const results = { count: 0, errors: [] };
  const batchSize = 100;
  let offset = 0;

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
        results.count++;
      } catch (err) {
        results.errors.push({ id: post.id, error: err.message });
      }
    }

    if (posts.length < batchSize) break;
    offset += batchSize;
  }

  return results;
}

async function backfillEvents(supabase, tenantId) {
  const results = { count: 0, errors: [] };
  const batchSize = 100;
  let offset = 0;

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
        results.count++;
      } catch (err) {
        results.errors.push({ id: event.id, error: err.message });
      }
    }

    if (events.length < batchSize) break;
    offset += batchSize;
  }

  return results;
}

async function backfillResources(supabase, tenantId) {
  const results = { count: 0, errors: [] };
  const batchSize = 100;
  let offset = 0;

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
        results.count++;
      } catch (err) {
        results.errors.push({ id: resource.id, error: err.message });
      }
    }

    if (resources.length < batchSize) break;
    offset += batchSize;
  }

  return results;
}

async function backfillComplexEvents(supabase, tenantId) {
  const results = { count: 0, errors: [] };
  const batchSize = 50;
  let offset = 0;

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
        results.count++;
      } catch (err) {
        results.errors.push({ id: ce.id, error: err.message });
      }
    }

    if (complexEvents.length < batchSize) break;
    offset += batchSize;
  }

  return results;
}

const TYPE_HANDLERS = {
  pages: backfillPages,
  blog_posts: backfillBlogPosts,
  news_posts: backfillNewsPosts,
  events: backfillEvents,
  resources: backfillResources,
  complex_events: backfillComplexEvents
};

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
    const type = req.query?.type || req.body?.type;

    if (type && !VALID_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Invalid type "${type}". Valid types: ${VALID_TYPES.join(', ')}`
      });
    }

    const typesToRun = type ? [type] : VALID_TYPES;
    const results = {};
    const allErrors = [];

    for (const t of typesToRun) {
      const result = await TYPE_HANDLERS[t](supabase, tenantId);
      results[t] = result.count;
      if (result.errors.length > 0) {
        allErrors.push(...result.errors.map(e => ({ type: t, ...e })));
      }
    }

    return res.json({
      success: true,
      tenantId,
      type: type || 'all',
      counts: results,
      total: Object.values(results).reduce((a, b) => a + b, 0),
      errors: allErrors.length > 0 ? allErrors : undefined
    });

  } catch (error) {
    console.error('[BackfillSearchText] Error:', error);
    return res.status(500).json({ error: 'Backfill failed', details: error.message });
  }
}
