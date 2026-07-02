const STYLE_KEY_SUFFIXES = [
  '_color', '_size', '_weight', '_family', '_spacing', '_height', '_type',
  '_opacity', '_angle', '_radius', '_fit', '_id', '_url', '_point',
  '_order', '_top', '_bottom', '_left', '_right', '_width', '_align',
  '_transform', '_decoration', '_style', '_mode', '_position', '_repeat',
  '_attachment', '_origin', '_clip', '_blend', '_filter'
];

const STYLE_KEY_EXACT = new Set([
  'anchor', 'background_type', 'background_color', 'gradient_start_color',
  'gradient_end_color', 'gradient_angle', 'overlay_opacity', 'height_type',
  'image_fit', 'border_radius', 'padding_top', 'padding_bottom',
  'padding_left', 'padding_right', 'display_order', 'element_type',
  'icon_type', 'layout', 'variant', 'columnWidths', 'rows', 'cols',
  'tableAlign', 'fullWidth', 'id', 'page_id', 'tenant_id', 'created_date',
  'updated_date', 'autoLatest', 'contentType', 'itemId', 'status',
  'is_public', 'image_url', 'feature_image_url', 'slug'
]);

export function isStyleKey(key) {
  if (STYLE_KEY_EXACT.has(key)) return true;
  for (const suffix of STYLE_KEY_SUFFIXES) {
    if (key.endsWith(suffix)) return true;
  }
  if (key.startsWith('mobile_')) return true;
  return false;
}

export function isStyleValue(val) {
  if (typeof val !== 'string') return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(val)) return true;
  if (/^rgba?\(/.test(val)) return true;
  if (/^hsla?\(/.test(val)) return true;
  if (/^(https?:\/\/|data:)/.test(val)) return true;
  if (/^\d+(\.\d+)?(px|em|rem|%|vh|vw|pt)?$/.test(val)) return true;
  return false;
}

export function stripHtml(html) {
  if (!html) return '';
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

export function extractTextFromObject(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return stripHtml(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return '';
  if (Array.isArray(obj)) return obj.map(extractTextFromObject).filter(Boolean).join(' ');

  const texts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isStyleKey(key)) continue;
    if (typeof value === 'string') {
      if (value.length < 2 || isStyleValue(value)) continue;
      texts.push(stripHtml(value));
    } else if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      const nested = extractTextFromObject(value);
      if (nested) texts.push(nested);
    }
  }
  return texts.join(' ');
}

export async function buildPageSearchText(supabase, pageId) {
  try {
    const { data: page } = await supabase
      .from('i_edit_page')
      .select('title, slug, description')
      .eq('id', pageId)
      .single();

    const parts = [];
    if (page) {
      if (page.title) parts.push(page.title);
      if (page.description) parts.push(stripHtml(page.description));
    }

    const { data: elements } = await supabase
      .from('i_edit_page_element')
      .select('content')
      .eq('page_id', pageId)
      .order('display_order', { ascending: true })
      .limit(500);

    if (elements) {
      for (const el of elements) {
        const text = extractTextFromObject(el.content);
        if (text) parts.push(text);
      }
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  } catch (err) {
    console.error('[SearchTextBuilder] Error building page search text:', err);
    return '';
  }
}

function extractContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return stripHtml(content);
  return extractTextFromObject(content);
}

