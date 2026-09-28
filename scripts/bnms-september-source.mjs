import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { CUSTOM_MAPPINGS as FINAL_FIELDS, TENANT_ID } from './bnms-final-source.mjs';
export { TENANT_ID };
export const FILE = 'attached_assets/Individuals_to_import_into_iConnect_28.09.26_1790621340218.xlsx';
export const SHA256 = '6e1ad1cb655fc6c2a175084637f7285d21db6bb97149c2cd8acbbf68733e2189';
export const HEADERS = Object.freeze(['YM Web Site Member ID', 'Membership status', 'YM Date Membership Expires', 'YM Membership type', 'Member class', 'First Name', 'Last Name', 'Title', 'Email', 'Alternative email address', 'Phone', 'Group UUID', 'Organisation UUID', 'Department UUID', 'Occupation', 'SRP/IRPA Affiliate', 'BNMS Region', 'Category - Focus Area']);
// Field identities are established BNMS definitions, not prior cohort permissions.
export const FIELDS = Object.freeze([
  ...FINAL_FIELDS.filter(f => f.column <= 9).map(f => ({ ...f })),
  { ...FINAL_FIELDS.find(f => f.column === 13), column: 14 },
  { ...FINAL_FIELDS.find(f => f.column === 14), column: 15 },
  { id: '0e3e3b1f-5a3d-40b5-a4b5-f0761c115216', column: 16, name: 'member_region', label: 'Region', type: 'dropdown' },
]);
export const clean = v => String(v ?? '').normalize('NFKC').trim();
export function dateValue(cell) {
  if (cell?.t !== 'n' || !Number.isFinite(cell.v) || cell.v < 61 || cell.v >= 100001) throw Error('Expected valid Excel calendar date');
  const iso = new Date(Date.UTC(1899, 11, 30) + Math.floor(cell.v) * 86400000).toISOString().slice(0, 10);
  return iso.split('-').reverse().join('/');
}
export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== SHA256) throw Error('September workbook fingerprint mismatch');
  const w = XLSX.read(bytes, { type: 'buffer', cellDates: false, cellFormula: true });
  if (w.Workbook?.WBProps?.date1904 || w.SheetNames.length !== 1 || w.SheetNames[0] !== 'Sheet1') throw Error('September worksheet contract mismatch');
  const s = w.Sheets.Sheet1;
  if (s['!ref'] !== 'A1:R32') throw Error('September range contract mismatch');
  HEADERS.forEach((header, c) => {
    const cell = s[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell?.f != null || cell?.t === 'e' || clean(cell?.v) !== header) throw Error('September header contract mismatch');
  });
  const rows = Array.from({ length: 31 }, (_, i) => {
    const sourceRow = i + 2;
    const cells = HEADERS.map((_, c) => s[XLSX.utils.encode_cell({ r: i + 1, c })]);
    const values = cells.map(c => clean(c?.v)), reasons = [];
    cells.forEach((c, column) => { if (c?.f != null || c?.t === 'e') reasons.push(`Formula/error in column ${column + 1}`); });
    if (!/^\d+$/.test(values[0])) reasons.push('Invalid legacy ID');
    if (!values[5] || !values[6]) reasons.push('Missing required name');
    for (const c of [8, 9]) {
      values[c] = values[c].toLowerCase();
      if ((c === 8 || values[c]) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values[c])) reasons.push(`Invalid ${HEADERS[c]}`);
    }
    if (values[10] && (cells[10].t !== 's' || !/^\+?[\d ()-]{5,30}$/.test(values[10]))) reasons.push('Unsafe Phone; opaque text required');
    if ([11, 12, 13].filter(c => values[c]).length > 1) reasons.push('Multiple hierarchy destinations');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const c of [11, 12]) if (values[c] && !uuid.test(values[c])) reasons.push(`Invalid ${HEADERS[c]}`);
    // The supplied multi-reference cell uses semicolon separators. Do not
    // accept arbitrary punctuation, empty tokens, or infer a primary Department.
    const departmentIds = values[13] ? values[13].split(';').map(clean) : [];
    if (departmentIds.some(id => !uuid.test(id)) || new Set(departmentIds).size !== departmentIds.length) reasons.push('Invalid or duplicate Department UUID');
    if (values[2]) { try { values[2] = dateValue(cells[2]); } catch { reasons.push('Invalid expiry'); } }
    if (values[15] === 'TRUE' || values[15] === 'True') values[15] = 'true';
    else if (values[15] === 'FALSE' || values[15] === 'False') values[15] = 'false';
    else reasons.push('Invalid affiliate boolean');
    return { sourceRow, values, departmentIds, legacyId: values[0], email: values[8], focusAreas: [...new Set(values[17].split('|').map(clean).filter(Boolean))], reasons };
  });
  for (const key of ['legacyId', 'email']) for (const row of rows) if (rows.filter(r => r[key] === row[key]).length > 1) row.reasons.push(`Duplicate source ${key}`);
  const counts = { group: rows.filter(r => r.values[11]).length, organization: rows.filter(r => r.values[12]).length, department: rows.filter(r => r.values[13]).length, none: rows.filter(r => !r.values.slice(11, 14).some(Boolean)).length };
  return { fingerprint, rows, counts };
}