// Offline export only: consumes the read-only audit and separately scoped
// purchase evidence. It never writes to the database or calls providers.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { addCalendarMonths, rollingDateString } from '../shared/rollingMembershipTerm.js';

const dir = 'generated-artifacts/bnms-all-renewal';
const evidence = JSON.parse(await fs.readFile(`${dir}/evidence.json`, 'utf8'));
const snapshot = JSON.parse(await fs.readFile(`${dir}/snapshot.json`, 'utf8'));
const purchases = JSON.parse(await fs.readFile(`${dir}/purchase-evidence.json`, 'utf8'));
const t = snapshot.tables;
const history = id => t.member_membership_history.find(h => h.id === id);
const config = id => t.membership_tier_config.find(c => c.id === id);
const blockers = evidence.rows.filter(r => !r.exclusion && r.issues.some(i => i.code === 'renewal_admission_review'));
const reconstruction = purchases.map(p => {
  const h = history(p.result?.history_id);
  assert.ok(h && p.result.entity_id === h.member_id);
  assert.equal(h.payment_status, 'paid');
  assert.equal(p.payment_status, 'paid');
  assert.equal(p.payment_reference, h.stripe_payment_intent_id);
  assert.equal(p.quote.config_id, h.config_id);
  assert.equal(p.quote.total_with_vat, h.total_with_vat);
  assert.equal(p.quote.billing_period, 'annual');
  const start = p.quote.membership_year_start;
  const renewal = rollingDateString(addCalendarMonths(start, 12));
  const end = new Date(`${renewal}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return {
    member: h.member_id, history: h.id, invoice: h.accounting_invoice_number || h.xero_invoice_number,
    amount: h.total_with_vat, start, end: end.toISOString().slice(0, 10), renewal,
    schedule: config(h.config_id)?.name || h.config_id, submission: p.id,
    evidence: 'Paid submission and history agree on member, Stripe reference, schedule and amount. Saved quote specifies annual term and commencement.',
    remaining: 'Obtain approval for reconstruction and renewal/grace policy. No live Stripe/Xero check performed. Re-test eligibility after repair.',
  };
});
assert.equal(reconstruction.length, 2);
const policies = blockers.filter(r => r.renewalReason === 'purchased_policy_unavailable').map(r => {
  const h = history(r.selectedHistoryId), c = config(h.config_id);
  return { member: r.memberId, history: h.id, invoice: h.accounting_invoice_number || h.xero_invoice_number || '',
    payment: h.payment_status, start: h.term_start_date, end: h.term_end_date, config: h.config_id || '',
    schedule: c?.name || 'No matching saved schedule', open: c?.renewal_open_days ?? '', grace: c?.renewal_grace_days ?? '',
    next: c ? 'Approve forward renewal policy; preserve existing paid term and dates. Current schedule is a proposal, not historical purchase evidence.'
      : 'Resolve schedule and unusual term dates before proposing a repair.' };
});
const wb = new ExcelJS.Workbook();
wb.creator = 'iConnect';
function sheet(name, headers, rows) {
  const ws = wb.addWorksheet(name);
  ws.columns = headers.map(([key, header, width = 24]) => ({ key, header, width }));
  rows.forEach(row => ws.addRow(row));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: headers.length } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };
  ws.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; });
  return ws;
}
sheet('Read me', [['label', 'Item', 34], ['value', 'Finding / limitation', 110]], [
  { label: 'Report', value: 'BNMS renewal readiness — fresh read-only regeneration; not the original missing attachment.' },
  { label: 'Snapshot UTC', value: evidence.summary.as_of },
  { label: 'All members', value: evidence.rows.length },
  { label: 'Non-excluded blockers or risks', value: evidence.summary.uniqueActionableMembers },
  { label: 'Non-excluded renewal blockers', value: blockers.length },
  { label: 'Strong reconstruction candidates', value: reconstruction.length },
  { label: 'Policy gaps with a saved schedule', value: policies.filter(p => p.schedule !== 'No matching saved schedule').length },
  { label: 'Other policy gaps', value: policies.filter(p => p.schedule === 'No matching saved schedule').length },
  { label: 'Important', value: 'These are readiness/evidence findings, not counts of failed payments. Categories overlap. No repair or policy assignment has been made.' },
  { label: 'Authority', value: 'Stored paid evidence is not a fresh provider check. Invoice numbers alone do not establish term dates or renewal policy. Current schedule settings must not be presented as purchased historical policy.' },
  { label: 'Coverage', value: 'Full member UUIDs are provided for authorized CRM lookup; contact details are omitted. Future renewal prices, live provider state and successful checkout are unverified.' },
]);
sheet('Reconstruction shortlist', [
  ['member', 'Member ID', 39], ['invoice', 'Invoice', 18], ['amount', 'GBP', 12],
  ['start', 'Evidence-based start', 20], ['end', 'Annual term end', 20], ['renewal', 'Next date', 20],
  ['schedule', 'Schedule', 40], ['history', 'History ID', 39], ['submission', 'Submission ID', 39],
  ['evidence', 'Evidence checked', 65], ['remaining', 'Still required', 65],
], reconstruction);
sheet('Policy review', [
  ['member', 'Member ID', 39], ['invoice', 'Invoice', 18], ['payment', 'Stored payment status', 18],
  ['start', 'Existing start', 20], ['end', 'Existing end', 20], ['schedule', 'Current matching schedule', 42],
  ['open', 'Current renewal window days', 20], ['grace', 'Current grace days', 20],
  ['history', 'History ID', 39], ['config', 'Schedule ID', 39], ['next', 'Approval / investigation needed', 80],
], policies);
const memberColumns = [['memberId', 'Member ID', 39], ['memberClass', 'Member class', 24],
  ['membershipStatus', 'Membership status', 20], ['exclusion', 'Population exclusion', 25],
  ['classification', 'Primary classification', 22], ['renewalReason', 'Renewal finding', 38],
  ['historyCount', 'History records', 16], ['selectedHistoryId', 'Selected history ID', 39],
  ['issuesText', 'All findings', 90], ['nextText', 'Next checks', 90]];
const project = r => ({ ...r, issuesText: r.issues.map(i => `${i.code}: ${i.reason}`).join('\n'),
  nextText: [...new Set(r.issues.map(i => i.nextAction).filter(Boolean))].join('\n') });
sheet('Renewal blockers', memberColumns, blockers.map(project));
sheet('All members', memberColumns, evidence.rows.map(project));
sheet('Issue counts', [['code', 'Finding', 46], ['members', 'All members', 18],
  ['activePopulationMembers', 'Non-excluded members', 24], ['occurrences', 'Occurrences', 18]],
Object.entries(evidence.summary.issueCounts).map(([code, data]) => ({ code, ...data })));
const output = `${dir}/BNMS-renewal-readiness-and-reconstruction.xlsx`;
await wb.xlsx.writeFile(output);
await fs.chmod(output, 0o600);
const check = new ExcelJS.Workbook();
await check.xlsx.readFile(output);
assert.equal(check.worksheets[0].name, 'Read me');
assert.equal(check.getWorksheet('All members').rowCount, 4081);
assert.equal(check.getWorksheet('Renewal blockers').rowCount, blockers.length + 1);
assert.equal(check.getWorksheet('Reconstruction shortlist').rowCount, 3);
assert.equal(check.getWorksheet('Reconstruction shortlist').getCell('D2').value, reconstruction[0].start);
console.log(JSON.stringify({ output, sheets: check.worksheets.map(s => ({ name: s.name, dataRows: s.rowCount - 1 })),
  reconstruction, policyCandidates: policies.filter(p => p.schedule !== 'No matching saved schedule').length }, null, 2));
