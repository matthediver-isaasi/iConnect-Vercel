// Task #2257: Help Center AI Q&A endpoint.
//
// Answers a natural-language question grounded ONLY in help articles the asking
// user is allowed to see. The retrieval filter IS the security boundary:
// candidate chunks are filtered server-side by the SAME rules that gate help
// content — article-level (help_article.required_feature) AND section-level
// ({{feature: key}} blocks, captured per-chunk as feature_gates at index time).
//
// Flow: authenticate -> resolve member exclusions -> embed question ->
// vector search -> drop inaccessible/low-similarity chunks -> ground the chat
// model on what's left -> return an answer + deduped citations.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  resolveMemberExclusions,
  makeFeatureAccessChecker,
} from '../_lib/memberFeatureAccess.js';

const rateLimits = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const CANDIDATE_COUNT = 30; // vector neighbours to fetch before access filtering
const CONTEXT_CHUNKS = 8; // accessible chunks to ground the answer on
const MIN_SIMILARITY = 0.15; // cosine similarity floor for a chunk to count
const MAX_QUESTION_LEN = 1000;

const FALLBACK_ANSWER =
  "I couldn't find an answer to that in the Help Center articles available to you. Try rephrasing your question, or browse the articles below.";

let openaiClient = null;
function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  openaiClient = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
  return openaiClient;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  // In-memory per-IP rate limit (mirrors invoke-llm / ai-reports).
  const clientIp =
    req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const rateData = rateLimits.get(clientIp);
  if (rateData) {
    if (now < rateData.resetTime) {
      if (rateData.count >= RATE_LIMIT) {
        return res
          .status(429)
          .json({ error: 'Too many requests. Please try again in a moment.' });
      }
      rateData.count++;
    } else {
      rateLimits.set(clientIp, { count: 1, resetTime: now + RATE_WINDOW });
    }
  } else {
    rateLimits.set(clientIp, { count: 1, resetTime: now + RATE_WINDOW });
  }
  if (rateLimits.size > 1000) {
    for (const [ip, data] of rateLimits.entries()) {
      if (now > data.resetTime) rateLimits.delete(ip);
    }
  }

  try {
    // --- Authenticate + resolve the asker's feature access ---
    // Members carry role + per-member exclusions. Tenant/admin users (no member
    // record) see all help content, matching the article editor preview.
    let exclusions = [];
    const member = await getSessionMember(req);
    if (member) {
      exclusions = await resolveMemberExclusions(
        {
          roleId: member.role_id,
          memberExcludedFeatures: member.member_excluded_features,
        },
        supabase
      );
    } else {
      const ctx = await getTenantContext(req);
      if (!ctx || !ctx.isAuthenticated) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      // Authenticated non-member (tenant/admin user): full access.
    }
    const access = makeFeatureAccessChecker(exclusions);

    // --- Validate the question ---
    const question =
      typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (question.length < 3) {
      return res.status(400).json({ error: 'Please enter a question.' });
    }
    if (question.length > MAX_QUESTION_LEN) {
      return res.status(400).json({ error: 'Question is too long.' });
    }

    const openai = getOpenAIClient();
    if (!openai) {
      return res
        .status(503)
        .json({ error: 'AI answers are not available right now.' });
    }

    // --- Embed the question + vector search ---
    const embResp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: question,
    });
    const queryEmbedding = embResp.data[0].embedding;

    const { data: matches, error: matchErr } = await supabase.rpc(
      'match_help_article_chunks',
      { query_embedding: queryEmbedding, match_count: CANDIDATE_COUNT }
    );
    if (matchErr) throw matchErr;

    // --- Security boundary: keep only accessible, relevant chunks ---
    const accessible = (matches || [])
      .filter((m) => (m.similarity ?? 0) >= MIN_SIMILARITY)
      .filter((m) => access.canAccessAllGates(m.feature_gates))
      .slice(0, CONTEXT_CHUNKS);

    if (!accessible.length) {
      return res.status(200).json({
        answer: FALLBACK_ANSWER,
        sources: [],
        grounded: false,
      });
    }

    // Deduped citations (order preserved, most-relevant first).
    const sources = [];
    const seenSlugs = new Set();
    for (const m of accessible) {
      if (!seenSlugs.has(m.slug)) {
        seenSlugs.add(m.slug);
        sources.push({ title: m.title, slug: m.slug });
      }
    }

    // --- Ground the chat model on the accessible context only ---
    const context = accessible
      .map(
        (m, i) =>
          `[${i + 1}] Article: "${m.title}"\n${m.content}`
      )
      .join('\n\n---\n\n');

    const systemPrompt =
      'You are a helpful assistant for a membership management platform Help Center. ' +
      'Answer the user\'s question using ONLY the provided help article excerpts. ' +
      'If the excerpts do not contain enough information to answer, say you don\'t ' +
      'have that information in the Help Center and suggest they browse the articles ' +
      'or contact their administrator. Be concise and practical. Do not invent ' +
      'features, settings, or steps that are not in the excerpts. Do not mention ' +
      'the word "excerpt" or "context" or reference excerpt numbers in your answer.';

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Help article excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}`,
        },
      ],
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() || FALLBACK_ANSWER;

    return res.status(200).json({ answer, sources, grounded: true });
  } catch (error) {
    console.error('[Help Ask] Error:', error);
    return res
      .status(500)
      .json({ error: 'Something went wrong answering your question.' });
  }
}
