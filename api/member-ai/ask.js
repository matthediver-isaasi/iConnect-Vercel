// Task #2363: Member AI Knowledge Assistant endpoint.
//
// Answers a member's natural-language question grounded ONLY in the tenant
// content the asking member is allowed to see: resources, events (event +
// complex_event), news_post, and blog_post. The retrieval filter IS the
// security boundary — every candidate chunk is re-checked against the member's
// RBAC + group/role visibility (see memberContentVisibility.js) before it can
// reach the model, and the vector search itself is hard-scoped to the tenant.
//
// Flow: authenticate -> resolve member RBAC + groups -> (optionally expand the
// question into 2-3 retrieval queries) -> embed -> tenant-scoped vector search
// per query -> merge/dedupe -> drop inaccessible/low-similarity chunks ->
// (recency-aware re-rank AFTER the visibility filter) -> ground gpt-4o-mini on
// what's left -> return answer + deduped citations.
// Multi-turn: prior turns are passed to the model for context; retrieval is
// driven by the latest question.
//
// Task #2402: broad/synthesis/recency questions ("latest developments in X")
// now get multi-query retrieval, dated excerpts, a bigger deduped context
// budget, a synthesis-friendly prompt, and structured fallback logging. The
// security boundary is unchanged: every candidate still passes through
// isChunkVisibleToMember before it can reach the model, and recency re-ranking
// happens strictly AFTER that filter.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  resolveMemberExclusions,
  makeFeatureAccessChecker,
} from '../_lib/memberFeatureAccess.js';
import { isChunkVisibleToMember } from '../_lib/memberContentVisibility.js';
import {
  isRecencyQuestion,
  recencyScore,
  formatChunkDate,
  mergeCandidates,
  rerankByRecency,
  selectContextChunks,
} from '../_lib/memberAiRanking.js';
import {
  looksLikeStructuredQuestion,
  buildPlannerMessages,
  fetchStructuredPrefFields,
  validateQuerySpec,
  executeQuerySpec,
  templateStructuredAnswer,
} from '../_lib/memberAiStructured.js';

// Re-export the pure ranking helpers for backwards compatibility (tests and
// any other importers use api/_lib/memberAiRanking.js as the source of truth).
export { isRecencyQuestion, recencyScore, formatChunkDate };

const rateLimits = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const CANDIDATE_COUNT = 40; // vector neighbours to fetch PER QUERY before access filtering
const CONTEXT_CHUNKS = 16; // accessible chunks to ground the answer on
const MAX_CHUNKS_PER_SOURCE = 3; // dedupe so one source can't crowd out the rest
const MIN_SIMILARITY = 0.15; // cosine similarity floor for a chunk to count
const MAX_QUESTION_LEN = 1000;
const MAX_HISTORY_TURNS = 6;
const MIN_WORDS_FOR_EXPANSION = 5; // skip multi-query expansion for short factual questions
const MAX_EXPANDED_QUERIES = 3;
// Recency blend weights/decay live in api/_lib/memberAiRanking.js
// (RECENCY_WEIGHT / RECENCY_HALF_LIFE_DAYS) alongside the pure helpers.

const CONTENT_TYPE_LABEL = {
  resource: 'Resource',
  event: 'Event',
  complex_event: 'Event',
  news_post: 'News',
  blog_post: 'Article',
};

const FALLBACK_ANSWER =
  "I couldn't find anything about that in the content available to you. Try rephrasing your question, or browse the portal directly.";

// Task #2419: graceful reply when a count/breakdown question can't be mapped
// to a safe whitelisted query — we say so plainly instead of guessing.
const STRUCTURED_UNMAPPABLE_ANSWER =
  "I can't answer that from the data I have access to — I can count things like organisations, members, events, resources, and bookings using the fields available in your portal, but that question uses something I can't query safely. Try rephrasing it with a field shown in the portal.";

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

// Cheap LLM pass: rewrite a broad question into up to 3 short alternative
// retrieval queries. Best-effort — any failure falls back to just the original
// question so expansion can never break answering.
async function expandRetrievalQueries(openai, question) {
  try {
    const resp = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.3,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You expand a member-portal search question into 2-3 short alternative ' +
            'search queries that would surface related content: synonyms, related ' +
            'topics, and broader or narrower phrasings. Example: "latest developments ' +
            'in graduate hiring" -> "graduate recruitment trends", "employer ' +
            'engagement", "labour market". Respond with JSON exactly like ' +
            '{"queries": ["...", "..."]}. Do not repeat the original question.',
        },
        { role: 'user', content: question },
      ],
    });
    const parsed = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
    const list = Array.isArray(parsed.queries) ? parsed.queries : [];
    return list
      .filter((q) => typeof q === 'string' && q.trim().length >= 3)
      .slice(0, MAX_EXPANDED_QUERIES)
      .map((q) => q.trim().slice(0, MAX_QUESTION_LEN));
  } catch (err) {
    console.warn('[Member AI Ask] query expansion failed:', err?.message || err);
    return [];
  }
}

