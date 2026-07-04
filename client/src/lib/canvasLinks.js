// Canvas Links extraction + apply helpers.
//
// Single source of truth for "where do links live inside a canvas_design
// document". Used by the Canvas Links Manager admin page (list) and its
// update endpoint (apply). This module is intentionally React-free and has
// NO imports from the block registry (registry.jsx / dynamicBlocks.jsx) so it
// can be imported both from the client (`@/lib/canvasLinks`) AND from the
// Vercel serverless backend (relative import). The block registry stays the
// place link *editors* live; this file mirrors the same field paths so that
// when a future block adds a link field, you add ONE spec entry here too.
//
// Verified field paths (against registry.jsx / dynamicBlocks.jsx):
//   Hero            content.ctas[].href
//   Image           content.href
//   Button          content.href
//   Card            content.ctaHref
//   Logo strip      content.logos[].href
//   Pricing table   content.tiers[].ctaHref      (array is `tiers`, not items)
//   Accordion       content.items[].links[].url
//   Mega menu       content.items[].href
//                   content.items[].columns[].links[].href
//                   content.items[].featuredHref
//   Speaker carousel content.ctaHref
//   Sponsor grid    content.emptyCatCtaHref
//   Sponsor carousel content.emptyCatCtaHref
//   Hero carousel   content.slides[].ctaLink
// Rich-text html fields (inline <a href> parsed out): text/columns/accordion
//   answer/card body/testimonials/testimonial-grid/card-flip-grid/hero-carousel
//   slide text/custom-html.
//
// NOTE: Article-list `ctaHref` and Form `successHref` were listed in the task
// brief but do NOT exist in the current block content shapes, so they are not
// extracted (extracting a field the editor never writes/reads would surface
// phantom rows). Add them here if/when those blocks gain the field.

import { BLOCK_TYPES } from './canvasDesign.js';

