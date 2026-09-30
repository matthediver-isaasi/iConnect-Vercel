// Gallery policies are deliberately small and versioned. Groups are OR-ed and
// conditions inside each group are AND-ed; authorization always happens here.
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const denied = (code) => ({ allowed: false, code, restricted: true });

export function normalizeGalleryAccessPolicy(input) {
  if (input === null || input === undefined || input === '') {
    return { ok: true, policy: null, restricted: false };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'access_policy must be an object' };
  }
  if (input.version !== 1 || !Array.isArray(input.groups)) {
    return { ok: false, error: 'access_policy requires version 1 and a groups array' };
  }
  const groups = [];
  const groupKeys = new Set();
  for (const rawGroup of input.groups) {
    if (!rawGroup || typeof rawGroup !== 'object' || !Array.isArray(rawGroup.conditions) || !rawGroup.conditions.length) {
      return { ok: false, error: 'Each access_policy group requires one or more conditions' };
    }
    const keys = new Set();
    const conditions = [];
    for (const raw of rawGroup.conditions) {
      const type = raw?.type;
      const id = clean(raw?.id);
      const event_type = raw?.event_type;
      if (!['member_group', 'role', 'event'].includes(type) || !id
        || (type === 'event' && !['simple', 'complex'].includes(event_type))
        || (type !== 'event' && event_type !== undefined)) {
        return { ok: false, error: 'Conditions require member_group/role IDs or event IDs with simple or complex event_type' };
      }
      const condition = type === 'event' ? { type, event_type, id } : { type, id };
      const key = `${type}:${event_type || ''}:${id}`;
      if (keys.has(key)) return { ok: false, error: 'Conditions in a group must be unique' };
      keys.add(key);
      conditions.push(condition);
    }
    const groupKey = JSON.stringify(conditions);
    if (groupKeys.has(groupKey)) return { ok: false, error: 'Access policy groups must be unique' };
    groupKeys.add(groupKey);
    groups.push({ conditions });
  }
  return { ok: true, policy: { version: 1, groups }, restricted: true };
}

const query = (supabase, table, columns, tenantId, ids) =>
  supabase.from(table).select(columns).eq('tenant_id', tenantId).in('id', ids);

const conditionIds = (policies, type, eventType) => [...new Set(
  policies.flatMap((policy) => policy.groups.flatMap((group) => group.conditions))
    .filter((condition) => condition.type === type && (!eventType || condition.event_type === eventType))
    .map((condition) => condition.id)
)];

export async function validateGalleryAccessPolicy({ supabase, tenantId, policy: input }) {
  const normalized = normalizeGalleryAccessPolicy(input);
  if (!normalized.ok || !normalized.restricted) return normalized;
  if (!supabase || !tenantId) return { ok: false, error: 'Cannot validate gallery policy without tenant context' };
  try {
    const conditions = normalized.policy.groups.flatMap((group) => group.conditions);
    const ids = (type, eventType) => [...new Set(conditions
      .filter((c) => c.type === type && (!eventType || c.event_type === eventType)).map((c) => c.id))];
    const groupIds = ids('member_group');
    const roleIds = ids('role');
    const simpleIds = ids('event', 'simple');
    const complexIds = ids('event', 'complex');
    const [groups, roles, events, complexEvents] = await Promise.all([
      groupIds.length ? query(supabase, 'member_group', 'id, is_active', tenantId, groupIds) : { data: [] },
      roleIds.length ? query(supabase, 'role', 'id', tenantId, roleIds) : { data: [] },
      simpleIds.length ? query(supabase, 'event', 'id', tenantId, simpleIds) : { data: [] },
      complexIds.length ? query(supabase, 'complex_event', 'id', tenantId, complexIds) : { data: [] },
    ]);
    if (groups.error || roles.error || events.error || complexEvents.error
      || (groups.data || []).length !== groupIds.length
      || (roles.data || []).length !== roleIds.length
      || (events.data || []).length !== simpleIds.length
      || (complexEvents.data || []).length !== complexIds.length
      || (groups.data || []).some((group) => group.is_active !== true)) {
      throw new Error('invalid reference');
    }
    return normalized;
  } catch {
    return { ok: false, error: 'One or more gallery policy references are missing, inactive, invalid, or belong to another tenant' };
  }
}

export async function evaluateGalleryAccessPolicy({ supabase, tenantId, memberId, roleId, policy: input, isManager = false, now = Date.now() }) {
  const [result] = await evaluateGalleryAccessPolicies({
    supabase, tenantId, memberId, roleId, policies: [input], isManager, now,
  });
  return result;
}

