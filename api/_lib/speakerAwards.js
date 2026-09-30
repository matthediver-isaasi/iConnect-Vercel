// Task #3285: speaker awards — training vouchers + library badges granted
// automatically when an event starts.
//
// Config shape (event.speaker_award_config / complex_event.speaker_award_config):
// {
//   enabled: true,
//   default: { voucher_value: 100, voucher_expiry: "2027-01-31", badge_id: "<uuid>|null" },
//   overrides: {
//     "<speakerId>": { excluded: true }
//       | { voucher_value: 50, voucher_expiry: "...", badge_id: "..." }
//   }
// }
//
// Vouchers are organisation-based: a speaker only receives a voucher when
// their email matches a member (case-insensitive) that is connected to an
// organisation. Badges are assigned to the matched member.

export function normalizeSpeakerAwardConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const def = raw.default && typeof raw.default === 'object' ? raw.default : {};
  const overrides = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {};
  const config = {
    enabled: raw.enabled === true,
    // Older saved configurations did not have this field.  Keeping the
    // default here (rather than in clients) makes their behaviour stable.
    badge_timing: raw.badge_timing === 'on_assignment' ? 'on_assignment' : 'event_start',
    default: {
      voucher_value: toPositiveNumber(def.voucher_value),
      voucher_expiry: toDateString(def.voucher_expiry),
      badge_id: def.badge_id || null,
    },
    overrides: {},
  };
  for (const [speakerId, o] of Object.entries(overrides)) {
    if (!o || typeof o !== 'object') continue;
    if (o.excluded === true) {
      config.overrides[speakerId] = { excluded: true };
    } else {
      config.overrides[speakerId] = {
        voucher_value: toPositiveNumber(o.voucher_value),
        voucher_expiry: toDateString(o.voucher_expiry),
        badge_id: o.badge_id || null,
      };
    }
  }
  return config;
}

function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toDateString(v) {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : v;
}

// Effective award for one speaker, or { excluded: true }, or null when the
// resolved award has nothing to grant.
export function resolveSpeakerAward(config, speakerId) {
  const c = normalizeSpeakerAwardConfig(config);
  if (!c || !c.enabled) return null;
  const override = c.overrides[speakerId];
  if (override?.excluded) return { excluded: true };
  const award = {
    voucher_value: override?.voucher_value ?? c.default.voucher_value,
    voucher_expiry: override?.voucher_expiry ?? c.default.voucher_expiry,
    badge_id: override?.badge_id ?? c.default.badge_id,
  };
  // A voucher needs both a value and an expiry date to be grantable.
  if (!award.voucher_value || !award.voucher_expiry) {
    award.voucher_value = null;
    award.voucher_expiry = null;
  }
  if (!award.voucher_value && !award.badge_id) return null;
  return award;
}

