// Task #3287: notification emails when a speaker award grant is fulfilled.
//
// When the grant cron moves a speaker_award_grant row to 'granted', we email:
//   - the matched member (speaker) — voucher and/or badge details;
//   - the organisation's billing contact (invoicing_email, falling back to the
//     primary-contact member) when a voucher was issued, since vouchers are
//     organisation-based.
//
// Delivery model (at-least-once per recipient, deduped by lease + delivery stamp):
//   - Each recipient has TWO columns: an in-flight send LEASE
//     (member_notify_lease_at / org_notify_lease_at) and a DELIVERED stamp
//     (member_notified_at / org_notified_at) set only AFTER a confirmed send.
//   - A worker acquires the lease with a compare-and-set update before
//     sending (…is(lease, null), or CAS against the exact stale value when a
//     lease is older than LEASE_TTL_MS — a crashed worker's abandoned claim).
//     An unexpired lease held elsewhere is skipped, never treated as
//     delivered.
//   - On send success the delivered stamp is written and the lease cleared;
//     on failure the lease is released (CAS on our own lease value) so a
//     later sweep retries. A crash between send and stamp means one duplicate
//     email after lease expiry — acceptable for notifications; an owed email
//     is never lost.
//   - notified_at (the overall-done marker the sweep filters on) is stamped
//     only after RE-READING the row and confirming every required recipient
//     has a delivered stamp.
//   - The sweep (sendPendingSpeakerAwardNotifications) queries unnotified
//     granted rows INDEPENDENTLY of the event's speaker_awards_granted_at
//     stamp, so failed sends are retried even after the event leaves the
//     grant queue.

import { supabase as defaultSupabase } from './database.js';
import { sendTenantEmail } from './tenantEmailService.js';
import { getTenantBaseUrl } from './campaignService.js';

const SWEEP_LIMIT = 50;
// A send lease older than this is considered abandoned (worker crashed
// mid-send) and may be stolen. Cron cadence is minutes, sends are seconds.
export const LEASE_TTL_MS = 15 * 60 * 1000;

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatValue(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `£${n.toFixed(2)}` : null;
}

const GRANT_COLUMNS = 'id, tenant_id, event_type, event_id, speaker_id, speaker_name, member_id, organization_id, status, voucher_id, voucher_value, badge_id, member_badge_id, notified_at, member_notified_at, org_notified_at, member_notify_lease_at, org_notify_lease_at';

// Sweep ALL granted-but-unnotified rows (regardless of whether their event is
// still in the grant queue) and send the owed notification emails.
// Never throws: returns { notified, failed } and logs failures.
export async function sendPendingSpeakerAwardNotifications({
  db = defaultSupabase,
  send = sendTenantEmail,
  limit = SWEEP_LIMIT,
} = {}) {
  const summary = { notified: 0, failed: 0 };
  try {
    const { data: grants, error } = await db
      .from('speaker_award_grant')
      .select(GRANT_COLUMNS)
      .eq('status', 'granted')
      .is('notified_at', null)
      .limit(limit);
    if (error) throw new Error(`unnotified grant fetch failed: ${error.message}`);
    if (!grants || grants.length === 0) return summary;

    // Resolve the events behind the grants (title + tenant for the emails).
    const events = {}; // `${event_type}:${event_id}` -> event row
    for (const grant of grants) {
      const key = `${grant.event_type}:${grant.event_id}`;
      if (events[key] !== undefined) continue;
      const table = grant.event_type === 'event' ? 'event' : 'complex_event';
      const { data: ev, error: evErr } = await db
        .from(table)
        .select('id, tenant_id, title')
        .eq('id', grant.event_id)
        .maybeSingle();
      if (evErr) {
        console.error(`[speakerAwardEmails] event fetch failed for ${key}: ${evErr.message}`);
        events[key] = null;
        continue;
      }
      events[key] = ev || null;
    }

    // Tenant slugs for portal links (one lookup per tenant).
    const baseUrls = {};
    for (const grant of grants) {
      if (baseUrls[grant.tenant_id] !== undefined) continue;
      const { data: tenant } = await db
        .from('tenant')
        .select('slug')
        .eq('id', grant.tenant_id)
        .maybeSingle();
      baseUrls[grant.tenant_id] = getTenantBaseUrl(tenant?.slug || null);
    }

    for (const grant of grants) {
      const event = events[`${grant.event_type}:${grant.event_id}`];
      if (!event) {
        summary.failed += 1;
        continue; // event unfetchable — retried next sweep
      }
      const result = await notifyGrant(db, send, { event, grant, baseUrl: baseUrls[grant.tenant_id] });
      summary.notified += result.notified;
      summary.failed += result.failed;
    }
  } catch (err) {
    console.error(`[speakerAwardEmails] sweep failed: ${err.message}`);
  }
  return summary;
}

