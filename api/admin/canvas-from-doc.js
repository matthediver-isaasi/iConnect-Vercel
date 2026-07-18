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
import { normalizeDesignDna } from '../_lib/styleReference.js';
import { buildNeutralDesign, buildDesign, extractThemeFromDesign, CONTENT_W } from '../_lib/canvasLayoutEngine.js';

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

// Extract a STRUCTURED representation of a .docx: an ordered list of blocks,
// each { type: 'heading' | 'para' | 'listitem', level, text }. Word paragraph
// styles ("Heading1".."Heading6"/"Title") and numbering (<w:numPr>) are used to
// classify blocks. This structure is the deterministic source of truth for page
// copy, so text is preserved verbatim.
async function extractDocxStructure(buffer) {
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
  const structure = [];
  for (const p of xml.split(/<\/w:p>/)) {
    const runs = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const text = runs.join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const styleMatch = p.match(/<w:pStyle\s+w:val="([^"]*)"/);
    const style = styleMatch ? styleMatch[1] : '';
    const isList = /<w:numPr[\s>]/.test(p);
    const headingMatch = /^Heading(\d)/i.exec(style);
    if (headingMatch) {
      structure.push({ type: 'heading', level: Math.min(6, Number(headingMatch[1]) || 2), text });
    } else if (/^(Title|Subtitle)$/i.test(style)) {
      structure.push({ type: 'heading', level: 1, text });
    } else if (isList) {
      structure.push({ type: 'listitem', level: 0, text });
    } else {
      structure.push({ type: 'para', level: 0, text });
    }
  }
  return structure;
}

// Turn a structure into its plain text (one block per line). Used as the
// verbatim source of truth for the fidelity check.
function structureToText(structure) {
  return structure.map((b) => b.text).join('\n');
}

// Build a structure from pasted plain text. There is no style information, so
// every non-empty line is kept verbatim as a paragraph (including any leading
// bullet / number the user typed — that is their content, not decoration).
function structureFromText(text) {
  const structure = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // Pasted text is kept verbatim: any leading bullet / number the user typed
    // is part of their content, so we do NOT strip it (that would drop supplied
    // text). Every non-empty line becomes a paragraph. The LLM path can still
    // re-organise this into a richer layout when it stays faithful.
    structure.push({ type: 'para', level: 0, text: line });
  }
  return structure;
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

