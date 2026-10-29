// Owner-approved, destination-pinned repair. Default executes and verifies the
// entire transaction then rolls it back. --apply commits; replay is zero-write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination, EVENT } from './annual-meeting-destination.mjs';

const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const SOURCE = '5fc106677f343951c341536141b7feaf13afe7a7f8cb4265e114e24c4ea68e19';
const reason = 'Owner approved CPD points and attendee certificate eligibility for the 64 imported Autumn Meeting registrations; no email send or badge release.';
const sql = fs.readFileSync(new URL('../supabase/migrations/202612090001_outstanding_registration_cpd_release.sql', import.meta.url), 'utf8')
  .replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '');
const db = await connectDestination();
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
  const exists = (await db.query("select to_regclass('public.outstanding_registration_cpd_release') name")).rows[0].name;
  if (!exists) await db.query(sql);
  // Pin the reviewed cohort and current rules throughout finalization.
  await db.query('LOCK TABLE public.outstanding_registration_award_hold,public.event_cpd_points_rule IN SHARE MODE');
  const held = (await db.query(`select h.booking_id,b.ticket_class_id from outstanding_registration_award_hold h
    join booking b on b.id=h.booking_id and b.tenant_id=h.tenant_id and b.event_id=h.event_id
    where h.tenant_id=$1 and h.event_id=$2 and h.source_sha256=$3 and b.status='confirmed'
    order by h.booking_id for update of b`, [TENANT, EVENT, SOURCE])).rows;
  assert.equal(held.length, 64, 'Reviewed cohort changed');
  const ids = held.map(row => row.booking_id);
  const original = (await db.query(`select to_jsonb(l) value from member_cpd_points_ledger l
    where tenant_id=$1 and event_id=$2 and not (booking_id=any($3::uuid[])) order by id`,
  [TENANT, EVENT, ids])).rows;
  const evidence = async () => (await db.query(`select
    (select count(*) from member_badge where tenant_id=$1 and booking_id=any($2::uuid[])) badges,
    (select count(*) from attendee_cpd_certificate_delivery where tenant_id=$1 and booking_id=any($2::uuid[])) deliveries,
    (select count(*) from event_cpd_badge_outbox where tenant_id=$1 and booking_id=any($2::uuid[])) badge_jobs`,
  [TENANT, ids])).rows[0];
  const before = await evidence();
  const inserted = await db.query(`insert into outstanding_registration_cpd_release
    (booking_id,tenant_id,event_id,reason,approved_by)
    select booking_id,tenant_id,event_id,$4,'Project owner approval'
    from outstanding_registration_award_hold where tenant_id=$1 and event_id=$2
    and booking_id=any($3::uuid[]) on conflict(booking_id) do nothing returning booking_id`,
  [TENANT, EVENT, ids, reason]);
  assert([0,64].includes(inserted.rowCount), 'Partial prior repair requires review');
  // Application roles cannot manufacture or edit release authority.
  for (const role of ['anon','authenticated','service_role']) {
    const { rows: [privileges] } = await db.query(`select
      has_table_privilege($1,'public.outstanding_registration_cpd_release','INSERT,UPDATE,DELETE,TRUNCATE') can_write`,
    [role]);
    assert.equal(privileges.can_write, false);
  }
  await db.query('SET LOCAL ROLE service_role');
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  const totals = {};
  for (const { booking_id: bookingId } of held) {
    const { rows: [flags] } = await db.query(`select
      outstanding_registration_is_held_for($1,'points') points,
      outstanding_registration_is_held_for($1,'attendee') attendee,
      outstanding_registration_is_held_for($1,'badge') badge,
      outstanding_registration_is_held_for($1,NULL) unknown`, [bookingId]);
    assert.deepEqual(flags, { points:false,attendee:false,badge:true,unknown:true });
    const { rows: [{ value: preview }] } = await db.query(
      "select evaluate_event_cpd_points_reprocessing_row($1,'booking',$2,$3) value",
      [TENANT, bookingId, EVENT]);
    if (inserted.rowCount === 0) {
      assert.equal(preview.outcome, 'already_awarded');
      continue;
    }
    assert.equal(preview.outcome, 'eligible', `Ineligible reviewed booking ${bookingId}`);
    assert.equal(preview.trigger, 'registration');
    assert(preview.member_id && [3,5,8].includes(Number(preview.proposed_points)));
    const attempt = {
      tenant_id:TENANT,event_id:EVENT,event_type:'event',booking_type:'booking',booking_id:bookingId,
      member_id:preview.member_id,ticket_id:preview.ticket_id,trigger_type:preview.trigger,status:'awarded',
      idempotency_key:`approved-import-cpd-release:${bookingId}`,
      evidence_type:preview.evidence_type,evidence_id:preview.evidence_id,
      evidence_snapshot:{...preview.evidence,release_reason:reason},detail:reason,
    };
    const { rows: [{ value: award }] } = await db.query(
      'select to_jsonb(record_event_cpd_points_award($1::jsonb)) value',[JSON.stringify(attempt)]);
    assert.equal(award.status, 'awarded');
    assert.equal(Number(award.points_value), Number(preview.proposed_points));
    // Same request must resolve to the original attempt, never a second award.
    const replay = (await db.query('select to_jsonb(record_event_cpd_points_award($1::jsonb)) value',
      [JSON.stringify(attempt)])).rows[0].value;
    assert.equal(replay.id, award.id);
    totals[Number(award.points_value)] = (totals[Number(award.points_value)] || 0) + 1;
  }
  await db.query('RESET ROLE');
  const after = (await db.query(`select to_jsonb(l) value from member_cpd_points_ledger l
    where tenant_id=$1 and event_id=$2 and not (booking_id=any($3::uuid[])) order by id`,
  [TENANT, EVENT, ids])).rows;
  assert.deepEqual(after, original, 'Existing awards changed');
  assert.deepEqual(await evidence(), before, 'Unexpected badge or certificate side effect');
  const summary = (await db.query(`select count(*) count,sum(points_value) points from member_cpd_points_ledger
    where tenant_id=$1 and event_id=$2 and booking_id=any($3::uuid[]) and entry_kind='event_award'`,
  [TENANT, EVENT, ids])).rows[0];
  assert.equal(Number(summary.count),64);
  // Immutable evidence is protected even from accidental owner edits.
  await db.query('SAVEPOINT immutable');
  let rejected = false;
  try { await db.query('delete from outstanding_registration_cpd_release where booking_id=$1',[ids[0]]); }
  catch (error) { assert.match(error.message,/immutable/); rejected=true; }
  await db.query('ROLLBACK TO SAVEPOINT immutable');
  assert(rejected);
  await db.query(process.argv.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({committed:process.argv.includes('--apply'),released:inserted.rowCount,
    awards:summary,byPoints:totals,existingLedgerRowsPreserved:original.length,
    certificateEmailsSent:0,badgeAwardsChanged:0}));
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }
