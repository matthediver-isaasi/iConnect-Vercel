import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FILE = path.join(
  ROOT,
  'attached_assets',
  'BNMS_FINAL_79_INDIVIDUALS_TO_IMPORT_22.09.26_1790149675043.xlsx',
);
export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const HEADERS = Object.freeze([
  'YM Web Site Member ID',
  'Membership status',
  'YM Date Membership Expires',
  'YM Membership type',
  'Member class',
  'First Name',
  'Last Name',
  'Title',
  'Email',
  'Alternative email address',
  'Phone',
  'Group UUID',
  'Organisation UUID',
  'Occupation',
  'SRP/IRPA Affiliate',
  'Student Course',
  'Student End Date',
  'Trainee training scheme name',
  'Trainee training number',
  'Trainee research fellow information',
  'Category - Focus Area',
]);

// These are the established BNMS member preference fields used by the UK
// individual and additional-member imports, remapped to this workbook's exact
// positional headers.
export const CUSTOM_MAPPINGS = Object.freeze([
  ['50d7b71c-29b0-4d4c-a817-f39edf35f2e0', 0, 'ym_web_site_member_id', 'YM Web Site Member ID', 'text'],
  ['388e1dfe-d917-4317-933a-0319542a7d92', 1, 'membership_status', 'Membership status', 'dropdown'],
  ['2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae', 2, 'ym_date_membership_expires', 'YM Date Membership Expires', 'text', 'validated-date'],
  ['40bdb74f-e8e0-4ad1-9760-b1128256a752', 3, 'ym_membership_type', 'YM Membership type', 'dropdown'],
  ['87f120ff-92e6-4d52-944b-9ba9d7b1fac0', 4, 'member_class', 'Member class', 'dropdown'],
  ['4f2e504c-1663-4dd8-a486-274159834320', 7, 'title', 'Title', 'dropdown'],
  ['b3d6ddbe-57c3-45a8-8f03-316f90b3dfbd', 9, 'alternative_email_address', 'Alternative email address', 'email'],
  ['1c84695f-e8f8-4afd-b4be-e54f5f540a26', 13, 'occupation', 'Occupation', 'dropdown'],
  ['2dcf5b2b-670d-4058-a3a6-b48c084cca39', 14, 'srp/irpa_affiliate', 'SRP/IRPA Affiliate', 'boolean', 'boolean'],
  ['a55e6c86-1b33-494a-adfd-0ac6717a18da', 15, 'student_course_title', 'Student course title', 'text'],
  ['462a3258-0808-4edc-bd01-45c7def87af2', 16, 'student_course_end_date', 'Student course end date', 'date', 'student-date'],
  ['b9937241-eb40-4510-9dd7-ec487f6d660d', 17, 'trainee_training_scheme_name', 'Trainee training scheme name', 'text'],
  ['1e2416d9-c338-4ed0-b982-97fd3db67653', 18, 'trainee_training_number', 'Trainee training number', 'text'],
  ['deac109c-7b27-467f-bacf-25b33e685cb6', 19, 'trainee_research_fellow_information', 'Trainee research fellow information', 'textarea'],
].map(([id, column, name, label, type, transform]) => Object.freeze({
  id, column, name, label, type, transform,
})));

const EXPECTED_SHA256 = '560923bb2986a69245d192c35724e4a0f513f690cab5b39e591ce16bee008fc6';
const SHEET_NAME = 'Replacement Import';
const ROW_COUNT = 79;
const EXCLUSIONS = Object.freeze(new Map([
  [75, '82906861'],
  [79, '82907468'],
]));
const RETAINED_DUPLICATE = Object.freeze({ sourceRow: 71, legacyId: '82907369' });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+?[\d ()-]{5,30}$/;
const clean = (value) => String(value ?? '').normalize('NFKC').trim();
const fail = (message) => { throw new Error(message); };

function excelDate(serial, context) {
  if (typeof serial !== 'number' || !Number.isInteger(serial) || serial < 61 || serial > 100000) {
    fail(`Invalid Excel date serial at ${context}.`);
  }
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  return date.toISOString().slice(0, 10);
}

