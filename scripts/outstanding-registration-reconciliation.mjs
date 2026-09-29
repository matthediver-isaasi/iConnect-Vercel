#!/usr/bin/env node
// Private operator reconciliation. No network calls; never a public web asset.
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import { SOURCE, SOURCE_HASH, parseWorkbook, validateManifest } from './outstanding-registration-import.mjs';
import { canonical } from './import-annual-meeting-delegates.mjs';
import { validateReconciliationEvidence } from './verify-outstanding-registrations.mjs';

const [manifestPath, resultPath, verificationPath, outputPath, baselinePath, acknowledgment] = process.argv.slice(2);
if (process.argv.length > 8 || (acknowledgment && acknowledgment !== '--acknowledge-concurrent-drift')) throw new Error('Unknown reconciliation argument');
const acknowledge = acknowledgment === '--acknowledge-concurrent-drift';
for (const name of [manifestPath, resultPath, verificationPath, outputPath, baselinePath]) {
  if (typeof name !== 'string' || !path.resolve(name).startsWith(path.resolve('private/annual-meeting') + path.sep)) {
    throw new Error('Supply manifest, apply result, verification, fresh XLSX output and baseline under private/annual-meeting; optional --acknowledge-concurrent-drift');
  }
}
if (fs.existsSync(outputPath)) throw new Error('Refusing to overwrite reconciliation');
const manifest = JSON.parse(fs.readFileSync(manifestPath));
validateManifest(parseWorkbook(fs.readFileSync(SOURCE)), manifest, manifest.report.manifest_sha256);
const { report } = manifest;
const result = JSON.parse(fs.readFileSync(resultPath));
const evidence = JSON.parse(fs.readFileSync(verificationPath));
const baseline = JSON.parse(fs.readFileSync(baselinePath));
if (result.manifest_sha256 !== report.manifest_sha256
  || evidence.manifest_sha256 !== report.manifest_sha256 || evidence.kind !== 'after_import'
  || evidence.workbook_sha256 !== SOURCE_HASH
  || !Array.isArray(result.results)) throw new Error('Reconciliation evidence does not establish verified import');
const artifactAudit = validateReconciliationEvidence(manifest, evidence, baseline, acknowledge);
const applied = new Map(result.results.map(r => [r.source_id, r]));
const verified = new Map(evidence.bookings_verified.map(r => [r.booking_id, r]));
for (const row of report.rows.filter(r => r.disposition === 'ready')) {
  const outcome = applied.get(row.source_id);
  if (!['inserted', 'replayed'].includes(outcome?.outcome)
    || outcome.booking_id !== row.planned_booking.id || !verified.has(outcome.booking_id)) {
    throw new Error('A planned registration lacks apply and independent verification evidence');
  }
}
const originalHeaders = ['Source sheet', 'Source row', 'Attendee name', 'Email',
  'Membership identifier', 'Attendance day', 'Current status / reason', 'Action needed', 'Correction (unnamed column 9)'];
