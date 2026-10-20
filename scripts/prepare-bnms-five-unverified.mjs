// Offline evidence reconstruction only. No provider calls or invoice associations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { TENANT, MEMBERS, hash, prepareProposal } from './prepare-bnms-five-members.mjs';

export { TENANT, MEMBERS, hash };
export const AS_OF = '2026-10-20';
export const TARGETS = [MEMBERS[1], MEMBERS[3]];
export const INPUTS = [
  ['/tmp/bnms-five-members-evidence.json', 'a94ff6c2005303c6d42e7aeb3a1288fe6069a6693a4184ff07f5538c32efb367'],
  ['/tmp/bnms-five-decisions.json', 'cf4d9d91f1296bc15ea3ece67506d08bde21c3aae2131e6a398ab030cf0a25bc'],
  ['/tmp/bnms-five-source-rows.json', '5a21600a6fbfa8c3eb255241846d41df4e9a418e389bb7eeb5781552c2c864ad'],
];
export const DISPLAY_FIELDS = [
  'id','tenant_id','member_id','membership_year','tier_label','term_start_date',
  'term_end_date','status','payment_status','notes','created_at','updated_at',
];
export function buildUnverifiedRows(evidence, decisions, sourceRows) {
  // Reuse the reviewed five-member source/date/Guest-transition checks, but never
  // select an invoice, payment, amount, pricing schedule or inferred commitment.
  assert.ok(!decisions.some(d => TARGETS.includes(d.memberId)), 'Target has financial evidence; re-review');
  const proposal = prepareProposal(evidence, [], AS_OF, sourceRows);
  assert.equal(proposal.blocked.length, 0);
  return TARGETS.map(memberId => {
    const source = proposal.rows.find(r => r.member_id === memberId);
    const row = Object.fromEntries(DISPLAY_FIELDS.filter(k => k in source).map(k => [k, source[k]]));
    row.payment_status = 'unverified';
    row.notes = JSON.stringify({
      ...JSON.parse(source.notes), approvalDate: AS_OF,
      approvalScope: 'two_unverified_display_only_histories',
      recordKind: 'legacy_date_only_fee_history',
      purchasedRollingCommitment: false,
      currentScheduleAuthority: 'not_evidence_of_a_purchased_commitment_or_renewal',
      historicalAnnualPriceAuthority: 'unknown_not_inferred',
      paymentMethodAuthority: 'unknown_not_inferred',
      frequencyAuthority: 'unknown_not_inferred',
      providerFinancialWrites: 0,
    });
    if (memberId === MEMBERS[3]) assert.equal(row.status, 'expired', 'Aisha must never activate');
    return row;
  });
}
export async function verifyWorkbookRows(rows) {
  for (const row of rows) {
    const pin = JSON.parse(row.notes).sourcePin;
    assert.ok(pin?.file.startsWith('attached_assets/') && pin.file.endsWith('.xlsx'));
    const buffer = await readFile(pin.file);
    assert.equal(createHash('sha256').update(buffer).digest('hex'), pin.sha256, 'Workbook bytes changed');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    assert.ok(workbook.Sheets[pin.sheet], 'Source sheet missing');
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[pin.sheet], { header: 1, raw: true, defval: null });
    const actual = {};
    data[0].forEach((header, index) => {
      const value = data[pin.row - 1]?.[index];
      if (value == null || value === '') return;
      actual[header] = value instanceof Date
        ? `${value.toISOString().slice(0,10)} 00:00:00` : String(value);
    });
    assert.equal(hash(actual), pin.rowHash, 'Source row content changed');
    assert.equal(actual['iConnect UUID'], row.member_id);
  }
  // Aisha's subsequent Guest source is also authority for never activating her.
  const aisha = rows.find(r => r.member_id === MEMBERS[3]);
  if (aisha) {
    const pin = JSON.parse(aisha.notes).sourcePin;
    const workbook = XLSX.read(await readFile(pin.file), { type: 'buffer', cellDates: true });
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[pin.sheet], { header: 1, raw: true, defval: null });
    const guest = Object.fromEntries(data[0].map((key, index) => [key, data[161]?.[index]]));
    assert.equal(guest['iConnect UUID'], MEMBERS[3]);
    assert.equal(guest['Membership History - Membership'], 'Guest');
    assert.equal(guest['Membership History - Membership Start Date'].toISOString().slice(0,10), '2026-08-26');
  }
}
export async function loadProposal() {
  const loaded = [];
  for (const [file, pin] of INPUTS) {
    const value = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(hash(value), pin, 'Pinned evidence changed');
    loaded.push(value);
  }
  const [evidence, decisions, sourceRows] = loaded;
  const rows = buildUnverifiedRows(evidence, decisions, sourceRows);
  await verifyWorkbookRows(rows);
  return { evidence, rows };
}
export function completeRows(rows, columns, timestamp) {
  return rows.map(row => {
    const full = Object.fromEntries(columns.map(c => [c.column_name, null]));
    for (const key of Object.keys(row)) assert.ok(key in full, `Unknown column ${key}`);
    Object.assign(full, row, { created_at: timestamp, updated_at: timestamp });
    for (const c of columns) if (c.is_nullable === 'NO') assert.notEqual(full[c.column_name], null);
    return full;
  });
}
export async function main(args = process.argv.slice(2)) {
  assert.ok(args.length === 2 && args[0] === '--prepare' && /^\/tmp\/[a-z0-9-]+\.json$/.test(args[1] || ''));
  const { rows } = await loadProposal();
  const proposal = { asOf: AS_OF, rows, proposalHash: hash(rows), providerCalls: 0, productionWrites: 0 };
  await writeFile(args[1], JSON.stringify(proposal, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ proposed: 2, proposalHash: proposal.proposalHash, productionWrites: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