// Try to acquire a recipient's send lease. Returns the lease value we hold,
// or null when the lease is held (unexpired) by another worker.
// Acquisition is a compare-and-set: either lease IS NULL, or CAS against the
// exact stale value of an abandoned (expired) lease.
async function acquireLease(db, { grantId, leaseColumn, currentLease, now }) {
  const leaseValue = now.toISOString();

  if (!currentLease) {
    const { data, error } = await db
      .from('speaker_award_grant')
      .update({ [leaseColumn]: leaseValue })
      .eq('id', grantId)
      .is(leaseColumn, null)
      .select('id');
    if (error) throw new Error(`lease acquire failed: ${error.message}`);
    return data && data.length > 0 ? leaseValue : null;
  }

  const age = now.getTime() - new Date(currentLease).getTime();
  if (!(Number.isFinite(age) && age > LEASE_TTL_MS)) return null; // live lease elsewhere

  // Steal an abandoned lease: CAS against its exact old value so only one
  // worker wins.
  const { data, error } = await db
    .from('speaker_award_grant')
    .update({ [leaseColumn]: leaseValue })
    .eq('id', grantId)
    .eq(leaseColumn, currentLease)
    .select('id');
  if (error) throw new Error(`lease steal failed: ${error.message}`);
  return data && data.length > 0 ? leaseValue : null;
}

// Release a lease we hold — CAS on our exact lease value, so a lease stolen
// from us (after expiry) is never cleared out from under its new holder.
async function releaseLease(db, grantId, leaseColumn, leaseValue) {
  const { error } = await db
    .from('speaker_award_grant')
    .update({ [leaseColumn]: null })
    .eq('id', grantId)
    .eq(leaseColumn, leaseValue)
    .select('id');
  if (error) console.error(`[speakerAwardEmails] failed to release ${leaseColumn} for grant ${grantId}: ${error.message}`);
}

