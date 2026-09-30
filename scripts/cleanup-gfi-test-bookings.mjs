// cleanup-gfi-test-bookings.mjs (task-3020)
//
// Deletes ~43 TEST event bookings (and linked child rows) for the tenant
// Graduate Futures Institute. Pure data cleanup: NO refunds, NO Stripe calls,
// NO Xero/QBO credit notes, NO balance reinstatement of any kind. Does NOT
// touch event rows (esp. "MAT TEST DO NOT REMOVE" — its bookings ARE in
// scope, the event is not).
//
// Usage:
//   node scripts/cleanup-gfi-test-bookings.mjs            # dry run (default)
//   node scripts/cleanup-gfi-test-bookings.mjs --apply    # actually delete
//
// Hard-pinned to tenant fd82da65-aab7-4a5c-85b8-b2febeb2003d. Fails loudly if
// any booking reference resolves to 0 rows or to a different tenant.
// Idempotent: re-running after --apply reports 0 rows and exits cleanly.
//
// Tables cleaned (children first, then booking rows):
//   training_fund_transaction      (booking_id)   — transaction rows only, org balance untouched
//   voucher_transaction            (booking_reference)
//   program_ticket_transaction     (booking_reference)
//   zoom_attendance                (matched_booking_id)
//   complex_event_session_checkin  (booking_id)
//   scheduled_email                (booking_id)
//   booking_cancellation_request   (booking_id OR booking_group_reference, tenant-scoped)
//   booking_transfer_request       (booking_id, tenant-scoped)
//   event_group_booking_participant(group_booking_id)
//   booking                        (by reference + group siblings)
//   complex_event_booking          (CEB-TVWWR87C)
//
// Not applicable (verified during investigation):
//   discount_code_usage — has NO booking linkage column (per code + org only); none of
//     these bookings carry a discount_code_id, nothing to do.
//   form_submission — has NO booking linkage column; conference form answers live on
//     the booking rows themselves (dietary/allergy/accessibility selections), deleted
//     with the booking.

import { createClient } from '@supabase/supabase-js';

const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d'; // Graduate Futures Institute — DO NOT CHANGE
const APPLY = process.argv.includes('--apply');

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('FATAL: DEST_SUPABASE_URL / DEST_SUPABASE_KEY must be set.');
  process.exit(1);
}
const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

// 31 verified booking references from the spreadsheet
// attached_assets/Event_testing_transactions_to_be_removed_1784738138495.xlsx
const BOOKING_REFS = [
  'OOE-1770717460242-3OLBU', 'OOE-1770810419481-RWZZE', 'OOE-1770996287173-RCZPO',
  'OOE-1770810019883-8QPS0', 'OOE-1774440596448-CD4FO', 'OOE-1771411457114-58E8F',
  'OOE-1770322664284-V9VQX', 'OOE-1771415630415-6NG92', 'OOE-1771269087124-TEVNO',
  'OOE-1771415844568-OD0AV', 'OOE-1771407724578-H3Z19', 'OOE-1771359436491-DY2W9-5',
  'OOE-1768387791782-YSFI3', 'IMP-1781706742591-0ARNS', 'OOE-1771511798929-LZH7F',
  'OOE-1774255552325-FDPFR', 'OOE-1771000223700-OBVR6', 'OOE-1771359667937-GTYFC',
  'OOE-1771359023542-059D4', 'OOE-1770321722504-G9CNP', 'OOE-1776753466951-8N75X',
  'OOE-1766373370205-DRS5O', 'IMP-1781788937803-AW1HR', 'OOE-1769980321330-JSLV3',
  'OOE-1772748589992-K9OKZ', 'OOE-1771413031219-60OWX', 'IMP-1781706919770-MEAYW',
  'OOE-1766399442277-LQOFY', 'IMP-1781705156724-E6777', 'OOE-1774368522995-QCP2T',
];
// Group references — ALL sibling booking rows in these groups are in scope.
const GROUP_REFS = [
  'OOE-1771359436491-DY2W9',
  'IMPG-1781706919770-QRJFL',
  'IMPG-1781706742591-SLM6B',
];
const COMPLEX_REF = 'CEB-TVWWR87C';