// Task #2419: run the structured-data planner. Returns null when the planner
// says the question is a content question (fall back to RAG); otherwise
// { spec } (may be null when structured-but-unmappable). Best-effort: any
// LLM/parse failure returns null so structured routing can never break RAG.
async function planStructuredQuery(openai, question, prefFields) {
  try {
    const resp = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: buildPlannerMessages(question, prefFields),
    });
    const parsed = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
    if (parsed?.structured !== true) return null;
    return { spec: parsed.spec && typeof parsed.spec === 'object' ? parsed.spec : null };
  } catch (err) {
    console.warn('[Member AI Ask] structured planner failed:', err?.message || err);
    return null;
  }
}

// Deterministic phrasing fallback if the synthesis LLM call fails — the
// numbers always come straight from the executor, never the model. Lives in
// api/_lib/memberAiStructured.js (templateStructuredAnswer) so it can handle
// count and sum/avg/min/max result shapes and be unit tested.

// Phrase executor results as a concise natural-language answer. The model is
// strictly instructed to only state numbers present in the results.
async function synthesizeStructuredAnswer(openai, question, result) {
  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content:
            'You phrase database query results as a short, friendly answer for a ' +
            'member portal. STRICT RULES: only state numbers that appear in the ' +
            'results JSON — never compute, estimate, or invent any number. For ' +
            'breakdowns, present a short markdown list (largest first). Mention ' +
            'the filters that were applied so the member knows what was counted. ' +
            'Do not mention JSON, queries, or databases.',
        },
        {
          role: 'user',
          content: `Question: ${question}\n\nResults JSON:\n${JSON.stringify(result)}`,
        },
      ],
    });
    return completion.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn('[Member AI Ask] structured synthesis failed:', err?.message || err);
    return null;
  }
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

    // --- Task #2419: structured-data routing (counts/breakdowns from the DB)
    // Cheap regex pre-gate, then an LLM planner fills a constrained whitelisted
    // query spec (never SQL). Executed with the member's visibility baked in.
    // Content questions — and any planner failure — fall through to RAG.
    if (looksLikeStructuredQuestion(question)) {
      const prefFields = await fetchStructuredPrefFields(supabase, ctx.tenantId);
      const plan = await planStructuredQuery(openai, question, prefFields);
      if (plan) {
        const validated = plan.spec
          ? validateQuerySpec(plan.spec, { prefFields })
          : { ok: false, reason: 'Planner could not map the question' };
        if (validated.ok) {
          const viewer = {
            isAdmin,
            roleId,
            groupIds,
            canAccessFeature: (key) => access.canAccessFeature(key),
          };
          const exec = await executeQuerySpec({
            supabase,
            tenantId: ctx.tenantId,
            spec: validated.spec,
            viewer,
          });
          if (exec.ok) {
            const answer =
              (await synthesizeStructuredAnswer(openai, question, exec.result)) ||
              templateStructuredAnswer(exec.result);
            return res
              .status(200)
              .json({ answer, sources: [], grounded: true, structured: true });
          }
          console.warn(
            '[Member AI Ask] structured execution refused: ' +
              JSON.stringify({
                tenantId: ctx.tenantId,
                entity: validated.spec.entity,
                reason: exec.reason,
              })
          );
          return res.status(200).json({
            answer: STRUCTURED_UNMAPPABLE_ANSWER,
            sources: [],
            grounded: false,
            structured: true,
          });
        }
        // The planner was confident this is a data question but the spec is
        // outside the whitelist — say so plainly rather than guessing a number.
        console.warn(
          '[Member AI Ask] structured spec rejected: ' +
            JSON.stringify({ tenantId: ctx.tenantId, reason: validated.reason })
        );
        return res.status(200).json({
          answer: STRUCTURED_UNMAPPABLE_ANSWER,
          sources: [],
          grounded: false,
          structured: true,
        });
      }
    }

    // --- Multi-query retrieval: expand broad questions into extra queries ---
    const wordCount = question.split(/\s+/).filter(Boolean).length;
    let queries = [question];
    if (wordCount >= MIN_WORDS_FOR_EXPANSION) {
      const extras = await expandRetrievalQueries(openai, question);
      const seen = new Set([question.toLowerCase()]);
      for (const q of extras) {
        const k = q.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          queries.push(q);
        }
      }
    }

    // --- Embed all queries in one call + tenant-scoped vector search each ---
    const embResp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: queries,
    });

    const matchResults = await Promise.all(
      embResp.data.map((d) =>
        supabase.rpc('match_member_content_chunks', {
          query_embedding: d.embedding,
          p_tenant_id: ctx.tenantId,
          match_count: CANDIDATE_COUNT,
        })
      )
    );

    // Merge/dedupe candidates across queries, keeping each chunk's best
    // similarity. This all happens BEFORE the visibility filter.
    for (const r of matchResults) {
      if (r.error) throw r.error;
    }
    const candidates = mergeCandidates(matchResults.map((r) => r.data));

    // --- Security boundary: keep only accessible, relevant chunks ---
    const now = new Date();
    const visibilityCtx = {
      isAdmin,
      roleId,
      groupIds,
      canAccessFeature: (key) => access.canAccessFeature(key),
      tenantId: ctx.tenantId,
      now,
    };

    const aboveFloor = candidates.filter(
      (m) => (m.similarity ?? 0) >= MIN_SIMILARITY
    );
    const visible = aboveFloor.filter((m) =>
      isChunkVisibleToMember(m, visibilityCtx)
    );

    if (!visible.length) {
      // Structured fallback instrumentation: make future stock answers
      // diagnosable from production logs. No change to what the user sees.
      const topSims = candidates
        .slice(0, 10)
        .map((m) => Number((m.similarity ?? 0).toFixed(3)));
      console.warn(
        '[Member AI Ask] fallback (no accessible chunks): ' +
          JSON.stringify({
            tenantId: ctx.tenantId,
            mode: isAdmin ? 'admin' : 'member',
            questionLength: question.length,
            queryCount: queries.length,
            candidates: candidates.length,
            droppedBySimilarityFloor: candidates.length - aboveFloor.length,
            droppedByVisibility: aboveFloor.length - visible.length,
            similarityFloor: MIN_SIMILARITY,
            topSimilarities: topSims,
          })
      );
      return res.status(200).json({
        answer: FALLBACK_ANSWER,
        sources: [],
        grounded: false,
      });
    }

    // --- Recency-aware re-rank (strictly AFTER the visibility filter) ---
    const recency = isRecencyQuestion(question);
    const ranked = rerankByRecency(visible, { recency, now });

    // --- Select context chunks with a per-source cap so one source can't
    // crowd out the rest; backfill from leftovers if under budget. ---
    const accessible = selectContextChunks(ranked, {
      contextChunks: CONTEXT_CHUNKS,
      maxPerSource: MAX_CHUNKS_PER_SOURCE,
    });

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
    // Each excerpt carries its published/event date so the model can frame
    // "latest"/"recent" answers against real dates.
    const context = accessible
      .map((m, i) => {
        const label = CONTENT_TYPE_LABEL[m.content_type] || 'Item';
        return `[${i + 1}] ${label}: "${m.title}"${formatChunkDate(m)}\n${m.content}`;
      })
      .join('\n\n---\n\n');

    const todayStr = now.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    const systemPrompt =
      'You are a helpful assistant for a membership organisation\'s member portal. ' +
      `Today's date is ${todayStr}. ` +
      'Answer the member\'s question using ONLY the provided excerpts, which come ' +
      'from the resources, events, news, and articles available to this member. ' +
      'For broad questions (e.g. "latest developments", "trends", "what\'s new"), ' +
      'you SHOULD synthesise: pull together themes from several excerpts into one ' +
      'coherent answer rather than treating each excerpt in isolation. Each excerpt ' +
      'may include its published or event date — use those dates to identify and ' +
      'mention what is most recent, and refer to specific items with their dates ' +
      'where helpful. Do not invent events, resources, dates, or details that are ' +
      'not in the excerpts. Only say you don\'t have that information (and suggest ' +
      'browsing the portal or contacting their administrator) when the excerpts are ' +
      'genuinely unrelated to the question — if the excerpts are relevant but ' +
      'partial, answer with what they do cover and say what is covered. Be ' +
      'friendly and practical. Do not mention the words "excerpt" or "context" or ' +
      'reference excerpt numbers in your answer.';

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
      max_tokens: 800,
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
