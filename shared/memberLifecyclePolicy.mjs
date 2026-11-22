// Pure policy evaluation. Results are proposals, never authority to mutate a member.
export const LIFECYCLE_ACTIVITIES = Object.freeze(['event_attendance', 'cpd_activity', 'portal_login']);
export const LIFECYCLE_CAPABILITIES = Object.freeze([
  'crm.member-lifecycle.view', 'crm.member-lifecycle.configure',
  'crm.member-lifecycle.review', 'crm.member-lifecycle.archive',
  'crm.member-lifecycle.minimise', 'crm.member-lifecycle.delete',
]);
export const DEFAULT_LIFECYCLE_POLICY = Object.freeze({
  timezone: 'UTC',
  formerRetentionYears: 5,
  guestInactivityYears: 5,
  archiveReviewYears: 1,
  activities: Object.freeze(['event_attendance', 'cpd_activity', 'portal_login']),
  formerRoleId: null,
  guestRoleId: null,
  eventOnlyRoleIds: Object.freeze([]),
  guestRoleIds: Object.freeze([]),
  notificationsEnabled: false,
  notificationLeadDays: 30,
});

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function roleId(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !uuid.test(value)) invalid('Select a valid tenant role.');
  return value;
}
export function validateLifecyclePolicy(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') invalid('A policy is required.');
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_LIFECYCLE_POLICY)) invalid(`Unknown policy setting: ${key}`);
  }
  const policy = { ...DEFAULT_LIFECYCLE_POLICY, ...input };
  for (const key of ['formerRetentionYears', 'guestInactivityYears', 'archiveReviewYears']) {
    if (!Number.isInteger(policy[key]) || policy[key] < 0 || policy[key] > 100) {
      invalid(`${key} must be a whole number between 0 and 100.`);
    }
  }
  if (!Number.isInteger(policy.notificationLeadDays) || policy.notificationLeadDays < 0
    || policy.notificationLeadDays > 365 || typeof policy.notificationsEnabled !== 'boolean') {
    invalid('Invalid notification settings.');
  }
  if (typeof policy.timezone !== 'string') invalid('A valid timezone is required.');
  try { new Intl.DateTimeFormat('en', { timeZone: policy.timezone }).format(); }
  catch { invalid('A valid timezone is required.'); }
  if (!Array.isArray(policy.activities) || !policy.activities.length
    || policy.activities.some(value => !LIFECYCLE_ACTIVITIES.includes(value))
    || new Set(policy.activities).size !== policy.activities.length) invalid('Choose valid qualifying activities.');
  policy.activities = [...policy.activities];
  policy.formerRoleId = roleId(policy.formerRoleId);
  policy.guestRoleId = roleId(policy.guestRoleId);
  for (const key of ['eventOnlyRoleIds', 'guestRoleIds']) {
    if (!Array.isArray(policy[key]) || policy[key].length > 200) invalid('Invalid role selection.');
    policy[key] = [...new Set(policy[key].map(value => {
      if (value == null) invalid('Invalid role selection.');
      return roleId(value);
    }))];
  }
  return policy;
}

export function lifecycleDay(value, timezone = 'UTC') {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Invalid date');
    return value;
  }
  if (value == null || value === '') throw new Error('Missing date');
  const date = new Date(value);
  if (!Number.isFinite(+date)) throw new Error('Invalid date');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Calendar anniversary, clamped to February 28 in non-leap years.
export function lifecycleAnniversary(value, years) {
  const day = lifecycleDay(value);
  if (!Number.isInteger(years) || years < 0 || years > 100) throw new Error('Invalid retention period');
  const [year, month, date] = day.split('-').map(Number);
  const last = new Date(Date.UTC(year + years, month, 0)).getUTCDate();
  return `${year + years}-${String(month).padStart(2, '0')}-${String(Math.min(date, last)).padStart(2, '0')}`;
}

function result(action, reason, details = {}) { return { action, reason, ...details }; }
const hold = (reason, details) => result('evidence_review', reason, details);

/**
 * Evidence is server-owned and scoped. No browser-supplied evidence may authorise
 * execution. Every relevant source must be complete, including genuinely empty
 * sources; absence of any source is uncertainty rather than inactivity.
 */