// ---------------------------------------------------------------------------
// Structured (non-html) link fields. Each block type maps to a list of specs.
// Spec kinds:
//   { field, label }                     -> content[field]
//   { array, field, label }              -> content[array][i][field]
//   { extract(content) -> rows[] }       -> fully custom (deeply nested)
// Optional spec keys:
//   enabledContentField                  -> block-level boolean toggle; when the
//                                           content field is explicitly `false`
//                                           the link never renders, so no row is
//                                           emitted (missing = enabled). Mirrors
//                                           the renderer gate (e.g. Card
//                                           `ctaEnabled !== false`).
// A returned row is { contentPath: [...], value, label, context? }.
// ---------------------------------------------------------------------------
export const LINK_FIELD_SPECS = {
  [BLOCK_TYPES.HERO]: [{ array: 'ctas', field: 'href', label: 'Hero CTA', imageSrcContentField: 'bgImageUrl', buttonLabelField: 'label' }],
  [BLOCK_TYPES.IMAGE]: [{ field: 'href', label: 'Image link', imageSrcField: 'src', imageAltField: 'alt' }],
  [BLOCK_TYPES.BUTTON]: [{ field: 'href', label: 'Button' }],
  [BLOCK_TYPES.CARD]: [{ field: 'ctaHref', label: 'Card CTA', imageSrcField: 'imageUrl', imageAltField: 'imageAlt', buttonLabelContentField: 'ctaLabel', contextContentField: 'heading', enabledContentField: 'ctaEnabled' }],
  [BLOCK_TYPES.LOGO_STRIP]: [{ array: 'logos', field: 'href', label: 'Logo / grid item', imageSrcField: 'src', imageAltField: 'alt' }],
  [BLOCK_TYPES.PRICING_TABLE]: [{ array: 'tiers', field: 'ctaHref', label: 'Pricing CTA', buttonLabelField: 'ctaLabel' }],
  [BLOCK_TYPES.SPEAKER_CAROUSEL]: [{ field: 'ctaHref', label: 'Speaker "see all"' }],
  [BLOCK_TYPES.SPONSOR_GRID]: [{ field: 'emptyCatCtaHref', label: 'Sponsor empty-category link' }],
  [BLOCK_TYPES.SPONSOR_CAROUSEL]: [{ field: 'emptyCatCtaHref', label: 'Sponsor empty-category link' }],
  [BLOCK_TYPES.HERO_CAROUSEL]: [{ array: 'slides', field: 'ctaLink', label: 'Hero carousel CTA', imageSrcField: 'backgroundImage', buttonLabelField: 'ctaText' }],
  [BLOCK_TYPES.ACCORDION]: [
    {
      extract: (content) => {
        const rows = [];
        const items = Array.isArray(content.items) ? content.items : [];
        items.forEach((item, i) => {
          const links = Array.isArray(item?.links) ? item.links : [];
          links.forEach((link, li) => {
            rows.push({
              contentPath: ['items', i, 'links', li, 'url'],
              value: link?.url,
              label: 'Accordion link',
              context: link?.label || item?.q || undefined,
            });
          });
        });
        return rows;
      },
    },
  ],
  [BLOCK_TYPES.MEGA_MENU]: [
    {
      extract: (content) => {
        const rows = [];
        const items = Array.isArray(content.items) ? content.items : [];
        items.forEach((item, i) => {
          // Top-level nav link (only when the item is not a dropdown panel)
          rows.push({
            contentPath: ['items', i, 'href'],
            value: item?.href,
            label: 'Mega-menu item',
            context: item?.label || undefined,
          });
          const columns = Array.isArray(item?.columns) ? item.columns : [];
          columns.forEach((col, ci) => {
            const links = Array.isArray(col?.links) ? col.links : [];
            links.forEach((link, li) => {
              rows.push({
                contentPath: ['items', i, 'columns', ci, 'links', li, 'href'],
                value: link?.href,
                label: 'Mega-menu column link',
                context: link?.label || col?.heading || undefined,
              });
            });
          });
          // Featured block link
          rows.push({
            contentPath: ['items', i, 'featuredHref'],
            value: item?.featuredHref,
            label: 'Mega-menu featured link',
            context: item?.featuredTitle || item?.label || undefined,
          });
        });
        return rows;
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Rich-text html fields. Inline <a href> anchors are parsed out of these.
// Spec kinds mirror the structured specs but point at html string fields:
//   { field }            -> content[field]
//   { array, field }     -> content[array][i][field]
// ---------------------------------------------------------------------------
export const HTML_FIELD_SPECS = {
  [BLOCK_TYPES.TEXT]: [{ field: 'html' }],
  [BLOCK_TYPES.COLUMNS]: [{ array: 'items', field: 'html' }],
  [BLOCK_TYPES.ACCORDION]: [{ array: 'items', field: 'a' }],
  [BLOCK_TYPES.CARD]: [{ field: 'body' }],
  [BLOCK_TYPES.TESTIMONIALS]: [{ array: 'items', field: 'quote' }],
  [BLOCK_TYPES.TESTIMONIAL_GRID]: [{ array: 'items', field: 'quote' }],
  [BLOCK_TYPES.CARD_FLIP_GRID]: [{ array: 'cards', field: 'content' }],
  [BLOCK_TYPES.CUSTOM_HTML]: [{ field: 'html' }],
  [BLOCK_TYPES.HERO_CAROUSEL]: [
    { array: 'slides', field: 'headerText' },
    { array: 'slides', field: 'subheadingText' },
    { array: 'slides', field: 'contentText' },
  ],
};

// ---------------------------------------------------------------------------
// Generic get/set of a scalar at a content path (array of string keys /
// numeric indices). Mutates a (cloned) content object.
// ---------------------------------------------------------------------------
function getAtPath(root, path) {
  let cur = root;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setAtPath(root, path, value) {
  if (!path.length) return;
  let cur = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      // Create the intermediate container. Numeric next key -> array.
      cur[key] = typeof path[i + 1] === 'number' ? [] : {};
    }
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Inline anchor helpers. The backend has no DOM, so anchors are addressed by
// their document order within an html string (anchorIndex). Both extraction
// and rewrite iterate opening <a ...> tags in the same order so the index is
// stable for a given html value.
// ---------------------------------------------------------------------------
const ANCHOR_OPEN_RE = /<a\b[^>]*>/gi;
const HREF_ATTR_RE = /\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i;

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Return [{ index, href, text }] for every <a> in an html string.
export function extractAnchors(html) {
  const src = String(html || '');
  if (!src) return [];
  const anchors = [];
  let m;
  ANCHOR_OPEN_RE.lastIndex = 0;
  let idx = 0;
  while ((m = ANCHOR_OPEN_RE.exec(src)) !== null) {
    const openTag = m[0];
    const hrefMatch = openTag.match(HREF_ATTR_RE);
    const href = hrefMatch ? (hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '') : '';
    // Inner text: from end of this open tag to the next </a>.
    const afterOpen = m.index + openTag.length;
    const closeIdx = src.toLowerCase().indexOf('</a>', afterOpen);
    const inner = closeIdx === -1 ? '' : src.slice(afterOpen, closeIdx);
    anchors.push({ index: idx, href, text: stripTags(inner) });
    idx += 1;
  }
  return anchors;
}

// Rewrite the href of the Nth (anchorIndex) <a> tag in html. Returns new html.
// Throws if the anchor index does not exist.
export function setAnchorHref(html, anchorIndex, newHref) {
  const src = String(html || '');
  let count = 0;
  let found = false;
  const out = src.replace(ANCHOR_OPEN_RE, (openTag) => {
    if (count === anchorIndex) {
      found = true;
      count += 1;
      const safe = String(newHref ?? '');
      if (HREF_ATTR_RE.test(openTag)) {
        return openTag.replace(HREF_ATTR_RE, ` href="${escapeAttr(safe)}"`);
      }
      // No href attribute present -> insert one right after `<a`.
      return openTag.replace(/^<a\b/i, `<a href="${escapeAttr(safe)}"`);
    }
    count += 1;
    return openTag;
  });
  if (!found) {
    throw new Error(`Anchor index ${anchorIndex} not found in html field`);
  }
  return out;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Block traversal. Walk every block in a design, recursing into section
// children and any nested block.children arrays (groups / containers).
// ---------------------------------------------------------------------------
function walkBlocks(design, visit) {
  const sections = design?.root?.sections;
  if (!Array.isArray(sections)) return;
  for (const section of sections) {
    const sectionId = section?.id || null;
    const children = Array.isArray(section?.children) ? section.children : [];
    for (const block of children) {
      walkBlock(block, sectionId, visit);
    }
  }
}

function walkBlock(block, sectionId, visit) {
  if (!block || typeof block !== 'object') return;
  visit(block, sectionId);
  if (Array.isArray(block.children)) {
    for (const child of block.children) {
      walkBlock(child, sectionId, visit);
    }
  }
}

// Human label for a block (falls back to the type).
function humanBlockType(type) {
  return String(type || 'block');
}

// ---------------------------------------------------------------------------
// Extraction. Returns a flat array of link rows for a single design document.
// Each row:
//   {
//     blockId, sectionId, blockType,
//     kind: 'field' | 'html-anchor',
//     label,               // human-readable link type
//     context,             // optional (item label / anchor text)
//     value,               // current href/url ('' when unset)
//     path: { contentPath: [...], anchorIndex? }
//   }
// ---------------------------------------------------------------------------
export function extractCanvasLinks(design) {
  const rows = [];
  if (!design || typeof design !== 'object') return rows;

  walkBlocks(design, (block, sectionId) => {
    const type = block.type;
    const content = block.content && typeof block.content === 'object' ? block.content : {};
    const blockId = block.id;
    if (!blockId) return; // cannot address a block without a stable id

    // 1. Structured link fields.
    const specs = LINK_FIELD_SPECS[type] || [];
    for (const spec of specs) {
      if (typeof spec.extract === 'function') {
        const custom = spec.extract(content) || [];
        for (const r of custom) {
          rows.push({
            blockId,
            sectionId,
            blockType: type,
            kind: 'field',
            label: r.label,
            context: r.context,
            value: typeof r.value === 'string' ? r.value : '',
            path: { contentPath: r.contentPath },
          });
        }
        continue;
      }
      // Respect a block-level "enabled" toggle. When the spec declares an
      // enabled field and the block has explicitly turned it off, the link
      // never renders (mirrors the renderer gate, e.g. Card `ctaEnabled !==
      // false`), so it must not surface as a phantom row here. A missing flag
      // is treated as enabled for backward compatibility.
      if (spec.enabledContentField && content[spec.enabledContentField] === false) {
        continue;
      }
      if (spec.array) {
        const arr = Array.isArray(content[spec.array]) ? content[spec.array] : [];
        arr.forEach((item, i) => {
          const row = {
            blockId,
            sectionId,
            blockType: type,
            kind: 'field',
            label: spec.label,
            context: item?.label || item?.name || item?.alt || undefined,
            value: typeof item?.[spec.field] === 'string' ? item[spec.field] : '',
            path: { contentPath: [spec.array, i, spec.field] },
          };
          // Attach a thumbnail source when the spec declares one. An
          // item-level image field (e.g. logo `src`) takes precedence; a
          // block-level content field (e.g. hero `bgImageUrl`) is the
          // fallback so every CTA row on the same block shows the shared image.
          let imageSrc;
          let imageAlt;
          if (spec.imageSrcField && typeof item?.[spec.imageSrcField] === 'string' && item[spec.imageSrcField]) {
            imageSrc = item[spec.imageSrcField];
            if (spec.imageAltField && typeof item?.[spec.imageAltField] === 'string' && item[spec.imageAltField]) {
              imageAlt = item[spec.imageAltField];
            }
          } else if (spec.imageSrcContentField && typeof content[spec.imageSrcContentField] === 'string' && content[spec.imageSrcContentField]) {
            imageSrc = content[spec.imageSrcContentField];
            if (spec.imageAltContentField && typeof content[spec.imageAltContentField] === 'string' && content[spec.imageAltContentField]) {
              imageAlt = content[spec.imageAltContentField];
            }
          }
          if (imageSrc) {
            row.imageSrc = imageSrc;
            if (imageAlt) row.imageAlt = imageAlt;
          }
          // Attach the CTA button's visible text (distinct from the link
          // value/path). An item-level label field takes precedence; a
          // block-level content field is the fallback.
          if (spec.buttonLabelField && typeof item?.[spec.buttonLabelField] === 'string' && item[spec.buttonLabelField]) {
            row.buttonLabel = item[spec.buttonLabelField];
          } else if (spec.buttonLabelContentField && typeof content[spec.buttonLabelContentField] === 'string' && content[spec.buttonLabelContentField]) {
            row.buttonLabel = content[spec.buttonLabelContentField];
          }
          rows.push(row);
        });
      } else {
        const row = {
          blockId,
          sectionId,
          blockType: type,
          kind: 'field',
          label: spec.label,
          value: typeof content[spec.field] === 'string' ? content[spec.field] : '',
          path: { contentPath: [spec.field] },
        };
        if (spec.imageSrcField) {
          const imageSrc = content[spec.imageSrcField];
          if (typeof imageSrc === 'string' && imageSrc) {
            row.imageSrc = imageSrc;
            const imageAlt = spec.imageAltField ? content[spec.imageAltField] : undefined;
            if (typeof imageAlt === 'string' && imageAlt) row.imageAlt = imageAlt;
          }
        }
        // Attach the CTA button's visible text (distinct from the link value).
        if (spec.buttonLabelContentField && typeof content[spec.buttonLabelContentField] === 'string' && content[spec.buttonLabelContentField]) {
          row.buttonLabel = content[spec.buttonLabelContentField];
        } else if (spec.buttonLabelField && typeof content[spec.buttonLabelField] === 'string' && content[spec.buttonLabelField]) {
          row.buttonLabel = content[spec.buttonLabelField];
        }
        // Attach surrounding context (e.g. a Card's heading) so links that
        // share a CTA label can be told apart.
        if (spec.contextContentField && typeof content[spec.contextContentField] === 'string' && content[spec.contextContentField]) {
          row.context = content[spec.contextContentField];
        }
        rows.push(row);
      }
    }

    // 2. Inline anchors inside rich-text html fields.
    const htmlSpecs = HTML_FIELD_SPECS[type] || [];
    for (const spec of htmlSpecs) {
      if (spec.array) {
        const arr = Array.isArray(content[spec.array]) ? content[spec.array] : [];
        arr.forEach((item, i) => {
          const html = item?.[spec.field];
          extractAnchors(html).forEach((a) => {
            rows.push({
              blockId,
              sectionId,
              blockType: type,
              kind: 'html-anchor',
              label: 'Inline text link',
              context: a.text || undefined,
              value: a.href || '',
              path: { contentPath: [spec.array, i, spec.field], anchorIndex: a.index },
            });
          });
        });
      } else {
        const html = content[spec.field];
        extractAnchors(html).forEach((a) => {
          rows.push({
            blockId,
            sectionId,
            blockType: type,
            kind: 'html-anchor',
            label: 'Inline text link',
            context: a.text || undefined,
            value: a.href || '',
            path: { contentPath: [spec.field], anchorIndex: a.index },
          });
        });
      }
    }
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Apply a single link update in place on a design object. `path` is the
// addressable path from an extracted row: { contentPath, anchorIndex? }.
// Returns the (same, mutated) design. Throws when the block or path cannot be
// resolved so callers fail loudly rather than silently no-op.
//
// Pass a deep clone in if you need to preserve the original.
// ---------------------------------------------------------------------------
export function applyCanvasLinkUpdate(design, blockId, path, newValue) {
  if (!design || typeof design !== 'object') {
    throw new Error('Invalid canvas_design document');
  }
  if (!blockId) throw new Error('blockId is required');
  if (!path || !Array.isArray(path.contentPath) || !path.contentPath.length) {
    throw new Error('A valid contentPath is required');
  }

  let target = null;
  walkBlocks(design, (block) => {
    if (block.id === blockId) target = block;
  });
  if (!target) throw new Error(`Block ${blockId} not found in design`);

  if (!target.content || typeof target.content !== 'object') {
    target.content = {};
  }

  if (Number.isInteger(path.anchorIndex)) {
    // Rewrite the Nth anchor href within an html field.
    const html = getAtPath(target.content, path.contentPath);
    if (typeof html !== 'string') {
      throw new Error('Target html field is missing or not a string');
    }
    setAtPath(target.content, path.contentPath, setAnchorHref(html, path.anchorIndex, newValue));
    return design;
  }

  setAtPath(target.content, path.contentPath, typeof newValue === 'string' ? newValue : '');
  return design;
}

// ---------------------------------------------------------------------------
// Internal-page suggestion matcher.
//
// Given an extracted link row and the tenant's internal-page picker pool,
// score each page against the row's descriptive signals (card heading /
// context, CTA text, link-type label, image alt) versus the page's title and
// slug, and return the single best page ONLY when the match is confident.
//
// The heading/context is the primary signal; generic CTAs like "Learn more"
// collapse to no tokens (all stopwords) so they never drive a match on their
// own. Dependency-free, React-free, and safe to import from the backend too.
// ---------------------------------------------------------------------------
const SUGGEST_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by',
  'with', 'from', 'our', 'your', 'my', 'is', 'are', 'be', 'this', 'that',
  'learn', 'more', 'read', 'click', 'here', 'view', 'see', 'all', 'find',
  'out', 'get', 'go', 'now', 'page', 'pages', 'link', 'links', 'button',
  'cta', 'hero', 'card', 'image', 'menu', 'item', 'items', 'inline', 'text',
  'logo', 'grid', 'accordion', 'featured', 'column', 'sponsor', 'speaker',
]);

function suggestTokens(str) {
  if (!str || typeof str !== 'string') return [];
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase / PascalCase slugs
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !SUGGEST_STOPWORDS.has(t));
}

// Match-confidence gate. Each page is scored with a weighted harmonic mean
// (F-beta, beta=2) of query-coverage (fraction of the row's descriptive tokens
// the page explains) and page-coverage (fraction of the page's title/slug the
// row explains). Query-coverage is weighted ~4x more heavily because the row
// heading is the primary signal. A realistic single strong-token overlap — e.g.
// heading "The Story of BNMS" vs page "About BNMS" sharing only "bnms" — scores
// 0.5, so the threshold sits just below that. Rows that share only a small
// fraction of tokens on both sides stay well under the bar (no false positives).
const SUGGEST_THRESHOLD = 0.45;
const SUGGEST_BETA_SQ = 4; // beta = 2 -> query-coverage weighted 4x over page-coverage

export function suggestInternalPage(row, internalPages, options = {}) {
  if (!row || !Array.isArray(internalPages) || internalPages.length === 0) return null;

  // Build the query token set from the row's descriptive signals. The heading
  // (context) and image alt are the strongest descriptors; the CTA label and
  // link-type label contribute but are mostly stripped by the stopword list.
  const query = new Set([
    ...suggestTokens(row.context),
    ...suggestTokens(row.imageAlt),
    ...suggestTokens(row.buttonLabel),
    ...suggestTokens(row.label),
  ]);
  if (query.size === 0) return null;

  const queryTokens = Array.from(query);
  const excludeId = options.excludePageId;

  let best = null;
  for (const page of internalPages) {
    if (excludeId != null && page.id === excludeId) continue;
    const pageSet = new Set([...suggestTokens(page.title), ...suggestTokens(page.slug)]);
    if (pageSet.size === 0) continue;

    let matched = 0;
    for (const t of queryTokens) if (pageSet.has(t)) matched += 1;
    if (matched === 0) continue;

    const queryCoverage = matched / queryTokens.length;
    const pageCoverage = matched / pageSet.size;
    const score =
      ((1 + SUGGEST_BETA_SQ) * pageCoverage * queryCoverage) /
      (SUGGEST_BETA_SQ * pageCoverage + queryCoverage);

    if (!best || score > best.score) best = { page, score };
  }

  if (best && best.score >= SUGGEST_THRESHOLD) return best.page;
  return null;
}
