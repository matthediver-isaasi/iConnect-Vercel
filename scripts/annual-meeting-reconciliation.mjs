#!/usr/bin/env node
// Private operator workbook; never publishes attendee data to a web directory.
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';

const [manifestPath, resultPath, cpdPath, outputPath] = process.argv.slice(2);
if (![manifestPath, resultPath, cpdPath, outputPath].every(p =>
  typeof p === 'string' && path.resolve(p).startsWith(path.resolve('private/annual-meeting') + path.sep))) {
  throw new Error('Supply manifest, result, CPD evidence and output paths under private/annual-meeting');
}
if (fs.existsSync(outputPath)) throw new Error('Refusing to overwrite reconciliation');
const { report } = JSON.parse(fs.readFileSync(manifestPath));
const result = JSON.parse(fs.readFileSync(resultPath));
const cpd = JSON.parse(fs.readFileSync(cpdPath));
if (result.manifest_sha256 !== report.manifest_sha256 || !Array.isArray(result.results)) throw new Error('Import result does not match manifest');
const applied = new Map(result.results.map(row => [row.source_id, row]));
if (report.rows.some(row => row.disposition === 'ready' && !['inserted', 'replayed'].includes(applied.get(row.source_id)?.outcome))) {
  throw new Error('Not all planned bookings are confirmed imported');
}
const reasons = {
  identical_source_row_covered_by_canonical: 'Identical duplicate source row: covered by the linked canonical registration; no extra booking or CPD award.',
  source_not_cpd_eligible: 'Excluded by instruction: CPD status is not Can be sent.',
  uuid_email_conflict: 'Workbook UUID belongs to a member with a different email; identity needs confirmation.',
  uuid_missing_or_cross_tenant: 'Workbook UUID was not found in this event tenant.',
  ambiguous_email: 'Multiple members share this email; identity needs confirmation.',
  member_missing_no_creation: 'No existing tenant member matched. No member was created.',
  role_has_no_ticket: 'Verified member role has no unique eligible ticket for this day; ticket mapping needs confirmation.',
  ambiguous_ticket: 'More than one ticket matches the role and day.',
  duplicate_source_email: 'Email appears on multiple attendance-sheet rows; reconcile identities and attendance days.',
  existing_booking_review_required: 'Existing registration needs review; it was not changed.',
  registration_rule_unavailable: 'No unambiguous registration CPD rule is configured.',
};
const originals = [...new Set(report.rows.flatMap(row => Object.keys(row.original)))];
const flatten = row => ({
  'Source sheet': row.sheet, 'Source Excel row': row.source_row,
  'Outcome': row.disposition === 'ready' ? 'Imported (see booking audit)' : row.disposition,
  'Reason': row.reasons.map(r => reasons[r] || r).join(' '),
  'Verified member UUID': row.member?.id || '',
  'Verified role UUID': row.member?.role_id || '',
  'Mapped ticket ID': row.ticket?.id || '', 'Mapped ticket name': row.ticket?.name || '',
  'Expected CPD points': row.rule?.points_value || '',
  'Certificate start date': row.certificate?.start_date || '',
  'Certificate end date': row.certificate?.end_date || '',
  'Existing booking IDs': (row.existing || []).map(b => b.id).join(', '),
  'Result booking ID': applied.get(row.source_id)?.booking_id || '',
  'Canonical source row': row.canonical_source_id || '',
  ...Object.fromEntries(originals.map(k => [`Original: ${k}`, row.original[k] ?? ''])),
});
const wb = new ExcelJS.Workbook();
wb.creator = 'iConnect controlled import';
const expected = [];
function sheet(name, rows) {
  const ws = wb.addWorksheet(name);
  const keys = [...new Set(rows.flatMap(Object.keys))];
  if (!keys.length) keys.push('Result');
  ws.columns = keys.map(key => ({ header: key, key, width: Math.min(50, Math.max(18, key.length + 2)) }));
  rows.forEach(row => ws.addRow(row));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: keys.length } };
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  expected.push({ name, keys, rows });
}
sheet('Summary', [
  { Item: 'Event', Value: 'BNMS Autumn Meeting 2026' },
  { Item: 'Destination project', Value: report.project },
  { Item: 'Event ID', Value: report.event_id },
  { Item: 'Workbook SHA-256', Value: report.workbook_sha256 },
  { Item: 'Manifest SHA-256', Value: report.manifest_sha256 },
  ...Object.entries(report.summary).map(([Item, Value]) => ({ Item: `Preflight ${Item}`, Value })),
  { Item: 'New registrations', Value: result.inserted },
  { Item: 'CPD verification', Value: JSON.stringify(cpd.summary || cpd.counts || {}) },
  { Item: 'Excluded', Value: 'Waiting for payment and No were not imported.' },
  { Item: 'Financial evidence', Value: 'Zero-price admin_import records are not claims of payment or settlement.' },
  { Item: 'Communication', Value: 'No booking confirmations or certificates sent.' },
  { Item: 'Migration status', Value: 'No schema migrations required or applied.' },
]);
sheet('Not imported', report.rows.filter(r => r.disposition !== 'ready').map(flatten));
const totals = new Map();
for (const row of report.rows) {
  const key = JSON.stringify([row.sheet, row.disposition, row.ticket?.name || '(unmapped)']);
  totals.set(key, (totals.get(key) || 0) + 1);
}
sheet('Counts by sheet and ticket', [...totals].map(([key, count]) => {
  const [sheet, outcome, ticket] = JSON.parse(key);
  return { Sheet: sheet, Outcome: outcome === 'ready' ? 'imported' : outcome, Ticket: ticket, Rows: count };
}));
sheet('Explicit exclusions', report.rows.filter(r => r.disposition === 'excluded').map(flatten));
sheet('Needs review', report.rows.filter(r => r.disposition === 'held').map(flatten));
sheet('Already registered', report.rows.filter(r => ['already_registered', 'already_present'].includes(r.disposition)).map(flatten));
sheet('All attendance rows', report.rows.map(flatten));
sheet('Master reconciliation', Object.entries(report.masterDiscrepancies)
  .filter(([, rows]) => Array.isArray(rows))
  .flatMap(([kind, rows]) => rows.map(row => ({
    'Discrepancy': kind, 'Source sheet': row.sheet, 'Source Excel row': row.source_row,
    'Action': kind === 'master_only' ? 'Not imported: master list is not an import batch.' : 'Attendance-sheet row absent from master list.',
    ...row.original,
  }))));
sheet('Booking audit', result.results.map(row =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : v]))));
sheet('CPD evidence', (cpd.bookings || cpd.rows || cpd.results || []).map(row =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : v]))));
await wb.xlsx.writeFile(outputPath);
fs.chmodSync(outputPath, 0o600);
// Independent reader: check every emitted value and row, not just ZIP readability.
const readback = XLSX.read(fs.readFileSync(outputPath));
for (const { name, keys, rows } of expected) {
  const actual = XLSX.utils.sheet_to_json(readback.Sheets[name], { header: 1, defval: '', blankrows: true });
  if (actual.length !== rows.length + 1) throw new Error(`Row-count mismatch: ${name}`);
  rows.forEach((row, i) => keys.forEach((key, j) => {
    if (String(actual[i + 1][j] ?? '') !== String(row[key] ?? '')) throw new Error(`Value mismatch: ${name}`);
  }));
}
console.log(JSON.stringify({ workbook: outputPath, sheets: expected.map(s => ({ name: s.name, rows: s.rows.length })), independently_read_back: true, microsoft_excel_open_test: false }));