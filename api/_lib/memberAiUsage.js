// Durable, database-atomic allowance reservations for Member AI. In-memory
// counters are intentionally not used: serverless instances and concurrent tabs
// must observe the same per-member and per-tenant limits.

import crypto from 'node:crypto';

export const MEMBER_AI_DEFAULTS = Object.freeze({
  enabled: true,
  public_enabled: false,
  per_member_hourly_limit: 20,
  per_ip_hourly_limit: 10,
  tenant_monthly_limit: 2000,
  max_concurrent_requests: 4,
  allowed_content_types: ['resource', 'event', 'complex_event', 'news_post', 'blog_post', 'canvas_page'],
});

export function memberAiRequestHash(question) {
  return crypto
    .createHash('sha256')
    .update(String(question || '').trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

export async function getMemberAiSettings({ supabase, tenantId }) {
  const { data, error } = await supabase
    .from('member_ai_settings')
    .select('enabled, public_enabled, per_member_hourly_limit, per_ip_hourly_limit, tenant_monthly_limit, max_concurrent_requests, allowed_content_types')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data || MEMBER_AI_DEFAULTS;
}

export async function reserveMemberAiUsage({ supabase, tenantId, memberId, question }) {
  const { data, error } = await supabase.rpc('claim_member_ai_usage', {
    p_tenant_id: tenantId,
    p_member_id: memberId,
    p_request_hash: memberAiRequestHash(question),
  });
  if (error) throw error;
  const decision = Array.isArray(data) ? data[0] : data;
  if (!decision?.allowed) {
    return {
      allowed: false,
      status: decision?.code === 'MEMBER_AI_DISABLED' ? 403 : 429,
      code: decision?.code || 'MEMBER_AI_LIMITED',
      error: decision?.message || 'The AI assistant is temporarily unavailable.',
    };
  }
  return { allowed: true, reservationId: decision.usage_id, usageKind: 'member' };
}

export async function reservePublicMemberAiUsage({ supabase, tenantId, ipHash, question }) {
  const { data, error } = await supabase.rpc('claim_public_member_ai_usage', {
    p_tenant_id: tenantId,
    p_ip_hash: ipHash,
    p_request_hash: memberAiRequestHash(question),
  });
  if (error) throw error;
  const decision = Array.isArray(data) ? data[0] : data;
  if (!decision?.allowed) {
    return {
      allowed: false,
      status: decision?.code === 'MEMBER_AI_DISABLED' || decision?.code === 'MEMBER_AI_PUBLIC_DISABLED' || decision?.code === 'MEMBER_AI_PLATFORM_DISABLED' ? 403 : 429,
      code: decision?.code || 'MEMBER_AI_LIMITED',
      error: decision?.message || 'The AI assistant is temporarily unavailable.',
    };
  }
  return { allowed: true, reservationId: decision.usage_id, usageKind: 'public' };
}

export async function reserveAdminMemberAiUsage({ supabase, tenantId, actorId, question }) {
  const actorHash = crypto.createHash('sha256')
    .update(`${process.env.MEMBER_AI_ADMIN_HASH_SALT || process.env.SESSION_SECRET || 'member-ai-admin'}:${String(actorId || '')}`)
    .digest('hex')
    .slice(0, 48);
  const { data, error } = await supabase.rpc('claim_admin_member_ai_usage', {
    p_tenant_id: tenantId,
    p_actor_hash: actorHash,
    p_request_hash: memberAiRequestHash(question),
  });
  if (error) throw error;
  const decision = Array.isArray(data) ? data[0] : data;
  if (!decision?.allowed) {
    return {
      allowed: false,
      status: decision?.code?.includes('DISABLED') ? 403 : 429,
      code: decision?.code || 'MEMBER_AI_LIMITED',
      error: decision?.message || 'The AI assistant is temporarily unavailable.',
    };
  }
  // Admin reservations use the non-member usage table intentionally, while
  // sharing its tenant/platform budget with both other request classes.
  return { allowed: true, reservationId: decision.usage_id, usageKind: 'public' };
}

export function memberAiIpHash(ip) {
  return crypto.createHash('sha256')
    .update(`${process.env.MEMBER_AI_IP_HASH_SALT || process.env.SESSION_SECRET || 'member-ai'}:${String(ip || 'unknown')}`)
    .digest('hex')
    .slice(0, 48);
}

export async function finishMemberAiUsage({
  supabase,
  reservationId,
  status,
  usageKind = 'member',
  inputTokens = 0,
  outputTokens = 0,
  providerRequestId = null,
}) {
  if (!reservationId) return;
  const { error } = await supabase
    .from(usageKind === 'public' ? 'member_ai_public_usage_event' : 'member_ai_usage_event')
    .update({
      status,
      completed_at: new Date().toISOString(),
      ...(status === 'succeeded' && {
        input_tokens: Math.max(0, Math.trunc(inputTokens)),
        output_tokens: Math.max(0, Math.trunc(outputTokens)),
        provider_request_id: providerRequestId ? String(providerRequestId).slice(0, 200) : null,
      }),
    })
    .eq('id', reservationId)
    .eq('status', 'reserved');
  if (error) throw error;
}