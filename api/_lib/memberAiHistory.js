// Task #2407: Member AI assistant — shared helpers for the conversation
// history endpoints (api/member-ai/conversations*).
//
// Scope model: STRICTLY (tenant_id, member_id). Tenant + member context are
// resolved exactly like api/member-ai/ask.js (getTenantContext +
// getSessionMember). Authenticated non-member users (tenant admins previewing
// the portal) get 403 with code 'not_member' — the client disables persistence
// for them; the chat itself still works.

import { getSessionMember } from './session.js';
import { getTenantContext } from './tenantContext.js';
import { supabase } from './database.js';
import { requireTenantAiAssistant } from './tenantAiAssistant.js';
import {
  resolveMemberExclusions,
  makeFeatureAccessChecker,
} from './memberFeatureAccess.js';
import {
  resolveAccessibleEventIds,
  resolveMemberContentGroupIds,
  revalidateMemberContentCandidates,
} from './memberContentAccess.js';
import {
  verifyAnswerProvenance,
  makeStructuredAccessFingerprint,
} from './memberAiAnswer.js';

export const MAX_TITLE_LEN = 120;
export const MAX_CONTENT_LEN = 8000;
// Hard cap of stored messages per conversation (200 turns). Enforced on both
// create (initial payload) and append.
export const MAX_MESSAGES = 400;

export function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content !== 'string' || !m.content.trim()) return null;
    out.push({
      role: m.role,
      content: m.content.slice(0, MAX_CONTENT_LEN),
      // Sources from the browser are deliberately discarded. Assistant source
      // provenance must be the short-lived envelope emitted by /ask.
      answerProvenance:
        m.role === 'assistant' && typeof m.answerProvenance === 'string'
          ? m.answerProvenance
          : null,
    });
  }
  return out;
}

/**
 * Turn browser messages into safe storage rows.  A member can save arbitrary
 * questions, but cannot attach a source, link, or access fence to an assistant
 * response unless /ask signed the exact answer for this member and tenant.
 */
export function preparePersistedMessages(raw, scope) {
  const messages = sanitizeMessages(raw);
  if (!messages) return null;
  const prepared = [];
  for (const message of messages) {
    if (message.role === 'user') {
      prepared.push({ role: 'user', content: message.content, sources: null });
      continue;
    }
    const verified = verifyAnswerProvenance(message.answerProvenance, {
      tenantId: scope.tenantId,
      memberId: scope.memberId,
      answer: message.content,
    });
    // Do not persist a browser-authored assistant claim.  The client can show
    // its transient response if saving failed, but it cannot become history.
    if (!verified) return null;
    prepared.push({
      role: 'assistant',
      content: message.content,
      // A structured result has no CMS citation to reauthorize. Keep an
      // explicit server-signed sentinel so it is distinguishable from legacy,
      // unfenced no-source model replies (which remain fail-closed).
      sources: verified.answerKind === 'structured'
        ? [{
          _memberAiAnswerKind: 'structured',
          accessFingerprint: verified.structuredAccessFingerprint,
        }]
        : verified.sources,
    });
  }
  return prepared;
}
export async function resolveMemberScope(req, res) {
  const ctx = await getTenantContext(req);
  if (!ctx || !ctx.isAuthenticated) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (!ctx.tenantId) {
    res.status(400).json({ error: 'Tenant context required' });
    return null;
  }
  if (!await requireTenantAiAssistant(ctx.tenantId, res)) return null;
  const member = await getSessionMember(req);
  if (!member) {
    res.status(403).json({
      error: 'Chat history is only available for member accounts.',
      code: 'not_member',
    });
    return null;
  }
  // Task #2441: RBAC gate — members excluded from support.member-ai cannot
  // use the assistant, including its conversation-history endpoints. Fails
  // CLOSED: if role exclusions can't be loaded we return 500 rather than
  // silently granting access (callers don't wrap scope resolution).
  let exclusions;
  try {
    exclusions = await resolveMemberExclusions(
      {
        roleId: member.role_id,
        memberExcludedFeatures: member.member_excluded_features,
      },
      supabase
    );
  } catch (error) {
    console.error('[Member AI History] Failed to resolve exclusions:', error);
    res.status(500).json({ error: 'Something went wrong with chat history.' });
    return null;
  }
  const access = makeFeatureAccessChecker(exclusions);
  if (!access.canAccessFeature('support.member-ai')) {
    res.status(403).json({
      error: 'The AI assistant is not available for your account.',
      code: 'feature_excluded',
    });
    return null;
  }
  let groupIds;
  let accessibleEventIds;
  try {
    [groupIds, accessibleEventIds] = await Promise.all([
      resolveMemberContentGroupIds({
        supabase,
        tenantId: ctx.tenantId,
        memberId: member.id,
      }),
      resolveAccessibleEventIds({ supabase, tenantId: ctx.tenantId, member }),
    ]);
  } catch (error) {
    console.error('[Member AI History] Failed to resolve current viewer access:', error);
    res.status(500).json({ error: 'Something went wrong with chat history.' });
    return null;
  }
  return {
    tenantId: ctx.tenantId,
    memberId: member.id,
    visibilityCtx: {
      tenantId: ctx.tenantId,
      isAdmin: false,
      isAuthenticated: true,
      roleId: member.role_id || null,
      groupIds,
      member,
      canAccessFeature: access.canAccessFeature,
    },
    accessibleEventIds,
    structuredAccessFingerprint: makeStructuredAccessFingerprint({
      tenantId: ctx.tenantId,
      memberId: member.id,
      roleId: member.role_id,
      groupIds,
      exclusions,
    }),
  };
}

