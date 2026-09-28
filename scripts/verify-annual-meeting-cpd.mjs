#!/usr/bin/env node
// Task 4825: verify an explicit import manifest. Never sends mail, renders a
// certificate, fabricates attendance evidence, or claims the global CPD queue.
// --process only claims ready registration outbox rows for exact reviewed IDs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { connectDestination, EVENT, PROJECT } from './annual-meeting-destination.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const SOURCE_SHA256 = '412652aded639dc603cfb8d20db0e266303d30014b1f016928907b3e88517a2b';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = message => { throw new Error(message); };
const normalizeEmail = email => String(email || '').trim().toLowerCase();
const exactPoints = value => {
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,6})?$/.test(text)) fail('Invalid exact CPD points value');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
};
export function expectedImportIdentity(sourceId) {
  const match = /^(Both Days|Thursday Only|Friday Only):([2-9]|[1-9]\d{1,3})$/.exec(sourceId || '');
  if (!match) fail('Explicit workbook sheet/row identity required');
  const digest = createHash('sha256').update(JSON.stringify([SOURCE_SHA256, TENANT, EVENT, sourceId])).digest('hex');
  const code = { 'Both Days': 'B', 'Thursday Only': 'T', 'Friday Only': 'F' }[match[1]];
  return {
    booking_id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
    booking_reference: `AM-${SOURCE_SHA256.slice(0, 16)}-${code}-${match[2]}`,
  };
}

// A caller supplies only identities from a reviewed, private import manifest.
// The read-only mode supports the minimal input contract; processing additionally
// requires the manifest's exact reference, ticket and attendee member IDs.
export function validateInput(input, process = false) {
  if (!input || input.tenant_id !== TENANT || !Array.isArray(input.bookings)
    || input.bookings.length < 1 || input.bookings.length > 100) fail('Invalid tenant or bounded booking list');
  if (process && input.source_sha256 !== SOURCE_SHA256) fail('Source workbook fingerprint required for processing');
  const seen = new Set();
  for (const item of input.bookings) {
    if (!item || !UUID.test(item.booking_id || '') || item.booking_source !== 'standard') {
      fail('Only explicit standard booking UUIDs are allowed');
    }
    if (seen.has(item.booking_id.toLowerCase())) fail('Repeated booking ID');
    seen.add(item.booking_id.toLowerCase());
    const value = exactPoints(item.expected_points);
    if (value !== 3000000n && value !== 5000000n && value !== 8000000n) fail('Unrecognized meeting CPD points');
    if (process && (!UUID.test(item.member_id || '') || !item.ticket_class_id || !item.source_id
      || !item.booking_reference)) {
      fail('Processing requires exact source row, member, ticket and import reference from the reviewed manifest');
    }
    if (item.source_id) {
      const expected = expectedImportIdentity(item.source_id);
      if (item.booking_id !== expected.booking_id || (item.booking_reference && item.booking_reference !== expected.booking_reference)) {
        fail('Imported booking identity differs from hash-pinned source row');
      }
    }
  }
  return input;
}

