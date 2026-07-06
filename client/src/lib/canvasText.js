// Task #2382: Member AI Knowledge Assistant — Canvas Builder text extraction.
//
// React-free so the backend indexer (api/_lib/*) can import it directly — the
// same constraint that already governs canvasLinks.js. Walks a Canvas Builder
// design document and pulls out the human-readable text a member would actually
// SEE on the rendered page (including text contributed by referenced symbols),
// so it can be embedded into the tenant member AI knowledge base.
//
// This deliberately mirrors what the public renderer shows: symbol blocks are
// resolved from their design (top-level references only, matching the public
// page endpoint's symbol embedding), and rich-text HTML is stripped to prose.

// Content-object keys whose STRING values carry human-readable, on-page text.
// Collected at ANY depth (arrays/objects are traversed), covering the fields the
// Canvas block renderers surface to readers across every block type: text,
// hero, buttons, cards, accordions, testimonials, columns, stats, pricing
// tables, news tickers, countdowns, card-flip grids, hero carousels, and the
// dynamic content blocks.
const TEXT_CONTENT_KEYS = new Set([
  'headline', 'subheadline', 'subheading', 'heading', 'subtitle', 'title',
  'eyebrow', 'label', 'text', 'html', 'body', 'content', 'contentText',
  'headerText', 'subheadingText', 'quote', 'author', 'role', 'company',
  'name', 'description', 'summary', 'caption', 'tooltip', 'value',
  'question', 'answer', 'q', 'a', 'backText', 'ctaLabel', 'ctaText',
  'featuredTitle', 'featuredText', 'emptyText', 'emptyCatMessage',
  'emptyCatCtaLabel', 'finishedMessage', 'annualNote',
  'recommendedBadgeLabel', 'alt', 'imageAlt', 'avatarAlt', 'companyLogoAlt',
  'featuredAlt',
]);

// Mirror of the chunker's HTML stripper so this module is self-contained and
// unit-testable without a backend dependency. Rich-text blocks contribute their
// prose, not their markup.
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

function collectText(node, out) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v === 'string') {
        if (TEXT_CONTENT_KEYS.has(key)) {
          const s = stripHtml(v);
          if (s) out.push(s);
        }
      } else {
        collectText(v, out);
      }
    }
  }
}

function walkBlock(block, symbolsById, out, seen) {
  if (!block || typeof block !== 'object') return;
  if (block.type === 'symbol') {
    const sid = block.content?.symbolId;
    if (sid && symbolsById && symbolsById[sid] && !seen.has(sid)) {
      seen.add(sid);
      const sym = symbolsById[sid];
      walkSections(sym?.design || sym, symbolsById, out, seen);
    }
    return;
  }
  collectText(block.content, out);
  if (Array.isArray(block.children)) {
    for (const child of block.children) walkBlock(child, symbolsById, out, seen);
  }
}

function walkSections(design, symbolsById, out, seen) {
  if (!design || typeof design !== 'object') return;
  const sections = design.root?.sections;
  if (!Array.isArray(sections)) return;
  for (const section of sections) {
    const children = section?.children || [];
    for (const block of children) walkBlock(block, symbolsById, out, seen);
  }
}

/**
 * Collect every top-level symbol id referenced by a canvas design. Mirrors the
 * public page endpoint's collector so the indexer fetches exactly the symbol
 * designs the renderer would embed — no more (which would leak unpublished
 * content) and no less.
 * @param {object} design canvas_design document
 * @returns {Set<string>} referenced symbol ids
 */
export function collectCanvasSymbolIds(design) {
  const ids = new Set();
  const sections = design?.root?.sections;
  if (Array.isArray(sections)) {
    for (const section of sections) {
      for (const b of section?.children || []) {
        if (b?.type === 'symbol' && b?.content?.symbolId) ids.add(b.content.symbolId);
      }
    }
  }
  return ids;
}

/**
 * Extract the human-readable, HTML-stripped text of a Canvas Builder page.
 * @param {object} design       canvas_design document
 * @param {Object<string,object>} symbolsById map of symbol id -> symbol row
 *        ({ id, design }) for every referenced symbol, so symbol text is
 *        resolved exactly as the renderer would show it.
 * @returns {string} newline-separated page text (duplicates removed)
 */
export function extractCanvasPageText(design, symbolsById = {}) {
  const out = [];
  walkSections(design, symbolsById, out, new Set());
  const uniq = [];
  const seenText = new Set();
  for (const t of out) {
    if (!seenText.has(t)) {
      seenText.add(t);
      uniq.push(t);
    }
  }
  return uniq.join('\n\n');
}
