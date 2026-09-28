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
import { getSessionMember, getSessionTenantUser } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { requireTenantAiAssistant } from '../_lib/tenantAiAssistant.js';
import { resolveTenantFromHost, getHostFromRequest } from '../_lib/tenantResolver.js';
import {
  resolveMemberExclusions,
  makeFeatureAccessChecker,
} from '../_lib/memberFeatureAccess.js';
import { isChunkVisibleToMember } from '../_lib/memberContentVisibility.js';
import {
  resolveAccessibleEventIds,
  resolveAccessibleSessionIds,
  resolveMemberContentGroupIds,
  resolvePreRankEligiblePdfChunkIds,
  revalidateMemberContentCandidates,
} from '../_lib/memberContentAccess.js';
import { fetchCategoriesWithAccess, computeHiddenSubcategories } from '../_lib/resourceCategoryAccess.js';
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
import {
  getMemberAiSettings,
  reserveMemberAiUsage,
  reservePublicMemberAiUsage,
  reserveAdminMemberAiUsage,
  memberAiIpHash,
  finishMemberAiUsage,
} from '../_lib/memberAiUsage.js';
import {
  makeCitationSources,
  sourceCitationId,
  validateAnswerCitations,
  makeAnswerProvenance,
  makeStructuredAccessFingerprint,
} from '../_lib/memberAiAnswer.js';

// Re-export the pure ranking helpers for backwards compatibility (tests and
// any other importers use api/_lib/memberAiRanking.js as the source of truth).
export { isRecencyQuestion, recencyScore, formatChunkDate };

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const CANDIDATE_COUNT = 40; // vector neighbours to fetch PER QUERY before access filtering
const CONTEXT_CHUNKS = 16; // accessible chunks to ground the answer on
const MAX_CHUNKS_PER_SOURCE = 3; // dedupe so one source can't crowd out the rest
const MIN_SIMILARITY = 0.15; // cosine similarity floor for a chunk to count
const MAX_QUESTION_LEN = 1000;
const MAX_HISTORY_TURNS = 6;
const REQUEST_DEADLINE_MS = 80_000; // Always below the durable 120-second lease.
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
  canvas_page: 'Portal page',
};
const MEMBER_AI_SOURCE_TYPES = Object.freeze(Object.keys(CONTENT_TYPE_LABEL));

const FALLBACK_ANSWER =
  "I couldn't find anything about that in the content available to you. Try rephrasing your question, or browse the portal directly.";

// Task #2419: graceful reply when a count/breakdown question can't be mapped
// to a safe whitelisted query — we say so plainly instead of guessing.
const STRUCTURED_UNMAPPABLE_ANSWER =
  "I can't answer that from the data I have access to — I can count things like organisations, members, events, resources, and bookings using the fields available in your portal, but that question uses something I can't query safely. Try rephrasing it with a field shown in the portal.";

let openaiClient = null;
function providerDeadlineOptions(deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining < 1_000) throw new Error('Member AI request deadline exceeded');
  return { timeout: Math.min(20_000, remaining) };
}
function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  // Bound all provider operations. The SDK retries once for transient failures;
  // usage reservations are finalized in the request `finally` path rather than
  // being left in-flight through an unbounded provider retry loop.
  openaiClient = new OpenAI({
    apiKey,
    ...(baseURL && { baseURL }),
    timeout: 20_000,
    maxRetries: 1,
  });
  return openaiClient;
}

export function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    // Assistant turns may have been grounded in a source whose permission was
    // later revoked. Client history has no reliable chunk provenance, so do
    // not send old assistant-derived text back to the provider. Retaining prior
    // member questions still gives follow-ups useful conversational continuity
    // without trusting old content.
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_LEN) }));
}