// Pure reconciliation: only a positive registration event_award for this exact
// booking/member/ticket and the configured 3/5/8 points qualifies. A reversal,
// an attendance award, a purchaser award, or a skipped RPC is not equivalent.
export function evaluateBooking(item, booking, member, rules, outbox, ledger, certificate) {
  const issues = [];
  if (!booking || booking.event_id !== EVENT || booking.tenant_id !== TENANT) {
    return { issues: ['booking_not_in_target_event'], points_status: 'missing', certificate_status: 'unavailable' };
  }
  if (booking.status !== 'confirmed' || booking.payment_method !== 'admin_import'
    || booking.is_guest_booking !== false || !booking.member_id || !booking.ticket_class_id
    || !booking.booking_reference) issues.push('booking_not_confirmed_member_import');
  if (item.member_id && item.member_id !== booking.member_id) issues.push('manifest_member_mismatch');
  if (item.ticket_class_id && item.ticket_class_id !== booking.ticket_class_id) issues.push('manifest_ticket_mismatch');
  if (item.booking_reference && item.booking_reference !== booking.booking_reference) issues.push('manifest_reference_mismatch');
  if (item.source_id && booking.booking_reference !== expectedImportIdentity(item.source_id).booking_reference) issues.push('source_reference_mismatch');
  if (!member || member.id !== booking.member_id || member.tenant_id !== TENANT
    || !normalizeEmail(booking.attendee_email)
    || normalizeEmail(member.email) !== normalizeEmail(booking.attendee_email)) issues.push('attendee_member_identity_mismatch');
  const matching = rules.filter(rule => rule.active === true && rule.ticket_id === booking.ticket_class_id);
  const fallback = rules.filter(rule => rule.active === true && rule.ticket_id == null);
  const effective = matching.length ? matching : fallback;
  const rule = effective.length === 1 ? effective[0] : null;
  if (!rule || rule.is_no_award || rule.trigger_type !== 'registration'
    || exactPoints(rule.points_value) !== exactPoints(item.expected_points)) issues.push('registration_rule_mismatch');
  const registrationOutbox = outbox.filter(row => row.trigger_type === 'registration');
  if (!registrationOutbox.length) issues.push('registration_outbox_missing');
  if (registrationOutbox.length !== 1 || registrationOutbox.some(row =>
    row.evidence_type !== 'confirmed_booking' || row.evidence_id !== booking.id
    || !row.idempotency_key?.startsWith(`registration:booking:${booking.id}:`)
    || !['complete', 'pending', 'retry', 'processing', 'dead'].includes(row.status))) {
    issues.push('unexpected_registration_outbox');
  }
  const positive = ledger.filter(row => row.entry_kind === 'event_award' && row.award_trigger === 'registration');
  const reversals = ledger.filter(row => row.entry_kind === 'reversal');
  if (positive.length > 1) issues.push('duplicate_positive_award');
  if (reversals.length) issues.push('award_reversed');
  const award = positive.length === 1 ? positive[0] : null;
  if (award && (award.member_id !== booking.member_id || award.ticket_id !== booking.ticket_class_id
    || award.rule_id !== rule?.id || award.evidence_type !== 'confirmed_booking'
    || award.event_id !== EVENT || award.booking_type !== 'booking'
    || award.booking_id !== booking.id
    || exactPoints(award.points_value) !== exactPoints(item.expected_points))) issues.push('ledger_award_mismatch');
  if (award && !registrationOutbox.some(row => row.status === 'complete')) issues.push('outbox_not_complete');
  if (!award) issues.push('registration_award_missing');
  if (!certificate?.available) issues.push(!award
    && typeof certificate?.reason === 'string'
    && certificate.reason.includes('cpd.cpd_points')
    ? 'certificate_pending_points' : 'certificate_unavailable');
  if (certificate?.available && (certificate.certificate_points_source !== 'member_ledger'
    || certificate.provenance?.attendee_member_id !== booking.member_id
    || !certificate.placeholders?.some(p => p.placeholder_key === 'cpd.cpd_points')
    || certificate.values?.['cpd.cpd_points'] == null
    || exactPoints(certificate.values['cpd.cpd_points']) !== exactPoints(item.expected_points))) {
    issues.push('certificate_points_mismatch');
  }
  return {
    issues,
    points_status: award && issues.every(i => !['ledger_award_mismatch', 'duplicate_positive_award', 'award_reversed'].includes(i))
      ? 'award_present' : 'unresolved',
    certificate_status: certificate?.available ? 'available' : 'unavailable',
    award_id: award?.id || null,
    outbox: registrationOutbox.map(row => ({ id: row.id, status: row.status, attempts: row.attempts })),
    certificate_fingerprint: certificate?.fingerprint || null,
  };
}

async function readOne(client, sql, args) {
  const rows = (await client.query(sql, args)).rows;
  if (rows.length > 1) fail('Ambiguous scoped lookup');
  return rows[0] || null;
}
export async function inspect(client, db, input, resolveCertificate, onProgress = () => {}) {
  const event = await readOne(client, 'select id,tenant_id from public.event where id=$1 and tenant_id=$2', [EVENT, TENANT]);
  if (!event) fail('Pinned destination event not found');
  const rules = (await client.query(`select id,ticket_id,trigger_type,points_value,is_no_award,active
    from public.event_cpd_points_rule where tenant_id=$1 and event_type='event' and event_id=$2 order by id`, [TENANT, EVENT])).rows;
  const results = new Array(input.bookings.length);
  let next = 0;
  let completed = 0;
  const inspectOne = async (index) => {
    const item = input.bookings[index];
    const booking = await readOne(client, `select id,tenant_id,event_id,status,member_id,attendee_email,
      ticket_class_id,booking_reference,payment_method,is_guest_booking from public.booking
      where id=$1 and tenant_id=$2 and event_id=$3`, [item.booking_id, TENANT, EVENT]);
    const member = booking?.member_id
      ? await readOne(client, 'select id,tenant_id,email from public.member where id=$1 and tenant_id=$2', [booking.member_id, TENANT])
      : null;
    const outbox = (await client.query(`select id,status,trigger_type,evidence_type,attempts,available_at,idempotency_key,evidence_id
      from public.event_cpd_points_outbox where tenant_id=$1 and booking_type='booking' and booking_id=$2
      order by id`, [TENANT, item.booking_id])).rows;
    const ledger = (await client.query(`select id,entry_kind,points_value,event_id,booking_type,booking_id,
      member_id,ticket_id,award_trigger,evidence_type,rule_id,reversal_of
      from public.member_cpd_points_ledger where tenant_id=$1 and booking_type='booking' and booking_id=$2
      order by id`, [TENANT, item.booking_id])).rows;
    // Resolver is read-only and must use the explicitly pinned DEST Supabase
    // client. The default imported database client can point to legacy SOURCE.
    let certificate = null;
    let certificateError = null;
    if (booking && member && booking.status === 'confirmed') {
      try {
        certificate = await resolveCertificate(db, {
          tenantId: TENANT, bookingId: item.booking_id, bookingSource: 'standard',
        });
      } catch {
        certificateError = 'certificate_resolution_failed';
      }
    }
    const result = evaluateBooking(item, booking, member, rules, outbox, ledger, certificate);
    if (certificateError) result.issues.push(certificateError);
    results[index] = { booking_id: item.booking_id, expected_points: String(item.expected_points), ...result };
    completed += 1;
    if (completed % 10 === 0) onProgress(completed, input.bookings.length);
  };
  // One SQL connection still serializes its queries; bounded concurrency keeps
  // certificate REST reads in flight while other selected bookings are inspected.
  await Promise.all(Array.from({ length: Math.min(5, input.bookings.length) }, async () => {
    while (next < input.bookings.length) await inspectOne(next++);
  }));
  return results;
}