// Build a PostgREST `.or()` clause for exact, case-insensitive email matches.
// Escape LIKE wildcards and reserved `.or()` syntax so user-controlled email
// values cannot broaden or alter the filter.
export function buildSpeakerEmailMatchOr(emails) {
  const escapeLike = (value) => String(value).replace(/([%_\\])/g, '\\$1');
  const escapeOr = (value) => String(value).replace(/([\\(),"])/g, '\\$1');
  return emails
    .map((email) => `email.ilike."${escapeOr(escapeLike(email))}"`)
    .join(',');
}

// Match speakers to members using the persisted member link first, then by
// email (case-insensitive) for legacy and ad-hoc speaker profiles. Returns
// { [speakerId]: { member_id, organization_id, organization_name } }.
export async function matchSpeakersToMembers(supabase, tenantId, speakers) {
  const bySpeaker = {};
  const linkedMemberIds = [...new Set(
    (speakers || []).map(s => s?.member_id).filter(Boolean)
  )];
  const emails = [...new Set(
    (speakers || [])
      .map(s => (s?.email || '').trim().toLowerCase())
      .filter(Boolean)
  )];
  if (linkedMemberIds.length === 0 && emails.length === 0) return bySpeaker;

  let linkedMembers = [];
  if (linkedMemberIds.length > 0) {
    const { data, error } = await supabase
      .from('member')
      .select('id, email, organization_id')
      .eq('tenant_id', tenantId)
      .in('id', linkedMemberIds);
    if (error) throw new Error(`linked member lookup failed: ${error.message}`);
    linkedMembers = data || [];
  }

  let emailMembers = [];
  if (emails.length > 0) {
    // Case-insensitive match: emails are stored lowercased by convention, but
    // legacy rows can be mixed-case.
    const { data, error } = await supabase
      .from('member')
      .select('id, email, organization_id')
      .eq('tenant_id', tenantId)
      .or(buildSpeakerEmailMatchOr(emails));
    if (error) throw new Error(`member lookup failed: ${error.message}`);
    emailMembers = data || [];
  }

  const byId = {};
  const byEmail = {};
  linkedMembers.forEach(m => { byId[m.id] = m; });
  emailMembers.forEach(m => {
    const key = (m.email || '').trim().toLowerCase();
    if (key && !byEmail[key]) byEmail[key] = m;
  });

  const allMatchedMembers = [...linkedMembers, ...emailMembers];
  const orgIds = [...new Set(allMatchedMembers.map(m => m.organization_id).filter(Boolean))];
  const orgNames = {};
  if (orgIds.length > 0) {
    const { data: orgs } = await supabase
      .from('organization')
      .select('id, name')
      .in('id', orgIds)
      .eq('tenant_id', tenantId);
    (orgs || []).forEach(o => { orgNames[o.id] = o.name; });
  }

  (speakers || []).forEach(s => {
    const email = (s?.email || '').trim().toLowerCase();
    const m = (s?.member_id && byId[s.member_id]) || (email ? byEmail[email] : null);
    if (m) {
      bySpeaker[s.id] = {
        member_id: m.id,
        organization_id: m.organization_id || null,
        organization_name: m.organization_id ? (orgNames[m.organization_id] || null) : null,
      };
    }
  });
  return bySpeaker;
}

// Deterministic per-grant voucher code so a crash between creating the
// voucher and recording its id can be recovered by looking the code up.
function voucherCodeForGrant(grantId) {
  return `SPK-${String(grantId).replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

// Grant the configured awards for one started event.
//
// Reliability model (at-least-once with dedupe, never double-award):
// 1. Each speaker's grant row is claimed FIRST under the
//    unique(event_type, event_id, speaker_id) constraint. Skip outcomes are
//    written with their final status; grantable outcomes are claimed as
//    'pending' with the intended voucher_value/badge_id snapshot.
// 2. Effects are then fulfilled idempotently: the voucher code is
//    deterministic per grant (looked up before insert), and the badge insert
//    dedupes on unique(badge_id, member_id). The row only moves from
//    'pending' to 'granted' after all intended effects exist.
// 3. On a later run, existing rows in a final state are skipped; rows still
//    'pending' are re-fulfilled. The caller must NOT stamp the event as done
//    while any speaker is left pending.
export async function grantSpeakerAwardsForEvent(supabase, { eventType, event, speakers, now = new Date(), badgeOnly = false }) {
  const results = [];
  const tenantId = event.tenant_id;
  const config = normalizeSpeakerAwardConfig(event.speaker_award_config);
  if (!config || !config.enabled) return results;

  const matches = await matchSpeakersToMembers(supabase, tenantId, speakers);
  const configuredBadgeIds = [...new Set([
    config.default.badge_id,
    ...Object.values(config.overrides)
      .filter(override => !override?.excluded)
      .map(override => override?.badge_id),
  ].filter(Boolean))];
  const tenantBadgeIds = new Set();
  if (configuredBadgeIds.length > 0) {
    const { data: badges, error: badgeError } = await supabase
      .from('badge')
      .select('id')
      .eq('tenant_id', tenantId)
      .in('id', configuredBadgeIds);
    if (badgeError) throw new Error(`badge validation failed: ${badgeError.message}`);
    (badges || []).forEach(badge => tenantBadgeIds.add(badge.id));
  }

  for (const speaker of speakers || []) {
    const award = resolveSpeakerAward(config, speaker.id);
    const match = matches[speaker.id] || null;

    // Decide the intended outcome.
    let status; // final skip status, or 'pending' when something is grantable
    let detail = null;
    let voucherValue = null;
    let badgeId = null;

    if (!award) {
      status = 'skipped_no_award';
    } else if (award.excluded) {
      status = 'skipped_excluded';
    } else {
      if (award.voucher_value && match?.organization_id) voucherValue = award.voucher_value;
      if (award.badge_id && !tenantBadgeIds.has(award.badge_id)) {
        detail = 'Badge skipped: badge not found for tenant';
      } else if (award.badge_id && match?.member_id) {
        badgeId = award.badge_id;
      }
      if (voucherValue || badgeId) {
        status = 'pending';
        if (award.voucher_value && !voucherValue) {
          detail = appendDetail(
            detail,
            match ? 'Voucher skipped: member has no organisation' : 'Voucher skipped: no member found for speaker email',
          );
        }
      } else {
        status = award.badge_id && !tenantBadgeIds.has(award.badge_id) && !award.voucher_value
          ? 'skipped_no_award'
          : 'skipped_no_member';
        if (award.voucher_value || tenantBadgeIds.has(award.badge_id)) {
          detail = appendDetail(detail, match ? 'Member has no organisation' : 'No member found for speaker email');
        }
      }
    }

    // Claim (or find) the grant row.
    let grant = null;
    const { data: claimed, error: claimError } = await supabase
      .from('speaker_award_grant')
      .insert({
        tenant_id: tenantId,
        event_type: eventType,
        event_id: event.id,
        speaker_id: speaker.id,
        speaker_name: speaker.full_name || null,
        member_id: match?.member_id || null,
        organization_id: match?.organization_id || null,
        status,
        voucher_value: voucherValue,
        badge_id: badgeId,
        detail,
      })
      .select('id, status, voucher_id, voucher_value, member_badge_id, badge_id, member_id, organization_id, detail')
      .single();

    if (claimError) {
      if (claimError.code !== '23505') {
        throw new Error(`grant claim failed for speaker ${speaker.id}: ${claimError.message}`);
      }
      const { data: existing, error: fetchErr } = await supabase
        .from('speaker_award_grant')
        .select('id, status, voucher_id, voucher_value, member_badge_id, badge_id, member_id, organization_id, detail')
        .eq('tenant_id', tenantId)
        .eq('event_type', eventType)
        .eq('event_id', event.id)
        .eq('speaker_id', speaker.id)
        .single();
      if (fetchErr) throw new Error(`grant fetch failed for speaker ${speaker.id}: ${fetchErr.message}`);
      const reopenGrantedForVoucher = !badgeOnly && existing.status === 'granted'
        && !existing.voucher_id && Boolean(voucherValue);
      const reopenSkippedAtStart = !badgeOnly
        && ['skipped_no_member', 'skipped_no_award', 'skipped_excluded'].includes(existing.status)
        && Boolean(voucherValue || badgeId);
      if (existing.status === 'cancelled' || reopenGrantedForVoucher || reopenSkippedAtStart) {
        // This transition locks the ledger row. It also avoids carrying an
        // active badge across a changed member/badge pairing.
        const recomputeAll = existing.status !== 'granted';
        const revived = await reactivateSpeakerAwardGrant(supabase, {
          tenantId, grantId: existing.id,
          memberId: recomputeAll ? (match?.member_id || null) : existing.member_id,
          organizationId: match?.organization_id || null,
          badgeId: recomputeAll ? badgeId : existing.badge_id,
          voucherValue,
          resetBadge: recomputeAll,
        });
        grant = revived;
      } else if (existing.status !== 'pending') {
        results.push({ speaker_id: speaker.id, status: 'already_processed' });
        continue;
      } else {
        grant = existing; // retry a previously-claimed pending grant
      }
    } else {
      grant = claimed;
    }

    if (grant.status !== 'pending') {
      // Skip outcome recorded with its final status at claim time.
      results.push({ speaker_id: speaker.id, status: grant.status });
      continue;
    }
    // Assignment-time processing must not freeze a future voucher. At event
    // start refresh its value and organisation from the then-current config
    // and member relationship before fulfilment.
    if (!badgeOnly && !grant.voucher_id) {
      const { error: refreshError } = await supabase.from('speaker_award_grant')
        .update({ voucher_value: voucherValue, organization_id: match?.organization_id || null })
        .eq('id', grant.id).eq('tenant_id', tenantId);
      if (refreshError) throw new Error(`voucher intent refresh failed for speaker ${speaker.id}: ${refreshError.message}`);
      grant = { ...grant, voucher_value: voucherValue, organization_id: match?.organization_id || null };
    }

    results.push(await fulfilGrant(supabase, {
      tenantId,
      eventType,
      event,
      config,
      grant,
      speakerId: speaker.id,
      speakerName: speaker.full_name || null,
      now,
      badgeOnly,
    }));
  }

  // A removed speaker must never be fulfilled by a later sweep.  In
  // particular this is important for assignment-time badge claims.
  const processedIds = new Set((speakers || []).map(s => s.id));
  const { data: stale, error: staleErr } = await supabase
    .from('speaker_award_grant')
    .select('id, status, voucher_id, voucher_value, member_badge_id, badge_id, member_id, organization_id, detail, speaker_id, speaker_name')
    .eq('tenant_id', tenantId)
    .eq('event_type', eventType)
    .eq('event_id', event.id)
    .eq('status', 'pending');
  if (staleErr) throw new Error(`pending grant sweep failed: ${staleErr.message}`);
  for (const grant of stale || []) {
    if (processedIds.has(grant.speaker_id)) continue;
    const { error: cancelError } = await supabase
      .from('speaker_award_grant')
      .update({ status: 'cancelled', detail: appendDetail(grant.detail, 'Speaker removed before award fulfilment') })
      .eq('id', grant.id)
      .eq('tenant_id', tenantId);
    if (cancelError) throw new Error(`stale grant cancellation failed: ${cancelError.message}`);
    results.push({ speaker_id: grant.speaker_id, status: 'cancelled' });
  }

  return results;
}

// Idempotently create the voucher/badge a pending grant row owes, then move
// it to 'granted'. Safe to re-run: voucher code is deterministic per grant
// and badge insert dedupes on unique(badge_id, member_id).
async function fulfilGrant(supabase, { tenantId, eventType, event, config, grant, speakerId, speakerName, now, badgeOnly = false }) {
  const updates = {};
  let failed = false;
  let invalidBadge = false;

  if (!badgeOnly && grant.voucher_value && grant.organization_id && !grant.voucher_id) {
    const code = voucherCodeForGrant(grant.id);
    try {
      // Crash recovery: the voucher may already exist from a previous run.
      const { data: existingVoucher, error: lookupErr } = await supabase
        .from('voucher')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('code', code)
        .maybeSingle();
      if (lookupErr) throw new Error(lookupErr.message);
      if (existingVoucher) {
        updates.voucher_id = existingVoucher.id;
      } else {
        const { data: voucher, error: vErr } = await supabase
          .from('voucher')
          .insert({
            tenant_id: tenantId,
            organization_id: grant.organization_id,
            code,
            value: grant.voucher_value,
            description: `Speaker award — ${event.title} — ${speakerName || 'Speaker'}`,
            expires_at: resolveSpeakerAward(config, speakerId)?.voucher_expiry,
            issued_at: now.toISOString(),
            status: 'active',
            funding_source: 'Speaker award',
            created_by: 'system:speaker-awards',
          })
          .select('id')
          .single();
        if (vErr) throw new Error(vErr.message);
        updates.voucher_id = voucher.id;
      }
    } catch (err) {
      failed = true;
      updates.detail = appendDetail(grant.detail, `Voucher creation failed (will retry): ${err.message}`);
    }
  }

  if (grant.badge_id && grant.member_id && !grant.member_badge_id) {
    const { data: ownedBadge, error: badgeLookupError } = await supabase
      .from('badge')
      .select('id')
      .eq('id', grant.badge_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (badgeLookupError) {
      failed = true;
      updates.detail = appendDetail(updates.detail ?? grant.detail, `Badge validation failed (will retry): ${badgeLookupError.message}`);
    } else if (!ownedBadge) {
      invalidBadge = true;
      updates.badge_id = null;
      updates.detail = appendDetail(updates.detail ?? grant.detail, 'Badge skipped: badge not found for tenant');
    } else {
      const { data: mb, error: bErr } = await supabase
        .from('member_badge')
        .insert({
          tenant_id: tenantId,
          badge_id: grant.badge_id,
          member_id: grant.member_id,
          source: 'speaker_award',
          source_ref: `${eventType}:${event.id}`,
          created_by: 'system:speaker-awards',
          awarded_by_type: 'system',
          awarded_by_label: 'Speaker awards automation',
        })
        .select('id')
        .single();
      if (bErr) {
        if (bErr.code === '23505') {
          // Member already holds this badge — treat as fulfilled.
          const { data: held } = await supabase
            .from('member_badge')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('badge_id', grant.badge_id)
            .eq('member_id', grant.member_id)
            .is('revoked_at', null)
            .maybeSingle();
          if (held) {
            updates.member_badge_id = held.id;
            updates.detail = appendDetail(updates.detail ?? grant.detail, 'Badge already held by member');
          } else {
            failed = true;
            updates.detail = appendDetail(updates.detail ?? grant.detail, 'Badge assignment conflict (will retry)');
          }
        } else {
          failed = true;
          updates.detail = appendDetail(updates.detail ?? grant.detail, `Badge assignment failed (will retry): ${bErr.message}`);
        }
      } else {
        updates.member_badge_id = mb.id;
      }
    }
  }

  const remainingVoucher = grant.voucher_value && !grant.voucher_id && !updates.voucher_id;
  // Badge-only fulfilment deliberately leaves a voucher (if configured)
  // pending for the event-start cron. Vouchers never move earlier.
  const finalStatus = failed || (badgeOnly && remainingVoucher)
    ? 'pending'
    : (invalidBadge && !grant.voucher_value && !grant.voucher_id ? 'skipped_no_award' : 'granted');
  const { error: uErr } = await supabase
    .from('speaker_award_grant')
    .update({ ...updates, status: finalStatus })
    .eq('id', grant.id)
    .eq('tenant_id', tenantId);
  if (uErr) {
    // Effects may exist but the row still says pending — the next run
    // re-fulfils idempotently (deterministic voucher code, badge dedupe).
    console.error(`[speakerAwards] failed to update grant ${grant.id}: ${uErr.message}`);
    return { speaker_id: speakerId, status: 'pending', ...updates };
  }

  return { speaker_id: speakerId, status: finalStatus, ...updates };
}

// Reconcile badges when an event is saved with badge_timing=on_assignment.
// This intentionally uses the normal grant ledger: vouchers are recorded as
// owed but are not fulfilled until the event-start cron calls the normal path.
export async function reconcileAssignmentSpeakerBadges(supabase, {
  eventType, event, speakers, revokeRemoved = false, actor = {},
  removeGrant = removeSpeakerAwardGrant,
}) {
  const config = normalizeSpeakerAwardConfig(event.speaker_award_config);
  // Removal remains available even after an administrator changes timing or
  // disables the config: a badge already attributed to this event still needs
  // provenance-safe reconciliation. Only new immediate awards need this mode.
  const results = config?.enabled && config.badge_timing === 'on_assignment'
    && event.status === 'published' && event.event_state !== 'draft'
    ? await grantSpeakerAwardsForEvent(supabase, {
      eventType, event, speakers, badgeOnly: true,
    })
    : [];
  const currentSpeakerIds = new Set((speakers || []).map(s => s.id).filter(Boolean));
  const { data: grants, error } = await supabase
    .from('speaker_award_grant')
    .select('id, speaker_id, member_id, badge_id, member_badge_id, detail, status, removal_reconciled_at, removal_revoke_requested')
    .eq('tenant_id', event.tenant_id)
    .eq('event_type', eventType)
    .eq('event_id', event.id);
  if (error) throw new Error(`grant reconciliation lookup failed: ${error.message}`);

  let removed = 0;
  let revoked = 0;
  for (const grant of grants || []) {
    if (currentSpeakerIds.has(grant.speaker_id)) continue;
    const outcome = await removeGrant(supabase, {
      tenantId: event.tenant_id, grantId: grant.id, revokeRemoved, actor,
    });
    if (outcome.status === 'processed') removed += 1;
    if (outcome.revoked) revoked += 1;
  }
  return { timing: config?.badge_timing || 'event_start', results, removed, revoked };
}

// The RPC does all decision/revoke work in one transaction. Do not emulate it
// in JS: a network failure must leave the operation retryable rather than
// guessing whether a badge was revoked.
export async function removeSpeakerAwardGrant(supabase, { tenantId, grantId, revokeRemoved, actor }) {
  const { data, error } = await supabase.rpc('reconcile_removed_speaker_award_grant', {
    p_tenant_id: tenantId, p_grant_id: grantId, p_revoke: revokeRemoved,
    p_actor_type: actor.type || 'system', p_actor_id: actor.id || null,
    p_actor_label: actor.label || 'Speaker assignment reconciliation',
  });
  if (error) throw new Error(`speaker award removal reconciliation failed: ${error.message}`);
  if (!data || typeof data !== 'object') throw new Error('speaker award removal reconciliation returned no result');
  return data;
}

// Locks and reopens a cancelled/currently-incomplete grant. The RPC checks an
// active member_badge before retaining its id, preventing a changed speaker
// match or badge config from inheriting an unrelated historical badge.
export async function reactivateSpeakerAwardGrant(supabase, input) {
  const { data, error } = await supabase.rpc('reactivate_speaker_award_grant', {
    p_tenant_id: input.tenantId, p_grant_id: input.grantId,
    p_member_id: input.memberId, p_organization_id: input.organizationId,
    p_badge_id: input.badgeId, p_voucher_value: input.voucherValue,
    p_reset_badge: input.resetBadge,
  });
  if (error) throw new Error(`speaker award reactivation failed: ${error.message}`);
  if (!data || typeof data !== 'object') throw new Error('speaker award reactivation returned no result');
  return data;
}

function appendDetail(existing, extra) {
  return existing ? `${existing}; ${extra}` : extra;
}
