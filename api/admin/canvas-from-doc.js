// Create a Canvas Builder page from an uploaded Word (.docx) document OR from
// raw pasted text.
//
// POST /api/admin/canvas-from-doc
//   body (JSON): { fileBase64, filename, title?, slug?, preview?, confirm?, design? }  — Word upload
//            or: { text, title?, slug?, preview?, confirm?, design? }                  — pasted text
//
// Content can be supplied either as an uploaded .docx (fileBase64) or as raw
// pasted text (text). Two-step flow so admins review the AI output before
// anything is persisted:
//   1. preview: true  → obtain the document text (decode the .docx zip and
//      extract text, or use the pasted text directly) → ask OpenAI to turn it
//      into a structured page spec → build a tenant-neutral Canvas design with
//      the shared layout engine → RETURN the design WITHOUT inserting a row.
//   2. confirm: true  → persist the design the admin reviewed (sent back in the
//      body as `design`) as a DRAFT canvas page. Returns the new page row so the
//      client can open it in the Canvas editor.
//
// For backward compatibility, a request with neither flag runs the full
// generate-and-insert path in one shot (legacy behaviour).
//
// Gated by `site-builder.pages` (tenant admin OR feature access). The page is
// created as a draft so the admin reviews it before publishing.

import OpenAI from 'openai';
import JSZip from 'jszip';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { buildNeutralDesign, CONTENT_W } from '../_lib/canvasLayoutEngine.js';

const MAX_DOC_CHARS = 12000;

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Extract paragraph text from a .docx buffer. We deliberately keep this simple:
// one line per Word paragraph, tags stripped. The LLM infers structure from the
// content, so we do not need style/heading fidelity here.
async function extractDocxText(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw Object.assign(new Error('The uploaded file is not a valid .docx document.'), { httpStatus: 400 });
  }
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw Object.assign(new Error('The uploaded file is not a valid Word document (missing document.xml).'), { httpStatus: 400 });
  }
  const xml = await docFile.async('string');
  const paras = xml
    .split(/<\/w:p>/)
    .map((p) => {
      const runs = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXmlEntities(m[1]));
      // Represent explicit line breaks inside a paragraph.
      const brs = p.includes('<w:br') ? '' : '';
      return (runs.join('') + brs).trim();
    })
    .filter((t) => t.length > 0);
  return paras.join('\n');
}

// Rough height estimate for a text block so the absolutely-positioned layout
// reserves enough vertical space (blocks clip overflow, so we slightly
// over-reserve; the "Clean up" pass can tighten later).
function estimateHeight(text, { width = CONTENT_W, min = 60, extra = 24, bullets = false } = {}) {
  const plain = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const charsPerLine = Math.max(20, Math.floor(width / 9));
  // Count explicit paragraphs / list items to add per-line breaks.
  const blocks = String(text || '').split(/<\/(?:p|li|h[1-6])>/i).filter((b) => b.replace(/<[^>]+>/g, '').trim().length);
  const paraCount = Math.max(1, blocks.length);
  const textLines = Math.ceil(plain.length / charsPerLine);
  const lines = Math.max(textLines, paraCount);
  const lineHeight = 30;
  const bulletPad = bullets ? paraCount * 6 : 0;
  return Math.max(min, lines * lineHeight + extra + bulletPad);
}

function toStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// Ensure any body text is HTML. Plain lines become <p> paragraphs.
function ensureHtml(v) {
  const s = toStr(v).trim();
  if (!s) return '<p></p>';
  if (/<\w+[^>]*>/.test(s)) return s;
  return s
    .split(/\n+/)
    .map((line) => `<p>${line.trim()}</p>`)
    .join('');
}

