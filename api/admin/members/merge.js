import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../_lib/roleVisibility.js';
import { anonymizeMember } from '../../_lib/memberAnonymize.js';
import { isMemberSoftDeleted } from '../../_lib/memberLoginResolver.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Core member columns an admin may copy from source onto target. Deliberately
// excludes identity/tenancy columns (id, tenant_id, identity_id, handle,
// is_guest, role_id) — the merge keeps the target's own identity, role and
// organisation unless organisation copy is explicitly chosen.
const COPYABLE_CORE_FIELDS = [
  'first_name', 'last_name', 'email', 'mobile', 'landline', 'job_title',
  'biography', 'profile_photo_url', 'linkedin_url', 'twitter_url',
  'show_in_directory', 'organization_id',
];

// member_id-style references re-pointed from source to target on a full
// merge. Tables/columns that no longer exist are skipped (42P01 / 42703).
// Unique-constraint collisions keep the TARGET row and drop the source row.
const REASSIGN_REFS = [
  { table: 'booking', column: 'member_id' },
  { table: 'complex_event_booking', column: 'member_id' },
  // (complex_event_session_checkin keys by booking_id — it moves with its booking)
  // (program_ticket_transaction keys by member_email — historical snapshot, out of scope)
  { table: 'form_submission', column: 'member_id' },
  { table: 'form_submission', column: 'created_member_id' },
  { table: 'member_group_assignment', column: 'member_id', uniqueCollisions: true },
  { table: 'member_group_guest', column: 'member_id', uniqueCollisions: true },
  { table: 'member_resource_category', column: 'member_id', uniqueCollisions: true },
  { table: 'member_preference_value', column: 'member_id', uniqueCollisions: true },
  { table: 'member_communication_preference', column: 'member_id', uniqueCollisions: true },
  { table: 'member_bookmark', column: 'member_id', uniqueCollisions: true },
  // member_note keys the member the note is ABOUT via target_member_id and
  // its writer via author_member_id (see api/admin/members/[memberId]/notes).
  // Authorship moves too: the source and target are the same person.
  { table: 'member_note', column: 'target_member_id' },
  { table: 'member_note', column: 'author_member_id' },
  { table: 'member_membership_history', column: 'member_id' },
  { table: 'member_membership_invoicing', column: 'member_id', uniqueCollisions: true },
  { table: 'membership_billing_agreements', column: 'member_id' },
  // Financial ownership moves with the person on a full merge (task spec:
  // "DD/billing rows and other member_id references"): recurring payment
  // plans (incl. GoCardless subscription/mandate ids) must follow their
  // billing agreement or DD renewals would run against the anonymised source.
  { table: 'membership_payment_plans', column: 'member_id' },
  { table: 'offline_award_assignment', column: 'member_id' },
  { table: 'engagement_award_assignment', column: 'member_id' },
  { table: 'email_campaign_recipient', column: 'member_id' },
  { table: 'member_inbox_message_state', column: 'member_id', uniqueCollisions: true },
  { table: 'member_inbox_folder', column: 'member_id', uniqueCollisions: true },
  { table: 'support_ticket', column: 'member_id' },
  { table: 'support_ticket_response', column: 'member_id' },
  { table: 'workflow_log', column: 'member_id' },
  { table: 'discount_code_usage', column: 'member_id' },
  // (training_fund_transaction is organization-keyed — no member_id column)
  { table: 'voucher_transaction', column: 'member_id' },
  { table: 'blog_post', column: 'author_id' },
  { table: 'job_posting', column: 'posted_by_member_id' },
  { table: 'vacancy', column: 'posted_by_member_id' },
  { table: 'vacancy_application', column: 'member_id' },
  { table: 'vacancy_award', column: 'awarded_member_id' },
  { table: 'vacancy_award', column: 'awarded_by_member_id' },
  { table: 'vacancy_decline', column: 'declined_member_id' },
  { table: 'vacancy_decline', column: 'declined_by_member_id' },
  { table: 'vacancy_decision_email', column: 'sent_by_member_id' },
  { table: 'form_submission_email', column: 'sent_by_member_id' },
  { table: 'form_submission_saved_view', column: 'member_id' },
  { table: 'discount_code', column: 'member_id' },
  { table: 'article_comment', column: 'author_member_id' },
  { table: 'comment_reaction', column: 'member_id', uniqueCollisions: true },
  { table: 'article_follow', column: 'follower_member_id', uniqueCollisions: true },
  { table: 'article_follow', column: 'followed_member_id', uniqueCollisions: true },
  // organization_note's author column is member_id (organization_id is the subject)
  { table: 'organization_note', column: 'member_id' },
  { table: 'wall_of_fame_person', column: 'member_id' },
  { table: 'forum_thread', column: 'member_id' },
  { table: 'forum_post', column: 'member_id' },
  { table: 'forum_reaction', column: 'member_id', uniqueCollisions: true },
];

