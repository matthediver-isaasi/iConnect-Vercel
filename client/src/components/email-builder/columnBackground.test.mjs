import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  BLOCK_TYPES,
  DEFAULT_COLUMN_BACKGROUND_COLOR,
  createBlock,
  resolveColumnBackgroundColor,
  resizeColumns,
  updateColumnBackgroundColor,
} from './types.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
const { designToHtml, designToMjml } = await import('./mjmlConverter.js');

const designWithColumns = (columns, blockBackground = '#eeeeee', globalStyles = {}) => ({
  blocks: [{
    id: 'columns-1',
    type: BLOCK_TYPES.COLUMNS,
    styles: {
      backgroundColor: blockBackground,
      columnGap: '10px',
      paddingTop: '0',
      paddingRight: '0',
      paddingBottom: '0',
      paddingLeft: '0',
    },
    columns,
  }],
  globalStyles,
});

test('new Columns blocks give every column a safe background default', () => {
  const block = createBlock(BLOCK_TYPES.COLUMNS);
  assert.deepEqual(
    block.columns.map((column) => column.backgroundColor),
    [DEFAULT_COLUMN_BACKGROUND_COLOR, DEFAULT_COLUMN_BACKGROUND_COLOR],
  );
});

test('expanding Columns preserves existing settings and initializes only new columns', () => {
  const original = [
    { id: 'one', width: '50%', backgroundColor: '#ff0000', blocks: [{ id: 'nested' }] },
    { id: 'two', width: '50%', backgroundColor: '#00ff00', blocks: [] },
  ];
  const resized = resizeColumns(original, 3, 123);

  assert.deepEqual(resized[0], { ...original[0], width: '33%' });
  assert.deepEqual(resized[1], { ...original[1], width: '33%' });
  assert.deepEqual(resized[2], {
    id: 'col-123-2',
    blocks: [],
    width: '33%',
    backgroundColor: DEFAULT_COLUMN_BACKGROUND_COLOR,
  });
  assert.equal(original[0].width, '50%', 'source design remains unchanged');
});

test('generated email HTML keeps distinct sibling column backgrounds', () => {
  const html = designToHtml(designWithColumns([
    { id: 'one', width: '50%', backgroundColor: '#ff0000', blocks: [] },
    { id: 'two', width: '50%', backgroundColor: '#0000ff', blocks: [] },
  ]));

  assert.match(html, /background-color:\s*#ff0000/i);
  assert.match(html, /background-color:\s*#0000ff/i);
});

test('preview backgrounds stay independent and legacy columns inherit the block background', () => {
  const styles = { backgroundColor: '#123456' };
  assert.equal(resolveColumnBackgroundColor({ backgroundColor: '#ff0000' }, styles), '#ff0000');
  assert.equal(resolveColumnBackgroundColor({ backgroundColor: '#0000ff' }, styles), '#0000ff');
  assert.equal(resolveColumnBackgroundColor({}, styles), '#123456');
  assert.equal(resolveColumnBackgroundColor({}, {}), undefined);
});

test('updating one column background preserves sibling and nested column data', () => {
  const columns = [
    { id: 'one', width: '50%', backgroundColor: '#ff0000', blocks: [{ id: 'nested' }] },
    { id: 'two', width: '50%', backgroundColor: '#0000ff', blocks: [] },
  ];
  const updated = updateColumnBackgroundColor(columns, 0, '#00ff00');

  assert.deepEqual(updated[0], { ...columns[0], backgroundColor: '#00ff00' });
  assert.equal(updated[1], columns[1], 'untouched sibling keeps its original object and settings');
  assert.equal(updated[0].blocks, columns[0].blocks, 'nested blocks are preserved');
  assert.equal(columns[0].backgroundColor, '#ff0000', 'source design remains unchanged');
});

test('legacy columns without a background continue to inherit the Columns block background', () => {
  const mjml = designToMjml(designWithColumns([
    { id: 'legacy-one', width: '50%', blocks: [] },
    { id: 'legacy-two', width: '50%', blocks: [] },
  ], null, { contentBackgroundColor: '#123456' }));

  assert.match(mjml, /<mj-wrapper background-color="#123456"/i);
  assert.doesNotMatch(
    mjml,
    /<mj-(?:section|column)[^>]*background-color=/i,
    'legacy Columns markup must remain transparent over the content background',
  );
});