import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const HEADERS = ['Member ID', 'Name', 'Current job title', 'Reason for review', 'Corrected job title'];
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildAudit(snapshot, evidence, review) {
  assert.equal(snapshot.tenant.id, TENANT);
  assert.equal(snapshot.total, snapshot.members.length);
  assert.equal(new Set(snapshot.members.map(m => m.id)).size, snapshot.total);
  assert.equal(review.snapshotHash, hash(snapshot), 'Review is for a different snapshot');
  const decisions = new Map(review.decisions.map(d => [d.id, d]));
  assert.equal(decisions.size, review.decisions.length, 'Duplicate reviewed identities');
  assert.equal(decisions.size, snapshot.members.filter(m => m.job_title?.trim()).length);
  return snapshot.members.map(member => {
    assert.equal(member.tenant_id, TENANT);
    if (!member.job_title?.trim()) return { member, classification: 'blank', reason: 'No job title recorded; no reliable unsuperseded source title recovered.' };
    const decision = decisions.get(member.id);
    assert.ok(decision && decision.expectedTitle === member.job_title, 'Unreviewed title');
    assert.ok(['valid', 'ambiguous', 'note'].includes(decision.classification));
    assert.ok(decision.reason);
    const matches = evidence.find(e => e.id === member.id)?.matches || [];
    const confirmed = matches.length === 1 && matches[0].legacyMatch && matches[0].equalsCurrent && matches[0].sourceValue === member.job_title;
    const classification = decision.classification === 'note' ? (confirmed ? 'confirmed-misplaced' : 'ambiguous') : decision.classification;
    return { member, classification, evidence: matches, reason: decision.reason + (decision.classification === 'note' && !confirmed ? ' Held: source identity/value is not independently confirmed.' : '') };
  });
}

export function repairItem(row) {
  assert.equal(row.classification, 'confirmed-misplaced');
  const member = row.member;
  assert.equal(member.tenant_id, TENANT);
  const source = row.evidence[0];
  assert.ok(source.legacyMatch && source.equalsCurrent && source.sourceValue === member.job_title);
  const noteId = `bnms-job-title-${hash([TENANT, member.id, member.job_title])}`;
  const content = `Automated BNMS data repair — imported content moved from Job Title, not newly authored by the member.\nSource: ${source.cohort}; CSV SHA-256 ${source.fingerprint}; row ${source.row}.\nOriginal Job Title content (verbatim):\n\n${member.job_title}`;
  return { id: member.id, tenant_id: TENANT, before: member, title: null, note: { id: noteId, target_member_id: member.id, author_member_id: null, content } };
}

export function workbookBytes(rows, summary) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([HEADERS, ...rows.map(r => [r.member.id, [r.member.first_name, r.member.last_name].filter(Boolean).join(' '), r.member.job_title ?? '', r.reason, ''])]);
  // Explicit strings: even values beginning with =, +, -, @ are never formulas.
  for (const [key, cell] of Object.entries(sheet)) if (!key.startsWith('!')) { cell.t = 's'; cell.v = String(cell.v ?? ''); delete cell.f; }
  sheet['!cols'] = [38, 30, 65, 75, 45].map(wch => ({ wch }));
  sheet['!autofilter'] = { ref: sheet['!ref'] };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Job titles');
  const instructions = [
    ['BNMS job-title completion — private'],
    ['Edit only Corrected job title. Blank corrections mean NO CHANGE, not deletion.'],
    ['Keep Member ID and the other columns unchanged. Do not add rows or duplicate IDs.'],
    ['Return this XLSX in this private project. Do not use Import Manager or a historical member importer.'],
    ['The dedicated updater previews changes and rejects unknown/off-tenant UUIDs, duplicate IDs and records changed since export.'],
    ['Only nonblank Job Title corrections can be applied; it never creates members or changes other profile fields.'],
    ['Ambiguous current titles were left unchanged. Do not infer titles from Occupation or membership class.'],
    ['Original evidence is retained separately in the private audit; it is not included in this workbook.'],
    ...Object.entries(summary).map(([key, value]) => [key, String(value)]),
  ];
  const info = XLSX.utils.aoa_to_sheet(instructions);
  info['!cols'] = [{ wch: 125 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(workbook, info, 'Instructions');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

export function parseCorrections(bytes, snapshot) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
  assert.deepEqual(workbook.SheetNames, ['Job titles', 'Instructions'], 'Unexpected workbook sheets');
  const sheet = workbook.Sheets['Job titles'];
  for (const [key, cell] of Object.entries(sheet)) if (!key.startsWith('!')) {
    assert.ok(!cell.f && !cell.l, 'Formulas and hyperlinks are not accepted');
    assert.ok(cell.t === 's' || cell.t === 'z', 'Only literal text cells are accepted');
  }
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  assert.deepEqual(grid.shift(), HEADERS, 'Workbook headers changed');
  const originals = new Map(snapshot.map(row => [row.member.id, row]));
  assert.equal(originals.size, snapshot.length);
  const seen = new Set(), changes = [];
  for (const row of grid) {
    if (row.every(v => v === '')) continue;
    assert.equal(row.length, HEADERS.length, 'Unexpected columns');
    const [id, name, current, reason, title] = row;
    assert.ok(uuid.test(id), 'Invalid member UUID');
    assert.ok(!seen.has(id), 'Duplicate member UUID'); seen.add(id);
    const original = originals.get(id);
    assert.ok(original && original.member.tenant_id === TENANT, 'Unknown or off-tenant member UUID');
    assert.equal(name, [original.member.first_name, original.member.last_name].filter(Boolean).join(' '), 'Name changed');
    assert.equal(current, original.member.job_title ?? '', 'Current title changed');
    assert.equal(reason, original.reason, 'Review reason changed');
    if (!title.trim()) continue;
    assert.ok(title.length <= 500 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title), 'Invalid corrected title');
    if (title === original.member.job_title) continue;
    changes.push({ id, tenant_id: TENANT, before: original.member, title });
  }
  return changes;
}

export function checkCurrent(item, current, note) {
  assert.ok(current && current.id === item.id && current.tenant_id === TENANT, 'Unknown or off-tenant identity');
  if (item.note && note) {
    for (const key of ['id', 'target_member_id', 'author_member_id', 'content']) assert.equal(note[key], item.note[key], 'Existing note differs');
    assert.equal(current.job_title, item.title, 'Previously repaired title changed');
    return 'replay';
  }
  assert.deepEqual(current, item.before, 'Stale member record; fresh review required');
  return 'write';
}
