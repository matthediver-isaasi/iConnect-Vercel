#!/usr/bin/env node
// Task 4825: private, fail-closed preflight. Never calls application/email APIs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { connectDestination, EVENT, PROJECT } from './annual-meeting-destination.mjs';
import { resolveEventCpdCertificatePolicy } from '../shared/eventCpdCertificatePolicy.js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const SOURCE = 'attached_assets/Delegate_List_annual_meeting_CPD_points_1790621999804.xlsx';
export const SOURCE_HASH = '412652aded639dc603cfb8d20db0e266303d30014b1f016928907b3e88517a2b';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const norm = value => String(value || '').trim().toLowerCase();
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const fail = message => { throw new Error(message); };
export function normalizeBookingTimestamps(booking, columns) {
  if (!booking) return booking;
  const normalized = { ...booking };
  for (const column of columns || []) {
    if (column.data_type !== 'timestamp with time zone') continue;
    const value = normalized[column.column_name];
    if (value == null) continue;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('Invalid persisted booking timestamp');
    normalized[column.column_name] = new Date(value).toISOString();
  }
  return normalized;
}
export function parseWorkbook(bytes) {
  if (hash(bytes) !== SOURCE_HASH) fail('Workbook fingerprint mismatch');
  const wb = XLSX.read(bytes, { type: 'buffer' });
  if (canonical(wb.SheetNames) !== canonical(['Delegates', 'Both Days', 'Thursday Only ', 'Friday Only'])) fail('Workbook sheets changed');
  const rows = [];
  for (const sheet of wb.SheetNames.slice(1)) {
    const ws = wb.Sheets[sheet];
    for (const cell of Object.values(ws)) if (cell?.f || cell?.t === 'e') fail('Formula or error requires review');
    XLSX.utils.sheet_to_json(ws, { defval: '' }).forEach((original, index) => {
      const email = norm(original.Email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Invalid source email');
      const uuid = String(original['Individual UUID']).trim();
      if (uuid && uuid !== 'to import' && !UUID.test(uuid)) fail('Invalid source UUID');
      rows.push({
        source_id: `${sheet.trim()}:${index + 2}`, sheet: sheet.trim(), source_row: index + 2,
        email, member_uuid: UUID.test(uuid) ? uuid.toLowerCase() : null,
        eligible: original['CPD?'] === 'Can be sent' && original.Attended_Event === 'Yes',
        original,
      });
    });
  }
  if (rows.length !== 179 || rows.filter(r => r.eligible).length !== 123) fail('Source count reconciliation failed');
  const master = XLSX.utils.sheet_to_json(wb.Sheets.Delegates, { defval: '' })
    .map((original, index) => ({ sheet: 'Delegates', source_row: index + 2, email: norm(original.Email), original }));
  const dayEmails = new Set(rows.map(r => r.email));
  const masterEmails = new Set(master.map(r => r.email));
  const masterDiscrepancies = {
    master_only: master.filter(r => !dayEmails.has(r.email)),
    day_only: rows.filter(r => !masterEmails.has(r.email)),
    master_rows: master.length, day_rows: rows.length,
  };
  return { workbook_sha256: SOURCE_HASH, rows, masterDiscrepancies };
}
export function matchMember(row, members) {
  const emailMatches = members.filter(m => m.tenant_id === TENANT && norm(m.email) === row.email);
  if (row.member_uuid) {
    const matches = members.filter(m => m.id === row.member_uuid);
    if (matches.length !== 1 || matches[0].tenant_id !== TENANT) return { reason: 'uuid_missing_or_cross_tenant' };
    if (norm(matches[0].email) !== row.email) return { reason: 'uuid_email_conflict' };
    if (emailMatches.length !== 1) return { reason: 'ambiguous_email' };
    return { member: matches[0] };
  }
  return emailMatches.length === 1 ? { member: emailMatches[0] }
    : { reason: emailMatches.length ? 'ambiguous_email' : 'member_missing_no_creation' };
}
export function matchTicket(row, member, tickets) {
  const matches = tickets.filter(t => row.sheet === 'Friday Only'
    ? t.name === 'Friday only'
    : t.name?.startsWith(row.sheet === 'Both Days' ? 'Full meeting - ' : 'Thursday only - ')
      && Array.isArray(t.role_ids) && t.role_ids.includes(member.role_id));
  return matches.length === 1 ? { ticket: matches[0] } : { reason: matches.length ? 'ambiguous_ticket' : 'role_has_no_ticket' };
}
function ruleFor(rules, ticket) {
  const active = rules.filter(r => r.active);
  const overrides = active.filter(r => r.ticket_id === ticket.id);
  const scope = overrides.length ? overrides : active.filter(r => r.ticket_id == null);
  const matching = scope.filter(r => r.trigger_type === 'registration' && !r.is_no_award);
  return !scope.some(r => r.is_no_award) && matching.length === 1 ? matching[0] : null;
}
export function plannedBooking(row, columns, preparedAt) {
  if (typeof preparedAt !== 'string' || !Number.isFinite(Date.parse(preparedAt))
    || new Date(preparedAt).toISOString() !== preparedAt) fail('Pinned preparation timestamp required');
  const digest = hash([SOURCE_HASH, TENANT, EVENT, row.source_id]);
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const code = { 'Both Days': 'B', 'Thursday Only': 'T', 'Friday Only': 'F' }[row.sheet];
  const booking = Object.fromEntries(columns.map(c => [c.column_name, null]));
  Object.assign(booking, {
    id, tenant_id: TENANT, event_id: EVENT, member_id: row.member.id,
    organization_id: row.member.organization_id || null,
    attendee_email: row.member.email, attendee_first_name: row.member.first_name || '',
    attendee_last_name: row.member.last_name || '', ticket_price: 0,
    ticket_class_id: row.ticket.id, ticket_class_name: row.ticket.name,
    payment_method: 'admin_import', status: 'confirmed',
    booking_reference: `AM-${SOURCE_HASH.slice(0, 16)}-${code}-${row.source_row}`,
    // Each source attendee is an independent registration, not a shared purchase.
    booking_group_reference: `AM-${SOURCE_HASH.slice(0, 16)}-${code}-${row.source_row}`,
    is_guest_booking: false, po_to_follow: false, is_one_off_event: false, buddy: false, badge: true,
  });
  // This is the import preparation instant, not the historical event date.
  for (const name of ['created_at', 'updated_at']) {
    if (columns.some(c => c.column_name === name)) booking[name] = preparedAt;
  }
  return booking;
}
export function preflight(source, state) {
  if (state.event?.id !== EVENT || state.event.tenant_id !== TENANT || state.event.is_complex) fail('Wrong event scope');
  let pricing = state.event.pricing_config;
  if (typeof pricing === 'string') pricing = JSON.parse(pricing);
  const counts = new Map();
  source.rows.forEach(r => counts.set(r.email, (counts.get(r.email) || 0) + 1));
  const canonicalSource = new Map();
  for (const row of source.rows) {
    const sameEmail = source.rows.filter(r => r.email === row.email);
    // Do not collapse conflicts or cross-day records, even when UUID agrees.
    if (sameEmail.length > 1 && sameEmail.every(r => r.sheet === row.sheet
      && r.member_uuid === row.member_uuid && r.eligible === row.eligible
      && canonical(r.original) === canonical(row.original))) {
      canonicalSource.set(row.source_id, sameEmail[0].source_id);
    }
  }
  const rows = source.rows.map(row => {
    const result = { ...row, disposition: 'held', reasons: [] };
    if (!row.eligible) return { ...result, disposition: 'excluded', reasons: ['source_not_cpd_eligible'] };
    if (counts.get(row.email) !== 1 && !canonicalSource.has(row.source_id)) result.reasons.push('duplicate_source_email');
    const matched = matchMember(row, state.members);
    if (!matched.member) result.reasons.push(matched.reason);
    else {
      result.member = matched.member;
      const selected = matchTicket(row, matched.member, pricing?.ticket_classes || []);
      if (!selected.ticket) result.reasons.push(selected.reason);
      else {
        result.ticket = selected.ticket;
        result.rule = ruleFor(state.rules, selected.ticket);
        if (!result.rule) result.reasons.push('registration_rule_unavailable');
        result.certificate = resolveEventCpdCertificatePolicy({
          config: state.certificate?.config, event: state.event,
          ticketReference: selected.ticket.id, templates: state.templates,
        });
        if (!result.certificate.available) result.reasons.push(`certificate_${result.certificate.reason}`);
      }
    }
    const existing = state.bookings.filter(b => norm(b.attendee_email) === row.email || (row.member_uuid && b.member_id === row.member_uuid));
    result.existing = existing;
    const reusable = existing.length === 1 && existing[0].table === 'booking'
      && existing[0].tenant_id === TENANT && existing[0].event_id === EVENT
      && existing[0].status === 'confirmed' && norm(existing[0].attendee_email) === row.email
      && existing[0].member_id === result.member?.id && existing[0].ticket_class_id === result.ticket?.id;
    if (existing.length && !reusable) result.reasons.push('existing_booking_review_required');
    if (!result.reasons.length) result.disposition = 'ready';
    if (!result.reasons.length && reusable) result.disposition = 'already_registered';
    if (result.disposition === 'ready') result.planned_booking = plannedBooking(result, state.columns || [], state.prepared_at);
    return result;
  });
  for (const row of rows) {
    const canonicalId = canonicalSource.get(row.source_id);
    if (!canonicalId || canonicalId === row.source_id) continue;
    const first = rows.find(r => r.source_id === canonicalId);
    if (!['ready', 'already_registered'].includes(first.disposition)) continue;
    row.disposition = 'duplicate_source_row';
    row.reasons = ['identical_source_row_covered_by_canonical'];
    row.canonical_source_id = canonicalId;
    row.covered_booking_id = first.planned_booking?.id || first.existing[0].id;
    delete row.planned_booking;
  }
  const report = {
    version: 1, task: 4825, project: PROJECT, tenant: TENANT, event_id: EVENT,
    workbook_sha256: source.workbook_sha256, state_sha256: hash(state), rows,
    prepared_at: state.prepared_at, timestamp_semantics: 'Pinned import preparation instant; not historical activity date',
    masterDiscrepancies: source.masterDiscrepancies || null,
    summary: Object.fromEntries(['ready', 'already_registered', 'duplicate_source_row', 'held', 'excluded'].map(d => [d, rows.filter(r => r.disposition === d).length])),
    effects: { emails: false, payments: false, attendance_claims: false,
      confirmed_insert_enqueues_registration_points: true, confirmed_insert_enqueues_registration_badges: true },
    provenance: 'Private hash-pinned manifest plus deterministic booking UUID/reference; no fabricated attendance or payment evidence',
  };
  return { ...report, manifest_sha256: hash(report) };
}
export async function readState(client, source) {
  // Normalize pg Date instances before hashing so persisted/reloaded manifests
  // use the identical representation as the live transaction snapshot.
  const query = async (sql, args = []) => JSON.parse(JSON.stringify((await client.query(sql, args)).rows));
  const event = (await query('select to_jsonb(e) as value from event e where id=$1 and tenant_id=$2', [EVENT, TENANT]))[0]?.value;
  const emails = [...new Set(source.rows.map(r => r.email))];
  const ids = source.rows.map(r => r.member_uuid).filter(Boolean);
  const members = await query(`select id,tenant_id,email,first_name,last_name,role_id,organization_id,status
    from member where id=any($1::uuid[]) or (tenant_id=$2 and lower(trim(email))=any($3::text[])) order by id`, [ids, TENANT, emails]);
  const bookings = [];
  for (const table of ['booking', 'complex_event_booking']) {
    bookings.push(...(await query(`select to_jsonb(b) as value
      from ${table} b where event_id=$1 order by id`, [EVENT])).map(b => ({ ...b.value, table })));
  }
  const rules = await query('select * from event_cpd_points_rule where event_id=$1 and tenant_id=$2 order by id', [EVENT, TENANT]);
  const badgeRules = await query('select * from event_cpd_badge_rule where event_id=$1 and tenant_id=$2 order by id', [EVENT, TENANT]);
  const certificate = (await query('select * from event_cpd_certificate_config where event_id=$1 and tenant_id=$2', [EVENT, TENANT]))[0] || null;
  const templates = await query('select id,status from cpd_certificate_template where tenant_id=$1 order by id', [TENANT]);
  const triggers = await query(`select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('booking','complex_event_booking') and not t.tgisinternal order by 1,2`);
  const columns = await query(`select column_name,data_type,is_nullable,column_default from information_schema.columns
    where table_schema='public' and table_name='booking' order by ordinal_position`);
  return { event, members, bookings: bookings.map(b => normalizeBookingTimestamps(b, columns)),
    rules, badgeRules, certificate, templates, triggers, columns };
}
export function validateManifest(source, manifest, expectedHash) {
  const { report, state } = manifest;
  if (!/^[a-f0-9]{64}$/.test(expectedHash || '') || report?.manifest_sha256 !== expectedHash
    || canonical(preflight(source, state)) !== canonical(report)) fail('Manifest hash or source/state mismatch');
}
export function revalidate(manifest, live) {
  const expected = manifest.state;
  const { bookings: baseline, prepared_at: preparationInstant, ...configuration } = expected;
  const { bookings: current, prepared_at: ignoredLivePreparation, ...liveConfiguration } = live;
  const planned = manifest.report.rows.filter(r => r.disposition === 'ready');
  const equivalent = (left, right) => canonical(normalizeBookingTimestamps(left, expected.columns))
    === canonical(normalizeBookingTimestamps(right, expected.columns));
  // A completed replay may coexist with unrelated subsequent member imports.
  // Never relax identity checks while even one approved booking needs inserting.
  const completeReplay = planned.length > 0 && planned.every(r => current.some(b =>
    b.table === 'booking' && equivalent(b, { ...r.planned_booking, table: 'booking' })));
  if (completeReplay) {
    const oldIds = new Set(configuration.members.map(m => m.id));
    const acceptedEmails = new Set(planned.map(r => norm(r.planned_booking.attendee_email)));
    const acceptedIds = new Set(planned.map(r => r.planned_booking.member_id));
    const extras = liveConfiguration.members.filter(m => !oldIds.has(m.id));
    if (extras.some(m => acceptedIds.has(m.id) || acceptedEmails.has(norm(m.email)))) fail('New member conflicts with approved attendee identity');
    liveConfiguration.members = liveConfiguration.members.filter(m => oldIds.has(m.id));
  }
  if (canonical(configuration) !== canonical(liveConfiguration)) fail('Live configuration/member/schema/trigger drift');
  const baselineIds = new Set(baseline.map(b => `${b.table}:${b.id}`));
  for (const old of baseline) {
    const found = current.find(b => b.table === old.table && b.id === old.id);
    if (!equivalent(found, old)) fail('Existing booking changed');
  }
  for (const b of current.filter(b => !baselineIds.has(`${b.table}:${b.id}`))) {
    const row = planned.find(r => r.planned_booking.id === b.id && b.table === 'booking');
    if (!row || !equivalent({ ...row.planned_booking, table: 'booking' }, b)) fail('Unexpected or conflicting booking; stop');
  }
}
export async function applyManifest(client, source, manifest, expectedHash, { read = readState } = {}) {
  validateManifest(source, manifest, expectedHash);
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    // Block inserts/updates on both booking paths, and changes to all policy/identity inputs.
    await client.query(`LOCK TABLE booking,complex_event_booking IN SHARE ROW EXCLUSIVE MODE`);
    await client.query(`LOCK TABLE event,member,event_cpd_points_rule,event_cpd_badge_rule,event_cpd_certificate_config,cpd_certificate_template IN SHARE MODE`);
    const live = await read(client, source);
    revalidate(manifest, live);
    const results = [];
    for (const row of manifest.report.rows.filter(r => ['ready', 'already_registered'].includes(r.disposition))) {
      if (row.disposition === 'already_registered') {
        results.push({ source_id: row.source_id, booking_id: row.existing[0].id, expected_points: row.rule.points_value, outcome: 'already_registered' });
        continue;
      }
      const booking = row.planned_booking;
      const present = live.bookings.some(b => b.table === 'booking' && b.id === booking.id);
      if (!present) {
        // Populate ALL columns explicitly so the manifest is the exact complete
        // row, including null payment/attendance fields. No mutable server defaults.
        const inserted = await client.query(`INSERT INTO booking SELECT (jsonb_populate_record(NULL::booking,$1::jsonb)).* RETURNING to_jsonb(booking) AS value`, [JSON.stringify(booking)]);
        if (canonical(normalizeBookingTimestamps(inserted.rows[0]?.value, manifest.state.columns))
          !== canonical(normalizeBookingTimestamps(booking, manifest.state.columns))) fail('Inserted booking differs from manifest');
      }
      results.push({ source_id: row.source_id, booking_id: booking.id, expected_points: row.rule.points_value, outcome: present ? 'replayed' : 'inserted' });
    }
    revalidate(manifest, await read(client, source));
    for (const row of manifest.report.rows.filter(r => r.disposition === 'duplicate_source_row')) {
      results.push({ source_id: row.source_id, canonical_source_id: row.canonical_source_id,
        booking_id: row.covered_booking_id, outcome: 'duplicate_source_row', expected_points: row.rule.points_value });
    }
    await client.query('COMMIT');
    committed = true;
    return { manifest_sha256: expectedHash, results, inserted: results.filter(r => r.outcome === 'inserted').length, emails_sent: 0, payment_claims: 0 };
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
}
export function savePrivate(filename, value) {
  const root = path.resolve('private/annual-meeting');
  const resolved = path.resolve(filename);
  if (!resolved.startsWith(root + path.sep)) fail('Output must be under private/annual-meeting');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export async function main(args = process.argv.slice(2)) {
  const flags = {};
  for (const arg of args) {
    const match = /^--(preflight|apply|confirm-write|manifest|manifest-sha256|out)(?:=(.+))?$/.exec(arg);
    if (!match || Object.hasOwn(flags, match[1])) fail('Unknown or repeated argument');
    flags[match[1]] = match[2] || true;
  }
  if (flags.apply && (flags.preflight || flags['confirm-write'] !== true || typeof flags.manifest !== 'string')) fail('Apply requires explicit manifest and --confirm-write');
  const source = parseWorkbook(fs.readFileSync(SOURCE));
  if (!flags.preflight && !flags.apply) {
    console.log(JSON.stringify({ workbook_sha256: SOURCE_HASH, rows: source.rows.length, eligible: source.rows.filter(r => r.eligible).length, writes: false }));
    return;
  }
  if (typeof flags.out !== 'string') fail('Private --out required');
  let manifest;
  if (flags.apply) {
    manifest = JSON.parse(fs.readFileSync(flags.manifest, 'utf8'));
    validateManifest(source, manifest, flags['manifest-sha256']);
  }
  const output = path.resolve(flags.out);
  if (!output.startsWith(path.resolve('private/annual-meeting') + path.sep) || fs.existsSync(output)) fail('Fresh private output path required');
  const client = await connectDestination();
  try {
    if (flags.apply) {
      const result = await applyManifest(client, source, manifest, flags['manifest-sha256']);
      savePrivate(flags.out, result);
      console.log(JSON.stringify({ inserted: result.inserted, manifest_sha256: result.manifest_sha256 }));
      return;
    }
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout='60s'");
    const state = { ...await readState(client, source), prepared_at: new Date().toISOString() };
    const report = preflight(source, state);
    await client.query('ROLLBACK');
    savePrivate(flags.out, { report, state });
    console.log(JSON.stringify({ summary: report.summary, manifest_sha256: report.manifest_sha256, writes: false }));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Annual meeting operation failed; inspect private inputs and reconcile durable state before retry.'); process.exitCode = 1; });
}