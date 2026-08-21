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
      .in('id', orgIds);
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
export async function grantSpeakerAwardsForEvent(supabase, { eventType, event, speakers, now = new Date() }) {
  const results = [];
  const tenantId = event.tenant_id;
  const config = normalizeSpeakerAwardConfig(event.speaker_award_config);
  if (!config || !config.enabled) return results;

  const matches = await matchSpeakersToMembers(supabase, tenantId, speakers);

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
      if (award.badge_id && match?.member_id) badgeId = award.badge_id;
      if (voucherValue || badgeId) {
        status = 'pending';
        if (award.voucher_value && !voucherValue) {
          detail = match ? 'Voucher skipped: member has no organisation' : 'Voucher skipped: no member found for speaker email';
        }
      } else {
        status = 'skipped_no_member';
        detail = match ? 'Member has no organisation' : 'No member found for speaker email';
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
        .eq('event_type', eventType)
        .eq('event_id', event.id)
        .eq('speaker_id', speaker.id)
        .single();
      if (fetchErr) throw new Error(`grant fetch failed for speaker ${speaker.id}: ${fetchErr.message}`);
      if (existing.status !== 'pending') {
        results.push({ speaker_id: speaker.id, status: 'already_processed' });
        continue;
      }
      grant = existing; // retry a previously-claimed pending grant
    } else {
      grant = claimed;
    }

    if (grant.status !== 'pending') {
      // Skip outcome recorded with its final status at claim time.
      results.push({ speaker_id: speaker.id, status: grant.status });
      continue;
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
    }));
  }

  // Sweep: previously claimed pending grants for speakers no longer attached
  // to the event (speaker list changed between runs). Without this the event
  // could be stamped complete while an owed award stays unfulfilled.
  const processedIds = new Set((speakers || []).map(s => s.id));
  const { data: stale, error: staleErr } = await supabase
    .from('speaker_award_grant')
    .select('id, status, voucher_id, voucher_value, member_badge_id, badge_id, member_id, organization_id, detail, speaker_id, speaker_name')
    .eq('event_type', eventType)
    .eq('event_id', event.id)
    .eq('status', 'pending');
  if (staleErr) throw new Error(`pending grant sweep failed: ${staleErr.message}`);
  for (const grant of stale || []) {
    if (processedIds.has(grant.speaker_id)) continue;
    results.push(await fulfilGrant(supabase, {
      tenantId,
      eventType,
      event,
      config,
      grant,
      speakerId: grant.speaker_id,
      speakerName: grant.speaker_name,
      now,
    }));
  }

  return results;
}

// Idempotently create the voucher/badge a pending grant row owes, then move
// it to 'granted'. Safe to re-run: voucher code is deterministic per grant
// and badge insert dedupes on unique(badge_id, member_id).
async function fulfilGrant(supabase, { tenantId, eventType, event, config, grant, speakerId, speakerName, now }) {
  const updates = {};
  let failed = false;

  if (grant.voucher_value && grant.organization_id && !grant.voucher_id) {
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
    const { data: mb, error: bErr } = await supabase
      .from('member_badge')
      .insert({
        tenant_id: tenantId,
        badge_id: grant.badge_id,
        member_id: grant.member_id,
        source: 'speaker_award',
        source_ref: `${eventType}:${event.id}`,
        created_by: 'system:speaker-awards',
      })
      .select('id')
      .single();
    if (bErr) {
      if (bErr.code === '23505') {
        // Member already holds this badge — treat as fulfilled.
        const { data: held } = await supabase
          .from('member_badge')
          .select('id')
          .eq('badge_id', grant.badge_id)
          .eq('member_id', grant.member_id)
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

  const finalStatus = failed ? 'pending' : 'granted';
  const { error: uErr } = await supabase
    .from('speaker_award_grant')
    .update({ ...updates, status: finalStatus })
    .eq('id', grant.id);
  if (uErr) {
    // Effects may exist but the row still says pending — the next run
    // re-fulfils idempotently (deterministic voucher code, badge dedupe).
    console.error(`[speakerAwards] failed to update grant ${grant.id}: ${uErr.message}`);
    return { speaker_id: speakerId, status: 'pending', ...updates };
  }

  return { speaker_id: speakerId, status: finalStatus, ...updates };
}

function appendDetail(existing, extra) {
  return existing ? `${existing}; ${extra}` : extra;
}
