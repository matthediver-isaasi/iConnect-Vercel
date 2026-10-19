import { parseFragment } from 'parse5';

// This is a closed allowlist, not a recursive walk of element.content.
// Paths describe authored copy only; custom selectors below enforce renderer
// branches (legacy fallbacks, hidden controls, table bounds and column modes).
function policy(fields, dynamic = false) {
  return Object.freeze({ fields: Object.freeze(fields), dynamic });
}

export const IEDIT_COMPONENT_POLICIES = Object.freeze({
  hero: policy(['heading', 'subheading', 'content_text', 'button.text']),
  text_block: policy(['heading', 'text']),
  image: policy(['altText', 'caption']),
  two_column: policy(['leftHeading', 'leftContent', 'rightHeading', 'rightContent']),
  cta_button: policy(['button.text']),
  image_hero: policy([]),
  wall_of_fame: policy(['heading_text', 'subheading_text', 'body_content', 'custom_title'], true),
  form: policy(['heading', 'subheading', 'text_content'], true),
  text_overlay_image: policy(['header', 'text']),
  table: policy(['header', 'description', 'cells[row-col]']),
  banner_carousel: policy(['banners[].headerText', 'banners[].paragraphText', 'banners[].ctaText']),
  showcase: policy(['headerText', 'descriptionText', 'body_content'], true),
  resources_showcase: policy(['headerText', 'subheaderText', 'descriptionText', 'button_text'], true),
  button_block: policy(['heading_text', 'subheading_text', 'body_content', 'buttons[].text']),
  page_header_hero: policy(['header_text', 'subheading_text', 'content_text']),
  organisation_directory: policy(['header_title', 'header_subtitle', 'header_content'], true),
  featured_job: policy(['header_label', 'main_heading', 'subheading', 'button_text', 'right_header_text'], true),
  image_panel: policy(['panels[].header_text', 'panels[].bottom_text', 'panels[].button.text']),
  accordion: policy(['header_title', 'header_subtitle', 'header_content', 'items[].title', 'items[].content', 'items[].links[].label']),
  quote: policy(['header_title', 'header_subtitle', 'header_content', 'quotes[].quote_text', 'quotes[].author_name', 'quote_text', 'author_name']),
  fifty_fifty: policy(['header_title', 'header_subtitle', 'header_content', 'left_heading', 'left_subheading', 'left_content', 'right_heading', 'right_subheading', 'right_content', 'button.text']),
  card_deck: policy(['heading', 'subheading', 'body_content', 'cardButtonText'], true),
  logo_grid: policy(['heading', 'subheading', 'body_content', 'logos[].name']),
  event_spotlight: policy(['heading', 'subheading', 'additional_content', 'button.text'], true),
  video: policy(['title', 'caption', 'transcript']),
  timeline: policy(['title', 'items[].year', 'items[].heading', 'items[].body', 'items[].media_items[].alt', 'items[].media.alt', 'items[].sub_items[]', 'items[].column_content[]']),
  hero_carousel: policy(['slides[].headerText', 'slides[].subheadingText', 'slides[].contentText', 'slides[].ctaText']),
  gallery: policy(['heading'], true),
});

const OMIT_HTML = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'input', 'textarea', 'select']);
const BLOCK_HTML = new Set(['p', 'div', 'section', 'article', 'figure', 'figcaption', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'blockquote', 'br', 'hr']);

