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
  };
}

export function normalizeTableContent(content = {}) {
  const rawColumns = Array.isArray(content.columns) ? content.columns : [];
  const used = new Set();
  const columns = rawColumns.map((column, index) => {
    let id = typeof column?.id === 'string' && column.id.trim() ? column.id.trim() : `col-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return { id, heading: typeof column?.heading === 'string' ? column.heading : `Column ${index + 1}` };
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

function metricAtBreakpoint(metrics, key, breakpoint) {
  if (breakpoint === 'mobile') return metrics?.[`${key}Mobile`] ?? metrics?.[`${key}Tablet`] ?? metrics?.[key];
  if (breakpoint === 'tablet') return metrics?.[`${key}Tablet`] ?? metrics?.[key];
  return metrics?.[key];
}

function explicitLineCount(value) {
  return Math.max(1, String(value ?? '').split(/\r\n|\r|\n/).length);
}

// Server-computable footprint used by Canvas v2's static first-paint CSS.
// The rendered table has max-content width inside a horizontal scroller, so
// ordinary text does not wrap; only explicit line breaks increase row height.
export function estimateDataTableHeight(content, breakpoint = 'desktop', styles = {}) {
  const table = normalizeTableContent(content);
  const rowHeight = (values, metrics) => {
    const fontSize = Math.max(8, Number(metricAtBreakpoint(metrics, 'fontSize', breakpoint)) || 16);
    const lineHeight = Math.max(0.5, Number(metricAtBreakpoint(metrics, 'lineHeight', breakpoint)) || 1.5);
    const lines = Math.max(1, ...values.map(explicitLineCount));
    return Math.ceil(fontSize * lineHeight * lines) + 17; // 16px y-padding + border
  };
  const headerMetrics = makeTableTypographyMetrics(styles.headerStyle, 16);
  const bodyMetrics = makeTableTypographyMetrics(styles.bodyStyle, 16);
  const headerHeight = rowHeight(table.columns.map((column) => column.heading), headerMetrics);
  const bodyHeight = table.rows.reduce(
    (sum, row) => sum + rowHeight(table.columns.map((column) => row.cells?.[column.id] ?? ''), bodyMetrics),
    0,
  );
  // Reserve a conservative native horizontal-scrollbar gutter. Overlay
  // scrollbar platforms use less, never more.
  return headerHeight + bodyHeight + 19;
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