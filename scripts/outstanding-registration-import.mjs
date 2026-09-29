#!/usr/bin/env node
// Private registration-only operator tool. No application, financial or send APIs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { connectDestination, EVENT, PROJECT } from './annual-meeting-destination.mjs';
import { TENANT, hash, canonical, readState, savePrivate, normalizeBookingTimestamps } from './import-annual-meeting-delegates.mjs';

export const SOURCE = 'attached_assets/cpd-import-outstanding-2026-09-28-clarified_(1)_1790686616364.xlsx';
export const SOURCE_HASH = '5fc106677f343951c341536141b7feaf13afe7a7f8cb4265e114e24c4ea68e19';
const SHEET = 'Outstanding CPD source rows';
const HEADERS = ['Source sheet', 'Source row', 'Attendee name', 'Email', 'Membership identifier', 'Attendance day', 'Current status / reason', 'Action needed', ''];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const norm = v => String(v || '').trim().toLowerCase();
const emailValid = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const fail = message => { throw new Error(message); };
export function parseSourceRow(cells, sourceRow) {
  if (cells.length !== 9) fail('Expected all nine source columns');
  const [sheet, originalRow, name, email, identifier, day, status, action, rawNote] = cells;
  const note = String(rawNote).trim();
  if (!['Both Days', 'Thursday Only', 'Friday Only'].includes(day) || sheet !== day
    || !Number.isSafeInteger(originalRow) || originalRow < 2 || !UUID.test(identifier)) fail('Invalid source provenance/identity/day');
  if (!['', 'Remove duplicate', 'Do not send', 'Both days', 'aware of different email, import using UUID'].includes(note) && !UUID.test(note)) fail('Unknown correction note');
  if (!emailValid(norm(email))) fail('Invalid source email');
  return {
    source_id: `${SHEET}:${sourceRow}`, source_row: sourceRow, sheet, original_source_row: originalRow,
    original: [...cells], name, email: norm(email), original_member_uuid: norm(identifier),
    member_uuid: UUID.test(note) ? norm(note) : norm(identifier),
    uuid_authoritative: UUID.test(note) || note === 'aware of different email, import using UUID',
    day: note === 'Both days' ? 'Both Days' : day, note, status, action,
    excluded: ['Remove duplicate', 'Do not send'].includes(note),
  };
}
export function parseWorkbook(bytes) {
  if (hash(bytes) !== SOURCE_HASH) fail('Workbook fingerprint mismatch');
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  if (canonical(workbook.SheetNames) !== canonical([SHEET])) fail('Unexpected sheets');
  const sheet = workbook.Sheets[SHEET];
  for (const cell of Object.values(sheet)) if (cell?.f || cell?.t === 'e') fail('Source formula/error');
  const values = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  if (canonical(values.shift()) !== canonical(HEADERS)) fail('Source headers changed');
  const rows = values.map((r, i) => parseSourceRow(r, i + 2));
  const counts = {
    rows: rows.length, emails: new Set(rows.map(r => r.email)).size,
    excluded: rows.filter(r => r.excluded).length,
    replacements: rows.filter(r => UUID.test(r.note)).length,
    dayCorrections: rows.filter(r => r.note === 'Both days').length,
    uuidOverrides: rows.filter(r => r.note === 'aware of different email, import using UUID').length,
  };
  if (canonical(counts) !== canonical({ rows: 74, emails: 70, excluded: 5, replacements: 3, dayCorrections: 4, uuidOverrides: 7 })) fail('Source count mismatch');
  return { workbook_sha256: SOURCE_HASH, rows, counts };
}
export function matchIdentity(row, members) {
  const matches = members.filter(m => m.id === row.member_uuid);
  if (matches.length !== 1 || matches[0].tenant_id !== TENANT) return { reason: 'uuid_missing_or_cross_tenant' };
  const member = matches[0];
  if (!row.uuid_authoritative && norm(member.email) !== row.email) return { reason: 'uuid_email_conflict' };
  const recipient = norm(member.email);
  if (!emailValid(recipient)) return { reason: 'invalid_current_recipient' };
  const recipients = members.filter(m => m.tenant_id === TENANT && norm(m.email) === recipient);
  if (recipients.length !== 1 || recipients[0].id !== member.id) return { reason: 'ambiguous_current_recipient' };
  return { member, recipient };
}
export function ticketDay(ticket) {
  if (ticket?.name?.startsWith('Full meeting - ')) return 'Both Days';
  if (ticket?.name?.startsWith('Thursday only - ')) return 'Thursday Only';
  return ticket?.name === 'Friday only' ? 'Friday Only' : null;
}
export function plannedBooking(row, columns, preparedAt) {
  if (!preparedAt || new Date(preparedAt).toISOString() !== preparedAt) fail('Pinned preparation instant required');
  if (!['ticket_price', 'total_cost'].every(name => columns.some(c => c.column_name === name))) fail('Import financial schema required');
  const digest = hash([SOURCE_HASH, TENANT, EVENT, row.member.id, row.day]);
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const reference = `OR-${SOURCE_HASH.slice(0, 12)}-${digest.slice(0, 16)}`;
  const booking = Object.fromEntries(columns.map(c => [c.column_name, null]));
  Object.assign(booking, {
    id, tenant_id: TENANT, event_id: EVENT, member_id: row.member.id,
    organization_id: row.member.organization_id || null, attendee_email: row.member.email,
    attendee_first_name: row.member.first_name || '', attendee_last_name: row.member.last_name || '',
    ticket_price: 0, total_cost: 0, ticket_class_id: row.ticket.id, ticket_class_name: row.ticket.name,
    payment_method: 'admin_import', status: 'confirmed', booking_reference: reference, booking_group_reference: reference,
    is_guest_booking: false, po_to_follow: false, is_one_off_event: false, buddy: false, badge: false,
  });
  for (const column of ['created_at', 'updated_at']) if (Object.hasOwn(booking, column)) booking[column] = preparedAt;
  const revision = columns.find(c => c.column_name === 'survey_invitation_revision');
  if (revision) {
    if (revision.data_type !== 'bigint' || revision.column_default !== '0') fail('Unexpected invitation revision schema');
    // Initial optimistic-concurrency metadata, not an invitation/send claim.
    booking.survey_invitation_revision = 0;
  }
  for (const column of columns) {
    if (column.is_nullable === 'NO' && booking[column.column_name] == null) {
      fail(`Uninitialized required booking column: ${column.column_name}`);
    }
  }
  return booking;
}
export function preflight(source, state) {
  if (source.workbook_sha256 !== SOURCE_HASH || state.event?.id !== EVENT || state.event.tenant_id !== TENANT || state.event.is_complex) fail('Wrong import scope');
  const pricing = typeof state.event.pricing_config === 'string' ? JSON.parse(state.event.pricing_config) : state.event.pricing_config;
  const tickets = pricing?.ticket_classes || [];
  if (new Set(tickets.map(t => t.id)).size !== tickets.length) fail('Duplicate ticket IDs');
  const rows = source.rows.map(row => {
    const result = { ...row, disposition: 'held', reasons: [] };
    if (row.excluded) return { ...result, disposition: 'excluded', reasons: [row.note === 'Do not send' ? 'do_not_send' : 'remove_duplicate'] };
    const identity = matchIdentity(row, state.members);
    if (!identity.member) return { ...result, reasons: [identity.reason] };
    Object.assign(result, identity);
    result.recipient_decision = row.email === identity.recipient ? 'current_member_email_matches_source' : 'explicit_uuid_instruction_current_member_email';
    const choices = tickets.filter(t => ticketDay(t) === row.day).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    result.ticket = choices.find(t => Array.isArray(t.role_ids) && t.role_ids.includes(identity.member.role_id)) || choices[0];
    if (!result.ticket) result.reasons.push('day_has_no_ticket');
    const existing = state.bookings.filter(b => b.member_id === identity.member.id
      || norm(b.attendee_email) === identity.recipient
      || (!row.uuid_authoritative && norm(b.attendee_email) === row.email));
    result.existing = existing;
    const reusable = existing.length === 1 && existing[0].tenant_id === TENANT && existing[0].event_id === EVENT
      && existing[0].member_id === identity.member.id && existing[0].status === 'confirmed'
      && norm(existing[0].attendee_email) === identity.recipient
      && ticketDay(tickets.find(t => t.id === existing[0].ticket_class_id)) === row.day;
    if (existing.length && !reusable) result.reasons.push('existing_booking_review_required');
    if (!result.reasons.length) {
      result.disposition = reusable ? 'already_present' : 'ready';
      if (!reusable) result.planned_booking = plannedBooking(result, state.columns, state.prepared_at);
    }
    return result;
  });
  const byMember = new Map();
  for (const row of rows.filter(r => r.member)) {
    const group = byMember.get(row.member.id) || [];
    group.push(row); byMember.set(row.member.id, group);
  }
  for (const group of byMember.values()) {
    if (new Set(group.map(r => r.day)).size > 1 || group.some(r => r.reasons.length)) {
      for (const row of group) { row.disposition = 'held'; row.reasons.push('conflicting_member_source_rows'); delete row.planned_booking; }
      continue;
    }
    const first = group[0];
    for (const row of group.slice(1)) {
      row.disposition = 'merged_source_duplicate';
      row.canonical_source_id = first.source_id;
      row.covered_booking_id = first.planned_booking?.id || first.existing[0].id;
      delete row.planned_booking;
    }
  }
  const report = {
    task: 4850, version: 1, project: PROJECT, tenant: TENANT, event_id: EVENT,
    workbook_sha256: SOURCE_HASH, state_sha256: hash(state), prepared_at: state.prepared_at, rows,
    summary: Object.fromEntries(['ready', 'already_present', 'merged_source_duplicate', 'excluded', 'held'].map(d => [d, rows.filter(r => r.disposition === d).length])),
    financial_provenance: 'Unknown/unpaid: legacy zero ticket_price/total_cost with admin_import renders Unavailable, not evidence of payment or free admission',
    effects: { awards: false, attendance: false, financial: false, sends: false },
  };
  return { ...report, manifest_sha256: hash(report) };
}
export async function readOutstandingState(client, source) {
  const state = await readState(client, source);
  // The inherited reader searches source emails. Also corroborate corrected
  // UUID recipients against ALL tenant members sharing their current address.
  const recipients = [...new Set(state.members.filter(m => source.rows.some(r => r.member_uuid === m.id)).map(m => norm(m.email)))];
  const { rows } = await client.query(`select id,tenant_id,email,first_name,last_name,role_id,organization_id,status
    from member where tenant_id=$1 and lower(trim(email))=any($2::text[]) order by id`, [TENANT, recipients]);
  state.members = [...new Map([...state.members, ...rows].map(m => [m.id, m])).values()].sort((a, b) => a.id.localeCompare(b.id));
  state.award_guard = await readGuardMetadata(client);
  return state;
}
const HOLD_TABLE = 'outstanding_registration_award_hold';
const GUARD_FUNCTIONS = ['validate_outstanding_registration_hold', 'check_outstanding_registration_hold_booking',
  'outstanding_registration_is_held', 'guard_outstanding_registration_awards',
  'record_event_cpd_points_award', 'record_event_cpd_badge_award', 'claim_attendee_cpd_certificate_delivery',
  'evaluate_event_cpd_points_reprocessing_row'];
