#!/usr/bin/env node
// Authorized one-off amendment: only group references; default read-only.
import fs from 'node:fs';
import { connectDestination, EVENT } from './annual-meeting-destination.mjs';
import { SOURCE, TENANT, hash, canonical, parseWorkbook, preflight, readState,
  normalizeBookingTimestamps, revalidate, savePrivate } from './import-annual-meeting-delegates.mjs';
const originalPath = 'private/annual-meeting/preflight-apply-final.json';
const amendmentPath = 'private/annual-meeting/preflight-group-amended.json';
const originalHash = '7122dde67cd2b60b9e298f7cb46991e4399ef010f1eec3c9c41711c53ed3ed74';
const flags = process.argv.slice(2);
if (flags.some(f => f !== '--apply' && !/^--out=private\/annual-meeting\/[^/]+\.json$/.test(f))) throw new Error('Invalid repair arguments');
const output = flags.find(f => f.startsWith('--out='))?.slice(6);
if (!output || fs.existsSync(output)) throw new Error('Fresh private output required');
const original = JSON.parse(fs.readFileSync(originalPath));
const { manifest_sha256, ...payload } = original.report;
if (manifest_sha256 !== originalHash || hash(payload) !== originalHash || hash(original.state) !== original.report.state_sha256) throw new Error('Original immutable manifest mismatch');
const source = parseWorkbook(fs.readFileSync(SOURCE));
const amended = { state: original.state, report: preflight(source, original.state) };
const rows = original.report.rows.filter(r => r.disposition === 'ready');
const changed = amended.report.rows.filter(r => r.disposition === 'ready');
if (rows.length !== 50 || changed.length !== 50 || new Set(changed.map(r => r.planned_booking.booking_group_reference)).size !== 50) throw new Error('Repair cardinality mismatch');
for (const row of rows) {
  const replacement = changed.find(r => r.source_id === row.source_id)?.planned_booking;
  if (!replacement || canonical({ ...replacement, booking_group_reference: row.planned_booking.booking_group_reference }) !== canonical(row.planned_booking)) throw new Error('Amendment changes more than group reference');
}
if (fs.existsSync(amendmentPath)) {
  if (canonical(JSON.parse(fs.readFileSync(amendmentPath))) !== canonical(amended)) throw new Error('Amendment file conflict');
} else savePrivate(amendmentPath, amended);
const ids = rows.map(r => r.planned_booking.id);
const client = await connectDestination();
try {
  await client.query(flags.includes('--apply') ? 'BEGIN' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL lock_timeout='10s'");
  await client.query("SET LOCAL statement_timeout='60s'");
  if (flags.includes('--apply')) {
    await client.query('LOCK TABLE booking,complex_event_booking IN SHARE ROW EXCLUSIVE MODE');
    await client.query('LOCK TABLE event,member,event_cpd_points_rule,event_cpd_badge_rule,event_cpd_certificate_config,cpd_certificate_template,member_cpd_points_ledger IN SHARE MODE');
  }
  const before = await readState(client, source);
  const normalize = b => normalizeBookingTimestamps(b, original.state.columns);
  const prospective = structuredClone(before);
  for (const row of rows) {
    const current = before.bookings.find(b => b.table === 'booking' && b.id === row.planned_booking.id);
    const target = changed.find(r => r.source_id === row.source_id).planned_booking;
    if (![row.planned_booking, target].some(b => canonical(normalize({ ...b, table: 'booking' })) === canonical(normalize(current)))) throw new Error('Imported row changed outside authorized repair');
    Object.assign(prospective.bookings.find(b => b.table === 'booking' && b.id === target.id), target);
  }
  // Checks both original baseline bookings, all policies/members and absence of unrelated inserts.
  revalidate(amended, prospective);
  const ledger = async () => (await client.query('SELECT to_jsonb(l) AS value FROM member_cpd_points_ledger l WHERE booking_id=ANY($1::uuid[]) ORDER BY id', [ids])).rows;
  const ledgerBefore = await ledger();
  if (ledgerBefore.length !== 50) throw new Error('Unexpected ledger cardinality');
  let updated = 0;
  const audit = [];
  for (const row of rows) {
    const target = changed.find(r => r.source_id === row.source_id).planned_booking;
    const current = before.bookings.find(b => b.id === target.id && b.table === 'booking');
    audit.push({ booking_id: target.id, source_id: row.source_id,
      previous_group: current.booking_group_reference, amended_group: target.booking_group_reference });
    if (flags.includes('--apply') && current.booking_group_reference !== target.booking_group_reference) {
      const result = await client.query('UPDATE booking SET booking_group_reference=$1 WHERE id=$2 AND tenant_id=$3 AND event_id=$4 AND booking_group_reference=$5',
        [target.booking_group_reference, target.id, TENANT, EVENT, current.booking_group_reference]);
      if (result.rowCount !== 1) throw new Error('Repair compare-and-set failed');
      updated++;
    }
  }
  if (flags.includes('--apply')) revalidate(amended, await readState(client, source));
  const ledgerAfter = await ledger();
  if (canonical(ledgerAfter) !== canonical(ledgerBefore)) throw new Error('Ledger changed');
  const groups = (await client.query(`SELECT count(*)::int AS bookings,
    count(DISTINCT booking_group_reference)::int AS report_groups,
    count(DISTINCT member_id)::int AS members FROM booking WHERE id=ANY($1::uuid[])`, [ids])).rows[0];
  if (flags.includes('--apply') && (groups.bookings !== 50 || groups.report_groups !== 50 || groups.members !== 50)) throw new Error('Report grouping verification failed');
  await client.query(flags.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
  savePrivate(output, { original_manifest_sha256: originalHash, amended_manifest_sha256: amended.report.manifest_sha256,
    applied: flags.includes('--apply'), updated, groups, ledger_before_sha256: hash(ledgerBefore),
    ledger_after_sha256: hash(ledgerAfter), audit, audit_sha256: hash(audit),
    unrelated_new_members: before.members.filter(m => !original.state.members.some(old => old.id === m.id)).length });
  console.log(JSON.stringify({ updated, groups, amended_manifest_sha256: amended.report.manifest_sha256, ledger_preserved: true }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Group repair failed; transaction rolled back:', error.message);
  process.exitCode = 1;
} finally { await client.end(); }