export function readableText(value) {
  if (typeof value !== 'string') return '';
  const parts = [];
  function visit(node) {
    if (node.nodeName === '#text') {
      parts.push(node.value);
      return;
    }
    if (OMIT_HTML.has(node.tagName)) return;
    const attrs = Object.fromEntries((node.attrs || []).map(({ name, value: attrValue }) => [name, attrValue]));
    if ('hidden' in attrs || attrs['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || '')) return;
    const block = BLOCK_HTML.has(node.tagName);
    if (block) parts.push('\n');
    if (node.tagName === 'img' && attrs.role !== 'presentation') parts.push(attrs.alt || '');
    for (const child of node.childNodes || []) visit(child);
    if (block) parts.push('\n');
  }
  visit(parseFragment(value));
  return parts.join('').replace(/\u00a0/g, ' ').replace(/[ \t\r\f]+/g, ' ')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n').trim();
}

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];

/**
 * Extract authored, renderer-visible content, never runtime/entity snapshots.
 * Dynamic is a dispatch signal for a separately authorized entity loader, even
 * when the element has no static sections or no configured selection.
 */
export function extractIEditElement(element) {
  const type = element?.element_type;
  if (!Object.hasOwn(IEDIT_COMPONENT_POLICIES, type)) {
    throw new Error(`Unsupported iEdit element type: ${String(type)}`);
  }
  const content = record(element.content);
  const sections = [];
  const add = value => {
    const text = readableText(value);
    if (text) sections.push({ text });
  };
  const fields = (object, names) => names.forEach(name => add(object?.[name]));
  const headers = () => fields(content, ['header_title', 'header_subtitle', 'header_content']);
  const button = object => add(object?.button?.text);
  const carousel = (rows, names) => {
    for (const row of list(rows)) {
      fields(row, names);
      if (row?.ctaLink) add(row.ctaText);
    }
  };
  function timelineEntry(entry, { item = false, column = false, sub = false } = {}) {
    if (!entry || typeof entry !== 'object') return;
    // Years may be numeric in persisted timeline data; arbitrary objects and
    // other numeric settings must never be stringified.
    if (!column) add(typeof entry.year === 'number' && Number.isFinite(entry.year) ? String(entry.year) : entry.year);
    if (item && entry.columns > 1 && list(entry.column_content).length) {
      for (const columnEntry of entry.column_content.slice(0, entry.columns)) timelineEntry(columnEntry, { column: true });
      return;
    }
    fields(entry, ['heading', 'body']);
    const mediaItems = list(entry.media_items);
    if (mediaItems.length) {
      for (const media of mediaItems) if (media?.src) add(media.alt);
    } else if (entry.media?.src && entry.media.type !== 'video') {
      add(entry.media.alt);
    }
    if (!sub) for (const subEntry of list(entry.sub_items)) timelineEntry(subEntry, { sub: true });
  }

  switch (type) {
    case 'hero': fields(content, ['heading', 'subheading', 'content_text']); button(content); break;
    case 'text_block': fields(content, ['heading', 'text']); break;
    case 'image':
      if (content.imageUrl) {
        if (!content.decorative) add(content.altText);
        add(content.caption);
      }
      break;
    case 'two_column': fields(content, ['leftHeading', 'leftContent', 'rightHeading', 'rightContent']); break;
    case 'cta_button': button(content); break;
    case 'image_hero': break; // Only image URLs and a fixed, non-authored alt.
    case 'wall_of_fame':
      fields(content, ['heading_text', 'subheading_text', 'body_content']);
      if (content.show_category_name !== false) add(content.custom_title);
      break;
    case 'form': fields(content, ['heading', 'subheading', 'text_content']); break;
    case 'text_overlay_image': fields(content, ['header', 'text']); break;
    case 'table': {
      fields(content, ['header', 'description']);
      // Iterate supplied keys, not untrusted row counts; retain renderer order
      // and ignore stale/out-of-grid cells and image URL values.
      const rows = Number(content.rows || 2);
      const cols = Number(content.cols || 2);
      Object.keys(record(content.cells)).map(key => ({ key, match: /^(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(key) }))
        .filter(({ match }) => match && +match[1] < rows && +match[2] < cols)
        .sort((a, b) => +a.match[1] - +b.match[1] || +a.match[2] - +b.match[2])
        .forEach(({ key }) => { if (content.cellTypes?.[key] !== 'image') add(content.cells[key]); });
      break;
    }
    case 'banner_carousel': carousel(content.banners, ['headerText', 'paragraphText']); break;
    case 'showcase': fields(content, ['headerText', 'descriptionText', 'body_content']); break;
    case 'resources_showcase': fields(content, ['headerText', 'subheaderText', 'descriptionText', 'button_text']); break;
    case 'button_block':
      fields(content, ['heading_text', 'subheading_text', 'body_content']);
      for (const entry of list(content.buttons)) add(entry?.text);
      break;
    case 'page_header_hero': fields(content, ['header_text', 'subheading_text', 'content_text']); break;
    case 'organisation_directory': headers(); break;
    case 'featured_job': fields(content, ['header_label', 'main_heading', 'subheading', 'button_text', 'right_header_text']); break;
    case 'image_panel':
      for (const panel of list(content.panels).slice(0, 5)) {
        fields(panel, ['header_text', 'bottom_text']); button(panel);
      }
      break;
    case 'accordion':
      headers();
      for (const item of list(content.items)) {
        fields(item, ['title', 'content']);
        for (const link of list(item?.links)) add(link?.label);
      }
      break;
    case 'quote':
      headers();
      for (const quote of list(content.quotes).length ? content.quotes : (content.quote_text ? [content] : [])) fields(quote, ['quote_text', 'author_name']);
      break;
    case 'fifty_fifty':
      headers();
      for (const side of ['left', 'right']) {
        if (content[`${side}_content_type`] !== 'image') fields(content, [`${side}_heading`, `${side}_subheading`, `${side}_content`]);
      }
      button(content);
      break;
    case 'card_deck':
      fields(content, ['heading', 'subheading', 'body_content']);
      // Button labels depend on an eligible selected card with a target URL.
      // The dynamic resolver applies each card's override and display toggle.
      break;
    case 'logo_grid':
      fields(content, ['heading', 'subheading', 'body_content']);
      for (const logo of list(content.logos)) add(logo?.name);
      break;
    case 'event_spotlight':
      fields(content, ['heading', 'subheading', 'additional_content']);
      if (content.show_cta_button !== false) button(content);
      break;
    case 'video': fields(content, ['title', 'caption', 'transcript']); break;
    case 'timeline':
      add(content.title);
      for (const item of list(content.items)) timelineEntry(item, { item: true });
      break;
    case 'hero_carousel': carousel(content.slides, ['headerText', 'subheadingText', 'contentText']); break;
    case 'gallery': add(content.heading); break;
    default: throw new Error(`Missing iEdit extraction policy implementation: ${type}`);
  }
  return { sections, dynamic: IEDIT_COMPONENT_POLICIES[type].dynamic };
}