// Emails listed on the spreadsheet (for flagging group siblings NOT on it).
const SPREADSHEET_EMAILS = new Set([
  'erica.imhof@agcas.org.uk', 'erica@graduatefutures.org', 'headofservicetest@graduatefutures.org',
  'hello@graduatefutures.org', 'isaasitesting1@outlook.com', 'isaasitesting2@outlook.com',
  'isaasitesting3@outlook.com', 'isaasitesting4@outlook.com', 'isaasitesting5@outlook.com',
  'isaasitesting6@outlook.com', 'isaasitesting7@outlook.com', 'isaasitesting8@outlook.com',
  'm.benedettomozo@westminster.ac.uk', 'martin@graduatefutures.org', 'nonmembertest@graduatefutures.org',
  'primarycoordinatortest@graduatefutures.org', 'sarah@graduatefutures.org', 'sharon.bacon@agcas.org.uk',
  'sharon@onlinem.co.uk', 'sharon-bacon@outlook.com', 'test@outlook.com', 'test@test.com',
  'claire@graduatefutures.org', 'craig@graduatefutures.org', 'eleanor@graduatefutures.org',
  'etta@graduatefutures.org', 'grace@graduatefutures.org', 'gsftesting1@outlook.com',
  'jeremy@graduatefutures.org', 'lara@graduatefutures.org', 'lucy@graduatefutures.org',
  'sarah.nichols@agcas.org.uk',
]);

const warnings = [];
function warn(msg) { warnings.push(msg); console.log(`  !! ${msg}`); }
function die(msg) { console.error(`\nFATAL: ${msg}`); process.exit(1); }