/**
 * A stored assistant reply is not durable authority. Its cited source ids and
 * source versions are revalidated on every history GET. Old rows lacking the
 * fences added with this feature are intentionally redacted rather than
 * replaying potentially revoked content.
 */
export async function redactRevokedHistoryMessages(messages, scope) {
  const assistantMessages = (messages || []).filter((message) => message?.role === 'assistant');
  const candidates = [];
  const messageKeys = new Map();
  for (const message of assistantMessages) {
    const sources = Array.isArray(message.sources) ? message.sources : [];
    if (
      sources.length === 1 &&
      sources[0]?._memberAiAnswerKind === 'structured'
    ) {
      // Structured replies contain no corpus citations. Their original answer
      // is replayable only while the signed member/role/group/feature
      // fingerprint still matches the freshly resolved history scope.
      if (
        sources[0].accessFingerprint &&
        sources[0].accessFingerprint === scope.structuredAccessFingerprint
      ) {
        messageKeys.set(message.id, ['structured-current']);
      } else {
        messageKeys.set(message.id, []);
      }
      continue;
    }
    const keys = [];
    for (const source of sources) {
      // A durable answer citation must retain every provenance-bearing chunk
      // which could have supported that source card. A title chunk and a PDF
      // chunk share one citation id; accepting only the title chunk would let a
      // later-revoked PDF remain visible in history.
      if (
        !source?.sourceId ||
        !source?.type ||
        source?.sourceGeneration == null ||
        !Array.isArray(source.supportingProvenance) ||
        !source.supportingProvenance.length
      ) continue;
      source.supportingProvenance.forEach((provenance, index) => {
        const key = `${source.type}:${source.sourceId}:${source.sourceGeneration}:${index}`;
        keys.push(key);
        candidates.push({
          content_type: source.type,
          source_id: source.sourceId,
          source_generation: Number(source.sourceGeneration),
          // Historical cards never authorize a guest path. Canvas citations must
          // still satisfy an authenticated projection.
          access_scope: source.accessScope === 'authenticated' ? 'authenticated' : 'public',
          provenance: provenance && typeof provenance === 'object' ? provenance : {},
          _historySupportKey: key,
        });
      });
    }
    messageKeys.set(message.id, keys);
  }
  const valid = await revalidateMemberContentCandidates({
    supabase,
    candidates,
    visibilityCtx: scope.visibilityCtx,
    accessibleEventIds: scope.accessibleEventIds,
  });
  const validKeys = new Set(valid.map((source) => source._historySupportKey).filter(Boolean));
  // A current structured fingerprint is an authorization key, not a content
  // source; let it satisfy only its own sentinel turn.
  if (scope.structuredAccessFingerprint) validKeys.add('structured-current');
  return redactHistoryByAuthorizedKeys(messages, validKeys, messageKeys);
}

export function redactHistoryByAuthorizedKeys(messages, validKeys, messageKeys) {
  return (messages || []).map((message) => {
    if (message?.role !== 'assistant') return message;
    const keys = messageKeys.get(message.id) || [];
    if (!keys.length || keys.some((key) => !validKeys.has(key))) {
      return {
        ...message,
        content: 'This earlier answer is no longer available because its portal source access changed.',
        sources: [],
        redacted: true,
      };
    }
    return message;
  });
}