const MISSING_CODES = new Set(['42P01', '42703']);

// Exported for tests: keep the reassignment contract inspectable.
export { REASSIGN_REFS };

/**
 * Build the audit-trail member_note row for a completed merge. member_note
 * keys the member the note is about via target_member_id and its writer via
 * author_member_id (matching api/admin/members/[memberId]/notes/index.js).
 * Exported for tests.
 */
export function buildAuditNotePayload({ targetId, adminId, adminName, sourceName, sourceEmail, sourceId, summary, outcomeLabel }) {
  return {
    target_member_id: targetId,
    author_member_id: adminId,
    attachments: [],
    content: `[Member merge] ${adminName} merged "${sourceName}" (${sourceEmail}, id ${sourceId}) into this record on ${new Date().toISOString()}. `
      + `Fields copied: ${summary.copiedCoreFields.length ? summary.copiedCoreFields.join(', ') : 'none'}. `
      + `Custom fields copied: ${summary.copiedCustomFields.length}. `
      + `Engagement statistics ${summary.engagementCopied ? 'copied' : 'not copied'}. `
      + `Source outcome: ${outcomeLabel}.`,
  };
}

async function verifyPermission(req) {
  const sessionMember = await getSessionMember(req);
  if (!sessionMember) return { hasPermission: false, status: 401, error: 'Not authenticated' };
  if (!sessionMember.role_id || !supabase) return { hasPermission: false, status: 403, error: 'Permission denied' };

  const { data: role, error: roleError } = await supabase
    .from('role')
    .select('excluded_features')
    .eq('id', sessionMember.role_id)
    .single();
  if (roleError || !role) return { hasPermission: false, status: 403, error: 'Permission denied' };

  const excludedFeatures = role.excluded_features || [];
  const isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');
  const canEditMembers = isAdmin || !isResourceExcluded(excludedFeatures, 'admin_can_edit_members');
  if (!isAdmin || !canEditMembers) {
    return { hasPermission: false, status: 403, error: 'Only tenant admins with member-edit rights can merge members' };
  }
  return { hasPermission: true, sessionMember };
}

async function resolveMemberTenantId(member, db = supabase) {
  if (member.tenant_id) return member.tenant_id;
  if (member.organization_id) {
    const { data: org } = await db
      .from('organization')
      .select('tenant_id')
      .eq('id', member.organization_id)
      .maybeSingle();
    return org?.tenant_id || null;
  }
  return null;
}

/**
 * Compute a member's engagement totals using the SAME rules as the Team
 * Engagement Report (client/src/pages/TeamEngagementReport.jsx):
 *  - events attended = unique event ids from confirmed bookings + opening balance
 *  - articles published = published blog posts authored + opening balance
 *  - jobs posted = job postings + opening balance
 *  - awards = online awards earned by threshold + offline assignments + opening balance
 *  - engagement awards = engagement award assignments + opening balance
 */