function slugify(s) {
  return toStr(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';
}

// Sanitize + normalize the LLM spec into exactly the shape buildDesign expects,
// computing block heights server-side (never trusting the model for geometry).
function sanitizeSpec(raw, fallbackTitle) {
  const spec = raw && typeof raw === 'object' ? raw : {};
  const heroIn = spec.hero && typeof spec.hero === 'object' ? spec.hero : {};
  const hero = {
    headline: toStr(heroIn.headline).trim() || fallbackTitle || 'Welcome',
    subheadline: toStr(heroIn.subheadline).trim(),
    ctaLabel: toStr(heroIn.ctaLabel).trim() || 'Learn more',
    bgImageUrl: '',
  };

  const out = { hero, sections: [] };

  if (spec.intro && typeof spec.intro === 'object') {
    const html = ensureHtml(spec.intro.html);
    out.intro = {
      icon: toStr(spec.intro.icon).trim(),
      strapline: toStr(spec.intro.strapline).trim() || hero.headline,
      html,
      h: estimateHeight(html, { min: 80 }),
    };
  }

  const rawSections = Array.isArray(spec.sections) ? spec.sections.slice(0, 20) : [];
  for (const sec of rawSections) {
    if (!sec || typeof sec !== 'object') continue;
    const heading = toStr(sec.heading).trim();
    const type = toStr(sec.type).trim();

    if (type === 'columns' && Array.isArray(sec.columns)) {
      const columns = sec.columns.slice(0, 2).map((c) => {
        const html = ensureHtml(c?.html);
        return {
          icon: toStr(c?.icon).trim(),
          h3: toStr(c?.h3).trim() || 'Details',
          html,
          bullets: c?.bullets === true,
          h: estimateHeight(html, { width: 420, min: 80, bullets: c?.bullets === true }),
        };
      });
      if (columns.length) out.sections.push({ heading, type: 'columns', columns });
    } else if (type === 'accordion' && Array.isArray(sec.items)) {
      const items = sec.items.slice(0, 12).map((it) => ({
        question: toStr(it?.question || it?.title).trim() || 'Question',
        answer: ensureHtml(it?.answer || it?.html),
      })).filter((it) => it.question);
      if (items.length) {
        out.sections.push({ heading, type: 'accordion', items, h: 80 + items.length * 64 });
      }
    } else if (type === 'cards' && Array.isArray(sec.cards)) {
      const cols = [2, 3, 4].includes(Number(sec.columns)) ? Number(sec.columns) : 3;
      const cards = sec.cards.slice(0, 12).map((c) => ({
        icon: toStr(c?.icon).trim(),
        heading: toStr(c?.heading || c?.title).trim() || 'Card',
        body: toStr(c?.body).trim(),
        cta: toStr(c?.cta).trim() || undefined,
      }));
      if (cards.length) out.sections.push({ heading, type: 'cards', columns: cols, cards });
    } else {
      // text / feature — body copy with optional CTA button(s).
      const html = ensureHtml(sec.html || sec.body);
      const bullets = sec.bullets === true;
      const buttons = Array.isArray(sec.buttons)
        ? sec.buttons.map((b) => toStr(b).trim()).filter(Boolean).slice(0, 4)
        : sec.cta
        ? [toStr(sec.cta).trim()].filter(Boolean)
        : [];
      out.sections.push({
        heading,
        type: 'text',
        html,
        bullets,
        h: estimateHeight(html, { min: 60, bullets }),
        ...(buttons.length ? { buttons } : {}),
      });
    }
  }

  if (out.sections.length === 0) {
    out.sections.push({ heading: '', type: 'text', html: '<p></p>', h: 60 });
  }

  const closeIn = spec.closingHero && typeof spec.closingHero === 'object' ? spec.closingHero : {};
  out.closingHero = {
    headline: toStr(closeIn.headline).trim() || 'Get in touch',
    subheadline: toStr(closeIn.subheadline).trim(),
    ctaLabel: toStr(closeIn.ctaLabel).trim() || 'Contact us',
    bgImageUrl: '',
  };

  return out;
}

const SPEC_SYSTEM_PROMPT = `You convert a document into a structured spec for a web page builder. Respond ONLY with valid JSON, no prose.

Output shape:
{
  "hero": { "headline": string, "subheadline": string, "ctaLabel": string },
  "intro": { "icon": "", "strapline": string, "html": string } | omitted,
  "sections": [ Section, ... ],
  "closingHero": { "headline": string, "subheadline": string, "ctaLabel": string }
}

A Section is ONE of:
- { "heading": string, "type": "text", "html": string, "bullets": boolean, "cta": string | omitted }
- { "heading": string, "type": "columns", "columns": [ { "h3": string, "html": string, "bullets": boolean }, ... up to 2 ] }
- { "heading": string, "type": "cards", "columns": 2|3|4, "cards": [ { "heading": string, "body": string, "cta": string | omitted }, ... ] }
- { "heading": string, "type": "accordion", "items": [ { "question": string, "answer": string }, ... ] }

Rules:
- Use the document's real content; do not invent facts. Keep the wording faithful.
- "html" fields may contain simple HTML (<p>, <ul>, <li>, <strong>). Wrap paragraphs in <p>.
- Pick the section "type" that best fits the content (FAQ-like -> accordion, short repeated items -> cards, side-by-side -> columns, otherwise text).
- Do NOT include icons, images, colors, sizes, heights, or positions. Leave "icon" empty.
- The hero headline should be the document title/subject; closingHero is a call to action.`;

async function generateSpec(client, docText, fallbackTitle) {
  const userPrompt = `Document title (best guess): ${fallbackTitle || '(unknown)'}\n\nDocument content:\n"""\n${docText}\n"""`;
  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SPEC_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    max_completion_tokens: 4000,
  });
  const content = completion.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw Object.assign(new Error('The document could not be interpreted. Please try again.'), { httpStatus: 502 });
  }
  return parsed;
}

// Insert a draft Canvas page for a fully-built design. Shared by the legacy
// one-shot path and the two-step confirm path so persistence stays identical.
async function insertCanvasPage(tenantId, { title, slug, design }) {
  const { data: inserted, error: insErr } = await supabase
    .from('i_edit_page')
    .insert({
      tenant_id: tenantId,
      organization_id: null,
      title,
      slug,
      description: '',
      status: 'draft',
      layout_type: 'public',
      public_chrome: 'both',
      hide_chrome: false,
      element_ids: [],
      search_text: title,
      builder_type: 'canvas',
      canvas_design: design,
    })
    .select('id, title, slug, builder_type, status')
    .single();
  if (insErr) {
    console.error('[canvas-from-doc] insert failed:', insErr.message);
    throw Object.assign(new Error('Failed to create page'), { httpStatus: 500 });
  }
  return inserted;
}

