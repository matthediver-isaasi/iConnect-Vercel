// Task #2363: Member AI Knowledge Assistant — chunker.
//
// Turns a source row (resource / event / complex_event / news_post /
// blog_post) into retrieval chunks. Unlike the Help chunker there is no
// section-gating DSL here: visibility is enforced per-ROW (see
// memberContentVisibility.js), so a chunk just needs the source's readable
// text. We build a normalized text blob per content type, strip HTML, and
// split it at paragraph boundaries so embeddings stay focused.

const MAX_CHUNK_CHARS = 1500;

function stripHtml(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLargeChunk(content) {
  if (content.length <= MAX_CHUNK_CHARS) return [content];
  const paragraphs = content.split(/\n\s*\n/);
  const out = [];
  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > MAX_CHUNK_CHARS && current) {
      out.push(current.trim());
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.length ? out : [content];
}

function joinParts(parts) {
  return parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Build the human-readable body text for a source row, by content type.
 * Returns a single string (already HTML-stripped).
 */
export function buildMemberContentText(item, contentType) {
  if (!item) return '';
  const title = item.title || '';

  switch (contentType) {
    case 'resource': {
      const meta = [];
      if (item.author_name) meta.push(`Author: ${item.author_name}`);
      if (item.resource_type) meta.push(`Type: ${item.resource_type}`);
      if (Array.isArray(item.tags) && item.tags.length) {
        meta.push(`Tags: ${item.tags.join(', ')}`);
      }
      if (Array.isArray(item.subcategories) && item.subcategories.length) {
        meta.push(`Categories: ${item.subcategories.join(', ')}`);
      }
      return joinParts([
        title,
        stripHtml(item.description),
        meta.join(' • '),
      ]);
    }
    case 'event':
    case 'complex_event': {
      const meta = [];
      const when = formatDate(item.start_date);
      if (when) meta.push(`Date: ${when}`);
      if (item.location) meta.push(`Location: ${item.location}`);
      if (item.event_type) meta.push(`Type: ${item.event_type}`);
      if (item.is_online) meta.push('Online event');
      return joinParts([
        title,
        stripHtml(item.summary),
        stripHtml(item.description),
        meta.join(' • '),
      ]);
    }
    case 'news_post':
    case 'blog_post': {
      const meta = [];
      if (item.author_name) meta.push(`Author: ${item.author_name}`);
      const when = formatDate(item.published_date);
      if (when) meta.push(`Published: ${when}`);
      if (Array.isArray(item.tags) && item.tags.length) {
        meta.push(`Tags: ${item.tags.join(', ')}`);
      }
      return joinParts([
        title,
        stripHtml(item.summary),
        stripHtml(item.content),
        meta.join(' • '),
      ]);
    }
    default:
      return joinParts([title, stripHtml(item.summary), stripHtml(item.description)]);
  }
}

/**
 * Chunk a source row into retrieval chunks.
 *
 * @param {object} item         source row
 * @param {string} contentType  resource | event | complex_event | news_post | blog_post
 * @returns {Array<{ chunkIndex:number, content:string }>}
 */
export function chunkMemberContent(item, contentType) {
  const text = buildMemberContentText(item, contentType);
  if (!text || !text.trim()) return [];
  const pieces = splitLargeChunk(text.trim());
  return pieces
    .map((content, i) => ({ chunkIndex: i, content: content.trim() }))
    .filter((c) => c.content.length > 0);
}
