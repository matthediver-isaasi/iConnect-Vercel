// Task #2281 — platform-owner endpoint that drafts a Help Center article for a
// given app page/feature using an LLM, saves it to help_article (idempotent by a
// deterministic slug derived from the feature key), then rebuilds that article's
// AI search index chunks so the new content is immediately answerable.
//
// Content generation and embeddings both need an OpenAI key
// (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY) that only exists in the
// Vercel/CI environment — fail loudly with a clear message if it is missing.
//
// Gated by platform-owner session RBAC (same as the rest of api/platform/*).

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getSessionPlatformOwner } from '../_lib/platformSession.js';
import {
  reindexArticle,
  getDefaultOpenAIClient,
} from '../_lib/helpArticleIndexer.js';

const GENERATION_MODEL = 'gpt-4o-mini';

function slugFromFeatureKey(featureKey) {
  return String(featureKey || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function buildPrompt({ moduleLabel, pageLabel, featureKey, pageFeatures, instructions }) {
  const featureLines = (pageFeatures || [])
    .filter((f) => f && f.id && f.label)
    .map((f) => `- ${f.id} — ${f.label}`)
    .join('\n');

  const system = `You are a professional technical writer producing member-facing help documentation for a membership-management web portal. You write clear, friendly, task-focused guidance for non-technical members.

The article body uses a light markdown + placeholder DSL that the portal renders:
- Headings: lines starting with "# ", "## " or "### ".
- Screenshots: a line like "{{screenshot: A short caption}}" renders a placeholder image box (no real image URL — just the caption). Use these sparingly where a screenshot would genuinely help.
- Feature gating: wrap a section that is only relevant to members with a specific sub-feature in "{{feature: SUB_FEATURE_KEY}}" and "{{/feature}}", each on their own line. Members without that access will not see the wrapped section (heading and all). Only use sub-feature keys from the list provided — never invent keys.

Rules:
- Write in plain British English, second person ("you").
- Do NOT include the top-level article title as a heading inside the body (the title is stored separately). Start the body with a short intro sentence, then use "##" section headings.
- Keep it practical: how to find the page, what members can do there, step-by-step where useful.
- Do NOT fabricate features that were not described. Base the content on the page and sub-features provided.
- Gate any section that clearly maps to one of the listed sub-features with the matching {{feature: KEY}} ... {{/feature}} markers.
- If the author provided extra instructions, follow them closely while still obeying every rule above.

Respond with a single valid JSON object with exactly these string keys:
- "title": a concise, member-friendly article title.
- "summary": one sentence (max ~140 chars) describing what the article covers.
- "category": a short category label for grouping (e.g. the module name).
- "body": the full article body using the DSL above.
- "explanation": one or two short plain-language sentences for the platform owner (NOT the member) describing what this article covers and, if the author gave instructions, how you addressed them. This is a summary of your plan, not part of the article.`;

  const instructionBlock = instructions
    ? `\nAuthor instructions (follow these closely):\n${instructions}\n`
    : '';

  const user = `Write a help article for this portal page.

Module: ${moduleLabel || '(unknown)'}
Page: ${pageLabel || '(unknown)'}
Page feature key (article is gated to members with this access): ${featureKey}

Sub-features available on this page (use these exact keys for {{feature:}} gating where relevant):
${featureLines || '(none — this page has no separately gated sub-features)'}
${instructionBlock}
Produce the JSON object now.`;

  return { system, user };
}

// Generate a draft article (title, summary, category, body, explanation) from
// an LLM. Never writes to the database. Throws on hard failure; returns a
// structured object on success.
async function generateDraft(openai, promptArgs) {
  const { system, user } = buildPrompt(promptArgs);

  const completion = await openai.chat.completions.create({
    model: GENERATION_MODEL,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[Platform Help Generate] Failed to parse LLM JSON:', raw?.slice(0, 500));
    const err = new Error('The content generator returned an unexpected response. Please try again.');
    err.statusCode = 502;
    throw err;
  }

  const title = String(parsed.title || promptArgs.pageLabel || 'Untitled').trim();
  const summary = parsed.summary ? String(parsed.summary).trim() : null;
  const category = parsed.category
    ? String(parsed.category).trim()
    : (promptArgs.moduleLabel || null);
  const body = String(parsed.body || '').trim();
  const explanation = parsed.explanation ? String(parsed.explanation).trim() : null;

  if (!title || !body) {
    const err = new Error('The content generator returned incomplete content. Please try again.');
    err.statusCode = 502;
    throw err;
  }

  return { title, summary, category, body, explanation };
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(403).json({ error: 'Platform owner access required' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const featureKey = typeof body.featureKey === 'string' ? body.featureKey.trim() : '';
  const moduleLabel = typeof body.moduleLabel === 'string' ? body.moduleLabel.trim() : '';
  const pageLabel = typeof body.pageLabel === 'string' ? body.pageLabel.trim() : '';
  const pageFeatures = Array.isArray(body.pageFeatures) ? body.pageFeatures : [];
  // Free-text steer for the AI; remembered per-page on commit.
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  // 'preview' generates and returns a draft WITHOUT saving. Any other value
  // (or none — preserves the original one-click behaviour) saves + reindexes.
  const mode = body.mode === 'preview' ? 'preview' : 'commit';
  // On commit the client may pass back the exact draft the owner reviewed so we
  // save precisely what was previewed rather than re-generating different text.
  const providedDraft =
    body.draft && typeof body.draft === 'object' ? body.draft : null;

  if (!featureKey) {
    return res.status(400).json({ error: 'featureKey is required' });
  }

  const slug = slugFromFeatureKey(featureKey);
  if (!slug) {
    return res.status(400).json({ error: 'A valid slug could not be derived from featureKey' });
  }

  // Generation + embeddings both require an OpenAI key. Fail loudly rather than
  // silently producing nothing (mirrors the reindex endpoint's behaviour).
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      '[Platform Help Generate] No OpenAI API key configured ' +
        '(AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY)'
    );
    return res.status(500).json({
      ok: false,
      error:
        'No OpenAI API key is configured, so help content cannot be generated. ' +
        'Add AI_INTEGRATIONS_OPENAI_API_KEY (or OPENAI_API_KEY) in the deployment environment and try again.',
    });
  }
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const openai = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });

  try {
    // Whether an article already exists for this slug (drives "create vs update"
    // wording in the review UI and idempotent upsert on commit).
    const { data: existing, error: findErr } = await supabase
      .from('help_article')
      .select('id, sort_order, title')
      .eq('slug', slug)
      .maybeSingle();
    if (findErr) throw findErr;

    // ── Preview mode: generate a draft and return it WITHOUT writing. ────────
    if (mode === 'preview') {
      const draft = await generateDraft(openai, {
        moduleLabel,
        pageLabel,
        featureKey,
        pageFeatures,
        instructions,
      });

      return res.status(200).json({
        ok: true,
        mode: 'preview',
        slug,
        exists: !!existing,
        existingTitle: existing?.title || null,
        explanation: draft.explanation,
        draft: {
          title: draft.title,
          summary: draft.summary,
          category: draft.category,
          body: draft.body,
        },
      });
    }

    // ── Commit mode: save + reindex. ─────────────────────────────────────────
    // Prefer the reviewed draft the client passes back so we persist exactly
    // what the owner saw; fall back to generating (preserves one-click use).
    let title;
    let summary;
    let category;
    let articleBody;

    if (providedDraft && String(providedDraft.body || '').trim()) {
      title = String(providedDraft.title || pageLabel || 'Untitled').trim();
      summary = providedDraft.summary ? String(providedDraft.summary).trim() : null;
      category = providedDraft.category
        ? String(providedDraft.category).trim()
        : (moduleLabel || null);
      articleBody = String(providedDraft.body || '').trim();
      if (!title || !articleBody) {
        return res.status(400).json({
          ok: false,
          error: 'The draft to save is incomplete (missing title or body).',
        });
      }
    } else {
      const draft = await generateDraft(openai, {
        moduleLabel,
        pageLabel,
        featureKey,
        pageFeatures,
        instructions,
      });
      title = draft.title;
      summary = draft.summary;
      category = draft.category;
      articleBody = draft.body;
    }

    // Remember the instructions used (null when blank) so a later rebuild
    // pre-fills them.
    const generationInstructions = instructions || null;

    const nowIso = new Date().toISOString();
    let article;

    if (existing) {
      const { data, error } = await supabase
        .from('help_article')
        .update({
          title,
          summary,
          category,
          body: articleBody,
          required_feature: featureKey,
          generation_instructions: generationInstructions,
          status: 'published',
          updated_at: nowIso,
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      article = data;
    } else {
      const { data, error } = await supabase
        .from('help_article')
        .insert({
          slug,
          title,
          summary,
          category,
          body: articleBody,
          required_feature: featureKey,
          generation_instructions: generationInstructions,
          status: 'published',
        })
        .select()
        .single();
      if (error) throw error;
      article = data;
    }

    // Rebuild this article's AI search chunks. We already verified a key above,
    // so embedding new/changed chunks will work. Surface (but don't fail on)
    // a re-index error so the owner knows the article saved yet search is stale.
    let indexSummary = null;
    let indexError = null;
    try {
      const indexer = getDefaultOpenAIClient() || openai;
      indexSummary = await reindexArticle(article, { supabase, openai: indexer });
    } catch (err) {
      indexError = err?.message || String(err);
      console.error('[Platform Help Generate] Re-index failed:', indexError);
    }

    return res.status(200).json({
      ok: true,
      mode: 'commit',
      article,
      indexSummary,
      indexError,
    });
  } catch (err) {
    console.error('[Platform Help Generate] fatal:', err);
    const status = err?.statusCode || 500;
    return res.status(status).json({ ok: false, error: err.message });
  }
}