export async function readGuardMetadata(client) {
  const tables = [HOLD_TABLE, 'booking', ...EFFECT_TABLES];
  const query = async (sql, args) => JSON.parse(JSON.stringify((await client.query(sql, args)).rows));
  return {
    tables: await query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
      c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [tables]),
    columns: await query(`SELECT table_name,column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])
      ORDER BY table_name,ordinal_position`, [tables]),
    constraints: await query(`SELECT c.relname,con.conname,pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,con.conname`, [tables]),
    triggers: await query(`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition,
      pg_get_functiondef(t.tgfoid) AS function FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [tables]),
    functions: await query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
      p.prosrc,p.prosecdef,p.proconfig,p.proacl::text AS acl,pg_get_userbyid(p.proowner) AS owner,
      pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname,arguments`, [GUARD_FUNCTIONS]),
    privileges: await query(`SELECT r.rolname,
      CASE WHEN to_regclass('public.outstanding_registration_award_hold') IS NULL THEN NULL ELSE
        has_table_privilege(r.oid,'public.outstanding_registration_award_hold','SELECT') END AS can_select,
      CASE WHEN to_regclass('public.outstanding_registration_award_hold') IS NULL THEN NULL ELSE
        has_table_privilege(r.oid,'public.outstanding_registration_award_hold','INSERT') END AS can_insert,
      CASE WHEN to_regclass('public.outstanding_registration_award_hold') IS NULL THEN NULL ELSE
        has_table_privilege(r.oid,'public.outstanding_registration_award_hold','UPDATE,DELETE,TRUNCATE,TRIGGER') END AS can_mutate
      FROM pg_roles r WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname`, []),
  };
}
export function assertGuardMetadata(metadata) {
  if (!metadata?.tables?.some(t => t.relname === HOLD_TABLE && t.relrowsecurity)) fail('Award hold migration required');
  const migration = fs.readFileSync(new URL('../supabase/migrations/20261125_outstanding_registration_award_hold.sql', import.meta.url), 'utf8');
  for (const name of GUARD_FUNCTIONS.slice(0, 4)) {
    const expected = new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*? AS \\$\\$([\\s\\S]*?)\\$\\$;`).exec(migration)?.[1];
    const actual = metadata.functions.filter(f => f.proname === name);
    if (!expected || actual.length !== 1 || actual[0].prosrc.trim() !== expected.trim()
      || !actual[0].prosecdef || canonical(actual[0].proconfig) !== canonical(['search_path=public'])) fail('Unexpected award hold guard definition');
  }
  for (const name of GUARD_FUNCTIONS.slice(4)) {
    const matches = metadata.functions.filter(f => f.proname === name);
    if (matches.length !== 1 || !matches[0].prosrc.includes('public.outstanding_registration_is_held(')
      || !matches[0].prosrc.includes(name.startsWith('evaluate_') ? "outcome:='registration_only_hold'" : "RAISE EXCEPTION 'Registration-only import award hold'")) fail('Missing award wrapper hold');
  }
  for (const table of EFFECT_TABLES.filter(t => t !== 'certificate_survey_entitlement')) {
    if (!metadata.triggers.some(t => t.relname === table && t.tgname === 'outstanding_registration_award_guard'
      && t.tgenabled === 'O' && t.definition.includes('BEFORE INSERT OR UPDATE')
      && t.definition.includes('guard_outstanding_registration_awards()'))) fail('Missing enabled award guard trigger');
  }
  for (const [table, name] of [[HOLD_TABLE, 'validate_outstanding_registration_hold'],
    [HOLD_TABLE, 'outstanding_hold_booking_required'], ['booking', 'outstanding_hold_booking_preserved']]) {
    if (!metadata.triggers.some(t => t.relname === table && t.tgname === name && t.tgenabled === 'O')) fail('Missing hold integrity trigger');
  }
  if (metadata.privileges.length !== 3 || metadata.privileges.some(p => p.can_mutate
    || (p.rolname === 'service_role' ? !p.can_insert || !p.can_select : p.can_insert || p.can_select))) fail('Unsafe hold privileges');
  if (!metadata.constraints.some(c => c.relname === HOLD_TABLE && c.definition.includes('FOREIGN KEY (booking_id)')
    && c.definition.includes('DEFERRABLE INITIALLY DEFERRED'))) fail('Missing deferred booking ownership constraint');
}
export function validateManifest(source, manifest, expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash || '') || manifest.report?.manifest_sha256 !== expectedHash
    || canonical(preflight(source, manifest.state)) !== canonical(manifest.report)) fail('Manifest/source/state mismatch');
}
export function revalidate(manifest, live) {
  const { bookings: baseline, prepared_at: ignored, ...config } = manifest.state;
  const { bookings: current, prepared_at: ignoredLive, ...liveConfig } = live;
  if (canonical(config) !== canonical(liveConfig)) fail('Live configuration/member/schema/trigger drift');
  const equivalent = (a, b) => canonical(normalizeBookingTimestamps(a, manifest.state.columns)) === canonical(normalizeBookingTimestamps(b, manifest.state.columns));
  for (const old of baseline) if (!equivalent(old, current.find(b => b.table === old.table && b.id === old.id))) fail('Existing booking changed');
  const planned = manifest.report.rows.filter(r => r.disposition === 'ready');
  for (const booking of current.filter(b => !baseline.some(old => old.table === b.table && old.id === b.id))) {
    const row = planned.find(r => r.planned_booking.id === booking.id && booking.table === 'booking');
    if (!row || !equivalent(booking, { ...row.planned_booking, table: 'booking' })) fail('Unexpected/conflicting booking');
  }
}
export const EFFECT_TABLES = ['event_cpd_points_outbox', 'event_cpd_badge_outbox', 'member_cpd_points_ledger', 'member_badge',
  'event_cpd_points_award_attempt', 'event_cpd_badge_award_attempt', 'attendee_cpd_certificate_delivery', 'certificate_survey_entitlement'];
export function plannedHold(booking) {
  return { booking_id: booking.id, tenant_id: TENANT, event_id: EVENT, source_sha256: SOURCE_HASH, booking_reference: booking.booking_reference };
}
export async function verifyCohortGuards(client, bookings) {
  const ids = bookings.map(b => b.id);
  const holds = (await client.query(`SELECT booking_id,tenant_id,event_id,source_sha256,booking_reference
    FROM public.outstanding_registration_award_hold WHERE booking_id=ANY($1::uuid[]) ORDER BY booking_id`, [ids])).rows;
  if (canonical(holds) !== canonical(bookings.map(plannedHold).sort((a, b) => a.booking_id.localeCompare(b.booking_id)))) fail('Cohort hold missing or changed');
  for (const table of EFFECT_TABLES) {
    const result = await client.query(`SELECT count(*)::int AS count FROM public.${table} WHERE booking_id=ANY($1::uuid[])`, [ids]);
    if (result.rows[0]?.count !== 0) fail('Prohibited cohort award/outbox/certificate effect');
  }
}
export async function applyManifest(client, source, manifest, expectedHash, {
  read = readOutstandingState, verify = verifyCohortGuards, assertGuards = assertGuardMetadata,
} = {}) {
  validateManifest(source, manifest, expectedHash);
  assertGuards(manifest.state.award_guard);
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query('LOCK TABLE booking,complex_event_booking,outstanding_registration_award_hold IN SHARE ROW EXCLUSIVE MODE');
    await client.query('LOCK TABLE event,member,event_cpd_points_rule,event_cpd_badge_rule,event_cpd_certificate_config,cpd_certificate_template IN SHARE MODE');
    const live = await read(client, source);
    revalidate(manifest, live);
    assertGuards(live.award_guard);
    const planned = manifest.report.rows.filter(r => r.disposition === 'ready');
    // Only exact deterministic rows accepted as a completed/partial replay.
    const present = planned.filter(r => live.bookings.some(b => b.table === 'booking' && b.id === r.planned_booking.id));
    await verify(client, present.map(r => r.planned_booking));
    const results = [];
    for (const row of planned) {
      const booking = row.planned_booking;
      const replayed = present.some(r => r.source_id === row.source_id);
      if (!replayed) {
        const hold = plannedHold(booking);
        await client.query(`INSERT INTO public.outstanding_registration_award_hold
          (booking_id,tenant_id,event_id,source_sha256,booking_reference) VALUES ($1,$2,$3,$4,$5)`,
        [hold.booking_id, hold.tenant_id, hold.event_id, hold.source_sha256, hold.booking_reference]);
        const inserted = await client.query('INSERT INTO booking SELECT (jsonb_populate_record(NULL::booking,$1::jsonb)).* RETURNING to_jsonb(booking) AS value', [JSON.stringify(booking)]);
        if (canonical(normalizeBookingTimestamps(inserted.rows[0]?.value, manifest.state.columns))
          !== canonical(normalizeBookingTimestamps(booking, manifest.state.columns))) fail('Inserted booking differs from manifest');
      }
      results.push({ source_id: row.source_id, booking_id: booking.id, outcome: replayed ? 'replayed' : 'inserted' });
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    revalidate(manifest, await read(client, source));
    await verify(client, planned.map(r => r.planned_booking));
    for (const row of manifest.report.rows.filter(r => ['already_present', 'merged_source_duplicate'].includes(r.disposition))) {
      results.push({ source_id: row.source_id, booking_id: row.covered_booking_id || row.existing[0].id,
        canonical_source_id: row.canonical_source_id || null, outcome: row.disposition });
    }
    await client.query('COMMIT');
    committed = true;
    return { manifest_sha256: expectedHash, results, inserted: results.filter(r => r.outcome === 'inserted').length,
      awards: 0, sends: 0, financial_claims: 0 };
  } finally { if (!committed) await client.query('ROLLBACK'); }
}
export async function main(args = process.argv.slice(2)) {
  const source = parseWorkbook(fs.readFileSync(SOURCE));
  if (!args.length) { console.log(JSON.stringify({ ...source.counts, writes: false })); return; }
  const flags = {};
  for (const arg of args) {
    const match = /^--(preflight|apply|confirm-write|manifest|manifest-sha256|out)(?:=(.+))?$/.exec(arg);
    if (!match || Object.hasOwn(flags, match[1])) fail('Unknown or repeated argument');
    flags[match[1]] = match[2] || true;
  }
  if (flags.apply ? flags.apply !== true || flags.preflight || flags['confirm-write'] !== true
    || typeof flags.manifest !== 'string' || typeof flags['manifest-sha256'] !== 'string'
    : flags.preflight !== true || flags['confirm-write'] || flags.manifest || flags['manifest-sha256']) fail('Explicit preflight or hash-pinned confirmed apply required');
  const output = flags.out;
  if (typeof output !== 'string') fail('Private output required');
  if (!path.resolve(output).startsWith(path.resolve('private/annual-meeting') + path.sep) || fs.existsSync(output)) fail('Fresh private output required');
  let manifest;
  if (flags.apply) {
    if (!path.resolve(flags.manifest).startsWith(path.resolve('private/annual-meeting') + path.sep)) fail('Private manifest required');
    manifest = JSON.parse(fs.readFileSync(flags.manifest, 'utf8'));
    validateManifest(source, manifest, flags['manifest-sha256']);
  }
  const client = await connectDestination();
  try {
    if (flags.apply) {
      const result = await applyManifest(client, source, manifest, flags['manifest-sha256']);
      savePrivate(output, result);
      console.log(JSON.stringify({ inserted: result.inserted, manifest_sha256: result.manifest_sha256 }));
      return;
    }
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout='60s'");
    const state = { ...await readOutstandingState(client, source), prepared_at: new Date().toISOString() };
    const report = preflight(source, state);
    await client.query('ROLLBACK');
    savePrivate(output, { report, state });
    console.log(JSON.stringify({ summary: report.summary, manifest_sha256: report.manifest_sha256, writes: false }));
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Outstanding registration operation failed; inspect private inputs.'); process.exitCode = 1; });
}