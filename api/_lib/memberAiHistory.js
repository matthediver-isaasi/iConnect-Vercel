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
import {
  resolveMemberExclusions,
  makeFeatureAccessChecker,
} from './memberFeatureAccess.js';

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
      sources:
        m.role === 'assistant' && Array.isArray(m.sources)
          ? m.sources.slice(0, 20).map((s) => ({
              title: typeof s?.title === 'string' ? s.title.slice(0, 300) : '',
              type: typeof s?.type === 'string' ? s.type.slice(0, 50) : '',
              typeLabel:
                typeof s?.typeLabel === 'string' ? s.typeLabel.slice(0, 50) : '',
              link: typeof s?.link === 'string' ? s.link.slice(0, 1000) : null,
            }))
          : null,
    });
  }
  return out;
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
  return { tenantId: ctx.tenantId, memberId: member.id };
}
