import XLSX from 'xlsx';
import { Unzip, UnzipInflate, zipSync } from 'fflate';

export const PUBLICATION_HEADERS = Object.freeze([
  'Title', 'Category', 'SLA', 'Contract', 'Submission Deadline', 'Writer Deadline',
  'Editor Deadline', 'Status', 'External Writer', 'Writer', 'Editor', 'Notes',
  'Contributor Type', 'Case Study', 'Member Copyright agreement',
  'External Writer first name', 'External Writer last name', 'External Writer email',
]);

const MAX_FILE = 1024 * 1024;
const MAX_EXPANDED = 10 * 1024 * 1024;
const INSTRUCTIONS = 'Publication import instructions v1';
const text = value => String(value ?? '').trim();
const norm = value => text(value).toLowerCase();
const titleKey = value => norm(value).replace(/\s+/g, ' ');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const DATE_FIELDS = {
  'Submission Deadline': 'deadline', 'Writer Deadline': 'writer_deadline',
  'Editor Deadline': 'editor_deadline',
};

// All fields except Title are optional. In particular, no tenant's stage,
// category, SLA, contract, identity, or deadline is used as a default. Blank
// status uses the first explicitly supplied configured stage.
export function createPublicationTemplate(settings = {}) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([PUBLICATION_HEADERS]), 'Publications');
  const guidance = [
    [INSTRUCTIONS],
    ['Upload .xlsx only; maximum 1 MB, 100 data rows and 512 KB combined row text. Do not use formulas on any sheet.'],
    ['Title', 'Required. Unique within this workbook; existing identical briefs are skipped, never updated.'],
    ['Category', `Optional. Configured categories: ${(settings.categories || []).join(', ')}`],
    ['SLA', 'Optional free text; blank means none.'],
    ['Contract', 'Optional free text; blank means none.'],
    ...Object.keys(DATE_FIELDS).map(h => [h, 'Optional real Excel date or strict ISO YYYY-MM-DD / timestamp with timezone. Stored as UTC. Blank means none.']),
    ['Status', `Optional configured key or label; blank uses the first configured stage. Available: ${(settings.stages || []).map(s => `${s.label} (${s.key})`).join(', ')}`],
    ['External Writer', 'Optional Yes/No, True/False or 1/0. Blank means No. Yes requires an existing external writer email; internal Writer must be blank.'],
    ['Writer', 'Optional existing internal member full name (not email). Blank means unassigned.'],
    ['Editor', 'Optional existing internal member full name (not email); maps to review owner. Blank means none.'],
    ['Notes', 'Optional free text. Blank means none.'],
    ['Contributor Type', 'Optional internal, team, volunteer or paid. Internal/team map to stored gfi; historical gfi and GFI team remain accepted. Blank means none.'],
    ['Case Study', 'Optional Yes/No, True/False or 1/0; blank means false. Requirement only, not evidence of completion.'],
    ['Member Copyright agreement', 'Optional Yes/No, True/False or 1/0; blank means false. Requirement only, not evidence of consent or a signed agreement.'],
    ['External Writer first name', 'Optional verification against the existing external writer only; never creates or changes an identity. Blank means no name check.'],
    ['External Writer last name', 'Optional verification against the existing external writer only; never creates or changes an identity. Blank means no name check.'],
    ['External Writer email', 'Required only when External Writer is Yes. Matches an existing external writer by email; blank otherwise.'],
    ['NDA', 'Not supported. Do not add an NDA column. No documents, consent, completion evidence or notifications are imported.'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(guidance), 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

// Count actual output, not attacker-controlled ZIP size metadata, before XLSX
// can allocate or parse anything. Small compressed chunks bound inflater output.
function inspectZip(buffer) {
  let expanded = 0;
  let files = 0;
  let completed = 0;
  const names = new Set();
  const entries = Object.create(null);
  const unzip = new Unzip(file => {
    check(++files <= 1000, 'Too many ZIP entries');
    check(!names.has(file.name), 'Duplicate ZIP entry');
    check(!file.name.includes('..') && !file.name.startsWith('/') && !file.name.includes('\\'), 'Invalid ZIP entry name');
    names.add(file.name);
    const chunks = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      expanded += chunk.length;
      check(expanded <= MAX_EXPANDED, 'Expanded workbook exceeds 10 MB');
      chunks.push(Buffer.from(chunk));
      if (final) {
        completed++;
        entries[file.name] = Buffer.concat(chunks);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < buffer.length; offset += 1024) {
    unzip.push(buffer.subarray(offset, offset + 1024), offset + 1024 >= buffer.length);
  }
  check(files > 0 && files === completed && names.has('[Content_Types].xml')
    && names.has('xl/workbook.xml'), 'Invalid XLSX ZIP archive');
  // Rebuild from inspected bytes: XLSX must not independently trust a forged
  // central directory or interpret different entries from those just bounded.
  return Buffer.from(zipSync(entries, { level: 0 }));
}

function isoDate(value) {
  check(typeof value === 'string', 'Use a real Excel date or strict ISO date/timestamp');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  check(m, 'Use strict ISO YYYY-MM-DD or a timestamp with timezone');
  const [, y, mo, d, h, mi, s, , zone] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  check(year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && (!h || (Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59)), 'Invalid calendar date/time');
  if (zone && zone !== 'Z') {
    check(Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59, 'Invalid timezone');
  }
  const parsed = new Date(h ? value : `${value}T00:00:00.000Z`);
  check(Number.isFinite(parsed.getTime()), 'Invalid date');
  return parsed.toISOString();
}

function excelDate(serial, date1904) {
  check(Number.isFinite(serial) && serial >= 0 && (date1904 || Math.floor(serial) !== 60), 'Invalid Excel date');
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const result = new Date(epoch + Math.round((serial - (!date1904 && serial > 60 ? 1 : 0)) * 86400000));
  check(Number.isFinite(result.getTime()) && result.getUTCFullYear() >= 1 && result.getUTCFullYear() <= 9999, 'Invalid Excel date');
  return result.toISOString();
}

export function parsePublicationWorkbook(buffer, { fileName, sheetName } = {}) {
  check(Buffer.isBuffer(buffer) && buffer.length > 0, 'A workbook buffer is required');
  check(buffer.length <= MAX_FILE, 'Workbook exceeds 1 MB');
  check(!fileName || /\.xlsx$/i.test(fileName), 'Only .xlsx files are supported');
  check(buffer[0] === 0x50 && buffer[1] === 0x4b, 'Only XLSX ZIP workbooks are supported');
  const inspected = inspectZip(buffer);
  const wb = XLSX.read(inspected, { type: 'buffer', cellFormula: true, cellNF: true, cellDates: false });
  check(wb.SheetNames.length > 0 && wb.SheetNames.length <= 20, 'Invalid number of worksheets');
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (sheet['!ref']) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      check(range.e.r < 1000 && range.e.c < 100, `Worksheet ${name} exceeds maximum dimensions`);
    }
    for (const [key, cell] of Object.entries(sheet)) {
      if (key.startsWith('!')) continue;
      check(cell.f === undefined && cell.F === undefined, `Formulas are not allowed (${name}!${key})`);
      const position = XLSX.utils.decode_cell(key);
      check(position.r < 1000 && position.c < 100, `Worksheet ${name} exceeds maximum dimensions`);
      check(cell.t !== 'e', `Excel error cell at ${name}!${key}`);
    }
  }
  const sheets = wb.SheetNames.filter(name => !(name === 'Instructions' && wb.Sheets[name].A1?.v === INSTRUCTIONS));
  if (!sheetName && sheets.length > 1) return { sheets, sheetName: null, records: [], needsSheetSelection: true };
  sheetName ||= sheets[0];
  check(sheets.includes(sheetName), 'Select a valid data worksheet');
  const sheet = wb.Sheets[sheetName];
  check(sheet['!ref'], 'Worksheet is empty');
  const range = XLSX.utils.decode_range(sheet['!ref']);
  check(range.s.r === 0 && range.s.c === 0 && range.e.r <= 100 && range.e.c < PUBLICATION_HEADERS.length,
    'Data worksheet exceeds 100 rows or 18 columns, or does not start at A1');
  const headers = [];
  const seen = new Set();
  for (let c = 0; c <= range.e.c; c++) {
    const raw = norm(sheet[XLSX.utils.encode_cell({ r: 0, c })]?.v);
    const header = PUBLICATION_HEADERS.find(h => norm(h) === raw);
    check(header, `Unknown or empty header in column ${c + 1}`);
    check(!seen.has(header), `Ambiguous duplicate header: ${header}`);
    seen.add(header);
    headers.push(header);
  }
  check(seen.has('Title'), 'Title header is required');
  const records = [];
  for (let r = 1; r <= range.e.r; r++) {
    const values = Object.fromEntries(PUBLICATION_HEADERS.map(h => [h, '']));
    for (let c = 0; c < headers.length; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      let value = cell?.v ?? '';
      check(['string', 'number', 'boolean'].includes(typeof value), `Unsupported cell value at row ${r + 1}`);
      if (typeof value === 'string') value = value.trim();
      if (DATE_FIELDS[headers[c]] && cell?.t === 'n' && XLSX.SSF.is_date(cell.z || '')) {
        value = excelDate(value, !!wb.Workbook?.WBProps?.date1904);
      }
      values[headers[c]] = value;
    }
    if (Object.values(values).some(v => v !== '')) records.push({ row: r + 1, values });
  }
  return { sheets, sheetName, records };
}

function flag(value) {
  if (value === '' || value == null) return false;
  check(['string', 'number', 'boolean'].includes(typeof value), 'Must be a boolean value');
  if (value === true || value === 1 || ['yes', 'true', '1'].includes(norm(value))) return true;
  if (value === false || value === 0 || ['no', 'false', '0'].includes(norm(value))) return false;
  throw new Error('Must be Yes/No, True/False or 1/0');
}

export function resolvePublicationRows(records, { settings, members, externalWriters, briefs, canAssign = false } = {}) {
  check(settings && Array.isArray(settings.categories) && Array.isArray(settings.stages), 'Complete tenant settings are required');
  check([members, externalWriters, briefs].every(Array.isArray), 'Complete members, externalWriters and briefs lookup arrays are required');
  check(Array.isArray(records) && records.length <= 100, 'Maximum 100 publication rows');
  const counts = new Map();
  for (const r of records) counts.set(titleKey(r.values.Title), (counts.get(titleKey(r.values.Title)) || 0) + 1);
  return records.map(({ row, values: v }) => {
    const errors = [], warnings = [];
    const textHeaders = PUBLICATION_HEADERS.filter(h => !DATE_FIELDS[h] && !['External Writer', 'Case Study', 'Member Copyright agreement'].includes(h));
    for (const header of PUBLICATION_HEADERS) {
      const value = v[header];
      if (value == null || value === '') continue;
      const limit = header === 'Notes' ? 10000 : header === 'Title' ? 500 : 255;
      if (typeof value === 'object' || (textHeaders.includes(header) && typeof value !== 'string')) {
        errors.push(`${header}: Must be text`);
      } else if (typeof value === 'string' && value.length > limit) {
        errors.push(`${header}: Maximum ${limit} characters`);
      }
    }
    const payload = { title: text(v.Title), assigned_writer_id: null, external_writer_id: null, review_owner_id: null };
    let writer = null, editor = null;
    const attempt = (label, fn) => {
      try { return fn(); } catch (error) { errors.push(`${label}: ${error.message}`); return null; }
    };
    const unique = (matches, label) => {
      check(matches.length === 1 && matches[0].id, `${label} is missing or ambiguous`);
      return matches[0];
    };
    if (!payload.title) errors.push('Title is required');
    if (counts.get(titleKey(payload.title)) > 1) errors.push('Duplicate title within workbook');
    for (const [header, key] of Object.entries({ Category: 'category', SLA: 'sla', Contract: 'contract', Notes: 'notes' })) {
      payload[key] = text(v[header]) || null;
    }
    if (payload.category) payload.category = attempt('Category', () => {
      const matches = settings.categories.filter(c => norm(c) === norm(payload.category));
      check(matches.length === 1, 'Unknown or ambiguous configured category');
      return matches[0];
    });
    payload.status = text(v.Status) ? attempt('Status', () => {
      const matches = settings.stages.filter(s => norm(s.key) === norm(v.Status) || norm(s.label) === norm(v.Status));
      check(matches.length === 1, 'Unknown or ambiguous configured status');
      return matches[0].key;
    }) : attempt('Status', () => {
      check(settings.stages[0]?.key, 'A configured stage is required');
      return settings.stages[0].key;
    });
    for (const [header, key] of Object.entries(DATE_FIELDS)) {
      payload[key] = v[header] === '' || v[header] == null ? null : attempt(header, () => isoDate(v[header]));
    }
    payload.case_study_required = attempt('Case Study', () => flag(v['Case Study']));
    payload.copyright_required = attempt('Member Copyright agreement', () => flag(v['Member Copyright agreement']));
    const external = attempt('External Writer', () => flag(v['External Writer']));
    const contributor = norm(v['Contributor Type']);
    // Historical scripts explicitly map GFI team -> gfi; the supported stored
    // enum is gfi / paid / volunteer, not arbitrary unvalidated source text.
    payload.contributor_type = ['gfi team', 'internal', 'team'].includes(contributor) ? 'gfi' : contributor || null;
    if (payload.contributor_type && !['gfi', 'paid', 'volunteer'].includes(payload.contributor_type)) errors.push('Unknown Contributor Type');
    const externalFields = ['External Writer email', 'External Writer first name', 'External Writer last name'];
    if (external && text(v.Writer)) errors.push('External writer and internal Writer assignments contradict each other');
    if (!external && externalFields.some(h => text(v[h]))) errors.push('External writer details require External Writer Yes');
    const member = name => unique(members.filter(m => norm(`${text(m.first_name)} ${text(m.last_name)}`) === norm(name)), 'Internal member');
    if (external) {
      writer = attempt('External Writer email', () => {
        check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(v['External Writer email'])), 'A valid existing external writer email is required');
        const match = unique(externalWriters.filter(w => norm(w.email) === norm(v['External Writer email'])), 'External writer');
        for (const [header, key] of [['External Writer first name', 'first_name'], ['External Writer last name', 'last_name']]) {
          check(!text(v[header]) || norm(v[header]) === norm(match[key]), `${header} contradicts the existing identity`);
        }
        return match;
      });
      payload.external_writer_id = writer?.id ?? null;
    } else if (text(v.Writer)) {
      writer = attempt('Writer', () => member(v.Writer));
      payload.assigned_writer_id = writer?.id ?? null;
    }
    if (text(v.Editor)) {
      editor = attempt('Editor', () => member(v.Editor));
      payload.review_owner_id = editor?.id ?? null;
    }
    if ((external || text(v.Writer) || text(v.Editor)) && !canAssign) errors.push('Assignment permission is required');
    if (payload.case_study_required || payload.copyright_required) warnings.push('Requirement flags do not import completion, consent or signed evidence');
    const existing = briefs.filter(b => titleKey(b.title) === titleKey(payload.title));
    let action = 'create';
    if (existing.length > 1) errors.push('Existing title is ambiguous');
    else if (existing.length === 1) {
      const differences = Object.keys(payload).filter(key => {
        if (key === 'title') return titleKey(existing[0].title) !== titleKey(payload.title);
        if (Object.values(DATE_FIELDS).includes(key)) {
          return payload[key] === null ? existing[0][key] != null
            : Date.parse(existing[0][key]) !== Date.parse(payload[key]);
        }
        return (existing[0][key] ?? null) !== payload[key];
      });
      if (differences.length) errors.push(`Existing title has different fields: ${differences.join(', ')}`);
      else { action = 'skip'; warnings.push('Identical existing brief; no changes will be made'); }
    }
    if (errors.length) action = 'error';
    return { row, title: payload.title, payload, action, errors, warnings, writer, editor };
  });
}