// Never reclaim another worker's processing lock, even when stale. CAS is
// scoped to the exact booking reference/tenant/member/ticket from the reviewed
// input, and only pending/retry registration work ready for delivery is claimed.
export async function claimSelected(client, item) {
  if (!item.member_id || !item.ticket_class_id || !item.booking_reference) fail('Unreviewed booking claim');
  await client.query('BEGIN');
  try {
    const result = await client.query(`UPDATE public.event_cpd_points_outbox o
      SET status='processing', attempts=o.attempts+1, locked_at=now(),
        lock_token=gen_random_uuid(),updated_at=now()
      FROM public.booking b, public.member m
      WHERE o.tenant_id=$1 AND o.booking_type='booking' AND o.booking_id=$2
        AND o.trigger_type='registration' AND o.evidence_type='confirmed_booking'
        AND o.evidence_id=o.booking_id::text
        AND o.idempotency_key LIKE ('registration:booking:' || o.booking_id::text || ':%')
        AND o.status IN ('pending','retry') AND o.available_at<=now()
        AND b.id=o.booking_id AND b.tenant_id=o.tenant_id AND b.event_id=$3
        AND b.status='confirmed' AND b.payment_method='admin_import'
        AND b.member_id=$4 AND b.ticket_class_id=$5 AND b.booking_reference=$6
        AND b.is_guest_booking=false
        AND m.id=b.member_id AND m.tenant_id=b.tenant_id
        AND lower(trim(m.email))=lower(trim(b.attendee_email))
      RETURNING o.id,o.idempotency_key,o.tenant_id,o.booking_type,o.booking_id,
        o.trigger_type,o.evidence_id,o.evidence_type,o.evidence_snapshot,o.lock_token`,
    [TENANT, item.booking_id, EVENT, item.member_id, item.ticket_class_id, item.booking_reference]);
    if (result.rows.length > 1) fail('Multiple ready registration outbox rows for booking');
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function processSelected(client, db, input, processAward) {
  const processed = [];
  for (const item of input.bookings) {
    const row = await claimSelected(client, item);
    if (!row) {
      processed.push({ booking_id: item.booking_id, status: 'not_claimed' });
      continue;
    }
    try {
      const result = await processAward({
        tenantId: TENANT, bookingType: 'booking', bookingId: item.booking_id,
        triggerType: 'registration', idempotencyKey: row.idempotency_key,
        evidenceId: row.evidence_id, evidence: { type: row.evidence_type, ...(row.evidence_snapshot || {}) },
      }, { db });
      if (!['awarded', 'already_awarded'].includes(result?.status)) throw new Error('Registration points outcome not awarded');
      const { data, error } = await db.rpc('complete_event_cpd_points_outbox', { p_id: row.id, p_lock_token: row.lock_token });
      if (error || data !== true) throw new Error('Unable to complete selected points outbox; reconcile before retry');
      processed.push({ booking_id: item.booking_id, outbox_id: row.id, status: result.status });
    } catch {
      // Keep the selected occurrence retryable without leaking private provider
      // errors into an audit row. A failed completion might have already minted
      // the immutable award; the next run detects the existing occurrence.
      const { data, error } = await db.rpc('fail_event_cpd_points_outbox', {
        p_id: row.id, p_lock_token: row.lock_token,
        p_error: 'Scoped annual meeting registration reconciliation failed',
        p_max_attempts: 8,
      });
      processed.push({ booking_id: item.booking_id, outbox_id: row.id,
        status: error || data !== true ? 'requires_manual_reconciliation' : 'retry_or_dead' });
    }
  }
  return processed;
}

export function savePrivate(filename, report) {
  const root = path.resolve('private/annual-meeting');
  const resolved = path.resolve(filename);
  if (!resolved.startsWith(`${root}${path.sep}`)) fail('Output must be under private/annual-meeting');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export async function main(argv = process.argv.slice(2)) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--(input|out|process)(?:=(.+))?$/.exec(arg);
    if (!match || Object.hasOwn(flags, match[1]) || (match[1] === 'process' && match[2])) {
      fail('Use --input=<private path> --out=<private path> [--process]');
    }
    flags[match[1]] = match[2] || true;
  }
  if (typeof flags.input !== 'string' || typeof flags.out !== 'string') fail('Explicit input and private output required');
  const root = `${path.resolve('private/annual-meeting')}${path.sep}`;
  if (!path.resolve(flags.input).startsWith(root)) fail('Input must be under private/annual-meeting');
  if (!path.resolve(flags.out).startsWith(root) || fs.existsSync(flags.out)) {
    fail('Fresh output must be under private/annual-meeting before any processing');
  }
  const input = validateInput(JSON.parse(fs.readFileSync(flags.input, 'utf8')), Boolean(flags.process));
  const client = await connectDestination();
  try {
    if (process.env.DEST_SUPABASE_URL !== `https://${PROJECT}.supabase.co`
      || !process.env.DEST_SUPABASE_KEY) fail('Explicit DEST service-role credentials required');
    // Imported modules have a SOURCE default in the development environment.
    // Override *before* dynamic import and always pass db explicitly.
    process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
    const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (url, init = {}) => fetch(url, {
        ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30000)]),
      }) },
    });
    const [{ resolveAttendeeCertificate }, { processCpdPointsAward }] = await Promise.all([
      import('../api/_lib/attendeeCpdCertificate.js'),
      import('../api/_lib/eventCpdPointsService.js'),
    ]);
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout='60s'");
    const progress = phase => (completed, requested) =>
      console.log(JSON.stringify({ phase, inspected: completed, requested }));
    const before = await inspect(client, db, input, resolveAttendeeCertificate, progress(flags.process ? 'preflight' : 'read_only'));
    await client.query('ROLLBACK');
    if (!flags.process) {
      const report = {
        task: 4825, project: PROJECT, tenant_id: TENANT, event_id: EVENT,
        source_sha256: SOURCE_SHA256, writes_performed: false, processed: [], rows: before,
        summary: {
          requested: before.length, verified: before.filter(row => row.issues.length === 0).length,
          unresolved: before.filter(row => row.issues.length > 0).length,
        },
      };
      savePrivate(flags.out, report);
      console.log(JSON.stringify({ ...report.summary, writes_performed: false, output: path.resolve(flags.out) }));
      if (report.summary.unresolved) process.exitCode = 2;
      return report;
    }
    // No processing when a claimed/held booking has a mismatched identity,
    // award, template, or rule. A missing award alone is expected before work.
    const allowedBefore = new Set(['registration_award_missing', 'certificate_points_mismatch', 'certificate_pending_points']);
    if (flags.process && before.some(row => row.issues.some(issue => !allowedBefore.has(issue)))) {
      fail('Preflight has non-recoverable import/CPD mismatches; no outbox rows claimed');
    }
    if (flags.process && before.some(row => !row.outbox || row.outbox.length !== 1
      || !['pending', 'retry', 'complete'].includes(row.outbox[0].status)
      || (row.issues.includes('registration_award_missing') && row.outbox[0].status === 'complete'))) {
      fail('Outbox is not claimable or already complete without an award; no rows claimed');
    }
    const processed = flags.process ? await processSelected(client, db, input, processCpdPointsAward) : [];
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    const rows = await inspect(client, db, input, resolveAttendeeCertificate, progress('post_process'));
    await client.query('ROLLBACK');
    const report = {
      task: 4825, project: PROJECT, tenant_id: TENANT, event_id: EVENT,
      source_sha256: SOURCE_SHA256, writes_performed: Boolean(flags.process && processed.some(row => row.status !== 'not_claimed')),
      processed, rows, summary: {
        requested: rows.length, verified: rows.filter(row => row.issues.length === 0).length,
        unresolved: rows.filter(row => row.issues.length > 0).length,
      },
    };
    savePrivate(flags.out, report);
    console.log(JSON.stringify({ ...report.summary, writes_performed: report.writes_performed,
      output: path.resolve(flags.out) }));
    if (report.summary.unresolved) process.exitCode = 2;
    return report;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // No SDK/SQL errors, workbook email, key, or recipient can appear on stdout.
    console.error('Annual meeting CPD verification failed; inspect private input, destination and audit state.');
    process.exitCode = 1;
  });
}