// Process one grant: lease + send + stamp each outstanding recipient, then
// stamp notified_at only once a RE-READ confirms every required recipient has
// a confirmed-delivery stamp.
async function notifyGrant(db, send, { event, grant, baseUrl, now = new Date() }) {
  const result = { notified: 0, failed: 0 };
  try {
    const ctx = await buildGrantContext(db, { event, grant, baseUrl });

    let anyFailed = false;
    let anyDeliveredByUs = false;
    for (const recipient of ctx.recipients) {
      if (grant[recipient.deliveredColumn]) continue; // already delivered

      let lease = null;
      try {
        lease = await acquireLease(db, {
          grantId: grant.id,
          leaseColumn: recipient.leaseColumn,
          currentLease: grant[recipient.leaseColumn],
          now,
        });
      } catch (err) {
        console.error(`[speakerAwardEmails] ${recipient.leaseColumn} for grant ${grant.id}: ${err.message}`);
        anyFailed = true;
        continue;
      }
      if (!lease) continue; // in-flight elsewhere — never treated as delivered

      // Post-acquire recheck: another worker may have stamped delivery
      // between our sweep read and the lease acquisition (e.g. we stole a
      // lease whose original holder had actually completed the send). Never
      // send against an existing delivery stamp.
      {
        const { data: check, error: checkErr } = await db
          .from('speaker_award_grant')
          .select(GRANT_COLUMNS)
          .eq('id', grant.id)
          .maybeSingle();
        if (checkErr || !check) {
          console.error(`[speakerAwardEmails] pre-send recheck failed for grant ${grant.id}: ${checkErr?.message || 'row missing'}`);
          anyFailed = true;
          await releaseLease(db, grant.id, recipient.leaseColumn, lease);
          continue;
        }
        if (check[recipient.deliveredColumn]) {
          await releaseLease(db, grant.id, recipient.leaseColumn, lease);
          continue; // already delivered by someone else
        }
      }

      let sent = false;
      try {
        const sendResult = await send({
          tenantId: grant.tenant_id,
          to: recipient.email,
          subject: ctx.subject,
          html: recipient.html,
        });
        sent = !!sendResult?.success;
        if (!sent) console.error(`[speakerAwardEmails] send failed for grant ${grant.id} to ${recipient.email}: ${sendResult?.error || 'unknown error'}`);
      } catch (err) {
        console.error(`[speakerAwardEmails] send threw for grant ${grant.id} to ${recipient.email}: ${err.message}`);
      }

      if (sent) {
        anyDeliveredByUs = true;
        // Delivery stamp only after a confirmed send. CAS on `IS NULL` so a
        // concurrent worker's stamp is never overwritten, and the lease is
        // NOT touched here — if ours was stolen mid-send, clearing the lease
        // unconditionally would clobber the thief's claim and reopen it to
        // yet more workers. The lease is released separately, CAS'd on OUR
        // exact value only.
        const { error: stampErr } = await db
          .from('speaker_award_grant')
          .update({ [recipient.deliveredColumn]: new Date().toISOString() })
          .eq('id', grant.id)
          .is(recipient.deliveredColumn, null);
        if (stampErr) {
          // Email went out but the stamp failed — the lease expires and a
          // later sweep resends (at-least-once). Log loudly.
          console.error(`[speakerAwardEmails] failed to stamp ${recipient.deliveredColumn} for grant ${grant.id}: ${stampErr.message}`);
          anyFailed = true;
        }
        await releaseLease(db, grant.id, recipient.leaseColumn, lease);
      } else {
        anyFailed = true;
        // Release only OUR lease (CAS on our value) so a later sweep retries
        // without resending recipients that already succeeded.
        await releaseLease(db, grant.id, recipient.leaseColumn, lease);
      }
    }

    if (anyFailed) {
      result.failed = 1;
      return result;
    }

    if (ctx.recipients.length === 0) {
      console.warn(`[speakerAwardEmails] grant ${grant.id}: no recipients resolvable, marked notified`);
    } else {
      // Re-read and verify EVERY required recipient has a confirmed delivery
      // stamp before declaring the grant notified — a lease (ours or another
      // worker's) is never proof of delivery.
      const { data: fresh, error: freshErr } = await db
        .from('speaker_award_grant')
        .select(GRANT_COLUMNS)
        .eq('id', grant.id)
        .maybeSingle();
      if (freshErr || !fresh) {
        console.error(`[speakerAwardEmails] re-read failed for grant ${grant.id}: ${freshErr?.message || 'row missing'}`);
        result.failed = 1;
        return result;
      }
      const allDelivered = ctx.recipients.every(r => !!fresh[r.deliveredColumn]);
      if (!allDelivered) return result; // someone still owes a send — retried next sweep
    }

    const { error: doneErr } = await db
      .from('speaker_award_grant')
      .update({ notified_at: new Date().toISOString() })
      .eq('id', grant.id)
      .is('notified_at', null);
    if (doneErr) {
      console.error(`[speakerAwardEmails] failed to stamp notified_at for grant ${grant.id}: ${doneErr.message}`);
      result.failed = 1;
      return result;
    }
    if (anyDeliveredByUs) result.notified = 1;
  } catch (err) {
    console.error(`[speakerAwardEmails] notification failed for grant ${grant.id}: ${err.message}`);
    result.failed = 1;
  }
  return result;
}