function escapeHtml(s) {
  return toStr(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Ensure any body text is HTML. Plain lines become <p> paragraphs (escaped so
// verbatim characters like < and & survive).
function ensureHtml(v) {
  const s = toStr(v).trim();
  if (!s) return '<p></p>';
  if (/<\w+[^>]*>/.test(s)) return s;
  return s
    .split(/\n+/)
    .map((line) => `<p>${escapeHtml(line.trim())}</p>`)
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
  // No fabricated fallbacks: hero copy comes only from the model (verified
  // against the source downstream); the only permitted default is the page
  // title the admin already supplied. CTA is emitted only when present.
  const hero = {
    headline: toStr(heroIn.headline).trim() || toStr(fallbackTitle).trim(),
    subheadline: toStr(heroIn.subheadline).trim(),
    ctaLabel: toStr(heroIn.ctaLabel).trim(),
    bgImageUrl: '',
  };

  const out = { hero, sections: [] };

  if (spec.intro && typeof spec.intro === 'object') {
    const html = ensureHtml(spec.intro.html);
    out.intro = {
      icon: toStr(spec.intro.icon).trim(),
      strapline: toStr(spec.intro.strapline).trim(),
      html,
      h: estimateHeight(html, { min: 80 }),
    };
  }

  const rawSections = Array.isArray(spec.sections) ? spec.sections.slice(0, 40) : [];
  for (const sec of rawSections) {
    if (!sec || typeof sec !== 'object') continue;
    const heading = toStr(sec.heading).trim();
    const type = toStr(sec.type).trim();

    if (type === 'columns' && Array.isArray(sec.columns)) {
      const columns = sec.columns.slice(0, 2).map((c) => {
        const html = ensureHtml(c?.html);
        return {
          icon: toStr(c?.icon).trim(),
          h3: toStr(c?.h3).trim(),
          html,
          bullets: c?.bullets === true,
          h: estimateHeight(html, { width: 420, min: 80, bullets: c?.bullets === true }),
        };
      });
      if (columns.length) out.sections.push({ heading, type: 'columns', columns });
    } else if (type === 'accordion' && Array.isArray(sec.items)) {
      const items = sec.items.slice(0, 30).map((it) => ({
        question: toStr(it?.question || it?.title).trim(),
        answer: ensureHtml(it?.answer || it?.html),
      })).filter((it) => it.question);
      if (items.length) {
        out.sections.push({ heading, type: 'accordion', items, h: 80 + items.length * 64 });
      }
    } else if (type === 'cards' && Array.isArray(sec.cards)) {
      const cols = [2, 3, 4].includes(Number(sec.columns)) ? Number(sec.columns) : 3;
      const cards = sec.cards.slice(0, 24).map((c) => ({
        icon: toStr(c?.icon).trim(),
        heading: toStr(c?.heading || c?.title).trim(),
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

  // Closing hero is OPTIONAL: only kept when the model supplies a headline. A
  // document with no closing call-to-action must not gain a fabricated one.
  const closeIn = spec.closingHero && typeof spec.closingHero === 'object' ? spec.closingHero : {};
  const closeHeadline = toStr(closeIn.headline).trim();
  if (closeHeadline) {
    out.closingHero = {
      headline: closeHeadline,
      subheadline: toStr(closeIn.subheadline).trim(),
      ctaLabel: toStr(closeIn.ctaLabel).trim(),
      bgImageUrl: '',
    };
  }

  return out;
}

const SPEC_SYSTEM_PROMPT = `You organise a document into a structured spec for a web page builder. You are NOT an author. You may only GROUP and CLASSIFY the document's existing text into layout blocks and choose block types. Respond ONLY with valid JSON, no prose.

Output shape:
{
  "hero": { "headline": string, "subheadline": string },
  "intro": { "strapline": string, "html": string } | omitted,
  "sections": [ Section, ... ]
}

A Section is ONE of:
- { "heading": string, "type": "text", "html": string, "bullets": boolean }
- { "heading": string, "type": "columns", "columns": [ { "h3": string, "html": string, "bullets": boolean }, ... up to 2 ] }
- { "heading": string, "type": "cards", "columns": 2|3|4, "cards": [ { "heading": string, "body": string }, ... ] }
- { "heading": string, "type": "accordion", "items": [ { "question": string, "answer": string }, ... ] }

ABSOLUTE FIDELITY RULES (a page that breaks these is rejected):
- Copy the document's text VERBATIM into the fields. Never paraphrase, summarise, translate, shorten, expand, correct, or reword ANY text. Every headline, heading, sentence, and list item must be an exact character-for-character copy of text that appears in the document.
- Do NOT invent ANY text. No call-to-action labels, no closing sections, no headlines, no placeholder words ("Learn more", "Get in touch", "Details", "Card", "Welcome", etc.). If the document has no heading for a section, use "".
- Include ALL of the document's text. Do not drop or omit any paragraph, heading, or list item.
- The hero headline must be an exact copy of the document's title or first heading. If unsure, use "".

Formatting (structure only, never changes wording):
- "html" fields may wrap the verbatim text in simple HTML: <p> for paragraphs, <ul><li> for list items, <strong>. Do not add words.
- Pick the section "type" that best fits (FAQ-like -> accordion, short repeated items -> cards, side-by-side -> columns, otherwise text). When in doubt, use "text".
- Do NOT include icons, images, colors, sizes, heights, or positions.`;

// Style reference (Task #2873): the Design DNA may ONLY nudge section-type
// choices (layout classification). It must never affect wording, so the
// fidelity rules above stay authoritative and isSpecFaithful still gates.
function styleHintForSpec(designDna) {
  if (!designDna) return '';
  const parts = [];
  if (designDna.composition) parts.push(`composition: ${designDna.composition}`);
  if (designDna.layoutRhythm) parts.push(`layout rhythm: ${designDna.layoutRhythm}`);
  if (designDna.sectionTransitions) parts.push(`section flow: ${designDna.sectionTransitions}`);
  if (!parts.length) return '';
  return `\n\nSTYLE PREFERENCE (affects ONLY which section "type" you pick — NEVER the text, which stays verbatim):
The admin supplied a visual style reference described as — ${parts.join('; ')}.
Where the document's content genuinely fits, lean towards section types that echo that rhythm (e.g. cards/columns for a modular grid feel, text for editorial flow). All fidelity rules above still apply unchanged.`;
}

async function generateSpec(client, docText, fallbackTitle, designDna = null) {
  const userPrompt = `Document title (best guess): ${fallbackTitle || '(unknown)'}\n\nDocument content (copy this text VERBATIM):\n"""\n${docText}\n"""`;
  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SPEC_SYSTEM_PROMPT + styleHintForSpec(designDna) },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_completion_tokens: 8000,
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

// ---------------------------------------------------------------------------
// Fidelity: the generated page must contain ONLY the supplied text and ALL of
// the supplied text. We compare verbatim except for whitespace (styling and
// layout are allowed to differ, wording — including case — is not).
// ---------------------------------------------------------------------------

// Strip tags + entities and collapse whitespace ONLY. Case and punctuation are
// preserved so the comparison is verbatim except for whitespace — a case-only or
// punctuation change (e.g. "NASA" -> "Nasa") must fail fidelity.
function normalizeForCompare(s) {
  return toStr(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

// Every text field the spec will render, as raw strings.
function collectSpecTexts(spec) {
  const out = [];
  const push = (t) => { const s = toStr(t).trim(); if (s) out.push(s); };
  if (spec.hero) { push(spec.hero.headline); push(spec.hero.subheadline); push(spec.hero.ctaLabel); }
  if (spec.intro) { push(spec.intro.strapline); push(spec.intro.html); }
  for (const sec of spec.sections || []) {
    push(sec.heading);
    if (sec.type === 'columns') {
      for (const c of sec.columns || []) { push(c.h3); push(c.html); }
    } else if (sec.type === 'accordion') {
      for (const it of sec.items || []) { push(it.question); push(it.answer); }
    } else if (sec.type === 'cards') {
      for (const c of sec.cards || []) { push(c.heading); push(c.body); push(c.cta); }
    } else {
      push(sec.html);
      for (const b of sec.buttons || []) push(b);
      if (sec.cta) push(sec.cta);
    }
  }
  if (spec.closingHero) { push(spec.closingHero.headline); push(spec.closingHero.subheadline); push(spec.closingHero.ctaLabel); }
  return out;
}

function wordMultiset(s) {
  const m = new Map();
  for (const w of normalizeForCompare(s).split(' ')) {
    if (w) m.set(w, (m.get(w) || 0) + 1);
  }
  return m;
}

// True when the spec is faithful to the source:
//   (a) no injected wording — every emitted chunk is a contiguous, verbatim
//       (whitespace/case-normalised) substring of the source, AND
//   (b) nothing dropped — every source word appears in the spec at least as
//       many times as in the source.
function isSpecFaithful(spec, sourceText) {
  const srcNorm = normalizeForCompare(sourceText);
  if (!srcNorm) return false;
  const chunks = collectSpecTexts(spec);

  for (const chunk of chunks) {
    const n = normalizeForCompare(chunk);
    if (!n) continue;
    if (!srcNorm.includes(n)) return false; // invented / reworded text
  }

  const srcWords = wordMultiset(sourceText);
  const specWords = wordMultiset(chunks.join(' '));
  for (const [word, count] of srcWords) {
    if ((specWords.get(word) || 0) < count) return false; // dropped text
  }
  // No fabricated OR duplicated wording: the spec must not contain any word more
  // often than the source does. Combined with the substring check above, this
  // makes the emitted copy an exact re-grouping of the source words — nothing
  // added, nothing repeated, nothing dropped.
  for (const [word, count] of specWords) {
    if ((srcWords.get(word) || 0) < count) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Deterministic 1:1 spec built straight from the document structure. Guarantees
// perfect fidelity (used as the fallback and for content too long for the LLM).
// Maps headings -> section headings, paragraphs -> text blocks, consecutive
// list items -> bulleted text blocks. No hero CTA, no closing hero.
// ---------------------------------------------------------------------------
function buildDeterministicSpec(structure, fallbackTitle) {
  const blocks = structure.slice();

  // Hero headline is always verbatim source text: the first heading if the
  // document opens with one, otherwise the first block. It is NEVER the
  // admin-supplied page title / filename — that is not part of the document
  // body, so injecting it would violate fidelity. The consumed block is removed
  // from the body so it is not rendered twice.
  let headline = '';
  if (blocks.length) {
    headline = blocks.shift().text;
  }
  const hero = {
    headline,
    subheadline: '',
    ctaLabel: '',
    bgImageUrl: '',
  };

  const sections = [];
  let pendingHeading = '';
  let run = null; // { bullets, parts: [] }

  const flushRun = () => {
    if (run && run.parts.length) {
      const html = run.parts.map((t) => `<p>${escapeHtml(t)}</p>`).join('');
      sections.push({
        heading: pendingHeading,
        type: 'text',
        html,
        bullets: run.bullets,
        h: estimateHeight(html, { min: 60, bullets: run.bullets }),
      });
      pendingHeading = '';
    }
    run = null;
  };

  for (const b of blocks) {
    if (b.type === 'heading') {
      flushRun();
      // A heading with no following body still gets its own (empty) section so
      // the heading text is not lost.
      if (pendingHeading) {
        sections.push({ heading: pendingHeading, type: 'text', html: '<p></p>', bullets: false, h: 60 });
        pendingHeading = '';
      }
      pendingHeading = b.text;
    } else {
      const bullet = b.type === 'listitem';
      if (!run || run.bullets !== bullet) { flushRun(); run = { bullets: bullet, parts: [] }; }
      run.parts.push(b.text);
    }
  }
  flushRun();
  if (pendingHeading) {
    sections.push({ heading: pendingHeading, type: 'text', html: '<p></p>', bullets: false, h: 60 });
  }

  if (sections.length === 0) {
    sections.push({ heading: '', type: 'text', html: '<p></p>', h: 60 });
  }

  return { hero, sections };
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

// Load a tenant-scoped seed page and derive a theme + typography from its
// canvas_design so the generated page reproduces that page's brand look. Returns
// null (→ neutral behaviour) when no id is given or the page can't be used.
async function resolveSeedStyle(tenantId, seedPageId) {
  const id = toStr(seedPageId).trim();
  if (!id) return null;
  const { data, error } = await supabase
    .from('i_edit_page')
    .select('id, builder_type, canvas_design')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  if (data.builder_type !== 'canvas' || !data.canvas_design || typeof data.canvas_design !== 'object') return null;
  try {
    return extractThemeFromDesign(data.canvas_design);
  } catch (err) {
    console.error('[canvas-from-doc] seed extraction failed:', err?.message || err);
    return null;
  }
}

// Build a design from a sanitized spec, styling it off a seed page when one was
// supplied (else tenant-neutral). Shared by the preview and legacy paths so the
// preview matches what a subsequent confirm persists.
function buildDesignForSpec(spec, seedStyle) {
  if (seedStyle) return buildDesign({ ...spec, theme: seedStyle.theme, typo: seedStyle.typo });
  return buildNeutralDesign(spec);
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
    // Build a structured, verbatim representation of the source. This is the
    // single source of truth for all page copy and drives both the fidelity
    // check and the deterministic fallback.
    let structure;
    let filename = '';
    if (buffer) {
      structure = await extractDocxStructure(buffer);
      if (!structure.length) {
        return res.status(400).json({ error: 'No readable text found in the document.' });
      }
      filename = toStr(body.filename).replace(/\.docx$/i, '').replace(/[-_]+/g, ' ').trim();
    } else {
      structure = structureFromText(pastedText);
      if (!structure.length) {
        return res.status(400).json({ error: 'No readable text found in the pasted content.' });
      }
    }
    const docText = structureToText(structure);
    const fallbackTitle = toStr(body.title).trim() || filename || 'Untitled page';

    // Best-effort: let the model organise the text into a richer layout, but
    // only accept it when it is verifiably faithful (no invented or dropped
    // wording). Otherwise fall back to a deterministic 1:1 layout that is
    // faithful by construction. The model is skipped for documents too long to
    // process in one request, so their full text is never silently truncated.
    let spec;
    let faithfulLayout = 'plain';
    // Style reference (Task #2873): layout-only hint. Only the analysed
    // Design DNA is used here (no screenshots — this endpoint's model call
    // must stay text-only and verbatim-gated).
    const styleDna = normalizeDesignDna(body.styleReference?.designDna);
    if (docText.length <= MAX_DOC_CHARS) {
      try {
        const rawSpec = await generateSpec(client, docText, fallbackTitle, styleDna);
        const candidate = sanitizeSpec(rawSpec, fallbackTitle);
        if (isSpecFaithful(candidate, docText)) {
          spec = candidate;
          faithfulLayout = 'ai';
        }
      } catch (err) {
        // Non-fatal: fall back to the deterministic layout below.
        console.error('[canvas-from-doc] AI layout failed, using deterministic layout:', err?.message || err);
      }
    }
    if (!spec) {
      spec = buildDeterministicSpec(structure, fallbackTitle);
    }

    const seedStyle = await resolveSeedStyle(context.tenantId, body.seedPageId);
    const design = buildDesignForSpec(spec, seedStyle);

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
        layout: faithfulLayout,
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
    return res.status(201).json({ page: inserted, blockCount, layout: faithfulLayout });
  } catch (err) {
    const status = err?.httpStatus || 500;
    if (status >= 500) console.error('[canvas-from-doc] error:', err?.message || err);
    return res.status(status).json({ error: err?.message || 'Failed to create page from document' });
  }
}