const readableReasons = {
  uuid_email_conflict: 'UUID/current member email conflicts with source email; no explicit override. Identity confirmation required.',
  remove_duplicate: 'Excluded by explicit Remove duplicate instruction; no separate registration.',
  do_not_send: 'Excluded by explicit Do not send instruction; not added to this import/survey cohort.',
  uuid_missing_or_cross_tenant: 'UUID does not identify one member in the verified tenant.',
  ambiguous_current_recipient: 'Current member email does not resolve uniquely.',
  existing_booking_review_required: 'Existing registration requires manual review; unchanged.',
};
const flatten = row => {
  const bookingId = applied.get(row.source_id)?.booking_id || row.covered_booking_id
    || (row.disposition === 'already_present' ? row.existing?.[0]?.id : '') || '';
  const selection = evidence.survey_selection.rows.find(r => r.booking_id === bookingId);
  return {
    'Outstanding workbook row': row.source_row,
    'Outcome': row.disposition === 'ready' ? 'Imported' : row.disposition,
    'Explanation': (row.reasons || []).map(r => readableReasons[r] || r).join(' '),
    'Canonical source row': row.canonical_source_id || '',
    'Corrected attendance day': row.day,
    'Resolved member UUID': row.member?.id || '',
    'Resolved recipient email': row.recipient || '',
    'Recipient decision': row.recipient_decision || '',
    'Ticket ID': row.ticket?.id || '', 'Ticket name': row.ticket?.name || '',
    'Registration ID': bookingId,
    'Existing registration IDs': (row.existing || []).map(b => b.id).join(', '),
    'Financial provenance': row.disposition === 'ready' ? report.financial_provenance : '',
    'Durable award hold': verified.has(bookingId) ? 'Active; no CPD, badge or certificate release authorized' : '',
    'Actual event audience': selection ? 'Verified' : '',
    'Eligible after existing preferences': selection ? String(selection.eligible_after_opt_outs) : '',
    ...Object.fromEntries(originalHeaders.map((header, i) => [`Original ${i + 1}: ${header}`, row.original[i] ?? ''])),
  };
};
const workbook = new ExcelJS.Workbook();
workbook.creator = 'iConnect controlled registration-only import';
const sheets = [];
function addSheet(name, rows) {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  if (!keys.length) keys.push('Result');
  const sheet = workbook.addWorksheet(name);
  sheet.columns = keys.map(key => ({ header: key, key, width: Math.min(48, Math.max(18, key.length)) }));
  rows.forEach(row => sheet.addRow(row));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(rows.length + 1, 1), column: keys.length } };
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  sheets.push({ name, rows, keys });
}
addSheet('Summary', [
  { Item: 'Destination project', Value: report.project },
  { Item: 'Tenant', Value: report.tenant },
  { Item: 'Event', Value: report.event_id },
  { Item: 'Source SHA-256', Value: report.workbook_sha256 },
  { Item: 'Manifest SHA-256', Value: report.manifest_sha256 },
  ...Object.entries(report.summary).map(([Item, Value]) => ({ Item, Value })),
  { Item: 'New registrations in this apply', Value: result.inserted },
  { Item: 'Independently verified imported bookings', Value: evidence.imported_verified },
  { Item: 'Pre-existing bookings unchanged', Value: evidence.existing_bookings_preserved },
  { Item: 'Artifact tables unchanged', Value: artifactAudit.filter(r => !r.Changed).length },
  { Item: 'Concurrent drift acknowledged', Value: acknowledge },
  { Item: 'Broad artifact tables with drift', Value: evidence.changed_artifact_tables.join(', ') || 'None' },
  { Item: 'Preservation limitation', Value: 'Only unchanged audit hashes establish whole-table preservation. Concurrent tasks and live activity changed some broad snapshots; these changes are not attributed to this import.' },
  { Item: 'Concurrent schema migration', Value: evidence.schema_addition_verification || '' },
  { Item: 'Survey audience verified', Value: evidence.survey_selection.verified },
  { Item: 'Eligible after existing communication preferences', Value: evidence.survey_selection.eligible },
  { Item: 'Communications', Value: 'Import and verifier invoke no send APIs. Imported cohort has zero recorded certificate/survey delivery artifacts. Concurrent broader email activity means tenant-wide absence of sends is not asserted.' },
  { Item: 'Financial evidence', Value: report.financial_provenance },
  { Item: 'Award policy', Value: 'New import cohort has a durable registration-only award hold. No CPD release authorized.' },
  { Item: 'Workbook verification', Value: 'Independent cell-by-cell readback, not a Microsoft Excel desktop test.' },
]);
addSheet('All source rows', report.rows.map(flatten));
for (const [name, disposition] of [['Imported', 'ready'], ['Already present', 'already_present'],
  ['Merged source duplicates', 'merged_source_duplicate'], ['Excluded', 'excluded'], ['Unresolved', 'held']]) {
  addSheet(name, report.rows.filter(r => r.disposition === disposition).map(flatten));
}
addSheet('Verified booking audit', evidence.bookings_verified);
addSheet('Survey selection audit', evidence.survey_selection.rows);
addSheet('Artifact preservation', artifactAudit.map(row => ({
  ...row, Scope: ['scheduled_email', 'email_link_click'].includes(row.Table) ? 'Conservative whole table' : 'Tenant or event',
})));
addSheet('Concurrent drift limitations', [
  { Item: 'Acknowledgment', Detail: acknowledge ? 'Operator explicitly acknowledged concurrent broad snapshot drift. Core failures cannot be waived.' : 'No drift acknowledged.' },
  { Item: 'Source of concurrency', Detail: 'Admin Member CPD Certificates and attendee survey prefill tasks merged concurrently; live tenant activity can also alter broad snapshots. Causation of individual changes is not established.' },
  { Item: 'Booking schema', Detail: '107 historical bookings gained survey_invitation_revision. Every historical field is unchanged and complete live rows match the final pre-apply manifest.' },
  { Item: 'Member schema', Detail: 'All 3946 member rows gained survey_invitation_revision. Separate read-only diagnostic stripping that column matched 3945 historical hashes; one row also changed. Member changes are not attributed to this import.' },
  { Item: 'Entitlement schema', Detail: 'All six entitlement rows gained survey_invitation_revision. Separate read-only diagnostic stripping that column restored the exact historical aggregate hash.' },
  { Item: 'Other broad activity', Detail: 'Form submissions, campaigns, campaign recipients and global email clicks changed. See exact counts/hashes in Artifact preservation. No assertion that those tables stayed unchanged.' },
  { Item: 'Core checks', Detail: 'Full imported and previous booking comparisons, cohort zero-artifact checks, and unchanged ledgers, badges, invoice/payment and attendance tables remain mandatory.' },
]);
await workbook.xlsx.writeFile(outputPath);
fs.chmodSync(outputPath, 0o600);
const readback = XLSX.read(fs.readFileSync(outputPath));
if (canonical(readback.SheetNames) !== canonical(sheets.map(s => s.name))) throw new Error('Workbook sheet mismatch');
for (const { name, rows, keys } of sheets) {
  const actual = XLSX.utils.sheet_to_json(readback.Sheets[name], { header: 1, defval: '', blankrows: true });
  if (actual.length !== rows.length + 1 || canonical(actual[0]) !== canonical(keys)) throw new Error('Workbook row/header mismatch');
  rows.forEach((row, i) => keys.forEach((key, j) => {
    if (String(actual[i + 1][j] ?? '') !== String(row[key] ?? '')) throw new Error('Workbook value mismatch');
  }));
}
console.log(JSON.stringify({ rows: report.rows.length, sheets: sheets.length, independent_readback: true, private: true }));