// Cheap structural validation of a design coming back from the client on
// confirm. We never trust the client for geometry, but an admin with edit
// rights can already create arbitrary canvas_design via the editor, so we only
// guard the shape needed to render/store it.
function isValidDesign(design) {
  return !!(
    design &&
    typeof design === 'object' &&
    design.root &&
    typeof design.root === 'object' &&
    Array.isArray(design.root.sections) &&
    design.root.sections.length > 0
  );
}

async function uniqueSlug(tenantId, base) {
  let slug = slugify(base);
  const { data } = await supabase
    .from('i_edit_page')
    .select('slug')
    .eq('tenant_id', tenantId)
    .like('slug', `${slug}%`);
  const taken = new Set((data || []).map((r) => r.slug));
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 500; i++) {
    const candidate = `${slug}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let context;
  try { context = await getTenantContext(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });

  let canEdit = !!context.tenantUserId;
  if (!canEdit && context.roleId) {
    canEdit = await hasFeatureAccess(context.roleId, 'site-builder.pages');
  }
  if (!canEdit) return res.status(404).json({ error: 'Not found' });

  const client = getOpenAIClient();
  if (!client) {
    return res.status(503).json({ error: 'Document import is not configured (missing OpenAI API key).' });
  }

  const body = req.body || {};

  // Step 2 — persist a design the admin already reviewed in the preview. No
  // docx / OpenAI work here; we just store exactly what they saw.
  if (body.confirm === true) {
    const design = body.design;
    if (!isValidDesign(design)) {
      return res.status(400).json({ error: 'A generated design is required to create the page.' });
    }
    try {
      const title = toStr(body.title).trim() || 'Untitled page';
      const slug = await uniqueSlug(context.tenantId, toStr(body.slug).trim() || title);
      const inserted = await insertCanvasPage(context.tenantId, { title, slug, design });
      const blockCount = design.root.sections[0]?.children?.length || 0;
      return res.status(201).json({ page: inserted, blockCount });
    } catch (err) {
      const status = err?.httpStatus || 500;
      if (status >= 500) console.error('[canvas-from-doc] confirm error:', err?.message || err);
      return res.status(status).json({ error: err?.message || 'Failed to create page' });
    }
  }

  const isPreview = body.preview === true;
  const fileBase64 = toStr(body.fileBase64);
  const pastedText = toStr(body.text);
  if (!fileBase64 && !pastedText.trim()) {
    return res.status(400).json({ error: 'Provide either a document (fileBase64) or pasted text.' });
  }

  let buffer = null;
  if (fileBase64) {
    try {
      buffer = Buffer.from(fileBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'Invalid file encoding' });
    }
    if (!buffer?.length) return res.status(400).json({ error: 'Empty file' });
    if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 8MB)' });
  }

  try {
    let docText;
    let filename = '';
    if (buffer) {
      docText = await extractDocxText(buffer);
      if (!docText.trim()) {
        return res.status(400).json({ error: 'No readable text found in the document.' });
      }
      filename = toStr(body.filename).replace(/\.docx$/i, '').replace(/[-_]+/g, ' ').trim();
    } else {
      docText = pastedText;
      if (!docText.trim()) {
        return res.status(400).json({ error: 'No readable text found in the pasted content.' });
      }
    }
    if (docText.length > MAX_DOC_CHARS) docText = docText.slice(0, MAX_DOC_CHARS);

    const fallbackTitle = toStr(body.title).trim() || filename || 'Untitled page';

    const rawSpec = await generateSpec(client, docText, fallbackTitle);
    const spec = sanitizeSpec(rawSpec, fallbackTitle);
    const design = buildNeutralDesign(spec);

    const title = toStr(body.title).trim() || spec.hero.headline || fallbackTitle;
    const blockCount = design.root.sections[0].children.length;

    // Step 1 — return the generated design for review; nothing is persisted.
    // The client sends it back with `confirm: true` when the admin approves.
    if (isPreview) {
      const sectionSummary = (spec.sections || []).map((s) => ({
        heading: toStr(s.heading).trim(),
        type: toStr(s.type).trim() || 'text',
      }));
      return res.status(200).json({
        preview: true,
        design,
        title,
        slug: slugify(toStr(body.slug).trim() || title),
        blockCount,
        summary: {
          hero: spec.hero.headline,
          sectionCount: (spec.sections || []).length,
          sections: sectionSummary,
        },
      });
    }

    // Legacy one-shot path: generate and insert in a single request.
    const slug = await uniqueSlug(context.tenantId, toStr(body.slug).trim() || title);
    const inserted = await insertCanvasPage(context.tenantId, { title, slug, design });
    return res.status(201).json({ page: inserted, blockCount });
  } catch (err) {
    const status = err?.httpStatus || 500;
    if (status >= 500) console.error('[canvas-from-doc] error:', err?.message || err);
    return res.status(status).json({ error: err?.message || 'Failed to create page from document' });
  }
}