export function evaluateMemberLifecycle({ policy: input, tenantId, member, evidence, roles, now = new Date() }) {
  let policy, today;
  try {
    policy = validateLifecyclePolicy(input);
    today = lifecycleDay(now, policy.timezone);
  } catch { return hold('invalid_policy_or_clock'); }
  if (!tenantId || !member?.id || member.tenant_id !== tenantId || evidence?.tenantId !== tenantId
    || evidence?.memberId !== member.id) return hold('evidence_scope_mismatch');
  if (member.lifecycle_state === 'deleted') return result('none', 'already_deleted');
  if (member.lifecycle_exempt === true || member.lifecycle_hold === true) return result('none', 'administrator_hold');
  if (Array.isArray(roles) && roles.some(role => role.id === member.role_id
    && role.tenant_id === tenantId && role.is_tenant_admin === true)) {
    return hold('administrator_role_requires_review');
  }
  if (member.lifecycle_review_after) {
    try {
      if (lifecycleDay(member.lifecycle_review_after, policy.timezone) > today) {
        return result('none', 'retention_extended', { eligibleOn: lifecycleDay(member.lifecycle_review_after, policy.timezone) });
      }
    } catch { return hold('invalid_review_date'); }
  }
  if (!evidence.membershipComplete || !evidence.obligationsComplete || !evidence.membership) {
    return hold('incomplete_membership_or_obligation_evidence');
  }
  if (evidence.membership.active || evidence.membership.futureEntitlement || evidence.membership.pendingRenewal) {
    return result('none', 'membership_protected');
  }
  if (member.membership_paused || member.membership_cancelled) return hold('separate_membership_lifecycle');
  if (!Array.isArray(evidence.blockers)) return hold('incomplete_obligation_evidence');
  if (evidence.blockers.length) return hold('unresolved_obligations', { blockers: [...evidence.blockers] });
  if (!['former', 'never'].includes(evidence.membership.historyKind)) return hold('membership_history_unknown');

  const historyKind = evidence.membership.historyKind;
  if (member.lifecycle_state === 'archived' || member.lifecycle_state === 'minimised') {
    if (historyKind !== 'former') return hold('archived_guest_retention_requires_review');
    try {
      const archivedOn = lifecycleDay(member.lifecycle_archived_at, policy.timezone);
      if (archivedOn > today) return hold('invalid_archive_date');
      const eligibleOn = lifecycleAnniversary(archivedOn, policy.archiveReviewYears);
      return today >= eligibleOn
        ? result('deletion_review', 'archive_retention_elapsed', { eligibleOn })
        : result('none', 'archive_retention_running', { eligibleOn });
    } catch { return hold('archive_date_unknown'); }
  }

  const knownStates = ['active', 'former', 'guest', null, undefined];
  if (!knownStates.includes(member.lifecycle_state)) return hold('unknown_lifecycle_state');
  // Persisted progression is not entitlement-cycle authority. A subsequent
  // renewal may change the role while the old lifecycle projection stays guest.
  const guest = member.role_id === policy.guestRoleId
    || policy.guestRoleIds.includes(member.role_id) || policy.eventOnlyRoleIds.includes(member.role_id);
  // Historical role labels alone cannot establish membership provenance.
  if (historyKind === 'never' && !guest) return hold('guest_classification_required');
  let graceEnd;
  if (historyKind === 'former') {
    try {
      graceEnd = lifecycleDay(evidence.membership.graceEndDate, policy.timezone);
      if (today <= graceEnd) return result('none', 'within_membership_grace');
    } catch { return hold('membership_grace_unknown'); }
  }
  function transition(action, reason, targetRoleId, details = {}) {
    if (!Array.isArray(roles) || !targetRoleId) return hold('destination_role_unavailable');
    const target = roles.find(role => role.id === targetRoleId && role.tenant_id === tenantId);
    if (!target || target.is_active === false || target.is_tenant_admin === true) return hold('destination_role_unavailable');
    return result(action, reason, { targetRoleId, ...details });
  }
  const activities = policy.eventOnlyRoleIds.includes(member.role_id) ? ['event_attendance'] : policy.activities;
  const occurrenceDays = [];
  for (const type of activities) {
    const source = evidence.activity?.[type];
    if (source?.complete !== true) return hold('activity_source_incomplete', { source: type });
    if (source.lastOccurredAt == null) continue;
    try {
      const occurredOn = lifecycleDay(source.lastOccurredAt, policy.timezone);
      if (occurredOn > today) return hold('future_activity_date', { source: type });
      occurrenceDays.push(occurredOn);
    } catch { return hold('invalid_activity_date', { source: type }); }
  }
  if (!occurrenceDays.length) return hold('last_activity_unknown');
  if (!guest && historyKind === 'former' && member.lifecycle_state !== 'former') {
    return transition('former', 'membership_grace_elapsed', policy.formerRoleId, { eligibleOn: graceEnd });
  }
  const lastActivityOn = occurrenceDays.sort().at(-1);
  if(historyKind==='former'){
    const eligibleOn=lifecycleAnniversary(graceEnd,policy.formerRetentionYears);
    if(today<eligibleOn)return result('none','former_retention_running',{eligibleOn,lastActivityOn});
  }
  const activityExpiry = lifecycleAnniversary(lastActivityOn, policy.guestInactivityYears);
  if (!guest) {
    const eligibleOn = lifecycleAnniversary(graceEnd, policy.formerRetentionYears);
    if (today < eligibleOn) return result('none', 'former_retention_running', { eligibleOn, lastActivityOn });
    if (today < activityExpiry) return transition('guest', 'former_with_recent_activity', policy.guestRoleId,
      { eligibleOn, lastActivityOn });
    return result('archive', 'former_inactivity_elapsed', { eligibleOn, lastActivityOn });
  }
  if (today < activityExpiry) return result('none', 'qualifying_activity_retained', { eligibleOn: activityExpiry, lastActivityOn });
  return historyKind === 'former'
    ? result('archive', 'former_guest_inactivity_elapsed', { eligibleOn: activityExpiry, lastActivityOn })
    : result('deletion_review', 'never_member_guest_inactivity_elapsed', { eligibleOn: activityExpiry, lastActivityOn });
}
