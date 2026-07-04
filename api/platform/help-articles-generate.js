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

function buildPrompt({ moduleLabel, pageLabel, featureKey, pageFeatures }) {
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

Respond with a single valid JSON object with exactly these string keys:
- "title": a concise, member-friendly article title.
- "summary": one sentence (max ~140 chars) describing what the article covers.
- "category": a short category label for grouping (e.g. the module name).
- "body": the full article body using the DSL above.`;

  const user = `Write a help article for this portal page.

Module: ${moduleLabel || '(unknown)'}
Page: ${pageLabel || '(unknown)'}
Page feature key (article is gated to members with this access): ${featureKey}

Sub-features available on this page (use these exact keys for {{feature:}} gating where relevant):
${featureLines || '(none — this page has no separately gated sub-features)'}

Produce the JSON object now.`;

  return { system, user };
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
    const { system, user } = buildPrompt({
      moduleLabel,
      pageLabel,
      featureKey,
      pageFeatures,
    });

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
    let draft;
    try {
      draft = JSON.parse(raw);
    } catch {
      console.error('[Platform Help Generate] Failed to parse LLM JSON:', raw?.slice(0, 500));
      return res.status(502).json({
        ok: false,
        error: 'The content generator returned an unexpected response. Please try again.',
      });
    }

    const title = String(draft.title || pageLabel || 'Untitled').trim();
    const summary = draft.summary ? String(draft.summary).trim() : null;
    const category = draft.category
      ? String(draft.category).trim()
      : (moduleLabel || null);
    const articleBody = String(draft.body || '').trim();

    if (!title || !articleBody) {
      return res.status(502).json({
        ok: false,
        error: 'The content generator returned incomplete content. Please try again.',
      });
    }

    // Upsert idempotently by the deterministic slug so re-running "Update
    // content" refreshes the same row instead of piling up duplicates.
    const { data: existing, error: findErr } = await supabase
      .from('help_article')
      .select('id, sort_order')
      .eq('slug', slug)
      .maybeSingle();
    if (findErr) throw findErr;

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
      article,
      indexSummary,
      indexError,
    });
  } catch (err) {
    console.error('[Platform Help Generate] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
