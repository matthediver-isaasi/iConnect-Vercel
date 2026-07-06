// Task #2363: Member AI Knowledge Assistant endpoint.
//
// Answers a member's natural-language question grounded ONLY in the tenant
// content the asking member is allowed to see: resources, events (event +
// complex_event), news_post, and blog_post. The retrieval filter IS the
// security boundary — every candidate chunk is re-checked against the member's
// RBAC + group/role visibility (see memberContentVisibility.js) before it can
// reach the model, and the vector search itself is hard-scoped to the tenant.
//
// Flow: authenticate -> resolve member RBAC + groups -> embed question ->
// tenant-scoped vector search -> drop inaccessible/low-similarity chunks ->
// ground gpt-4o-mini on what's left -> return answer + deduped citations.
// Multi-turn: prior turns are passed to the model for context; retrieval is
// driven by the latest question.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  resolveMemberExclusions,
  makeFeatureAccessChecker,
} from '../_lib/memberFeatureAccess.js';
import { isChunkVisibleToMember } from '../_lib/memberContentVisibility.js';

const rateLimits = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const CANDIDATE_COUNT = 40; // vector neighbours to fetch before access filtering
const CONTEXT_CHUNKS = 8; // accessible chunks to ground the answer on
const MIN_SIMILARITY = 0.15; // cosine similarity floor for a chunk to count
const MAX_QUESTION_LEN = 1000;
const MAX_HISTORY_TURNS = 6;

const CONTENT_TYPE_LABEL = {
  resource: 'Resource',
  event: 'Event',
  complex_event: 'Event',
  news_post: 'News',
  blog_post: 'Article',
};

const FALLBACK_ANSWER =
  "I couldn't find anything about that in the content available to you. Try rephrasing your question, or browse the portal directly.";

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

// Resolve the member's active group ids (regardless of admin flag). Mirrors
// getCallerGroupMembershipIds but works off an already-resolved member id.
async function resolveMemberGroupIds(memberId, tenantId) {
  if (!memberId || !tenantId) return new Set();
  const nowIso = new Date().toISOString();
  const { data: assignments } = await supabase
    .from('member_group_assignment')
    .select('group_id, expires_at')
    .eq('member_id', memberId);
  const liveIds = (assignments || [])
    .filter((a) => a.group_id && (!a.expires_at || new Date(a.expires_at).toISOString() > nowIso))
    .map((a) => a.group_id);
  if (liveIds.length === 0) return new Set();
  const { data: groupRows } = await supabase
    .from('member_group')
    .select('id, is_active, tenant_id')
    .eq('tenant_id', tenantId)
    .in('id', [...new Set(liveIds)]);
  return new Set((groupRows || []).filter((g) => g.is_active !== false).map((g) => g.id));
}

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_LEN) }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  // In-memory per-IP rate limit (mirrors help/ask).
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
    // --- Authenticate + resolve the asker's tenant, RBAC, and groups ---
    const ctx = await getTenantContext(req);
    if (!ctx || !ctx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!ctx.tenantId) {
      return res.status(400).json({ error: 'Tenant context required' });
    }

    let exclusions = [];
    let roleId = null;
    let groupIds = new Set();
    let isAdmin = false;

    const member = await getSessionMember(req);
    if (member) {
      roleId = member.role_id || null;
      exclusions = await resolveMemberExclusions(
        {
          roleId: member.role_id,
          memberExcludedFeatures: member.member_excluded_features,
        },
        supabase
      );
      groupIds = await resolveMemberGroupIds(member.id, ctx.tenantId);
    } else {
      // Authenticated non-member (tenant/admin user): full tenant access.
      isAdmin = true;
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
    const history = sanitizeHistory(req.body?.history);

    const openai = getOpenAIClient();
    if (!openai) {
      return res
        .status(503)
        .json({ error: 'AI answers are not available right now.' });
    }

    // --- Embed the question + tenant-scoped vector search ---
    const embResp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: question,
    });
    const queryEmbedding = embResp.data[0].embedding;

    const { data: matches, error: matchErr } = await supabase.rpc(
      'match_member_content_chunks',
      {
        query_embedding: queryEmbedding,
        p_tenant_id: ctx.tenantId,
        match_count: CANDIDATE_COUNT,
      }
    );
    if (matchErr) throw matchErr;

    // --- Security boundary: keep only accessible, relevant chunks ---
    const visibilityCtx = {
      isAdmin,
      roleId,
      groupIds,
      canAccessFeature: (key) => access.canAccessFeature(key),
      tenantId: ctx.tenantId,
      now: new Date(),
    };

    const accessible = (matches || [])
      .filter((m) => (m.similarity ?? 0) >= MIN_SIMILARITY)
      .filter((m) => isChunkVisibleToMember(m, visibilityCtx))
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
    const seen = new Set();
    for (const m of accessible) {
      const key = `${m.content_type}:${m.source_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        sources.push({
          title: m.title,
          type: m.content_type,
          typeLabel: CONTENT_TYPE_LABEL[m.content_type] || 'Item',
          link: m.link,
        });
      }
    }

    // --- Ground the chat model on the accessible context only ---
    const context = accessible
      .map((m, i) => {
        const label = CONTENT_TYPE_LABEL[m.content_type] || 'Item';
        return `[${i + 1}] ${label}: "${m.title}"\n${m.content}`;
      })
      .join('\n\n---\n\n');

    const systemPrompt =
      'You are a helpful assistant for a membership organisation\'s member portal. ' +
      'Answer the member\'s question using ONLY the provided excerpts, which come ' +
      'from the resources, events, news, and articles available to this member. ' +
      'If the excerpts do not contain enough information to answer, say you don\'t ' +
      'have that information and suggest they browse the portal or contact their ' +
      'administrator. Be concise, friendly, and practical. Do not invent events, ' +
      'resources, dates, or details that are not in the excerpts. Do not mention ' +
      'the words "excerpt" or "context" or reference excerpt numbers in your answer.';

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      {
        role: 'user',
        content: `Portal content excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}`,
      },
    ];

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 600,
      messages,
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() || FALLBACK_ANSWER;

    return res.status(200).json({ answer, sources, grounded: true });
  } catch (error) {
    console.error('[Member AI Ask] Error:', error);
    return res
      .status(500)
      .json({ error: 'Something went wrong answering your question.' });
  }
}
