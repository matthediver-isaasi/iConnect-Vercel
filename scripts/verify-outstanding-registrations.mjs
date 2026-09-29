#!/usr/bin/env node
// Read-only DEST verifier. All evidence remains in ignored operator storage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDestination, EVENT, PROJECT } from './annual-meeting-destination.mjs';
import { TENANT, canonical, hash, savePrivate, normalizeBookingTimestamps } from './import-annual-meeting-delegates.mjs';
import { SOURCE, SOURCE_HASH, parseWorkbook, validateManifest } from './outstanding-registration-import.mjs';
import { normalizeGroupPayment, normalizeGroupPricePaid } from '../api/reports/_pricePaid.js';

const fail = message => { throw new Error(message); };
const privatePath = value => {
  if (typeof value !== 'string' || !path.resolve(value).startsWith(path.resolve('private/annual-meeting') + path.sep)) fail('Private evidence paths required');
  return value;
};
const norm = value => String(value || '').trim().toLowerCase();
export function compareHistoricalBooking(old, live, approved, columns) {
  const normalize = booking => normalizeBookingTimestamps(booking, columns);
  const projected = live && Object.fromEntries(Object.keys(old).map(k => [k, live[k]]));
  if (canonical(normalize(old)) !== canonical(normalize(projected))
    || canonical(normalize(live)) !== canonical(normalize(approved))) fail('Pre-existing booking changed');
  const additions = Object.keys(live).filter(k => !Object.hasOwn(old, k));
  if (additions.some(column => column !== 'survey_invitation_revision')) fail('Unreviewed historical booking schema addition');
  return additions;
}
export function validateReconciliationEvidence(manifest, evidence, baseline, acknowledge = false) {
  const planned = manifest.report.rows.filter(r => r.disposition === 'ready').map(r => r.planned_booking);
  const allowedDrift = ['member', 'certificate_survey_entitlement', 'form_submission',
    'email_campaign', 'email_campaign_recipient', 'email_link_click'];
  if (evidence.kind !== 'after_import' || evidence.manifest_sha256 !== manifest.report.manifest_sha256
    || evidence.workbook_sha256 !== SOURCE_HASH || evidence.imported_verified !== planned.length
    || evidence.holds_verified !== planned.length || evidence.survey_selection?.verified !== planned.length
    || evidence.bookings_verified?.length !== planned.length) fail('Core reconciliation verification incomplete');
  const requiredZero = ['member_cpd_points_ledger', 'member_badge', 'event_cpd_points_outbox',
    'event_cpd_badge_outbox', 'attendee_cpd_certificate_delivery', 'campaign_survey_delivery',
    'certificate_survey_entitlement', 'event_cpd_points_award_attempt', 'event_cpd_badge_award_attempt'];
  if (requiredZero.some(table => evidence.cohort_artifacts?.[table] !== 0)) fail('Core cohort artifact verification failed');
  if (!baseline || baseline.project !== PROJECT || baseline.tenant !== TENANT || baseline.event !== EVENT
    || canonical(baseline.planned_ids) !== canonical(planned.map(p => p.id).sort())
    || evidence.existing_bookings_preserved !== baseline.bookings.length) fail('Core baseline verification missing');
  for (const old of baseline.bookings) compareHistoricalBooking(old,
    evidence.bookings.find(b => b.id === old.id && b.table === old.table),
    manifest.state.bookings.find(b => b.id === old.id && b.table === old.table), manifest.state.columns);
  const normalize = b => normalizeBookingTimestamps(b, manifest.state.columns);
  for (const row of planned) {
    if (canonical(normalize({ ...row, table: 'booking' })) !== canonical(normalize(evidence.bookings.find(b => b.id === row.id && b.table === 'booking')))) fail('Core imported booking mismatch');
  }
  const changed = Object.keys(baseline.tables).filter(table =>
    canonical(baseline.tables[table]) !== canonical(evidence.tables[table]));
  if (canonical([...changed].sort()) !== canonical([...(evidence.changed_artifact_tables || [])].sort())) fail('Artifact drift evidence inconsistent');
  if (changed.length && !acknowledge) fail('Concurrent artifact drift requires explicit acknowledgment');
  if (changed.some(table => !allowedDrift.includes(table))) fail('Core ledger/badge/invoice/payment/attendance artifact drift cannot be waived');
  return Object.keys(baseline.tables).map(table => {
    const historicalHashes = new Set(baseline.tables[table].row_sha256);
    return {
    Table: table, 'Before rows': baseline.tables[table].count, 'After rows': evidence.tables[table].count,
    'Before SHA-256': baseline.tables[table].sha256, 'After SHA-256': evidence.tables[table].sha256,
    'Unchanged historical row hashes': evidence.tables[table].row_sha256.filter(h => historicalHashes.has(h)).length,
    Changed: changed.includes(table),
    Limitation: changed.includes(table) ? 'Concurrent broad-scope drift acknowledged; not attributed to this import. No claim of table-wide preservation. Historical values cannot be reconstructed from hashes.' : 'Exact aggregate full-row hashes preserved.',
    };
  });
}
// Tenant-wide snapshots deliberately catch unrelated changes too; any such
// drift requires operator reconciliation, never an unsupported "unchanged" claim.
const artifactTables = [
  'member', 'member_cpd_points_ledger', 'member_badge',
  'event_cpd_points_award_attempt', 'event_cpd_badge_award_attempt',
  'event_cpd_points_outbox', 'event_cpd_badge_outbox',
  'attendee_cpd_certificate_delivery', 'certificate_survey_entitlement',
  'campaign_survey_delivery', 'attendance_current_outcome',
  'attendance_outcome_revision', 'attendance_outcome_transition',
  'attendance_participant_match', 'attendance_transition_outbox',
  'complex_event_session_checkin', 'zoom_attendance',
  'form_submission', 'form_submission_email', 'email_campaign',
  'event_email', 'member_email', 'member_transactional_message', 'scheduled_email',
  'sales_accounting_invoice_attempt', 'sales_accounting_invoice_link',
  'membership_instalment_invoices', 'gocardless_payments', 'payment_webhook_events',
  'training_fund_transaction', 'program_ticket_transaction',
];
export async function snapshot(client) {
  const columns = (await client.query(`select table_name,column_name from information_schema.columns
    where table_schema='public' order by table_name,ordinal_position`)).rows;
  const schemas = new Map();
  for (const c of columns) {
    const names = schemas.get(c.table_name) || [];
    names.push(c.column_name); schemas.set(c.table_name, names);
  }
  const tables = {};
  async function record(name, sql, parameters) {
    const rows = (await client.query(sql, parameters)).rows.map(row => row.value);
    const rowHashes = rows.map(hash).sort();
    tables[name] = { count: rows.length, sha256: hash(rowHashes), row_sha256: rowHashes };
  }
  for (const name of artifactTables) {
    if (!schemas.has(name)) fail(`Required artifact schema unavailable: ${name}`);
    if (schemas.get(name).includes('tenant_id')) {
      await record(name, `select to_jsonb(t) value from public.${name} t where tenant_id=$1`, [TENANT]);
    } else if (name === 'event_email') {
      await record(name, `select to_jsonb(t) value from event_email t where event_id=$1`, [EVENT]);
    } else if (name === 'scheduled_email') {
      await record(name, `select to_jsonb(t) value from scheduled_email t`, []);
    } else fail(`Required tenant-scoped artifact schema unavailable: ${name}`);
  }
  await record('email_campaign_recipient', `select to_jsonb(r) value from email_campaign_recipient r
    join email_campaign c on c.id=r.campaign_id where c.tenant_id=$1`, [TENANT]);
  await record('certificate_survey_credential', `select to_jsonb(c) value from certificate_survey_credential c
    join certificate_survey_entitlement e on e.id=c.entitlement_id where e.tenant_id=$1`, [TENANT]);
  // Email events can record provider deliveries independently of campaigns.
  for (const name of ['email_event', 'email_link_click']) {
    if (!schemas.has(name)) fail(`Required communication schema unavailable: ${name}`);
    if (schemas.get(name).includes('tenant_id')) {
      await record(name, `select to_jsonb(t) value from ${name} t where tenant_id=$1`, [TENANT]);
    } else {
      // No tenant column: full-table snapshot is conservative and explicit.
      await record(name, `select to_jsonb(t) value from ${name} t`, []);
    }
  }
  const bookings = [];
  for (const table of ['booking', 'complex_event_booking']) {
    bookings.push(...(await client.query(`select to_jsonb(b) value from ${table} b where event_id=$1 order by id`, [EVENT]))
      .rows.map(({ value }) => ({ ...value, table })));
  }
  return { project: PROJECT, tenant: TENANT, event: EVENT, captured_at: new Date().toISOString(), tables, bookings };
}