// Cheap LLM pass: rewrite a broad question into up to 3 short alternative
// retrieval queries. Best-effort — any failure falls back to just the original
// question so expansion can never break answering.
async function expandRetrievalQueries(openai, question, onUsage, deadlineAt) {
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
    }, providerDeadlineOptions(deadlineAt));
    onUsage?.(resp);
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
async function planStructuredQuery(openai, question, prefFields, onUsage, deadlineAt) {
  try {
    const resp = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: buildPlannerMessages(question, prefFields),
    }, providerDeadlineOptions(deadlineAt));
    onUsage?.(resp);
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
async function synthesizeStructuredAnswer(openai, question, result, onUsage, deadlineAt) {
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
    }, providerDeadlineOptions(deadlineAt));
    onUsage?.(completion);
    return completion.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn('[Member AI Ask] structured synthesis failed:', err?.message || err);
    return null;
  }
}

async function repairAnswerCitations(openai, answer, sources, onUsage, deadlineAt) {
  const ids = sources.map((source) => source.citationId).join(', ');
  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 800,
      messages: [{
        role: 'system',
        content:
          'Return the supplied answer with factual wording unchanged, but add one or more ' +
          'inline citations in the exact form [S1]. Only use citation IDs from this list: ' +
          `${ids}. Never invent a citation ID or URL. If the answer cannot be supported, return exactly: UNSUPPORTED`,
      }, { role: 'user', content: answer }],
    }, providerDeadlineOptions(deadlineAt));
    onUsage?.(completion);
    const repaired = completion.choices?.[0]?.message?.content?.trim();
    return repaired === 'UNSUPPORTED' ? null : repaired || null;
  } catch (error) {
    console.warn('[Member AI Ask] citation repair failed:', error?.message || error);
    return null;
  }
}

