/**
 * Durable recorder for member-group join/leave events.
 *
 * Each call inserts one row into `member_group_activity`.  The group name is
 * snapshotted at call time so history survives group renames and deletion.
 *
 * Best-effort: never throws — callers should not let recording failures affect
 * the primary operation.
 *
 * @param {object} opts
 * @param {string}  opts.memberId     - Member UUID
 * @param {string}  opts.groupId      - Member-group UUID (may be null when group already deleted)
 * @param {string}  opts.groupName    - Snapshot of the group name at this moment
 * @param {'joined'|'left'} opts.action
 * @param {string|null} [opts.actorEmail]  - Email of the person who triggered the change
 * @param {string}  opts.tenantId     - Tenant UUID
 * @param {object}  opts.supabaseClient - Supabase client to use (avoids circular import)
 */
export async function recordMemberGroupActivity({
  memberId,
  groupId,
  groupName,
  action,
  actorEmail = null,
  tenantId,
  supabaseClient,
}) {
  if (!supabaseClient || !memberId || !tenantId || !groupName || !action) return;
  try {
    const { error } = await supabaseClient
      .from('member_group_activity')
      .insert({
        tenant_id: tenantId,
        member_id: memberId,
        group_id: groupId || null,
        group_name: groupName,
        action,
        actor_email: actorEmail || null,
      });
    if (error) {
      console.warn('[memberGroupActivity] insert failed:', error.message);
    }
  } catch (err) {
    console.warn('[memberGroupActivity] unexpected error:', err.message || err);
  }
}

/**
 * Resolve actor email from a Supabase member row lookup.
 * Returns null on any failure (best-effort).
 */
export async function resolveActorEmail(memberId, supabaseClient) {
  if (!memberId || !supabaseClient) return null;
  try {
    const { data } = await supabaseClient
      .from('member')
      .select('email')
      .eq('id', memberId)
      .maybeSingle();
    return data?.email || null;
  } catch {
    return null;
  }
}
