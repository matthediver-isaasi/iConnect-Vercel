import { supabase as defaultSupabase } from './database.js';
import { invalidateMemberSessions } from './session.js';

/**
 * Anonymise ("soft delete") a member row in place.
 *
 * Extracted from the Member branch of the generic entity DELETE handler so
 * the admin merge flow can reuse the exact same behaviour:
 *  - all sessions invalidated
 *  - magic links removed (keyed by email)
 *  - personal-data side tables deleted
 *  - the member row PII-scrubbed, email -> deleted_<id>@deleted.local,
 *    login disabled, row + organisation link + history preserved
 *  - stale tenant_membership.member_id references cleared
 *
 * Returns { success: true } or { success: false, error }.
 */
export async function anonymizeMember(memberId, { supabase = defaultSupabase } = {}) {
  const id = memberId;
  if (!supabase) return { success: false, error: 'Database not configured' };
  console.log(`[Member Delete] Starting anonymization and cleanup for member ${id}`);

  // SECURITY: Invalidate all sessions for this member FIRST to force immediate logout
  const sessionResult = await invalidateMemberSessions(id);
  console.log(`[Member Delete] Session invalidation result:`, sessionResult);

  // Look up member's email before anonymization so we can clean up magic_link
  // (magic_link is keyed by email, not member_id)
  const { data: memberRow, error: memberFetchError } = await supabase
    .from('member')
    .select('email')
    .eq('id', id)
    .single();
  if (memberFetchError) {
    console.log(`[Member Delete] Note: Could not fetch member email for magic_link cleanup: ${memberFetchError.message}`);
  }
  const memberEmail = memberRow?.email ? memberRow.email.toLowerCase() : null;

  if (memberEmail) {
    const { error: magicLinkError } = await supabase
      .from('magic_link')
      .delete()
      .eq('email', memberEmail);
    if (magicLinkError) {
      console.log(`[Member Delete] Note: Could not delete from magic_link.email: ${magicLinkError.message}`);
    } else {
      console.log(`[Member Delete] Deleted magic_link rows for email ${memberEmail}`);
    }
  }

  // Delete from member-related tables (personal data, preferences, activity)
  const deleteTables = [
    { table: 'member_resource_category', column: 'member_id' },
    { table: 'member_group_assignment', column: 'member_id' },
    { table: 'member_group_guest', column: 'member_id' },
    { table: 'member_preference_value', column: 'member_id' },
    { table: 'member_communication_preference', column: 'member_id' },
    { table: 'member_credentials', column: 'member_id' },
    { table: 'article_follow', column: 'follower_member_id' },
    { table: 'article_follow', column: 'followed_member_id' },
    { table: 'article_comment', column: 'author_member_id' },
    { table: 'comment_reaction', column: 'member_id' },
    { table: 'form_submission', column: 'member_id' },
    { table: 'support_ticket_response', column: 'member_id' },
    { table: 'support_ticket', column: 'member_id' },
    { table: 'workflow_log', column: 'member_id' },
    // organization_note's author column is member_id (organization_id is the subject)
    { table: 'organization_note', column: 'member_id' },
  ];

  for (const { table, column } of deleteTables) {
    const { error: deleteError } = await supabase
      .from(table)
      .delete()
      .eq(column, id);

    if (deleteError) {
      console.log(`[Member Delete] Note: Could not delete from ${table}.${column}: ${deleteError.message}`);
    } else {
      console.log(`[Member Delete] Deleted records from ${table} where ${column} = ${id}`);
    }
  }

  // Nullify member references that should be preserved (history kept, just unlinked)
  const memberNullifyTables = [
    { table: 'form_submission', column: 'created_member_id' },
  ];
  for (const { table, column } of memberNullifyTables) {
    const { error: nullifyError } = await supabase
      .from(table)
      .update({ [column]: null })
      .eq(column, id);
    if (nullifyError) {
      console.log(`[Member Delete] Note: Could not nullify ${table}.${column}: ${nullifyError.message}`);
    } else {
      console.log(`[Member Delete] Nullified ${table}.${column} references for member ${id}`);
    }
  }

  // article_view and article_reaction track members via user_identifier+is_member
  // (no member_id column). Only delete member rows; leave guest rows (is_member=false) alone.
  for (const memberTrackedTable of ['article_view', 'article_reaction']) {
    const { error: deleteError } = await supabase
      .from(memberTrackedTable)
      .delete()
      .eq('is_member', true)
      .eq('user_identifier', id);

    if (deleteError) {
      console.log(`[Member Delete] Note: Could not delete from ${memberTrackedTable}: ${deleteError.message}`);
    } else {
      console.log(`[Member Delete] Deleted member records from ${memberTrackedTable} where user_identifier = ${id}`);
    }
  }

  // Anonymize the member record - clear ALL personal data but keep id
  // Based on actual schema/Member.json columns
  const { error: anonymizeError } = await supabase
    .from('member')
    .update({
      email: `deleted_${id}@deleted.local`,
      first_name: 'Deleted',
      last_name: 'Member',
      handle: null,
      job_title: null,
      biography: null,
      profile_photo_url: null,
      login_enabled: false,
      show_in_directory: false,
    })
    .eq('id', id);

  if (anonymizeError) {
    console.error(`[Member Delete] Error anonymizing member ${id}:`, anonymizeError);
    return { success: false, error: 'Failed to anonymize member data' };
  }

  // Clear stale tenant_membership.member_id references that point at
  // this now-deleted member. Otherwise the auth flow can resolve the
  // soft-deleted row when a future member is created for the same
  // identity in this tenant, causing the admin "Active" badge and
  // login to disagree.
  try {
    const { error: tmClearError } = await supabase
      .from('tenant_membership')
      .update({ member_id: null })
      .eq('member_id', id);
    if (tmClearError) {
      console.log(`[Member Delete] Note: Could not clear tenant_membership.member_id for ${id}: ${tmClearError.message}`);
    } else {
      console.log(`[Member Delete] Cleared tenant_membership.member_id references for ${id}`);
    }
  } catch (tmErr) {
    console.error(`[Member Delete] Error clearing tenant_membership.member_id for ${id}:`, tmErr);
  }

  console.log(`[Member Delete] Successfully anonymized member ${id} and deleted related data`);
  return { success: true };
}