async function main() {
  console.log('='.repeat(72));
  console.log(`GFI test-booking cleanup — ${APPLY ? '*** APPLY MODE ***' : 'DRY RUN (no changes)'}`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log('='.repeat(72));

  // ---- 1. Resolve booking rows --------------------------------------------
  const { data: byRef, error: e1 } = await sb.from('booking')
    .select('id, booking_reference, booking_group_reference, attendee_email, attendee_first_name, attendee_last_name, tenant_id, status, event_id, zoom_registrant_id')
    .in('booking_reference', BOOKING_REFS);
  if (e1) die(`booking by-reference query failed: ${e1.message}`);

  const { data: byGrp, error: e2 } = await sb.from('booking')
    .select('id, booking_reference, booking_group_reference, attendee_email, attendee_first_name, attendee_last_name, tenant_id, status, event_id, zoom_registrant_id')
    .in('booking_group_reference', GROUP_REFS);
  if (e2) die(`booking by-group query failed: ${e2.message}`);

  const bookingMap = new Map();
  for (const b of [...(byRef || []), ...(byGrp || [])]) bookingMap.set(b.id, b);
  const bookings = [...bookingMap.values()];

  // Validate: every reference resolved, unless already deleted by a prior --apply run.
  const foundRefs = new Set(bookings.map(b => b.booking_reference));
  const missingRefs = BOOKING_REFS.filter(r => !foundRefs.has(r));

  // Complex booking
  const { data: cebRows, error: e3 } = await sb.from('complex_event_booking')
    .select('id, booking_reference, booking_group_reference, attendee_email, tenant_id, status, event_id')
    .or(`booking_reference.eq.${COMPLEX_REF},booking_group_reference.eq.${COMPLEX_REF}`);
  if (e3) die(`complex_event_booking query failed: ${e3.message}`);
  const cebs = cebRows || [];
  // CEB-TVWWR87C sits in group CEB-EM8JB2QQ — verify no OTHER bookings share it.
  for (const c of cebs) {
    if (c.booking_group_reference) {
      const { data: sibs } = await sb.from('complex_event_booking')
        .select('id, booking_reference')
        .eq('booking_group_reference', c.booking_group_reference)
        .neq('id', c.id);
      if (sibs && sibs.length > 0) {
        warn(`complex booking group ${c.booking_group_reference} has ${sibs.length} OTHER booking(s) NOT in scope: ${sibs.map(s => s.booking_reference).join(', ')} — leaving them untouched.`);
      }
    }
  }

  if (bookings.length === 0 && cebs.length === 0) {
    if (missingRefs.length === BOOKING_REFS.length) {
      console.log('\nAll references resolve to 0 rows — cleanup appears to have already been applied. Nothing to do.');
      return;
    }
    die('No booking rows resolved at all.');
  }
  if (missingRefs.length > 0) {
    die(`These booking references resolved to 0 rows (unexpected partial state):\n  ${missingRefs.join('\n  ')}`);
  }
  if (cebs.length === 0) die(`Complex booking ${COMPLEX_REF} resolved to 0 rows.`);

  // Tenant pin — hard fail on any row outside GFI.
  for (const b of [...bookings, ...cebs]) {
    if (b.tenant_id !== TENANT_ID) {
      die(`Booking ${b.booking_reference} (${b.id}) belongs to tenant ${b.tenant_id}, NOT GFI. Aborting.`);
    }
  }

  const bookingIds = bookings.map(b => b.id);
  const cebIds = cebs.map(c => c.id);
  const allIds = [...bookingIds, ...cebIds];
  const allRefs = [...new Set([
    ...bookings.map(b => b.booking_reference),
    ...bookings.map(b => b.booking_group_reference).filter(Boolean),
    ...cebs.map(c => c.booking_reference),
    ...cebs.map(c => c.booking_group_reference).filter(Boolean),
  ])];

  console.log(`\nResolved ${bookings.length} booking row(s) + ${cebs.length} complex_event_booking row(s).`);

  // ---- 2. Enumerate rows per table ----------------------------------------
  const label = (b) => `${b.booking_reference}  ${b.attendee_email || '(no email)'}`;

  console.log(`\n--- booking (${bookings.length} rows) ---`);
  for (const b of bookings.sort((a, z) => (a.booking_reference || '').localeCompare(z.booking_reference || ''))) {
    const flags = [];
    if (b.status === 'cancelled') flags.push('already-cancelled');
    if (b.zoom_registrant_id) flags.push('has zoom_registrant_id (no Zoom API call — data delete only)');
    if (b.attendee_email && !SPREADSHEET_EMAILS.has(b.attendee_email.toLowerCase()))
      flags.push('GROUP SIBLING NOT ON SPREADSHEET (in scope per task: include ALL group rows)');
    console.log(`  ${label(b)}  [id ${b.id}]${flags.length ? '  <-- ' + flags.join('; ') : ''}`);
    if (flags.some(f => f.startsWith('GROUP SIBLING'))) warn(`booking ${b.booking_reference} (${b.attendee_email}) is a group sibling not listed on the spreadsheet — included via group ${b.booking_group_reference}.`);
  }

  console.log(`\n--- complex_event_booking (${cebs.length} rows) ---`);
  for (const c of cebs) console.log(`  ${label(c)}  [id ${c.id}]`);

  // Child tables: { table, column, values, extraFilter }
  const childSpecs = [
    { table: 'training_fund_transaction', column: 'booking_id', values: allIds,
      describe: r => `type=${r.type} amount=${r.amount} reason="${r.reason}"` },
    { table: 'voucher_transaction', column: 'booking_reference', values: allRefs,
      describe: r => `amount=${r.amount ?? r.value ?? '?'}` },
    { table: 'program_ticket_transaction', column: 'booking_reference', values: allRefs,
      describe: r => `program=${r.program_name} type=${r.transaction_type}` },
    { table: 'zoom_attendance', column: 'matched_booking_id', values: allIds,
      describe: r => `event=${r.event_id}` },
    { table: 'complex_event_session_checkin', column: 'booking_id', values: allIds,
      describe: r => `session=${r.session_id}` },
    { table: 'scheduled_email', column: 'booking_id', values: allIds,
      describe: r => `status=${r.status} send=${r.scheduled_send_time}` },
    { table: 'booking_cancellation_request', column: 'booking_id', values: allIds, tenantScoped: true,
      describe: r => `status=${r.status} reason="${(r.reason || '').slice(0, 60)}"` },
    { table: 'booking_transfer_request', column: 'booking_id', values: allIds, tenantScoped: true,
      describe: r => `status=${r.status}` },
    { table: 'event_group_booking_participant', column: 'group_booking_id', values: allIds,
      describe: () => '' },
  ];

  const childRows = {}; // table -> array of ids
  for (const spec of childSpecs) {
    let q = sb.from(spec.table).select('*').in(spec.column, spec.values).limit(2000);
    if (spec.tenantScoped) q = q.eq('tenant_id', TENANT_ID);
    const { data, error } = await q;
    if (error) die(`${spec.table} query failed: ${error.message}`);
    childRows[spec.table] = { spec, rows: data || [] };
    console.log(`\n--- ${spec.table} (${(data || []).length} rows, linked by ${spec.column}) ---`);
    for (const r of data || []) {
      const parent = bookingMap.get(r[spec.column]) || cebs.find(c => c.id === r[spec.column]);
      const refLabel = parent ? parent.booking_reference : (spec.column.includes('reference') ? r[spec.column] : r[spec.column]);
      console.log(`  [id ${r.id}] booking=${refLabel}  ${spec.describe(r)}`);
    }
    if ((data || []).length >= 2000) die(`${spec.table} hit the 2000-row probe cap — paginate before applying.`);
  }

  // booking_cancellation_request also links by booking_group_reference
  {
    const { data, error } = await sb.from('booking_cancellation_request')
      .select('*').in('booking_group_reference', allRefs).eq('tenant_id', TENANT_ID);
    if (error) die(`booking_cancellation_request by-group query failed: ${error.message}`);
    const existingIds = new Set(childRows['booking_cancellation_request'].rows.map(r => r.id));
    const extra = (data || []).filter(r => !existingIds.has(r.id));
    if (extra.length > 0) {
      console.log(`\n--- booking_cancellation_request extra rows by booking_group_reference (${extra.length}) ---`);
      for (const r of extra) console.log(`  [id ${r.id}] group=${r.booking_group_reference} status=${r.status}`);
      childRows['booking_cancellation_request'].rows.push(...extra);
    }
  }

  // ---- 3. Summary -----------------------------------------------------------
  console.log('\n' + '='.repeat(72));
  console.log('SUMMARY');
  console.log('='.repeat(72));
  const plan = [];
  for (const [table, { rows }] of Object.entries(childRows)) {
    console.log(`  ${table.padEnd(36)} ${rows.length}`);
    if (rows.length) plan.push({ table, ids: rows.map(r => r.id) });
  }
  console.log(`  ${'booking'.padEnd(36)} ${bookings.length}`);
  console.log(`  ${'complex_event_booking'.padEnd(36)} ${cebs.length}`);
  console.log(`\n  Warnings: ${warnings.length}`);
  warnings.forEach(w => console.log(`    - ${w}`));
  console.log('\n  NOT touched: events, org balances (training fund / voucher / account),');
  console.log('  discount_code usage counts, Stripe, Xero/QBO, Zoom API, invoices.');

  if (!APPLY) {
    console.log('\nDRY RUN complete — re-run with --apply to delete the rows above.');
    return;
  }

  // ---- 4. Apply: children first, then booking rows ---------------------------
  console.log('\nAPPLYING deletions (children first)...');
  for (const { table, ids } of plan) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error } = await sb.from(table).delete().in('id', chunk);
      if (error) die(`DELETE from ${table} failed: ${error.message} — stopping. Re-run to resume (idempotent).`);
    }
    console.log(`  deleted ${ids.length} row(s) from ${table}`);
  }
  for (let i = 0; i < bookingIds.length; i += 200) {
    const chunk = bookingIds.slice(i, i + 200);
    const { error } = await sb.from('booking').delete().in('id', chunk).eq('tenant_id', TENANT_ID);
    if (error) die(`DELETE from booking failed: ${error.message}`);
  }
  console.log(`  deleted ${bookingIds.length} row(s) from booking`);
  {
    const { error } = await sb.from('complex_event_booking').delete().in('id', cebIds).eq('tenant_id', TENANT_ID);
    if (error) die(`DELETE from complex_event_booking failed: ${error.message}`);
    console.log(`  deleted ${cebIds.length} row(s) from complex_event_booking`);
  }

  // ---- 5. Verify --------------------------------------------------------------
  console.log('\nVerifying...');
  const { data: leftRef } = await sb.from('booking').select('id').in('booking_reference', BOOKING_REFS);
  const { data: leftGrp } = await sb.from('booking').select('id').in('booking_group_reference', GROUP_REFS);
  const { data: leftCeb } = await sb.from('complex_event_booking').select('id').eq('booking_reference', COMPLEX_REF);
  const remaining = (leftRef?.length || 0) + (leftGrp?.length || 0) + (leftCeb?.length || 0);
  if (remaining > 0) die(`Verification failed: ${remaining} booking row(s) still present.`);
  console.log('  0 matching booking rows remain. Cleanup complete.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
