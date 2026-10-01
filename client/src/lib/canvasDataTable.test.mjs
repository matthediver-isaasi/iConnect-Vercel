import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TABLE_LIMITS,
  addTableColumn,
  appendParsedTableRows,
  estimateDataTableHeight,
  makeTableRow,
  normalizeTableContent,
  parseDelimitedTable,
  removeTableColumn,
  reorderTableColumns,
} from './canvasDataTable.js';
import {
  BLOCK_TYPES,
  AUTO_HEIGHT_LEAF_TYPES,
  createBlock,
  createFlowDesign,
  createFlowNode,
  insertFlowNode,
  normalizeCanvasDesign,
  validateBlock,
} from './canvasDesign.js';
import { buildFlowCanvasCss, resolveFlowLayout } from './canvasFlowLayout.js';

const table = {
  columns: [{ id: 'a', heading: 'Name' }, { id: 'b', heading: 'Notes' }],
  rows: [{ id: 'r1', cells: { a: 'Ada', b: 'First' } }],
  headerTypographyStyleId: 'header-style',
  bodyTypographyStyleId: 'body-style',
};

test('CSV parser handles quotes, embedded commas, blanks and common line endings', () => {
  const result = parseDelimitedTable('Name,Notes\r\n"Ada, Jr.","Said ""hello"""\r\nLin,\n', table.columns);
  assert.deepEqual(result.errors, []);
  assert.equal(result.headerMatches, true);
  assert.deepEqual(result.rows, [
    ['Name', 'Notes'],
    ['Ada, Jr.', 'Said "hello"'],
    ['Lin', ''],
  ]);
});

test('tab-separated spreadsheet rows preserve blank cells', () => {
  const result = parseDelimitedTable('Ada\t\nLin\tSecond', table.columns);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [['Ada', ''], ['Lin', 'Second']]);
});

test('spreadsheet tabs win over literal commas in unquoted TSV cells', () => {
  const result = parseDelimitedTable('Ada, Jr.\tFirst\nLin\tSecond', table.columns);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0], ['Ada, Jr.', 'First']);
});

test('quoted blank cells are retained and malformed closing quotes are rejected', () => {
  const blank = parseDelimitedTable('"",Notes', table.columns);
  assert.deepEqual(blank.errors, []);
  assert.deepEqual(blank.rows, [['', 'Notes']]);
  assert.match(parseDelimitedTable('"Ada"x,Notes', table.columns).errors[0], /text after a closing quote/);
});

test('delimiter detection ignores quoted tabs in comma CSV and strips a BOM header', () => {
  const result = parseDelimitedTable('\uFEFFName,Notes\nAda,"tab\tinside"', table.columns);
  assert.deepEqual(result.errors, []);
  assert.equal(result.headerMatches, true);
  assert.deepEqual(result.rows[1], ['Ada', 'tab\tinside']);
});

test('uneven and unclosed rows return actionable errors and cannot append', () => {
  const uneven = parseDelimitedTable('Ada\nLin,Second,Extra', table.columns);
  assert.match(uneven.errors[0], /Row 1 has 1 cells/);
  const quoted = parseDelimitedTable('"Ada,Lin', table.columns);
  assert.match(quoted.errors[0], /not closed/);
});

test('column rename and reorder retain cell values by stable identity', () => {
  const renamed = { ...table, columns: [{ id: 'a', heading: 'Person' }, table.columns[1]] };
  const reordered = reorderTableColumns(renamed, 0, 1);
  assert.deepEqual(reordered.columns.map((c) => c.id), ['b', 'a']);
  assert.deepEqual(reordered.rows[0].cells, { a: 'Ada', b: 'First' });
  assert.equal(reordered.columns[1].heading, 'Person');
});

test('adding and removing a column updates row maps without disturbing other values', () => {
  const added = addTableColumn(table, 'Country');
  const newColumn = added.columns.at(-1);
  assert.equal(added.rows[0].cells[newColumn.id], '');
  const removed = removeTableColumn(added, 'b');
  assert.deepEqual(removed.columns.map((c) => c.id), ['a', newColumn.id]);
  assert.equal(removed.rows[0].cells.a, 'Ada');
  assert.equal('b' in removed.rows[0].cells, false);
});

