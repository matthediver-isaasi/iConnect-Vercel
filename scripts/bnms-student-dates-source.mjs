import { createHash } from 'node:crypto';
import XLSX from 'xlsx';

export const FILE = 'attached_assets/Student_expiry_dates_to_import_1794337885874.xlsx';
export const HASH = '2118907f35b66af8434672ab921ee05e773d99a4de95c2ee49198ad6b700c8e3';
export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const FIELD = '462a3258-0808-4edc-bd01-45c7def87af2';
export const HEADERS = ['member_id', 'Student course end date'];
const check = (ok, message) => { if (!ok) throw Error(message); };

export function excelDate(value) {
  check(typeof value === 'number' && Number.isInteger(value) && value >= 61 && value <= 100000,
    'Invalid Excel 1900 date serial');
  return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
}

export function parseSource(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  check(!verifyFingerprint || fingerprint === HASH, 'Workbook fingerprint mismatch');
  const book = XLSX.read(bytes, { type: 'buffer', cellDates: false, cellFormula: true });
  check(!book.Workbook?.WBProps?.date1904, 'Excel 1904 dates forbidden');
  check(book.SheetNames.length === 1 && book.SheetNames[0] === 'Sheet1', 'Expected only Sheet1');
  const sheet = book.Sheets.Sheet1;
  check(sheet['!ref'] === 'A1:B31', 'Unexpected worksheet range');
  check(!Object.values(sheet).some(c => c?.f != null || c?.t === 'e'), 'Formula/error cell forbidden');
  check(HEADERS.every((h, i) => sheet[`${i ? 'B' : 'A'}1`]?.v === h), 'Header mismatch');
  const rows = Array.from({ length: 30 }, (_, i) => {
    const sourceRow = i + 2, id = sheet[`A${sourceRow}`]?.v, cell = sheet[`B${sourceRow}`];
    const reasons = [];
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) reasons.push('Invalid member_id');
    let value = null;
    try { check(cell?.t === 'n', 'Expected serial'); value = excelDate(cell.v); }
    catch { reasons.push('Invalid course-end date'); }
    return { sourceRow, member_id: typeof id === 'string' ? id.toLowerCase() : null, value, reasons };
  });
  for (const row of rows) {
    if (row.member_id && rows.filter(r => r.member_id === row.member_id).length > 1) row.reasons.push('Duplicate source member_id');
  }
  return { fingerprint, rows };
}

export function reconcile(rows, members, preferences) {
  return rows.map(row => {
    const reasons = [...row.reasons];
    const matches = members.filter(m => m.id === row.member_id);
    const before = preferences.filter(p => p.member_id === row.member_id && p.field_id === FIELD);
    if (matches.length !== 1) reasons.push('Missing or ambiguous member');
    else if (matches[0].tenant_id !== TENANT) reasons.push('Cross-tenant member');
    if (before.length > 1) reasons.push('Duplicate preference rows');
    return { ...row, reasons, before,
      outcome: reasons.length ? 'held' : before[0]?.value === row.value ? 'unchanged' : 'update' };
  });
}