export async function handleMemberAiAsk(req, res, { publicOnly = false } = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  let usageReservationId = null;
  let usageKind = 'member';
  const tokenUsage = { inputTokens: 0, outputTokens: 0, providerRequestId: null };
  const recordProviderUsage = (response) => {
    const usage = response?.usage || {};
    tokenUsage.inputTokens += Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
    tokenUsage.outputTokens += Number(usage.completion_tokens ?? usage.output_tokens) || 0;
    tokenUsage.providerRequestId = response?._request_id || tokenUsage.providerRequestId;
  };
  const finishUsage = async (status) =>
    finishMemberAiUsage({
      supabase, reservationId: usageReservationId, status, usageKind,
      ...(status === 'succeeded' ? tokenUsage : {}),
    });
  try {
    const requestDeadline = Date.now() + REQUEST_DEADLINE_MS;
    // --- Authenticate + resolve the asker's tenant, RBAC, and groups ---
    // Public requests intentionally resolve *only* from the trusted host
    // mapping. They never inspect member/admin cookies or a browser-supplied
    // mode flag, so an authenticated visitor cannot accidentally receive the
    // privileged retrieval path through the public route.
    const publicTenant = publicOnly
      ? await resolveTenantFromHost(getHostFromRequest(req))
      : null;
    const ctx = publicOnly
      ? { tenantId: publicTenant?.id || null, isAuthenticated: false, tenantFromHost: publicTenant }
      : await getTenantContext(req);
    if (ctx?.tenantMismatch) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!ctx?.tenantId) {
      return res.status(400).json({ error: 'Tenant context required' });
    }
    if (!await requireTenantAiAssistant(ctx.tenantId, res)) return;
    const isAnonymous = !ctx.isAuthenticated;
    if (process.env.MEMBER_AI_EMERGENCY_DISABLED === 'true') {
      return res.status(503).json({ error: 'AI answers are not available right now.', code: 'MEMBER_AI_EMERGENCY_DISABLED' });
    }

    let exclusions = [];
    let roleId = null;
    let groupIds = new Set();
    let isAdmin = false;
    let accessibleEventIds = new Set();
    let accessibleSessionIds = new Set();
    let adminActorId = null;
    let structuredAccessFingerprint = null;

    const member = isAnonymous ? null : await getSessionMember(req);
    const answerPayload = (payload) => {
      // A no-answer/fallback has no verifiable source provenance and is not
      // retained as a model-derived history answer. Structured output is
      // explicitly server-signed as a non-corpus result.
      if (!member || (!payload.structured && !(payload.sources || []).length)) return payload;
      return {
        ...payload,
        answerProvenance: makeAnswerProvenance({
          tenantId: ctx.tenantId,
          memberId: member.id,
          answer: payload.answer,
          sources: payload.sources || [],
          answerKind: payload.structured ? 'structured' : 'content',
          structuredAccessFingerprint,
        }),
      };
    };
    if (member) {
      roleId = member.role_id || null;
      exclusions = await resolveMemberExclusions(
        {
          roleId: member.role_id,
          memberExcludedFeatures: member.member_excluded_features,
        },
        supabase
      );
      [groupIds, accessibleEventIds, accessibleSessionIds] = await Promise.all([
        resolveMemberContentGroupIds({
          supabase,
          tenantId: ctx.tenantId,
          memberId: member.id,
        }),
        resolveAccessibleEventIds({
          supabase,
          tenantId: ctx.tenantId,
          member,
        }),
        resolveAccessibleSessionIds({
          supabase,
          tenantId: ctx.tenantId,
          member,
        }),
      ]);
    } else if (!isAnonymous) {
      // An absent member row is NOT evidence of administrator access. Verify
      // the current tenant-user session before allowing the portal preview
      // branch; getSessionTenantUser independently validates active tenant
      // membership and tenant binding.
      const tenantUser = await getSessionTenantUser(req);
      const userTenantId = tenantUser?._sessionTenantId || tenantUser?.tenant_id;
      if (!tenantUser || userTenantId !== ctx.tenantId) {
        return res.status(403).json({
          error: 'A member or verified tenant administrator account is required.',
          code: 'viewer_not_authorized',
        });
      }
      isAdmin = true;
      adminActorId = tenantUser.id || tenantUser.user_id || tenantUser.email || null;
    }
    const access = makeFeatureAccessChecker(exclusions);
    if (member) {
      structuredAccessFingerprint = makeStructuredAccessFingerprint({
        tenantId: ctx.tenantId,
        memberId: member.id,
        roleId: member.role_id,
        groupIds,
        exclusions,
      });
    }

    // Task #2441: RBAC gate — members whose effective exclusions include
    // support.member-ai cannot use the assistant. Admin/non-member sessions
    // are unaffected (isAdmin branch above leaves exclusions empty).
    if (member && !access.canAccessFeature('support.member-ai')) {
      return res.status(403).json({
        error: 'The AI assistant is not available for your account.',
        code: 'feature_excluded',
      });
    }

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
    if (member) {
      const allowance = await reserveMemberAiUsage({
        supabase,
        tenantId: ctx.tenantId,
        memberId: member.id,
        question,
      });
      if (!allowance.allowed) {
        return res.status(allowance.status).json({
          error: allowance.error,
          code: allowance.code,
        });
      }
      usageReservationId = allowance.reservationId;
      usageKind = allowance.usageKind;
    } else if (isAnonymous) {
      const forwarded = req.headers['x-forwarded-for'];
      const clientIp = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0].trim() ||
        req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
      const allowance = await reservePublicMemberAiUsage({
        supabase,
        tenantId: ctx.tenantId,
        ipHash: memberAiIpHash(clientIp),
        question,
      });
      if (!allowance.allowed) {
        return res.status(allowance.status).json({ error: allowance.error, code: allowance.code });
      }
      usageReservationId = allowance.reservationId;
      usageKind = allowance.usageKind;
    } else {
      const allowance = await reserveAdminMemberAiUsage({
        supabase,
        tenantId: ctx.tenantId,
        actorId: adminActorId,
        question,
      });
      if (!allowance.allowed) {
        return res.status(allowance.status).json({
          error: allowance.error,
          code: allowance.code,
        });
      }
      usageReservationId = allowance.reservationId;
      usageKind = allowance.usageKind;
    }

    // This tenant-managed allow-list is supplied to the database matcher,
    // excluding disabled source families before lexical/vector scoring and LIMIT.
    const sourceSettings = await getMemberAiSettings({
      supabase,
      tenantId: ctx.tenantId,
    });
    const allowedContentTypes = Array.isArray(sourceSettings.allowed_content_types)
      ? sourceSettings.allowed_content_types.filter((type) => MEMBER_AI_SOURCE_TYPES.includes(type))
      : MEMBER_AI_SOURCE_TYPES;
    // --- Task #2419: structured-data routing (counts/breakdowns from the DB)
    // Cheap regex pre-gate, then an LLM planner fills a constrained whitelisted
    // query spec (never SQL). Executed with the member's visibility baked in.
    // Content questions — and any planner failure — fall through to RAG.
    if (!isAnonymous && looksLikeStructuredQuestion(question)) {
      const prefFields = await fetchStructuredPrefFields(supabase, ctx.tenantId);
      const plan = await planStructuredQuery(openai, question, prefFields, recordProviderUsage, requestDeadline);
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
              (await synthesizeStructuredAnswer(openai, question, exec.result, recordProviderUsage, requestDeadline)) ||
              templateStructuredAnswer(exec.result);
            await finishUsage('succeeded');
            const response = answerPayload({
              answer,
              sources: [],
              grounded: true,
              structured: true,
            });
            return res
              .status(200)
              .json(response);
          }
          console.warn(
            '[Member AI Ask] structured execution refused: ' +
              JSON.stringify({
                tenantId: ctx.tenantId,
                entity: validated.spec.entity,
                reason: exec.reason,
              })
          );
          await finishUsage('succeeded');
          const response = answerPayload({
            answer: STRUCTURED_UNMAPPABLE_ANSWER,
            sources: [],
            grounded: false,
            structured: true,
          });
          return res.status(200).json(response);
        }
        // The planner was confident this is a data question but the spec is
        // outside the whitelist — say so plainly rather than guessing a number.
        console.warn(
          '[Member AI Ask] structured spec rejected: ' +
            JSON.stringify({ tenantId: ctx.tenantId, reason: validated.reason })
        );
        await finishUsage('succeeded');
        const response = answerPayload({
          answer: STRUCTURED_UNMAPPABLE_ANSWER,
          sources: [],
          grounded: false,
          structured: true,
        });
        return res.status(200).json(response);
      }
    }

    // --- Multi-query retrieval: expand broad questions into extra queries ---
    const wordCount = question.split(/\s+/).filter(Boolean).length;
    let queries = [question];
    if (wordCount >= MIN_WORDS_FOR_EXPANSION) {
      const extras = await expandRetrievalQueries(openai, question, recordProviderUsage, requestDeadline);
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
    if (!allowedContentTypes.length) {
      await finishUsage('failed');
      return res.status(403).json({
        error: 'No content sources are enabled for the AI assistant.',
        code: 'MEMBER_AI_NO_SOURCES',
      });
    }
    const embResp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: queries,
    }, providerDeadlineOptions(requestDeadline));
    recordProviderUsage(embResp);

    // Derive the current access predicates before the vector RPC ranks/limits
    // candidates.  This avoids the unsafe "retrieve every tenant chunk, then
    // filter" shape. Source rows are re-read again below before model context.
    const categories = await fetchCategoriesWithAccess(supabase, ctx.tenantId);
    const hiddenSubcats = computeHiddenSubcategories(categories, {
      roleId,
      isPrivileged: isAdmin,
    });
    const preRankVisibilityCtx = {
      isAdmin,
      isAuthenticated: !isAnonymous,
      roleId,
      groupIds,
      member,
      canAccessFeature: (key) => access.canAccessFeature(key),
      tenantId: ctx.tenantId,
      now: new Date(),
    };
    // File/folder/gallery eligibility is resolved from current source rows
    // before vector ranking. The RPC treats this list as an allow-list only
    // for derived PDF chunks; lookup failure therefore fails those chunks
    // closed without suppressing unrelated, ordinary content.
    let eligiblePdfChunkIds;
    try {
      eligiblePdfChunkIds = await resolvePreRankEligiblePdfChunkIds({
        supabase,
        tenantId: ctx.tenantId,
        visibilityCtx: preRankVisibilityCtx,
      });
    } catch (error) {
      if (error?.code === 'MEMBER_CONTENT_PRERANK_LIMIT') {
        await finishUsage('failed');
        return res.status(503).json({
          error: 'The content search is temporarily unavailable. Please try again shortly.',
          code: error.code,
        });
      }
      throw error;
    }
    const searchAccess = {
      p_is_authenticated: !isAnonymous,
      p_is_admin: isAdmin,
      p_role_id: roleId,
      p_group_ids: [...groupIds],
      p_accessible_event_ids: [...accessibleEventIds],
      p_accessible_session_ids: [...accessibleSessionIds],
      p_hidden_subcategories: [...hiddenSubcats],
      p_eligible_pdf_chunk_ids: eligiblePdfChunkIds,
      p_allowed_content_types: allowedContentTypes,
      p_allowed_feature_keys: isAnonymous ? [
        // Public browse surfaces are not feature-gated by the member's portal
        // exclusions. The RPC still permits only public chunks.
        'content.resources', 'events.browse-events', 'content.news', 'content.articles',
      ] : [
        'content.resources',
        'events.browse-events',
        'content.news',
        'content.articles',
      ].filter((key) => access.canAccessFeature(key)),
    };
    const matchResults = await Promise.all(
      embResp.data.map((d, index) =>
        supabase.rpc('match_member_content_chunks', {
          query_embedding: d.embedding,
          p_tenant_id: ctx.tenantId,
          match_count: CANDIDATE_COUNT,
          p_query_text: queries[index] || question,
          ...searchAccess,
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
    const visibilityCtx = { ...preRankVisibilityCtx, now };

    const aboveFloor = candidates.filter(
      (m) => (m.similarity ?? 0) >= MIN_SIMILARITY
    );
    let visible = aboveFloor.filter((m) =>
      isChunkVisibleToMember(m, visibilityCtx)
    );
    // `access_scope` is the primary anonymous gate. Resources additionally
    // carry the explicit public flag from their authoritative browse row; do
    // not let an empty role allow-list turn a member-only resource into a
    // guest result while an older retrieval RPC is being rolled out.
    if (isAnonymous) {
      visible = visible.filter(
        (chunk) => chunk.content_type !== 'resource' || chunk.is_public === true
      );
    }

    // Final live-source validation is deliberately after the cheap metadata
    // checks and before ranking/limiting. It makes publication, role, group,
    // category and booking revocations effective without waiting for an
    // embedding rebuild and prevents stale source links from being cited.
    visible = await revalidateMemberContentCandidates({
      supabase,
      candidates: visible,
      visibilityCtx,
      accessibleEventIds,
      accessibleSessionIds,
    });

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
      await finishUsage('succeeded');
      return res.status(200).json(answerPayload({
        answer: FALLBACK_ANSWER,
        sources: [],
        grounded: false,
      }));
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

    // Deduped server-owned citation cards. Citations use source-level ids even
    // where several chunks from one source form the prompt context.
    const { sources, sourceByKey } = makeCitationSources(accessible, CONTENT_TYPE_LABEL);
    const citeable = accessible.filter((chunk) => sourceCitationId(chunk, sourceByKey));
    if (!citeable.length) {
      await finishUsage('succeeded');
      return res.status(200).json(answerPayload({
        answer: FALLBACK_ANSWER, sources: [], grounded: false,
      }));
    }

    // --- Ground the chat model on the accessible context only ---
    // Each excerpt carries its published/event date so the model can frame
    // "latest"/"recent" answers against real dates.
    const context = citeable
      .map((m) => {
        const label = CONTENT_TYPE_LABEL[m.content_type] || 'Item';
        return `[${sourceCitationId(m, sourceByKey)}] ${label}: "${m.title}"${formatChunkDate(m)}\n${m.content}`;
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
      'from the resources, events, news, articles, and portal pages available to this member. ' +
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
       'friendly and practical. Cite every factual claim using one or more source IDs ' +
       'in square brackets (for example [S1]). Use only IDs that appear at the start of ' +
       'the supplied source sections. Do not output URLs. Do not mention the words "excerpt" or "context".';

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
    }, providerDeadlineOptions(requestDeadline));
    recordProviderUsage(completion);

    let answer =
      completion.choices?.[0]?.message?.content?.trim() || FALLBACK_ANSWER;
    // A source can be unpublished/restricted while the provider is generating.
    // Refresh viewer entitlements as well as sources before returning the
    // generated text or a citation card. A role/group/booking revocation that
    // commits while the provider is running therefore takes effect now.
    let finalVisibilityCtx = visibilityCtx;
    let finalAccessibleEventIds = accessibleEventIds;
    let finalAccessibleSessionIds = accessibleSessionIds;
    if (member) {
      const currentMember = await getSessionMember(req);
      if (!currentMember || currentMember.id !== member.id) {
        await finishUsage('succeeded');
        return res.status(200).json(answerPayload({
          answer: FALLBACK_ANSWER, sources: [], grounded: false,
        }));
      }
      const [currentExclusions, currentGroups, currentEvents, currentSessions] = await Promise.all([
        resolveMemberExclusions({
          roleId: currentMember.role_id,
          memberExcludedFeatures: currentMember.member_excluded_features,
        }, supabase),
        resolveMemberContentGroupIds({
          supabase, tenantId: ctx.tenantId, memberId: currentMember.id,
        }),
        resolveAccessibleEventIds({
          supabase, tenantId: ctx.tenantId, member: currentMember,
        }),
        resolveAccessibleSessionIds({
          supabase, tenantId: ctx.tenantId, member: currentMember,
        }),
      ]);
      const currentAccess = makeFeatureAccessChecker(currentExclusions);
      finalVisibilityCtx = {
        ...visibilityCtx,
        roleId: currentMember.role_id || null,
        groupIds: currentGroups,
        member: currentMember,
        canAccessFeature: (key) => currentAccess.canAccessFeature(key),
      };
      finalAccessibleEventIds = currentEvents;
      finalAccessibleSessionIds = currentSessions;
    } else if (!isAnonymous) {
      const currentTenantUser = await getSessionTenantUser(req);
      const currentTenantId = currentTenantUser?._sessionTenantId || currentTenantUser?.tenant_id;
      if (!currentTenantUser || currentTenantId !== ctx.tenantId) {
        await finishUsage('succeeded');
        return res.status(200).json({ answer: FALLBACK_ANSWER, sources: [], grounded: false });
      }
    }
    const finalChunks = await revalidateMemberContentCandidates({
      supabase,
      candidates: citeable,
      visibilityCtx: finalVisibilityCtx,
      accessibleEventIds: finalAccessibleEventIds,
      accessibleSessionIds: finalAccessibleSessionIds,
    });
    if (finalChunks.length !== citeable.length) {
      await finishUsage('succeeded');
      return res.status(200).json(answerPayload({
        answer: FALLBACK_ANSWER, sources: [], grounded: false,
      }));
    }
    let citationCheck = validateAnswerCitations(answer, sources);
    if (!citationCheck.ok) {
      const repaired = await repairAnswerCitations(openai, answer, sources, recordProviderUsage, requestDeadline);
      citationCheck = repaired ? validateAnswerCitations(repaired, sources) : { ok: false };
      if (citationCheck.ok) answer = repaired;
    }
    if (!citationCheck.ok) {
      await finishUsage('succeeded');
      return res.status(200).json(answerPayload({
        answer: FALLBACK_ANSWER, sources: [], grounded: false,
      }));
    }
    const response = answerPayload({
      answer,
      sources: citationCheck.sources,
      grounded: true,
      citations: citationCheck.citationIds,
    });
    await finishUsage('succeeded');
    return res.status(200).json(response);
  } catch (error) {
    if (usageReservationId) {
      try {
        await finishUsage('failed');
      } catch (usageError) {
        console.error('[Member AI Ask] usage completion failed:', usageError);
      }
    }
    console.error('[Member AI Ask] Error:', error);
    return res
      .status(500)
      .json({ error: 'Something went wrong answering your question.' });
  }
}

export default async function handler(req, res) {
  return handleMemberAiAsk(req, res);
}