export function buildBlogPostSearchText(record) {
  const parts = [];
  if (record.title) parts.push(record.title);
  if (record.summary) parts.push(stripHtml(record.summary));
  if (record.content) parts.push(extractContent(record.content));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function buildNewsPostSearchText(record) {
  const parts = [];
  if (record.title) parts.push(record.title);
  if (record.summary) parts.push(stripHtml(record.summary));
  if (record.content) parts.push(extractContent(record.content));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function buildEventSearchText(record) {
  const parts = [];
  if (record.title) parts.push(record.title);
  if (record.description) parts.push(extractContent(record.description));
  if (record.summary) parts.push(extractContent(record.summary));
  if (record.location) parts.push(record.location);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function buildResourceSearchText(record) {
  const parts = [];
  if (record.title) parts.push(record.title);
  if (record.description) parts.push(extractContent(record.description));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export async function buildComplexEventSearchText(supabase, eventId) {
  try {
    const { data: event } = await supabase
      .from('complex_event')
      .select('title, description, summary, location')
      .eq('id', eventId)
      .single();

    const parts = [];
    if (event) {
      if (event.title) parts.push(event.title);
      if (event.description) parts.push(extractContent(event.description));
      if (event.summary) parts.push(extractContent(event.summary));
      if (event.location) parts.push(event.location);
    }

    const { data: sessions } = await supabase
      .from('complex_event_session')
      .select('title, description')
      .eq('complex_event_id', eventId)
      .limit(500);

    if (sessions) {
      for (const session of sessions) {
        if (session.title) parts.push(session.title);
        if (session.description) parts.push(extractContent(session.description));
      }
    }

    const { data: tracks } = await supabase
      .from('complex_event_track')
      .select('name, description')
      .eq('complex_event_id', eventId)
      .limit(100);

    if (tracks) {
      for (const track of tracks) {
        if (track.name) parts.push(track.name);
        if (track.description) parts.push(extractContent(track.description));
      }
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  } catch (err) {
    console.error('[SearchTextBuilder] Error building complex event search text:', err);
    return '';
  }
}

export async function updateSearchText(supabase, tableName, recordId, searchText) {
  try {
    const { error } = await supabase
      .from(tableName)
      .update({ search_text: searchText })
      .eq('id', recordId);
    if (error) {
      console.error(`[SearchTextBuilder] Error updating search_text for ${tableName}/${recordId}:`, error.message);
    }
  } catch (err) {
    console.error(`[SearchTextBuilder] Exception updating search_text for ${tableName}/${recordId}:`, err);
  }
}

export async function rebuildSearchTextForEntity(supabase, entity, data, id) {
  const entityNorm = entity.replace(/[-_]/g, '').toLowerCase();
  try {
    switch (entityNorm) {
      case 'ieditpage': {
        const searchText = await buildPageSearchText(supabase, id || data.id);
        await updateSearchText(supabase, 'i_edit_page', id || data.id, searchText);
        break;
      }
      case 'ieditpageelement': {
        let pageId = data?.page_id;
        if (!pageId && id) {
          const { data: el } = await supabase
            .from('i_edit_page_element')
            .select('page_id')
            .eq('id', id)
            .single();
          pageId = el?.page_id;
        }
        if (pageId) {
          const searchText = await buildPageSearchText(supabase, pageId);
          await updateSearchText(supabase, 'i_edit_page', pageId, searchText);
        }
        break;
      }
      case 'blogpost': {
        let record = data;
        if (!record?.title && id) {
          const { data: r } = await supabase.from('blog_post').select('title, summary, content').eq('id', id).single();
          record = r;
        }
        if (record) {
          const searchText = buildBlogPostSearchText(record);
          await updateSearchText(supabase, 'blog_post', id || data.id, searchText);
        }
        break;
      }
      case 'newspost': {
        let record = data;
        if (!record?.title && id) {
          const { data: r } = await supabase.from('news_post').select('title, summary, content').eq('id', id).single();
          record = r;
        }
        if (record) {
          const searchText = buildNewsPostSearchText(record);
          await updateSearchText(supabase, 'news_post', id || data.id, searchText);
        }
        break;
      }
      case 'event': {
        let record = data;
        if (!record?.title && id) {
          const { data: r } = await supabase.from('event').select('title, description, summary, location').eq('id', id).single();
          record = r;
        }
        if (record) {
          const searchText = buildEventSearchText(record);
          await updateSearchText(supabase, 'event', id || data.id, searchText);
        }
        break;
      }
      case 'resource': {
        let record = data;
        if (!record?.title && id) {
          const { data: r } = await supabase.from('resource').select('title, description').eq('id', id).single();
          record = r;
        }
        if (record) {
          const searchText = buildResourceSearchText(record);
          await updateSearchText(supabase, 'resource', id || data.id, searchText);
        }
        break;
      }
      case 'complexevent': {
        const searchText = await buildComplexEventSearchText(supabase, id || data.id);
        await updateSearchText(supabase, 'complex_event', id || data.id, searchText);
        break;
      }
      case 'complexeventsession': {
        let eventId = data?.complex_event_id;
        if (!eventId && id) {
          const { data: s } = await supabase
            .from('complex_event_session')
            .select('complex_event_id')
            .eq('id', id)
            .single();
          eventId = s?.complex_event_id;
        }
        if (eventId) {
          const searchText = await buildComplexEventSearchText(supabase, eventId);
          await updateSearchText(supabase, 'complex_event', eventId, searchText);
        }
        break;
      }
      case 'complexeventtrack': {
        let eventId = data?.complex_event_id;
        if (!eventId && id) {
          const { data: t } = await supabase
            .from('complex_event_track')
            .select('complex_event_id')
            .eq('id', id)
            .single();
          eventId = t?.complex_event_id;
        }
        if (eventId) {
          const searchText = await buildComplexEventSearchText(supabase, eventId);
          await updateSearchText(supabase, 'complex_event', eventId, searchText);
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[SearchTextBuilder] Error rebuilding search text for ${entity}:`, err);
  }
}