function britishDate(value, context) {
  const match = clean(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) fail(`Invalid British date at ${context}; expected dd/mm/yyyy.`);
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)) {
    fail(`Invalid British date at ${context}.`);
  }
  return `${year}-${month}-${day}`;
}

function dateFromCell(cell, context) {
  if (cell.t === 'n') return excelDate(cell.v, context);
  if (cell.t !== 's' && cell.t !== 'str') fail(`Date at ${context} must be text or an Excel serial.`);
  return britishDate(cell.v, context);
}

function expiryValue(cell, context) {
  const iso = dateFromCell(cell, context);
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function duplicateAudit(rows, eligible) {
  const eligibleSet = new Set(eligible);
  const result = [];
  for (const [key, label] of [['legacyId', 'legacyId'], ['email', 'email']]) {
    const groups = new Map();
    for (const row of rows) {
      if (!row[key]) continue;
      groups.set(row[key], [...(groups.get(row[key]) || []), row]);
    }
    for (const [value, matches] of groups) {
      if (matches.length < 2) continue;
      result.push({
        key: label,
        value,
        sourceRows: matches.map((row) => row.sourceRow),
        eligibleRows: matches.filter((row) => eligibleSet.has(row)).map((row) => row.sourceRow),
      });
    }
  }
  return result;
}

function assignmentCounts(rows) {
  return {
    group: rows.filter((row) => row.values[11]).length,
    organization: rows.filter((row) => !row.values[11] && row.values[12]).length,
    none: rows.filter((row) => !row.values[11] && !row.values[12]).length,
  };
}

export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_SHA256) {
    fail(`Workbook fingerprint mismatch; expected ${EXPECTED_SHA256}, found ${fingerprint}.`);
  }

  const workbook = XLSX.read(bytes, {
    type: 'buffer',
    cellDates: false,
    cellFormula: true,
    cellNF: true,
  });
  if (workbook.Workbook?.WBProps?.date1904 === true) {
    fail('The Excel 1904 date system is forbidden.');
  }
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== SHEET_NAME) {
    fail(`Workbook must contain exactly the "${SHEET_NAME}" worksheet.`);
  }
  const sheet = workbook.Sheets[SHEET_NAME];
  if (sheet['!ref'] !== 'A1:U80') fail(`Worksheet range drifted; expected A1:U80, found ${sheet['!ref'] || 'none'}.`);

  for (let column = 0; column < HEADERS.length; column += 1) {
    const address = XLSX.utils.encode_cell({ r: 0, c: column });
    const cell = sheet[address];
    if (cell?.f != null || cell?.t === 'e') fail(`Workbook header contract contains a formula or error at ${address}.`);
    const actual = clean(cell?.v);
    if (actual !== HEADERS[column]) fail(`Workbook header contract drifted at column ${column + 1}.`);
  }

  const rows = [];
  for (let rowIndex = 1; rowIndex < 80; rowIndex += 1) {
    const sourceRow = rowIndex + 1;
    const cells = Array.from({ length: HEADERS.length }, (_, column) =>
      sheet[XLSX.utils.encode_cell({ r: rowIndex, c: column })]);
    const original = cells.map((cell) => String(cell?.v ?? ''));
    const values = original.map(clean);
    const reasons = [];
    for (let column = 0; column < cells.length; column += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: column });
      if (cells[column]?.f != null) reasons.push(`Formula cell forbidden at ${address}`);
      if (cells[column]?.t === 'e') reasons.push(`Error cell forbidden at ${address}`);
    }
    if (!values.some(Boolean)) reasons.push('Unexpectedly blank worksheet row');
    if (!values[0] || !/^\d+$/.test(values[0])) reasons.push('Invalid YM Web Site Member ID');
    if (!values[5] || !values[6]) reasons.push('Blank required name');
    if (!values[8] || !EMAIL_RE.test(values[8])) reasons.push('Invalid Email');
    if (values[9] && !EMAIL_RE.test(values[9])) reasons.push('Invalid Alternative email address');
    if (values[10] && (cells[10]?.t !== 's' || !PHONE_RE.test(values[10]))) {
      reasons.push('Unsafe Phone');
    }
    if (values[11] && values[12]) reasons.push('Multiple hierarchy destinations');
    for (const column of [11, 12]) {
      if (values[column] && !UUID_RE.test(values[column])) reasons.push(`Invalid ${HEADERS[column]}`);
    }
    if (values[2]) {
      try {
        values[2] = expiryValue(cells[2], `row ${sourceRow}, ${HEADERS[2]}`);
      } catch {
        reasons.push(`Invalid ${HEADERS[2]}`);
      }
    }
    if (values[16]) {
      try {
        values[16] = dateFromCell(cells[16], `row ${sourceRow}, ${HEADERS[16]}`);
      } catch {
        reasons.push(`Invalid ${HEADERS[16]}`);
      }
    }
    if (values[14] === 'True') values[14] = 'true';
    else if (values[14] === 'False') values[14] = 'false';
    else if (values[14]) reasons.push('Invalid SRP/IRPA Affiliate; expected True or False');
    values[8] = values[8].toLowerCase();
    values[9] = values[9].toLowerCase();

    rows.push({
      sourceRow,
      legacyId: values[0],
      email: values[8],
      values,
      original,
      reasons: [...new Set(reasons)],
    });
  }
  if (rows.length !== ROW_COUNT) fail(`Workbook must contain exactly ${ROW_COUNT} populated rows.`);

  for (const [sourceRow, legacyId] of EXCLUSIONS) {
    const row = rows.find((candidate) => candidate.sourceRow === sourceRow);
    if (row?.legacyId !== legacyId) fail(`Pinned exclusion at row ${sourceRow} drifted.`);
    row.reasons.push('Reviewed duplicate email exclusion');
  }
  const retained = rows.find((row) => row.sourceRow === RETAINED_DUPLICATE.sourceRow);
  if (retained?.legacyId !== RETAINED_DUPLICATE.legacyId) fail('Pinned retained duplicate at row 71 drifted.');

  const excluded = rows.filter((row) => EXCLUSIONS.has(row.sourceRow));
  const eligible = rows.filter((row) => !EXCLUSIONS.has(row.sourceRow));
  const duplicates = duplicateAudit(rows, eligible);
  for (const item of duplicates.filter((candidate) => candidate.eligibleRows.length > 1)) {
    for (const sourceRow of item.eligibleRows) {
      const row = rows.find((candidate) => candidate.sourceRow === sourceRow);
      row.reasons.push(`Duplicate eligible ${item.key}: ${item.value}`);
    }
  }

  const counts = {
    source: assignmentCounts(rows),
    eligible: assignmentCounts(eligible),
  };
  if (JSON.stringify(counts.source) !== JSON.stringify({ group: 28, organization: 28, none: 23 })
    || JSON.stringify(counts.eligible) !== JSON.stringify({ group: 26, organization: 28, none: 23 })) {
    fail(`Assignment counts drifted: ${JSON.stringify(counts)}.`);
  }
  const dateCellCounts = (column) => {
    const cells = rows.map((row) => sheet[`${column}${row.sourceRow}`]);
    return {
      serial: cells.filter((cell) => clean(cell?.v) && cell?.t === 'n').length,
      // Any populated nonnumeric cell is part of the textual source count even
      // when its cell type is itself invalid and separately recorded in the
      // row's reasons. This keeps row errors independent from global totals.
      text: cells.filter((cell) => clean(cell?.v) && cell?.t !== 'n').length,
      blank: cells.filter((cell) => !clean(cell?.v)).length,
    };
  };
  const dateCounts = {
    expiry: dateCellCounts('C'),
    studentEnd: dateCellCounts('Q'),
  };
  if (Object.values(dateCounts).some((countsForColumn) =>
    countsForColumn.serial + countsForColumn.text + countsForColumn.blank !== ROW_COUNT)
    || dateCounts.expiry.serial + dateCounts.expiry.text !== 33
    || dateCounts.studentEnd.serial + dateCounts.studentEnd.text !== 1) {
    fail(`Date counts drifted: ${JSON.stringify(dateCounts)}.`);
  }

  return { fingerprint, rows, eligible, excluded, duplicates, counts, dateCounts };
}