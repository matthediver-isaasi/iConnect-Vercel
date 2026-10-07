// React-free content helpers for the Canvas data table block.
// Rows deliberately store values by stable column id, never by column index.

export const TABLE_LIMITS = {
  maxColumns: 20,
  maxRows: 500,
  maxPasteChars: 100_000,
  maxCellChars: 10_000,
};

let idCounter = 0;
export function makeTableId(prefix = 'tbl') {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function makeTableColumn(heading = 'Column') {
  return { id: makeTableId('col'), heading: String(heading) };
}

export function makeTableRow(columns, values = {}) {
  const cells = {};
  for (const col of Array.isArray(columns) ? columns : []) {
    if (col?.id) cells[col.id] = String(values?.[col.id] ?? '');
  }
  return { id: makeTableId('row'), cells };
}

export function makeTableTypographyMetrics(style, fallbackFontSize = 16) {
  const finite = (value) =>
    value === null || value === undefined || value === ''
      ? null
      : Number.isFinite(Number(value))
        ? Number(value)
        : null;
  return {
    fontSize: finite(style?.font_size) ?? fallbackFontSize,
    fontSizeTablet: finite(style?.font_size_tablet),
    fontSizeMobile: finite(style?.font_size_mobile),
    lineHeight: finite(style?.line_height) ?? 1.5,
    lineHeightTablet: finite(style?.line_height_tablet),
    lineHeightMobile: finite(style?.line_height_mobile),
    letterSpacing: finite(style?.letter_spacing) ?? 0,
    letterSpacingTablet: finite(style?.letter_spacing_tablet),
    letterSpacingMobile: finite(style?.letter_spacing_mobile),
  };
}

export function normalizeTableContent(content = {}) {
  const rawColumns = Array.isArray(content.columns) ? content.columns : [];
  const used = new Set();
  const columns = rawColumns.map((column, index) => {
    let id = typeof column?.id === 'string' && column.id.trim() ? column.id.trim() : `col-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    const normalized = { id, heading: typeof column?.heading === 'string' ? column.heading : `Column ${index + 1}` };
    // Optional author intent only: never invent defaults or rescale allocations.
    // Keep invalid nonblank saved values so validation can report them.
    if (column?.widthPercent !== undefined && column.widthPercent !== null && column.widthPercent !== '') {
      normalized.widthPercent = column.widthPercent;
    }
    return normalized;
  });
  const rawRows = Array.isArray(content.rows) ? content.rows : [];
  const rowIds = new Set();
  const rows = rawRows.map((row, index) => {
    let id = typeof row?.id === 'string' && row.id ? row.id : `row-${index + 1}`;
    while (rowIds.has(id)) id = `${id}-${index + 1}`;
    rowIds.add(id);
    const source = row?.cells && typeof row.cells === 'object' ? row.cells : {};
    // Preserve orphaned keys during routine normalization. Renderers ignore
    // keys without a column, while an explicit column removal deletes its key.
    // This prevents a malformed/oversized saved document losing data simply by
    // being opened; validation reports it instead.
    const cells = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value ?? '')]));
    for (const col of columns) cells[col.id] = String(source[col.id] ?? '');
    return { id, cells };
  });
  return {
    ...content,
    columns,
    rows,
    headerTypographyStyleId: typeof content.headerTypographyStyleId === 'string' ? content.headerTypographyStyleId : '',
    bodyTypographyStyleId: typeof content.bodyTypographyStyleId === 'string' ? content.bodyTypographyStyleId : '',
  };
}

// Shared by the inspector, renderer and first-paint estimator. Null widths mean
// use the exact legacy equal-width layout (no colgroup), including invalid data.
export function resolveTableColumnWidths(columns = []) {
  const hasExplicit = columns.some((column) => column.widthPercent !== undefined && column.widthPercent !== null && column.widthPercent !== '');
  if (!hasExplicit) return { widths: null, error: null };
  let total = 0;
  let autoCount = 0;
  for (const column of columns) {
    const value = column.widthPercent;
    if (value === undefined || value === null || value === '') { autoCount += 1; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
      return { widths: null, error: 'Each column width must be greater than 0 and at most 100%.' };
    }
    total += value;
  }
  // Tolerance only for binary floating-point addition, never normalize input.
  const tolerance = 1e-10;
  if (total > 100) return { widths: null, error: 'Column widths cannot total more than 100%.' };
  if (autoCount && total >= 100) return { widths: null, error: 'Leave some width available for Auto columns (total must be below 100%).' };
  if (!autoCount && Math.abs(total - 100) > tolerance) return { widths: null, error: 'When every column has a width, the total must be 100%.' };
  return {
    widths: columns.map((column) => column.widthPercent === undefined || column.widthPercent === null || column.widthPercent === ''
      ? (100 - total) / autoCount : column.widthPercent),
    error: null,
  };
}

// Accept inspector drafts without clamping. Clearing removes the property.
export function setTableColumnWidth(column, raw) {
  const { widthPercent: _, ...rest } = column;
  return raw === '' || raw === null || raw === undefined
    ? rest
    : { ...rest, widthPercent: typeof raw === 'number' ? raw : Number(raw) };
}

function metricAtBreakpoint(metrics, key, breakpoint) {
  if (breakpoint === 'mobile') return metrics?.[`${key}Mobile`] ?? metrics?.[`${key}Tablet`] ?? metrics?.[key];
  if (breakpoint === 'tablet') return metrics?.[`${key}Tablet`] ?? metrics?.[key];
  return metrics?.[key];
}

function wrappedLineCount(value, width, fontSize, letterSpacing, transform) {
  let text = String(value ?? '');
  if (transform === 'uppercase') text = text.toUpperCase();
  else if (transform === 'lowercase') text = text.toLowerCase();
  // A deterministic font-independent approximation for first paint only.
  // Keep word boundaries, preserved whitespace/newlines, and anywhere breaks
  // for long tokens. Live ResizeObserver measurements remain authoritative.
  const advance = Math.max(1, fontSize * 0.6 + letterSpacing);
  const capacity = Math.max(1, Math.floor(width / advance));
  return text.split(/\r\n|\r|\n/).reduce((total, line) => {
    let lines = 1;
    let used = 0;
    for (const token of line.replace(/\t/g, '        ').match(/\s+|\S+/gu) || []) {
      let length = Array.from(token).length;
      if (!/^\s/u.test(token) && used > 0 && used + length > capacity) {
        lines += 1;
        used = 0;
      }
      while (length > 0) {
        if (used === capacity) { lines += 1; used = 0; }
        const take = Math.min(length, capacity - used);
        used += take;
        length -= take;
      }
    }
    return total + lines;
  }, 0);
}

// Server-computable footprint used by Canvas v2's static first-paint CSS.
// Legacy fixed-layout tables share width equally. Valid opt-in allocations use
// the same percentages as the renderer, with leftover width shared by Auto.
// Width excludes the block wrapper's padding/border; cell padding is 12px/side.
export function estimateDataTableHeight(content, breakpoint = 'desktop', styles = {}) {
  const table = normalizeTableContent(content);
  const width = Number.isFinite(styles.contentWidth) ? Math.max(0, styles.contentWidth) : 1200;
  const cellWidth = Math.max(1, width / Math.max(1, table.columns.length) - 24);
  const { widths } = resolveTableColumnWidths(table.columns);
  const rowHeight = (values, metrics, style) => {
    const fontSize = Math.max(8, Number(metricAtBreakpoint(metrics, 'fontSize', breakpoint)) || 16);
    const lineHeight = Math.max(0.5, Number(metricAtBreakpoint(metrics, 'lineHeight', breakpoint)) || 1.5);
    const letterSpacing = Number(metricAtBreakpoint(metrics, 'letterSpacing', breakpoint)) || 0;
    const lines = Math.max(1, ...values.map((value, index) =>
      wrappedLineCount(value, widths ? Math.max(1, width * widths[index] / 100 - 24) : cellWidth, fontSize, letterSpacing, style?.text_transform)));
    return Math.ceil(fontSize * lineHeight * lines) + 17; // 16px y-padding + border
  };
  const headerMetrics = makeTableTypographyMetrics(styles.headerStyle, 16);
  const bodyMetrics = makeTableTypographyMetrics(styles.bodyStyle, 16);
  const headerHeight = rowHeight(table.columns.map((column) => column.heading), headerMetrics, styles.headerStyle);
  const bodyHeight = table.rows.reduce(
    (sum, row) => sum + rowHeight(table.columns.map((column) => row.cells?.[column.id] ?? ''), bodyMetrics, styles.bodyStyle),
    0,
  );
  // Header has a 2px collapsed border instead of the body's 1px border.
  return headerHeight + bodyHeight + 1;
}

export function addTableColumn(content, heading = 'Column') {
  const table = normalizeTableContent(content);
  if (table.columns.length >= TABLE_LIMITS.maxColumns) return table;
  const column = makeTableColumn(heading);
  return { ...table, columns: [...table.columns, column], rows: table.rows.map((row) => ({ ...row, cells: { ...row.cells, [column.id]: '' } })) };
}

export function removeTableColumn(content, columnId) {
  const table = normalizeTableContent(content);
  const columns = table.columns.filter((column) => column.id !== columnId);
  return {
    ...table,
    columns,
    rows: table.rows.map((row) => {
      const { [columnId]: _, ...cells } = row.cells;
      return { ...row, cells };
    }),
  };
}

export function reorderTableColumns(content, from, to) {
  const table = normalizeTableContent(content);
  if (from < 0 || to < 0 || from >= table.columns.length || to >= table.columns.length) return table;
  const columns = [...table.columns];
  columns.splice(to, 0, columns.splice(from, 1)[0]);
  return { ...table, columns };
}

export function parseDelimitedTable(text, columns) {
  if (typeof text !== 'string' || !text.trim()) return { rows: [], headerMatches: false, errors: ['Paste some comma- or tab-separated rows first.'] };
  if (text.length > TABLE_LIMITS.maxPasteChars) return { rows: [], headerMatches: false, errors: [`Pasted data is too large (maximum ${TABLE_LIMITS.maxPasteChars.toLocaleString()} characters).`] };
  // Strip the BOM emitted by Excel/Sheets exports before header comparison.
  const input = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  // Pick a dialect from the first record, counting separators only when they
  // are outside quotes. A quoted tab inside valid comma CSV must not turn the
  // whole paste into TSV.
  let commas = 0, tabs = 0, dialectQuoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (dialectQuoted && input[i + 1] === '"') i += 1;
      else dialectQuoted = !dialectQuoted;
    } else if (!dialectQuoted && (ch === '\n' || ch === '\r')) break;
    else if (!dialectQuoted && ch === ',') commas += 1;
    else if (!dialectQuoted && ch === '\t') tabs += 1;
  }
  const delimiter = tabs > 0 ? '\t' : ',';
  const parsed = [];
  let row = [], cell = '', quoted = false, recordStarted = false, justClosedQuote = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; justClosedQuote = true; }
      } else cell += ch;
    } else if (ch === '"' && cell === '' && !justClosedQuote) { quoted = true; recordStarted = true; }
    else if (ch === '"') return { rows: [], headerMatches: false, errors: [`Row ${parsed.length + 1} contains a quote inside an unquoted value.`] };
    else if (justClosedQuote && ch !== delimiter && ch !== '\n' && ch !== '\r') {
      return { rows: [], headerMatches: false, errors: [`Row ${parsed.length + 1} has text after a closing quote.`] };
    } else if (ch === delimiter) { row.push(cell); cell = ''; recordStarted = true; justClosedQuote = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(cell); parsed.push(row); row = []; cell = ''; recordStarted = false; justClosedQuote = false;
    } else { cell += ch; recordStarted = true; }
  }
  if (quoted) return { rows: [], headerMatches: false, errors: ['A quoted value is not closed. Close the quote and try again.'] };
  if (recordStarted || cell || row.length) { row.push(cell); parsed.push(row); }
  if (parsed.length && parsed[parsed.length - 1].every((value) => value === '')) parsed.pop();
  const headings = (columns || []).map((c) => String(c.heading || '').trim().toLocaleLowerCase());
  const headerMatches = !!parsed[0] && parsed[0].length === headings.length
    && parsed[0].every((value, index) => String(value).trim().toLocaleLowerCase() === headings[index]);
  const errors = [];
  if (!columns?.length) errors.push('Add at least one column before pasting rows.');
  const maxParsedRows = TABLE_LIMITS.maxRows + (headerMatches ? 1 : 0);
  if (parsed.length > maxParsedRows) errors.push(`Pasted data has too many data rows (maximum ${TABLE_LIMITS.maxRows}).`);
  parsed.forEach((values, index) => {
    if (values.length !== headings.length) errors.push(`Row ${index + 1} has ${values.length} cells; this table needs ${headings.length}.`);
    if (values.some((value) => value.length > TABLE_LIMITS.maxCellChars)) errors.push(`Row ${index + 1} contains a cell longer than ${TABLE_LIMITS.maxCellChars.toLocaleString()} characters.`);
  });
  return { rows: parsed, headerMatches, errors };
}

export function appendParsedTableRows(content, parsedRows, skipHeader = false) {
  const table = normalizeTableContent(content);
  const source = skipHeader ? parsedRows.slice(1) : parsedRows;
  if (table.rows.length + source.length > TABLE_LIMITS.maxRows) {
    throw new Error(`This would exceed the ${TABLE_LIMITS.maxRows}-row table limit.`);
  }
  return {
    ...table,
    rows: [...table.rows, ...source.map((values) => makeTableRow(table.columns, Object.fromEntries(table.columns.map((col, i) => [col.id, values[i] ?? '']))))],
  };
}