async function computeEngagementTotals(member, db = supabase) {
  const memberId = member.id;
  const ob = member.engagement_opening_balances || {};
  const obEvents = ob.eventsAttended || 0;
  const obArticles = ob.articlesPublished || 0;
  const obJobs = ob.jobsPosted || 0;
  const obAwards = ob.awards || 0;
  const obEngagement = ob.engagementAwards || 0;

  const [bookingsRes, articlesRes, jobsRes, awardsRes, offlineRes, engagementRes] = await Promise.all([
    db.from('booking').select('event_id').eq('member_id', memberId).eq('status', 'confirmed'),
    db.from('blog_post').select('id').eq('author_id', memberId).eq('status', 'published'),
    db.from('job_posting').select('id').eq('posted_by_member_id', memberId),
    db.from('award').select('award_type, threshold').eq('is_active', true),
    db.from('offline_award_assignment').select('id').eq('member_id', memberId),
    db.from('engagement_award_assignment').select('id').eq('member_id', memberId),
  ]);

  // Fail closed: a failed read must never silently count as zero, or the
  // merge could bake incomplete totals into the target's opening balances
  // and then dispose of the source.
  const labelled = [
    ['bookings', bookingsRes], ['articles', articlesRes], ['jobs', jobsRes],
    ['awards', awardsRes], ['offline awards', offlineRes], ['engagement awards', engagementRes],
  ];
  for (const [label, resPart] of labelled) {
    if (resPart.error) {
      throw new Error(`Could not read source engagement data (${label}): ${resPart.error.message}`);
    }
  }

  const uniqueEventIds = new Set((bookingsRes.data || []).map(b => b.event_id).filter(Boolean));
  const eventsAttended = uniqueEventIds.size + obEvents;
  const articlesPublished = (articlesRes.data || []).length + obArticles;
  const jobsPosted = (jobsRes.data || []).length + obJobs;

  const earnedOnlineAwards = (awardsRes.data || []).filter(award => {
    const stat = award.award_type === 'events_attended' ? eventsAttended
      : award.award_type === 'articles_published' ? articlesPublished
      : award.award_type === 'jobs_posted' ? jobsPosted : 0;
    return stat >= award.threshold;
  });

  return {
    eventsAttended,
    articlesPublished,
    jobsPosted,
    awards: earnedOnlineAwards.length + (offlineRes.data || []).length + obAwards,
    engagementAwards: (engagementRes.data || []).length + obEngagement,
    openingBalances: {
      eventsAttended: obEvents,
      articlesPublished: obArticles,
      jobsPosted: obJobs,
      awards: obAwards,
      engagementAwards: obEngagement,
    },
  };
}

/**
 * Re-point one table.column from sourceId to targetId. Bulk first; on a
 * unique-violation fall back to per-row updates, deleting the source row
 * (keeping the target's) when an individual row collides.
 */
