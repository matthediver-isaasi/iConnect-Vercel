import { supabase } from './database.js';

/**
 * Group Files side-effect (Task #1575).
 *
 * Each member group gets its own File Repository folder (file_repository_folder
 * linked to the group via its member_group_id column). Group resource uploads
 * (created from /MemberGroupDetail) land in this folder so tenant admins can find
 * them in /FileManagement. The folder is provisioned once, at group-create time;
 * existing groups are intentionally NOT backfilled (out of scope).
 *
 * Best-effort: logs errors but never throws — provisioning is a background concern.
 */
export async function syncGroupFileRepositoryFolder(groupId) {
  if (!supabase || !groupId) return { ok: false, reason: 'no_supabase_or_group' };

  try {
    const { data: group, error: groupErr } = await supabase
      .from('member_group')
      .select('id, name, tenant_id')
      .eq('id', groupId)
      .maybeSingle();
    if (groupErr || !group) {
      return { ok: false, reason: 'group_not_found' };
    }

    const tenantId = group.tenant_id;
    if (!tenantId) return { ok: false, reason: 'no_tenant' };

    // Idempotent: if a linked folder already exists, do nothing.
    const { data: existing, error: existingErr } = await supabase
      .from('file_repository_folder')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('member_group_id', groupId)
      .limit(1);
    if (existingErr) {
      console.error('[syncGroupFileRepositoryFolder] lookup failed:', existingErr.message);
      return { ok: false, reason: 'lookup_failed' };
    }
    if (existing && existing.length > 0) {
      return { ok: true, action: 'exists', folderId: existing[0].id };
    }

    // Place the new folder after existing top-level folders for a stable order.
    const { count } = await supabase
      .from('file_repository_folder')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .is('parent_folder_id', null);

    const { data: created, error: createErr } = await supabase
      .from('file_repository_folder')
      .insert({
        tenant_id: tenantId,
        name: group.name || 'Group Resources',
        description: `Resource uploads for the ${group.name || 'group'} member group.`,
        parent_folder_id: null,
        display_order: typeof count === 'number' ? count : 0,
        member_group_id: groupId,
      })
      .select('id')
      .single();
    if (createErr) {
      console.error('[syncGroupFileRepositoryFolder] create failed:', createErr.message);
      return { ok: false, reason: 'create_failed' };
    }

    return { ok: true, action: 'created', folderId: created?.id };
  } catch (err) {
    console.error('[syncGroupFileRepositoryFolder] unexpected error:', err.message || err);
    return { ok: false, reason: 'exception' };
  }
}

/**
 * Hook invoked after a member-group create. Provisions the group's File
 * Repository folder. Mirrors handleMemberGroupForumChange but only acts on the
 * 'membergroup' entity (assignment changes do not affect the folder).
 *
 * Best-effort.
 */
export async function handleMemberGroupFilesChange({ entityNorm, data, beforeData }) {
  if (!supabase) return;
  try {
    if (entityNorm !== 'membergroup') return;
    const groupId = data?.id || beforeData?.id;
    if (!groupId) return;
    await syncGroupFileRepositoryFolder(groupId);
  } catch (err) {
    console.error('[handleMemberGroupFilesChange] unexpected error:', err.message || err);
  }
}