// Evaluate a directory-sized set of policies using one set of reference and
// member-evidence lookups instead of repeating those queries for every gallery.
export async function evaluateGalleryAccessPolicies({
  supabase, tenantId, memberId, roleId, policies, isManager = false, now = Date.now(),
}) {
  const inputs = Array.isArray(policies) ? policies : [];
  if (isManager) {
    return inputs.map(() => ({ allowed: true, code: 'MANAGEMENT_BYPASS', restricted: false }));
  }
  const normalized = inputs.map((input) => normalizeGalleryAccessPolicy(input));
  if (!supabase || !tenantId) {
    return normalized.map((item) => item.ok && !item.restricted
      ? { allowed: true, code: 'UNRESTRICTED', restricted: false }
      : denied(item.ok ? 'AUTHENTICATION_REQUIRED' : 'INVALID_ACCESS_POLICY'));
  }
  const restrictedPolicies = normalized.filter((item) => item.ok && item.restricted).map((item) => item.policy);
  if (!restrictedPolicies.length) {
    return normalized.map((item) => item.ok
      ? { allowed: true, code: 'UNRESTRICTED', restricted: false }
      : denied('INVALID_ACCESS_POLICY'));
  }
  if (!memberId) {
    return normalized.map((item) => !item.ok
      ? denied('INVALID_ACCESS_POLICY')
      : item.restricted ? denied('AUTHENTICATION_REQUIRED')
        : { allowed: true, code: 'UNRESTRICTED', restricted: false });
  }

  try {
    const groupIds = conditionIds(restrictedPolicies, 'member_group');
    const roleIds = conditionIds(restrictedPolicies, 'role');
    const simpleIds = conditionIds(restrictedPolicies, 'event', 'simple');
    const complexIds = conditionIds(restrictedPolicies, 'event', 'complex');
    const [groups, roles, events, complexEvents, assignments, simpleBookings, complexBookings] = await Promise.all([
      groupIds.length ? query(supabase, 'member_group', 'id, is_active', tenantId, groupIds) : { data: [] },
      roleIds.length ? query(supabase, 'role', 'id', tenantId, roleIds) : { data: [] },
      simpleIds.length ? query(supabase, 'event', 'id', tenantId, simpleIds) : { data: [] },
      complexIds.length ? query(supabase, 'complex_event', 'id', tenantId, complexIds) : { data: [] },
      groupIds.length ? supabase.from('member_group_assignment').select('group_id, expires_at')
        .eq('tenant_id', tenantId).eq('member_id', memberId).in('group_id', groupIds) : { data: [] },
      simpleIds.length ? supabase.from('booking').select('event_id').eq('tenant_id', tenantId).eq('member_id', memberId)
        .in('event_id', simpleIds).eq('status', 'confirmed').not('checked_in_at', 'is', null).is('check_in_reversed_at', null) : { data: [] },
      complexIds.length ? supabase.from('complex_event_booking').select('id, complex_event_id').eq('tenant_id', tenantId).eq('member_id', memberId)
        .in('complex_event_id', complexIds).eq('status', 'confirmed') : { data: [] },
    ]);
    if ([groups, roles, events, complexEvents, assignments, simpleBookings, complexBookings].some((result) => result.error)) {
      throw new Error('access lookup failed');
    }
    const bookingIds = (complexBookings.data || []).map((booking) => booking.id);
    const checkins = bookingIds.length ? await supabase.from('complex_event_session_checkin').select('booking_id')
      .eq('tenant_id', tenantId).in('booking_id', bookingIds).not('checked_in_at', 'is', null).is('check_in_reversed_at', null) : { data: [] };
    if (checkins.error) throw new Error('access lookup failed');

    const validGroups = new Set((groups.data || []).filter((group) => group.is_active === true).map((group) => group.id));
    const validRoles = new Set((roles.data || []).map((role) => role.id));
    const validSimpleEvents = new Set((events.data || []).map((event) => event.id));
    const validComplexEvents = new Set((complexEvents.data || []).map((event) => event.id));
    const activeGroups = new Set((assignments.data || []).filter((assignment) =>
      !assignment.expires_at || Date.parse(assignment.expires_at) > now).map((assignment) => assignment.group_id));
    const attended = new Set((simpleBookings.data || []).map((booking) => booking.event_id));
    const bookingEvents = new Map((complexBookings.data || []).map((booking) => [booking.id, booking.complex_event_id]));
    for (const checkin of checkins.data || []) {
      if (bookingEvents.has(checkin.booking_id)) attended.add(bookingEvents.get(checkin.booking_id));
    }
    const referenceValid = (condition) => condition.type === 'role'
      ? validRoles.has(condition.id)
      : condition.type === 'member_group'
        ? validGroups.has(condition.id)
        : condition.event_type === 'simple'
          ? validSimpleEvents.has(condition.id)
          : validComplexEvents.has(condition.id);
    const conditionAllowed = (condition) => condition.type === 'role'
      ? condition.id === roleId
      : condition.type === 'member_group'
        ? activeGroups.has(condition.id)
        : attended.has(condition.id);

    return normalized.map((item) => {
      if (!item.ok) return denied('INVALID_ACCESS_POLICY');
      if (!item.restricted) return { allowed: true, code: 'UNRESTRICTED', restricted: false };
      const conditions = item.policy.groups.flatMap((group) => group.conditions);
      if (conditions.some((condition) => !referenceValid(condition))) return denied('INVALID_ACCESS_POLICY');
      const allowed = item.policy.groups.some((group) => group.conditions.every(conditionAllowed));
      return allowed ? { allowed: true, code: 'ACCESS_GRANTED', restricted: true } : denied('GALLERY_ACCESS_DENIED');
    });
  } catch {
    return normalized.map((item) => item.ok && !item.restricted
      ? { allowed: true, code: 'UNRESTRICTED', restricted: false }
      : denied(item.ok ? 'ACCESS_LOOKUP_FAILED' : 'INVALID_ACCESS_POLICY'));
  }
}