test('manual rows survive appending parsed rows and matching header can be skipped', () => {
  const parsed = parseDelimitedTable('Name,Notes\nGrace,Compiler', table.columns);
  const appended = appendParsedTableRows(table, parsed.rows, true);
  assert.equal(appended.rows.length, 2);
  assert.equal(appended.rows[0].cells.a, 'Ada');
  assert.equal(appended.rows[1].cells.a, 'Grace');
  assert.equal(appended.rows[1].cells.b, 'Compiler');
});

test('append limit rejects the whole operation', () => {
  const full = { ...table, rows: Array.from({ length: TABLE_LIMITS.maxRows }, (_, i) => makeTableRow(table.columns, { a: String(i) })) };
  assert.throws(() => appendParsedTableRows(full, [['extra', 'row']]), /row table limit/);
  assert.equal(full.rows.length, TABLE_LIMITS.maxRows);
});

test('normalization repairs unsafe structures while preserving style selections', () => {
  const normalized = normalizeTableContent({
    columns: [{ id: 'same', heading: 'One' }, { id: 'same', heading: 'Two' }],
    rows: [{ cells: { same: 42 } }],
    headerTypographyStyleId: 'h',
    bodyTypographyStyleId: 'p',
  });
  assert.equal(new Set(normalized.columns.map((c) => c.id)).size, 2);
  assert.equal(normalized.rows[0].cells.same, '42');
  assert.equal(normalized.headerTypographyStyleId, 'h');
  assert.equal(normalized.bodyTypographyStyleId, 'p');
});

test('normalization does not silently truncate persisted oversize content', () => {
  const long = 'x'.repeat(TABLE_LIMITS.maxCellChars + 1);
  const normalized = normalizeTableContent({
    columns: Array.from({ length: TABLE_LIMITS.maxColumns + 1 }, (_, i) => ({ id: `c${i}`, heading: `C${i}` })),
    rows: [{ id: 'r', cells: { c0: long, orphan: 'preserve me' } }],
  });
  assert.equal(normalized.columns.length, TABLE_LIMITS.maxColumns + 1);
  assert.equal(normalized.rows[0].cells.c0.length, TABLE_LIMITS.maxCellChars + 1);
  assert.equal(normalized.rows[0].cells.orphan, 'preserve me');
  const errors = validateBlock({ type: BLOCK_TYPES.DATA_TABLE, content: normalized });
  assert.ok(errors.some((error) => error.includes('maximum of 20 columns')));
  assert.ok(errors.some((error) => error.includes('cell longer')));
});

test('Canvas table defaults and saved data survive normalize/save/reload round trips', () => {
  const block = createBlock(BLOCK_TYPES.DATA_TABLE);
  assert.equal(block.type, 'data-table');
  assert.equal(block.content.columns.length, 2);
  const edited = { ...block, content: table };
  const design = normalizeCanvasDesign({ version: 1, root: { sections: [{ id: 'root-section', children: [edited] }] } });
  const reloaded = normalizeCanvasDesign(JSON.parse(JSON.stringify(design)));
  assert.deepEqual(reloaded.root.sections[0].children[0].content, normalizeTableContent(table));
  assert.deepEqual(validateBlock(reloaded.root.sections[0].children[0]), []);
});

test('publish validation rejects empty headings and unusable structures', () => {
  const errors = validateBlock({ type: BLOCK_TYPES.DATA_TABLE, content: { columns: [{ id: 'a', heading: '' }], rows: [] } });
  assert.ok(errors.some((error) => error.includes('requires a heading')));
  assert.ok(validateBlock({ type: BLOCK_TYPES.DATA_TABLE, content: { columns: [], rows: [] } }).some((error) => error.includes('at least one column')));
});

test('shared renderer keeps semantic headers and width-constrained wrapping', () => {
  const registrySource = readFileSync(new URL('../components/canvas/blocks/registry.jsx', import.meta.url), 'utf8');
  const renderer = registrySource.slice(
    registrySource.indexOf('function DataTableRender'),
    registrySource.indexOf('function DataTableInspector'),
  );
  assert.match(renderer, /table-fixed/);
  assert.doesNotMatch(renderer, /min-w-max|overflow-x-auto/);
  assert.equal((renderer.match(/overflow-wrap:anywhere/g) || []).length, 2);
  assert.match(renderer, /<table\b/);
  assert.match(renderer, /<thead>/);
  assert.match(renderer, /<tbody>/);
  assert.match(renderer, /<th key=\{column\.id\} scope="col"/);
});