export async function verifyCampaignSelection(planned) {
  if (process.env.DEST_SUPABASE_URL !== `https://${PROJECT}.supabase.co` || !process.env.DEST_SUPABASE_KEY) fail('Pinned DEST REST credentials required for real recipient verification');
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method || input?.method || 'GET').toUpperCase();
    if (url.origin !== process.env.DEST_SUPABASE_URL || !['GET', 'HEAD'].includes(method)) fail('Verifier blocked a non-read-only request');
    reads++;
    return originalFetch(input, init);
  };
  try {
    const { getTargetRecipients } = await import('../api/_lib/campaignService.js');
    const { supabase } = await import('../api/_lib/database.js');
    const result = await getTargetRecipients({
      target_type: 'event_attendees', target_ids: [EVENT],
    }, TENANT, false, true);
    if (!result.success) fail('Real event attendee recipient selection failed');
    const audience = new Set((result.detailedLists?.audience || []).map(r => norm(r.email)));
    const eligible = new Map(result.recipients.map(r => [norm(r.email), r]));
    const results = [];
    for (const booking of planned) {
      if (!audience.has(norm(booking.attendee_email))) fail('Imported attendee missing from actual survey audience');
      const selected = eligible.get(norm(booking.attendee_email));
      if (selected && selected.member_id !== booking.member_id && selected.id !== booking.member_id) fail('Actual recipient identity differs from import identity');
      // Exact production survey-source read from campaignSurveyDelivery.js.
      // Never call its preparation function: that would create a delivery.
      const { data, error } = await supabase.from('booking').select('id,attendee_email,member_id')
        .eq('tenant_id', TENANT).eq('event_id', EVENT).eq('status', 'confirmed')
        .ilike('attendee_email', booking.attendee_email.trim().replace(/([%_\\])/g, '\\$1'))
        .order('created_at', { ascending: false }).limit(1);
      if (error || data?.[0]?.id !== booking.id || data[0].member_id !== booking.member_id) fail('Survey source booking resolution mismatch');
      results.push({ booking_id: booking.id, member_id: booking.member_id,
        in_actual_audience: true, eligible_after_opt_outs: Boolean(selected),
        survey_source_booking_verified: true });
    }
    return { verified: results.length, eligible: results.filter(r => r.eligible_after_opt_outs).length,
      suppressed_by_existing_preferences: results.filter(r => !r.eligible_after_opt_outs).length,
      readonly_http_requests: reads, sends: 0, rows: results };
  } finally { globalThis.fetch = originalFetch; }
}

