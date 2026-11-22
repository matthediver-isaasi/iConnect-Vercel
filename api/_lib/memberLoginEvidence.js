import { randomUUID } from 'node:crypto';
import { lifecycleDay } from '../../shared/memberLifecyclePolicy.mjs';

export const MEMBER_LOGIN_SOURCES = Object.freeze(['password', 'google', 'password_setup', 'mobile_password']);

export function isGenuineMemberLogin(session, source) {
  return MEMBER_LOGIN_SOURCES.includes(source) && session?.userType === 'member'
    && Boolean(session.memberId && session.tenantId)
    && !session.tenantUserId && !session.isMasquerading && !session.isPlatformImpersonation
    && !session.masqueradeAdminSessionId && !session.promotedFromMember
    && !session.originalUserType;
}

export function assessLifecycleLogins(rows, { tenantId, memberId, timezone = 'UTC', now = new Date() }) {
  if (!Array.isArray(rows)) throw new Error('Login evidence is unavailable');
  const ids = new Set(), dates = [];
  const today = lifecycleDay(now, timezone);
  for (const row of rows) {
    if (!row.id || ids.has(row.id) || row.tenant_id !== tenantId || row.member_id !== memberId
      || !MEMBER_LOGIN_SOURCES.includes(row.source) || !row.occurred_at) {
      throw new Error('Invalid login evidence');
    }
    ids.add(row.id);
    const day = lifecycleDay(row.occurred_at, timezone);
    if (day > today) throw new Error('Future login evidence');
    dates.push(day);
  }
  return {
    // Forward observations cannot establish absence of earlier activity or
    // uninterrupted capture. A separate reviewed coverage contract is required.
    complete: false,
    lastOccurredAt: dates.sort().at(-1) || null,
    source: 'member_lifecycle_login_evidence',
    reasons: ['login_history_coverage_unverified'],
  };
}

/**
 * Called only after session insertion and the second current access fence.
 * An explicit server-owned login source is required; refresh, SSO projection,
 * tenant switching and masquerading must never opt in.
 *
 * The migration's trigger atomically preserves this event independently of the
 * expiring session. Before installation the JSON marker is backward compatible,
 * but must NOT be treated as complete historical activity coverage.
 */
export async function stampMemberLoginSession(db, { sessionId, sessionData, source }) {
  if (!isGenuineMemberLogin(sessionData, source)) return true;
  const marker = { id: randomUUID(), source, version: 1 };
  try {
    const { data, error } = await db.from('session')
      .update({ sess: { ...sessionData, memberLoginEvidence: marker } })
      .eq('sid', sessionId).select('sid').maybeSingle();
    if (error || !data || data.sid !== sessionId) {
      // Never log session tokens, member details, database payloads or errors.
      console.error('[Member login evidence] Session finalization failed');
      return false;
    }
    return true;
  } catch {
    console.error('[Member login evidence] Session finalization unavailable');
    return false;
  }
}