test('flow layout treats tables as measured auto-height leaves and pushes following content down', () => {
  assert.equal(AUTO_HEIGHT_LEAF_TYPES.has(BLOCK_TYPES.DATA_TABLE), true);
  let design = createFlowDesign();
  const tableNode = createFlowNode(BLOCK_TYPES.DATA_TABLE, { id: 'table-flow' });
  const nextNode = createFlowNode(BLOCK_TYPES.BUTTON, { id: 'after-table', flow: { heightMode: 'fixed', height: 44 } });
  design = insertFlowNode(design, tableNode);
  design = insertFlowNode(design, nextNode);
  const layout = resolveFlowLayout(design, {
    breakpoint: 'mobile',
    containerWidth: 375,
    measured: { 'table-flow': { height: 360 } },
  });
  assert.ok(layout.boxes['after-table'].y >= layout.boxes['table-flow'].y + 360);
  const css = buildFlowCanvasCss(design, '#scope');
  assert.match(css, /\[data-cb="table-flow"\]\{[^}]*height:auto/);
});

test('flow static CSS reserves a content-derived table footprint before the next block', () => {
  let design = createFlowDesign();
  const tableNode = createFlowNode(BLOCK_TYPES.DATA_TABLE, {
    id: 'static-table',
    content: {
      ...table,
      rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, cells: { a: `Person ${i}`, b: 'Details' } })),
    },
  });
  const nextNode = createFlowNode(BLOCK_TYPES.BUTTON, { id: 'static-after', flow: { heightMode: 'fixed', height: 44 } });
  design = insertFlowNode(design, tableNode);
  design = insertFlowNode(design, nextNode);
  const css = buildFlowCanvasCss(design, '#scope');
  const tableTop = Number(css.match(/\[data-cb="static-table"\]\{[^}]*top:(\d+)px/)[1]);
  const nextTop = Number(css.match(/\[data-cb="static-after"\]\{[^}]*top:(\d+)px/)[1]);
  assert.ok(nextTop >= tableTop + estimateDataTableHeight(tableNode.content, 'desktop'));
  assert.ok(nextTop - tableTop > 180, 'static layout must not use the default table geometry for many rows');
});

test('flow static table footprint includes wrapper chrome and current responsive tenant typography', () => {
  let design = createFlowDesign();
  const tableNode = createFlowNode(BLOCK_TYPES.DATA_TABLE, {
    id: 'styled-static-table',
    style: { paddingTop: 30, paddingBottom: 24, borderWidth: 4 },
    content: {
      ...table,
      headerTypographyStyleId: 'header-live',
      bodyTypographyStyleId: 'body-live',
      rows: Array.from({ length: 4 }, (_, i) => ({ id: `styled-r${i}`, cells: { a: `Person ${i}`, b: 'Details' } })),
    },
  });
  const nextNode = createFlowNode(BLOCK_TYPES.BUTTON, { id: 'styled-static-after', flow: { heightMode: 'fixed', height: 44 } });
  design = insertFlowNode(design, tableNode);
  design = insertFlowNode(design, nextNode);
  const liveStyles = [
    { id: 'header-live', font_size: 32, font_size_mobile: 48, line_height: 1.2, line_height_mobile: 1.5 },
    { id: 'body-live', font_size: 24, font_size_mobile: 56, line_height: 1.25, line_height_mobile: 1.8 },
  ];
  const css = buildFlowCanvasCss(design, '#scope', { typographyStyles: liveStyles });
  const mobileCss = css.slice(css.lastIndexOf('@media (max-width: 639.98px)'));
  const tableTop = Number(mobileCss.match(/\[data-cb="styled-static-table"\]\{[^}]*top:(\d+)px/)[1]);
  const nextTop = Number(mobileCss.match(/\[data-cb="styled-static-after"\]\{[^}]*top:(\d+)px/)[1]);
  const expectedContent = estimateDataTableHeight(tableNode.content, 'mobile', {
    headerStyle: liveStyles[0],
    bodyStyle: liveStyles[1],
  });
  assert.ok(nextTop >= tableTop + expectedContent + 30 + 24 + 8);
});