export async function main(args = process.argv.slice(2)) {
  const [mode, manifestPath, baselinePath, outputPath] = args;
  if (!['baseline', 'verify'].includes(mode) || (mode === 'baseline' ? args.length !== 3 : args.length !== 4)) fail('Use baseline <manifest> <output> OR verify <manifest> <baseline> <output>');
  const output = privatePath(mode === 'baseline' ? baselinePath : outputPath);
  if (fs.existsSync(output)) fail('Fresh output required');
  const manifest = JSON.parse(fs.readFileSync(privatePath(manifestPath)));
  validateManifest(parseWorkbook(fs.readFileSync(SOURCE)), manifest, manifest.report.manifest_sha256);
  const client = await connectDestination();
  let evidence;
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout='60s'");
    const current = await snapshot(client);
    const planned = manifest.report.rows.filter(r => r.disposition === 'ready').map(r => r.planned_booking);
    if (mode === 'baseline') {
      if (current.bookings.some(b => planned.some(p => p.id === b.id))) fail('Baseline cannot be captured after import');
      evidence = { ...current, workbook_sha256: SOURCE_HASH, manifest_sha256: manifest.report.manifest_sha256,
        planned_ids: planned.map(p => p.id).sort(), kind: 'before_import' };
    } else {
      const baseline = JSON.parse(fs.readFileSync(privatePath(baselinePath)));
      if (baseline.project !== PROJECT || baseline.tenant !== TENANT || baseline.event !== EVENT
        || baseline.workbook_sha256 !== SOURCE_HASH
        || canonical(baseline.planned_ids) !== canonical(planned.map(p => p.id).sort())) fail('Baseline scope mismatch');
      const changed = Object.keys(baseline.tables).filter(name =>
        canonical(baseline.tables[name]) !== canonical(current.tables[name]));
      const normalize = booking => normalizeBookingTimestamps(booking, manifest.state.columns);
      const baselineSchemaAdditions = new Map();
      for (const old of baseline.bookings) {
        const live = current.bookings.find(b => b.id === old.id && b.table === old.table);
        const approved = manifest.state.bookings.find(b => b.id === old.id && b.table === old.table);
        // Other deployed migrations may add columns between the independent
        // baseline and the final reviewed manifest. Preserve the historical
        // baseline; compare every historical field, then require the COMPLETE
        // live row to equal the later approved pre-apply row. Never use this
        // allowance for changed historical values or post-manifest additions.
        for (const column of compareHistoricalBooking(old, live, approved, manifest.state.columns)) {
          baselineSchemaAdditions.set(column, (baselineSchemaAdditions.get(column) || 0) + 1);
        }
      }
      const additions = current.bookings.filter(b => !baseline.bookings.some(old => old.table === b.table && old.id === b.id));
      if (additions.length !== planned.length) fail('Unexpected new event booking count');
      const verified = [];
      for (const booking of planned) {
        const live = additions.find(b => b.table === 'booking' && b.id === booking.id);
        if (canonical(normalize(live)) !== canonical(normalize({ ...booking, table: 'booking' }))) fail('Imported full booking differs from approved plan');
        const financial = normalizeGroupPayment([live]);
        const paid = normalizeGroupPricePaid([live])[0];
        if (financial.totalsStatus !== 'unavailable_import_financials' || paid.price_paid !== null
          || booking.booking_group_reference !== booking.booking_reference) fail('Registration financial/group provenance mismatch');
        verified.push({ booking_id: booking.id, member_id: booking.member_id, ticket_id: booking.ticket_class_id,
          independent_group: booking.booking_group_reference, financial_status: financial.totalsStatus, price_paid: paid.price_paid });
      }
      if (new Set(verified.map(r => r.independent_group)).size !== planned.length) fail('Import registrations share groups');
      const holds = (await client.query(`select to_jsonb(h) value from outstanding_registration_award_hold h where booking_id=any($1::uuid[])`, [planned.map(p => p.id)])).rows.map(r => r.value);
      if (holds.length !== planned.length || holds.some(h => h.tenant_id !== TENANT || h.event_id !== EVENT || h.source_sha256 !== SOURCE_HASH
        || h.booking_reference !== planned.find(b => b.id === h.booking_id)?.booking_reference)) fail('Durable award hold mismatch');
      const cohort = {};
      for (const table of ['member_cpd_points_ledger', 'member_badge', 'event_cpd_points_outbox',
        'event_cpd_badge_outbox', 'attendee_cpd_certificate_delivery', 'campaign_survey_delivery',
        'certificate_survey_entitlement', 'event_cpd_points_award_attempt', 'event_cpd_badge_award_attempt']) {
        cohort[table] = Number((await client.query(`select count(*) count from ${table} where booking_id=any($1::uuid[])`, [planned.map(p => p.id)])).rows[0].count);
      }
      if (Object.values(cohort).some(Boolean)) fail('Prohibited imported-cohort artifact found');
      evidence = { ...current, kind: 'after_import', workbook_sha256: SOURCE_HASH,
        manifest_sha256: manifest.report.manifest_sha256, changed_artifact_tables: changed,
        historical_baseline_schema_additions: Object.fromEntries(baselineSchemaAdditions),
        schema_addition_verification: 'Historical fields preserved; complete rows equal final pre-apply manifest. survey_invitation_revision added by concurrent survey migration.',
        existing_bookings_preserved: baseline.bookings.length, imported_verified: verified.length,
        holds_verified: holds.length, cohort_artifacts: cohort, bookings_verified: verified };
    }
    await client.query('ROLLBACK');
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
  if (mode === 'verify') {
    evidence.survey_selection = await verifyCampaignSelection(manifest.report.rows.filter(r => r.disposition === 'ready').map(r => r.planned_booking));
  }
  savePrivate(output, evidence);
  console.log(JSON.stringify({ mode, artifact_tables: Object.keys(evidence.tables).length,
    imported_verified: evidence.imported_verified, changed_artifact_tables: evidence.changed_artifact_tables,
    survey: evidence.survey_selection && { verified: evidence.survey_selection.verified,
      eligible: evidence.survey_selection.eligible }, writes: false }));
  if (evidence.changed_artifact_tables?.length) fail('Artifact snapshots drifted; private evidence saved for reconciliation');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}