async function reassignRef({ table, column }, sourceId, targetId, db = supabase) {
  const { error } = await db
    .from(table)
    .update({ [column]: targetId })
    .eq(column, sourceId);

  if (!error) return { table, column, ok: true };
  if (MISSING_CODES.has(error.code)) return { table, column, ok: true, skipped: 'missing' };

  if (error.code !== '23505') {
    return { table, column, ok: false, error: error.message };
  }

  // Unique collision: per-row, keep target's row on conflict.
  const { data: rows, error: fetchError } = await db
    .from(table)
    .select('id')
    .eq(column, sourceId);
  if (fetchError) return { table, column, ok: false, error: fetchError.message };

  let moved = 0;
  let dropped = 0;
  for (const row of rows || []) {
    const { error: rowError } = await db
      .from(table)
      .update({ [column]: targetId })
      .eq('id', row.id);
    if (!rowError) { moved += 1; continue; }
    if (rowError.code === '23505') {
      const { error: delError } = await db.from(table).delete().eq('id', row.id);
      if (delError) return { table, column, ok: false, error: delError.message };
      dropped += 1;
      continue;
    }
    return { table, column, ok: false, error: rowError.message };
  }
  return { table, column, ok: true, moved, droppedDuplicates: dropped };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const perm = await verifyPermission(req);
  if (!perm.hasPermission) {
    return res.status(perm.status).json({ error: perm.error });
  }
  const adminMember = perm.sessionMember;

  try {
    const {
      action = 'preview',
      sourceId,
      targetId,
      coreFields = [],
      customFieldIds = [],
      includeEngagement = false,
      sourceDisposal = 'keep', // 'reassign' | 'anonymise' | 'keep'
    } = req.body || {};

    if (!UUID_RE.test(String(sourceId)) || !UUID_RE.test(String(targetId))) {
      return res.status(400).json({ error: 'sourceId and targetId must be valid member ids' });
    }
    if (sourceId === targetId) {
      return res.status(400).json({ error: 'Source and target must be different members' });
    }
    if (!['preview', 'execute'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    if (!['reassign', 'anonymise', 'keep'].includes(sourceDisposal)) {
      return res.status(400).json({ error: 'Invalid sourceDisposal' });
    }

    // Load both members and verify same-tenant scope against the caller.
    const { data: memberRows, error: memberError } = await supabase
      .from('member')
      .select('*')
      .in('id', [sourceId, targetId]);
    if (memberError) {
      return res.status(500).json({ error: memberError.message });
    }
    const source = (memberRows || []).find(m => m.id === sourceId);
    const target = (memberRows || []).find(m => m.id === targetId);
    if (!source || !target) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (isMemberSoftDeleted(source) || isMemberSoftDeleted(target)) {
      return res.status(400).json({ error: 'Deleted member records cannot be merged' });
    }
    if (source.is_guest || target.is_guest) {
      return res.status(400).json({ error: 'Guest records cannot be merged' });
    }

    const callerTenantId = await resolveMemberTenantId(adminMember);
    const [sourceTenantId, targetTenantId] = await Promise.all([
      resolveMemberTenantId(source),
      resolveMemberTenantId(target),
    ]);
    if (!callerTenantId || sourceTenantId !== callerTenantId || targetTenantId !== callerTenantId) {
      return res.status(403).json({ error: 'Both members must belong to your tenant' });
    }

    const sameOrganisation = !!source.organization_id
      && source.organization_id === target.organization_id;

    if (action === 'preview') {
      const [sourcePrefs, targetPrefs, sourceEngagement] = await Promise.all([
        supabase.from('member_preference_value').select('field_id, value').eq('member_id', sourceId),
        supabase.from('member_preference_value').select('field_id, value').eq('member_id', targetId),
        computeEngagementTotals(source),
      ]);
      return res.json({
        source,
        target,
        sourcePreferenceValues: sourcePrefs.data || [],
        targetPreferenceValues: targetPrefs.data || [],
        sourceEngagement,
        sameOrganisation,
        copyableCoreFields: COPYABLE_CORE_FIELDS,
      });
    }

    // ---------- execute ----------
    const result = await performMerge({
      db: supabase,
      source,
      target,
      coreFields,
      customFieldIds,
      includeEngagement,
      sourceDisposal,
      adminMember,
      callerTenantId,
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[Member Merge] Error:', error);
    return res.status(500).json({ error: 'Merge failed', details: error.message });
  }
}

/**
 * Execute the merge. Ordering guarantee: ALL non-destructive copies onto the
 * target (core fields, custom values, engagement balances) happen and must
 * succeed BEFORE the source record is touched (history reassignment /
 * anonymisation). Any failure before disposal aborts with the source fully
 * intact. Exported for tests (db is any supabase-compatible client).
 */
export async function performMerge({
  db,
  source,
  target,
  coreFields = [],
  customFieldIds = [],
  includeEngagement = false,
  sourceDisposal = 'keep',
  adminMember,
  callerTenantId,
  // Injectable for tests so unit runs never touch the real session store.
  anonymize = anonymizeMember,
}) {
  const sourceId = source.id;
  const targetId = target.id;
  const warnings = [];
  const summary = {
    copiedCoreFields: [],
    copiedCustomFields: [],
    engagementCopied: false,
    reassigned: [],
    sourceOutcome: sourceDisposal,
  };

  const requestedCore = (Array.isArray(coreFields) ? coreFields : [])
    .filter(f => COPYABLE_CORE_FIELDS.includes(f));
  const requestedCustom = (Array.isArray(customFieldIds) ? customFieldIds : [])
    .filter(f => UUID_RE.test(String(f)));

  // 1) Engagement totals computed BEFORE any history moves. When history is
  // reassigned to the target, only the source's opening balances are folded
  // in (the moved rows will count naturally), avoiding double counting.
  let engagementToAdd = null;
  const targetObCurrent = target.engagement_opening_balances || {};
  const priorMergeCredits = targetObCurrent.mergeCredits || {};
  if (includeEngagement && priorMergeCredits[sourceId]) {
    // Idempotency guard: this source's engagement was already folded into
    // the target on a previous (possibly partially failed) attempt. Never
    // add it twice — a retry must be safe.
    summary.engagementCopied = true;
    summary.engagementAdded = priorMergeCredits[sourceId];
    summary.engagementAlreadyApplied = true;
  } else if (includeEngagement) {
    let totals;
    try {
      totals = await computeEngagementTotals(source, db);
    } catch (engErr) {
      return { status: 500, body: { error: `${engErr.message}. Nothing was changed.`, retryable: true } };
    }
    engagementToAdd = sourceDisposal === 'reassign' ? totals.openingBalances : {
      eventsAttended: totals.eventsAttended,
      articlesPublished: totals.articlesPublished,
      jobsPosted: totals.jobsPosted,
      awards: totals.awards,
      engagementAwards: totals.engagementAwards,
    };
  }

  // 2) Read the source's selected custom values (anonymisation later deletes
  // the source's member_preference_value rows). Failure aborts pre-disposal.
  let sourceCustomValues = [];
  if (requestedCustom.length > 0) {
    const { data: sv, error: prefError } = await db
      .from('member_preference_value')
      .select('field_id, value')
      .eq('member_id', sourceId)
      .in('field_id', requestedCustom);
    if (prefError && !MISSING_CODES.has(prefError.code)) {
      return { status: 500, body: { error: `Could not read source custom values: ${prefError.message}. Nothing was changed.` } };
    }
    sourceCustomValues = sv || [];
  }

  // 3) Copy selected core fields onto the target. Email is deferred until
  // after disposal when the source is being removed (the source still holds
  // it, so copying now would collide with per-tenant email uniqueness).
  let deferredEmail = null;
  if (requestedCore.length > 0) {
    const updates = {};
    for (const field of requestedCore) {
      let value = source[field];
      if (field === 'email' && typeof value === 'string') value = value.toLowerCase();
      updates[field] = value === undefined ? null : value;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'email') && updates.email) {
      if (sourceDisposal === 'reassign' || sourceDisposal === 'anonymise') {
        deferredEmail = updates.email;
        delete updates.email;
      } else {
        // Copy-only merge: the source keeps its email, so copying it to the
        // target would duplicate an active email in the tenant.
        const { data: emailRows } = await db
          .from('member')
          .select('id, email, tenant_id, organization_id')
          .eq('email', updates.email)
          .neq('id', targetId);
        const conflict = (emailRows || []).filter(r => !isMemberSoftDeleted(r));
        let hasTenantConflict = false;
        for (const row of conflict) {
          const rowTenant = await resolveMemberTenantId(row, db);
          if (rowTenant === callerTenantId) { hasTenantConflict = true; break; }
        }
        if (hasTenantConflict) {
          delete updates.email;
          warnings.push('Email was not copied: another active member in this tenant already uses it.');
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await db
        .from('member')
        .update(updates)
        .eq('id', targetId);
      if (updateError) {
        return { status: 500, body: { error: `Failed to copy fields onto the target member: ${updateError.message}. The source record was not changed.` } };
      }
      summary.copiedCoreFields = Object.keys(updates);
    }
  }

  // 4) Copy selected custom preference values (upsert; multi-select values
  // are stored as-is in the value column so they copy intact). A failure
  // here aborts BEFORE disposal so no selected source value can be lost.
  for (const row of sourceCustomValues) {
    const { error: upsertError } = await db
      .from('member_preference_value')
      .upsert(
        { member_id: targetId, field_id: row.field_id, value: row.value },
        { onConflict: 'member_id,field_id' }
      );
    if (upsertError) {
      return { status: 500, body: { error: `Failed to copy custom field values: ${upsertError.message}. The source record was not changed.`, partial: summary } };
    }
    summary.copiedCustomFields.push(row.field_id);
  }

  // 5) Fold engagement totals into the target's opening balances (still
  // before disposal — a failure must not cost the source its history).
  if (engagementToAdd) {
    const targetOb = targetObCurrent;
    const newBalances = {
      ...targetOb,
      eventsAttended: (targetOb.eventsAttended || 0) + (engagementToAdd.eventsAttended || 0),
      articlesPublished: (targetOb.articlesPublished || 0) + (engagementToAdd.articlesPublished || 0),
      jobsPosted: (targetOb.jobsPosted || 0) + (engagementToAdd.jobsPosted || 0),
      awards: (targetOb.awards || 0) + (engagementToAdd.awards || 0),
      engagementAwards: (targetOb.engagementAwards || 0) + (engagementToAdd.engagementAwards || 0),
      // Per-source credit marker: makes the fold-in idempotent, so a retry
      // of a partially failed merge can never double-count.
      mergeCredits: { ...priorMergeCredits, [sourceId]: engagementToAdd },
    };
    const { error: obError } = await db
      .from('member')
      .update({ engagement_opening_balances: newBalances })
      .eq('id', targetId);
    if (obError) {
      return { status: 500, body: { error: `Failed to update engagement opening balances: ${obError.message}. The source record was not changed.`, partial: summary, retryable: true } };
    }
    summary.engagementCopied = true;
    summary.engagementAdded = engagementToAdd;
  }

  // 6) Full merge: re-point every member reference from source to target.
  // Abort (leaving the source row itself intact) on the first hard failure.
  if (sourceDisposal === 'reassign') {
    for (const ref of REASSIGN_REFS) {
      const result = await reassignRef(ref, sourceId, targetId, db);
      if (!result.ok) {
        return {
          status: 500,
          body: {
            error: `Merge stopped while reassigning ${result.table}.${result.column}: ${result.error}. The source member record has not been removed. `
              + 'Reassignment is safe to retry: run the merge again with the same choices to move the remaining history and complete the merge.',
            partial: summary.reassigned,
            retryable: true,
          },
        };
      }
      if (!result.skipped) summary.reassigned.push(result);
    }
  }

  // 7) Remove the source via the existing member-deletion anonymisation
  // (both the full-merge path and the explicit keep-as-deleted path).
  if (sourceDisposal === 'reassign' || sourceDisposal === 'anonymise') {
    const anonResult = await anonymize(sourceId, { supabase: db });
    if (!anonResult.success) {
      return { status: 500, body: { error: anonResult.error || 'Failed to anonymise the source member', partial: summary } };
    }
  }

  // 8) Deferred email copy, now that the source no longer holds the address.
  if (deferredEmail) {
    const { error: emailError } = await db
      .from('member')
      .update({ email: deferredEmail })
      .eq('id', targetId);
    if (emailError) {
      warnings.push(`Email could not be copied onto the kept record: ${emailError.message}`);
    } else {
      summary.copiedCoreFields.push('email');
    }
  }

  // 9) Audit trail: note on the target member's timeline.
  const adminName = `${adminMember.first_name || ''} ${adminMember.last_name || ''}`.trim() || adminMember.email;
  const sourceName = `${source.first_name || ''} ${source.last_name || ''}`.trim() || source.email;
  const outcomeLabel = sourceDisposal === 'reassign'
    ? 'history reassigned to this record and the source record was removed (anonymised)'
    : sourceDisposal === 'anonymise'
      ? 'source record kept as an anonymised deleted member (history retained by its organisation)'
      : 'source record left untouched';
  const auditNote = buildAuditNotePayload({
    targetId,
    adminId: adminMember.id,
    adminName,
    sourceName,
    sourceEmail: source.email,
    sourceId,
    summary,
    outcomeLabel,
  });
  // Retry-safe: skip the audit insert if a merge note for this source
  // already exists on the target (a prior attempt got this far).
  const { data: existingAudit } = await db
    .from('member_note')
    .select('id')
    .eq('target_member_id', targetId)
    .like('content', `%id ${sourceId})%`);
  if ((existingAudit || []).length > 0) {
    summary.auditNoteCreated = true;
    console.log(`[Member Merge] ${adminMember.id} merged ${sourceId} -> ${targetId} (disposal: ${sourceDisposal}, retried)`);
    return { status: 200, body: { success: true, summary, warnings } };
  }
  const { error: auditError } = await db.from('member_note').insert(auditNote);
  if (auditError) {
    warnings.push(`Merge completed but the audit note could not be written: ${auditError.message}`);
    console.error('[Member Merge] Audit note failed:', auditError);
  } else {
    summary.auditNoteCreated = true;
  }

  console.log(`[Member Merge] ${adminMember.id} merged ${sourceId} -> ${targetId} (disposal: ${sourceDisposal})`);
  return { status: 200, body: { success: true, summary, warnings } };
}