// Resolve everything one grant's emails need: award details + recipients.
// Each recipient carries its deliveredColumn + leaseColumn for idempotency.
async function buildGrantContext(db, { event, grant, baseUrl }) {
  // Voucher details (value, expiry) come from the voucher row itself.
  // Lookup failures must THROW (marking the attempt failed/retryable) —
  // treating a transient read error as "no award" would produce zero
  // recipients and permanently stamp the grant notified without any email.
  let voucher = null;
  if (grant.voucher_id) {
    const { data, error } = await db
      .from('voucher')
      .select('id, value, expires_at, code')
      .eq('id', grant.voucher_id)
      .maybeSingle();
    if (error) throw new Error(`voucher lookup failed: ${error.message}`);
    if (!data) throw new Error(`voucher ${grant.voucher_id} not found`);
    voucher = data;
  }

  let badgeName = null;
  if (grant.member_badge_id && grant.badge_id) {
    const { data, error } = await db
      .from('badge')
      .select('id, name')
      .eq('id', grant.badge_id)
      .maybeSingle();
    if (error) throw new Error(`badge lookup failed: ${error.message}`);
    badgeName = data?.name || null;
  }

  let member = null;
  if (grant.member_id) {
    const { data, error } = await db
      .from('member')
      .select('id, email, first_name')
      .eq('id', grant.member_id)
      .maybeSingle();
    if (error) throw new Error(`member lookup failed: ${error.message}`);
    member = data || null;
  }

  let organization = null;
  let billingEmail = null;
  if (voucher && grant.organization_id) {
    const { data: org, error: orgErr } = await db
      .from('organization')
      .select('id, name, invoicing_email')
      .eq('id', grant.organization_id)
      .maybeSingle();
    if (orgErr) throw new Error(`organization lookup failed: ${orgErr.message}`);
    organization = org || null;
    billingEmail = organization?.invoicing_email || null;
    if (!billingEmail) {
      const { data: pc, error: pcErr } = await db
        .from('member')
        .select('email')
        .eq('organization_id', grant.organization_id)
        .eq('is_primary_contact', true)
        .limit(1)
        .maybeSingle();
      if (pcErr) throw new Error(`primary contact lookup failed: ${pcErr.message}`);
      billingEmail = pc?.email || null;
    }
  }

  const speakerName = grant.speaker_name || member?.first_name || 'Speaker';
  const eventTitle = event.title || 'the event';
  const subject = `Thank you for speaking at ${eventTitle} — your speaker award`;

  const awardLines = [];
  if (voucher) {
    const value = formatValue(voucher.value ?? grant.voucher_value);
    const expiry = formatDate(voucher.expires_at);
    awardLines.push(
      `<li>A training voucher${value ? ` worth <strong>${escapeHtml(value)}</strong>` : ''}` +
      `${organization?.name ? ` for ${escapeHtml(organization.name)}` : ''}` +
      `${expiry ? `, valid until <strong>${escapeHtml(expiry)}</strong>` : ''}.</li>`
    );
  }
  if (badgeName) {
    awardLines.push(`<li>The <strong>${escapeHtml(badgeName)}</strong> badge on your member profile.</li>`);
  }

  const awardsHtml = `<ul>${awardLines.join('')}</ul>`;
  const whereHtml = voucher
    ? `<p>The voucher is available to your organisation now — you can see it under <a href="${escapeHtml(`${baseUrl}/Balances`)}">Balances</a> in the member portal.</p>`
    : `<p>You can see it in the <a href="${escapeHtml(baseUrl)}">member portal</a>.</p>`;

  const recipients = [];
  if (member?.email && awardLines.length > 0) {
    recipients.push({
      deliveredColumn: 'member_notified_at',
      leaseColumn: 'member_notify_lease_at',
      email: member.email,
      html: `
        <p>Hi ${escapeHtml(member.first_name || speakerName)},</p>
        <p>Thank you for speaking at <strong>${escapeHtml(eventTitle)}</strong>. In recognition, you've been awarded:</p>
        ${awardsHtml}
        ${whereHtml}`,
    });
  }
  if (voucher && billingEmail && billingEmail.trim().toLowerCase() !== (member?.email || '').trim().toLowerCase()) {
    const value = formatValue(voucher.value ?? grant.voucher_value);
    const expiry = formatDate(voucher.expires_at);
    recipients.push({
      deliveredColumn: 'org_notified_at',
      leaseColumn: 'org_notify_lease_at',
      email: billingEmail,
      html: `
        <p>Hello,</p>
        <p>${escapeHtml(speakerName)} spoke at <strong>${escapeHtml(eventTitle)}</strong>, and in recognition your organisation${organization?.name ? ` (${escapeHtml(organization.name)})` : ''} has received a training voucher${value ? ` worth <strong>${escapeHtml(value)}</strong>` : ''}${expiry ? `, valid until <strong>${escapeHtml(expiry)}</strong>` : ''}.</p>
        <p>You can see it under <a href="${escapeHtml(`${baseUrl}/Balances`)}">Balances</a> in the member portal.</p>`,
    });
  }

  return { subject, recipients };
}