const schedule = {
  columns: [{ id: 'time', heading: 'Time' }, { id: 'session', heading: 'Session and presenter information' }],
  rows: [
    { id: 's1', cells: { time: '09:00 – 09:30', session: 'Martin Edmondson, opening address and conference welcome' } },
    { id: 's2', cells: { time: '10:45 – 11:30', session: 'Parallel Sessions (Rotating workshops and discussion)' } },
  ],
};

test('table estimate wraps headings, words and unbroken tokens within the available column width', () => {
  const height = (content, width) => estimateDataTableHeight(content, 'desktop', { contentWidth: width });
  assert.ok(height(schedule, 320) > height(schedule, 900));
  for (const value of ['A long heading that needs several lines', 'W'.repeat(100)]) {
    const heading = { columns: [{ id: 'a', heading: value }], rows: [] };
    const body = { columns: [{ id: 'a', heading: 'A' }], rows: [{ id: 'r', cells: { a: value } }] };
    assert.ok(height(heading, 160) > height(heading, 1000));
    assert.ok(height(body, 160) > height(body, 1000));
  }
  assert.ok(Number.isFinite(height(schedule, 0)), 'transient zero width must not loop or produce Infinity');
});

test('explicit newlines add lines even in a wide table; no scrollbar gutter is reserved', () => {
  const single = { columns: [{ id: 'a', heading: 'A' }], rows: [{ id: 'r', cells: { a: 'B' } }] };
  const multiline = { ...single, rows: [{ id: 'r', cells: { a: 'B\r\nC\nD' } }] };
  assert.equal(estimateDataTableHeight(single), 83);
  assert.equal(estimateDataTableHeight(multiline) - estimateDataTableHeight(single), 48);
});

test('wrapping estimates use current responsive font size, line height and letter spacing without changing content', () => {
  const before = JSON.stringify(schedule);
  const styles = {
    contentWidth: 400,
    headerStyle: { font_size: 16, font_size_tablet: 22, font_size_mobile: 28, line_height: 1.5 },
    bodyStyle: { font_size: 16, font_size_tablet: 22, font_size_mobile: 28, line_height: 1.5, line_height_mobile: 1.8 },
  };
  assert.ok(estimateDataTableHeight(schedule, 'mobile', styles) > estimateDataTableHeight(schedule, 'tablet', styles));
  assert.ok(estimateDataTableHeight(schedule, 'tablet', styles) > estimateDataTableHeight(schedule, 'desktop', styles));
  assert.ok(estimateDataTableHeight(schedule, 'desktop', {
    ...styles, bodyStyle: { ...styles.bodyStyle, letter_spacing: 4 },
  }) > estimateDataTableHeight(schedule, 'desktop', styles));
  assert.equal(JSON.stringify(schedule), before);
});

test('static footprint uses parent column width and wrapper chrome rather than stale stored width', () => {
  let design = createFlowDesign();
  const tableNode = createFlowNode(BLOCK_TYPES.DATA_TABLE, {
    id: 'column-table', content: schedule,
    style: { paddingLeft: 12, paddingRight: 18, paddingTop: 7, paddingBottom: 9, borderWidth: 2 },
    flow: { basis: '30%' },
  });
  const row = createFlowNode(BLOCK_TYPES.ROW, {
    id: 'schedule-row',
    flow: { gap: 20, padLeft: 10, padRight: 10 },
    children: [tableNode, createFlowNode(BLOCK_TYPES.SPACER, { id: 'other-column' })],
  });
  design = insertFlowNode(design, row);
  design = insertFlowNode(design, createFlowNode(BLOCK_TYPES.BUTTON, { id: 'below-row' }));
  const before = JSON.stringify(design);
  const { boxes } = resolveFlowLayout(design, { breakpoint: 'desktop', containerWidth: 1200 });
  assert.ok(boxes['column-table'].w < 400);
  const expected = estimateDataTableHeight(schedule, 'desktop', { contentWidth: boxes['column-table'].w - 34 }) + 20;
  const css = buildFlowCanvasCss(design, '#scope');
  const top = (id) => Number(css.match(new RegExp(`\\[data-cb="${id}"\\]\\{[^}]*top:(\\d+)px`))[1]);
  assert.ok(top('below-row') >= top('column-table') + expected);
  assert.equal(JSON.stringify(design), before, 'first-paint estimation must remain read-only');
});