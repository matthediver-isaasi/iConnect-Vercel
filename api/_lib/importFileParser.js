// Shared parsing logic for the Import Manager endpoints (parse / preview / execute).
// Detects whether an uploaded file is an XLSX spreadsheet or a CSV and parses
// it into the same array-of-row-objects shape (header row becomes object keys,
// all values are trimmed strings). Keeping this in one place avoids drift
// between the three import endpoints.

// Detect XLSX uploads by filename extension first, then fall back to the ZIP
// magic bytes ("PK", 0x50 0x4B) that all .xlsx (OOXML) files start with.
export function isXlsxFile(file) {
  const name = (file?.originalname || '').toLowerCase();
  if (name.endsWith('.xlsx')) return true;
  if (name.endsWith('.csv')) return false;

  const buf = file?.buffer;
  if (buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    return true;
  }
  return false;
}

// Parse the first worksheet of an XLSX workbook into the same shape as the CSV
// path: an array of row objects keyed by the header row, values as trimmed
// strings.
async function parseXlsxRecords(buffer) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  // header:1 -> array-of-arrays; raw:false -> formatted strings (matches what a
  // CSV export of the same sheet would contain); blankrows:false skips empties.
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false,
  });

  if (!rows.length) return [];

  const headers = (rows[0] || []).map((h) => String(h ?? '').trim());

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const rowArr = rows[i] || [];

    // Skip fully empty rows.
    const isEmpty = rowArr.every(
      (c) => c === '' || c === null || c === undefined
    );
    if (isEmpty) continue;

    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const val = rowArr[c];
      obj[key] = val === null || val === undefined ? '' : String(val).trim();
    }
    records.push(obj);
  }

  return records;
}

// Parse a CSV buffer: strip BOM, normalize line endings, auto-detect the
// delimiter (semicolon vs comma), then parse with csv-parse.
async function parseCsvRecords(buffer) {
  let csvContent = buffer.toString('utf-8');

  // Remove BOM if present.
  if (csvContent.charCodeAt(0) === 0xfeff) {
    csvContent = csvContent.slice(1);
  }

  // Normalize line endings.
  csvContent = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Auto-detect delimiter (semicolon or comma) from the header line.
  const firstLine = csvContent.split('\n')[0] || '';
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delimiter = semicolonCount > commaCount ? ';' : ',';

  const { parse } = await import('csv-parse/sync');
  return parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter,
    relax_quotes: true,
    relax_column_count: true,
    escape: '"',
    quote: '"',
  });
}

// Parse an uploaded import file into records.
// Returns { records, isXlsx, fileLabel } where fileLabel is a human-friendly
// noun ("spreadsheet"/"CSV file") for use in error messages.
export async function parseImportFile(file) {
  const isXlsx = isXlsxFile(file);
  const records = isXlsx
    ? await parseXlsxRecords(file.buffer)
    : await parseCsvRecords(file.buffer);

  return {
    records,
    isXlsx,
    fileLabel: isXlsx ? 'spreadsheet' : 'CSV file',
  };
}
