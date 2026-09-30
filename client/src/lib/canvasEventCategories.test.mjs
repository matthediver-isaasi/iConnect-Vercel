import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';

import {
  ALL_EVENT_CATEGORIES,
  getCanvasEventCategories,
  getCanvasEventCategoryOptions,
  matchesCanvasEventCategory,
  resolveCanvasEventCategory,
} from './canvasEventCategories.js';

const dynamicBlocks = readFileSync(
  new URL('../components/canvas/blocks/dynamicBlocks.jsx', import.meta.url),
  'utf8',
);

function extractFunction(name) {
  const start = dynamicBlocks.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const parametersEnd = dynamicBlocks.indexOf(')', start);
  const bodyStart = dynamicBlocks.indexOf('{', parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < dynamicBlocks.length; index += 1) {
    if (dynamicBlocks[index] === '{') depth += 1;
    if (dynamicBlocks[index] === '}') depth -= 1;
    if (depth === 0) return dynamicBlocks.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const filterAndSortEvents = new Function(
  'resolveCanvasEventCategory',
  'matchesCanvasEventCategory',
  `${extractFunction('filterAndSortEvents')}; return filterAndSortEvents;`,
)(resolveCanvasEventCategory, matchesCanvasEventCategory);

const definitions = [
  {
    id: 'format',
    name: 'Format',
    is_active: true,
    applies_to_content_types: ['Events'],
    subcategories: ['Conference', 'Shared'],
  },
  {
    id: 'topic',
    name: 'Topic',
    is_active: true,
    applies_to_content_types: ['Articles', 'Events'],
    subcategories: ['Shared', 'Leadership'],
  },
];
const categories = getCanvasEventCategories(definitions);

test('only active Events definitions with usable subcategories are exposed', () => {
  const result = getCanvasEventCategories([
    null,
    { id: 'inactive', name: 'Inactive', is_active: false, applies_to_content_types: ['Events'], subcategories: ['A'] },
    { id: 'wrong-type', name: 'Article', is_active: true, applies_to_content_types: ['Articles'], subcategories: ['A'] },
    { id: 42, name: 'Numeric ID', is_active: true, applies_to_content_types: ['Events'], subcategories: ['A'] },
    { id: 'no-types', name: 'No types', is_active: true, subcategories: ['A'] },
    { id: 'not-array', name: 'Bad subs', is_active: true, applies_to_content_types: ['Events'], subcategories: 'A' },
    { id: 'empty', name: 'Empty', is_active: true, applies_to_content_types: ['Events'], subcategories: [null, '', '   ', 7] },
    { id: 'valid', name: 'Valid', is_active: true, applies_to_content_types: ['Events'], subcategories: ['Good', '', null] },
  ]);

  assert.deepEqual(result.map(({ id, subcategories }) => ({ id, subcategories })), [
    { id: 'valid', subcategories: ['Good'] },
  ]);
  assert.deepEqual(getCanvasEventCategories(null), []);
  assert.deepEqual(getCanvasEventCategories({}), []);
});

test('dropdown starts with All sentinel and disambiguates duplicate labels', () => {
  assert.deepEqual(getCanvasEventCategoryOptions(categories), [
    { value: ALL_EVENT_CATEGORIES, label: 'All categories' },
    { value: 'format::Conference', label: 'Format — Conference' },
    { value: 'format::Shared', label: 'Format — Shared' },
    { value: 'topic::Shared', label: 'Topic — Shared' },
    { value: 'topic::Leadership', label: 'Topic — Leadership' },
  ]);
});

test('legacy labels resolve deterministically while composite selections retain their category', () => {
  assert.equal(resolveCanvasEventCategory('Conference', categories), 'format::Conference');
  assert.equal(resolveCanvasEventCategory('Shared', categories), 'format::Shared');
  assert.equal(resolveCanvasEventCategory('topic::Shared', categories), 'topic::Shared');
  assert.equal(resolveCanvasEventCategory('missing::Shared', categories), '');
});

test('empty, All, stale, malformed, or definition-unavailable selections leave events unfiltered', () => {
  const events = [
    { id: 'one', start_date: '2024-01-01', filter_tags: ['format::Conference'] },
    { id: 'two', start_date: '2024-01-02', filter_tags: [] },
  ];
  const base = { filter: 'all', showPast: true };

  for (const category of ['', ALL_EVENT_CATEGORIES, 'deleted::Value', null, 12]) {
    assert.deepEqual(
      filterAndSortEvents(events, { ...base, category }, categories).map((event) => event.id),
      ['one', 'two'],
    );
  }
  assert.deepEqual(
    filterAndSortEvents(events, { ...base, category: 'format::Conference' }, []).map((event) => event.id),
    ['one', 'two'],
  );
});

test('renderer filtering reads canonical filter_tags only, never similarly named aliases', () => {
  const events = [
    { id: 'canonical', start_date: '2024-01-01', filter_tags: ['topic::Shared'] },
    { id: 'legacy-tag', start_date: '2024-01-02', filter_tags: ['Shared'] },
    { id: 'category-alias', start_date: '2024-01-03', category: 'topic::Shared' },
    { id: 'type-alias', start_date: '2024-01-04', event_type: 'topic::Shared' },
    { id: 'tags-alias', start_date: '2024-01-05', tags: ['topic::Shared'] },
    { id: 'malformed-tags', start_date: '2024-01-06', filter_tags: 'topic::Shared' },
  ];
  const content = { filter: 'all', showPast: true, category: 'topic::Shared' };

  assert.deepEqual(
    filterAndSortEvents(events, content, categories).map((event) => event.id),
    ['canonical'],
  );
  assert.equal(matchesCanvasEventCategory(events[1], 'format::Shared', categories), true);
});

test('composite selection survives save/reload and editor/public use the same filtering path', () => {
  const savedBlock = JSON.parse(JSON.stringify({
    id: 'events',
    content: {
      filter: 'all',
      showPast: true,
      category: 'topic::Shared',
    },
  }));
  const events = [
    { id: 'format', start_date: '2024-01-01', filter_tags: ['format::Shared'] },
    { id: 'topic', start_date: '2024-01-02', filter_tags: ['topic::Shared'] },
  ];

  const publicItems = filterAndSortEvents(events, savedBlock.content, categories);
  const editorItems = filterAndSortEvents(events, savedBlock.content, categories);
  assert.equal(savedBlock.content.category, 'topic::Shared');
  assert.deepEqual(publicItems.map(({ id }) => id), ['topic']);
  assert.deepEqual(editorItems, publicItems);
  assert.match(dynamicBlocks, /const items = useMemo\(\(\) => filterAndSortEvents\(data, c, categories\)/);
  assert.match(dynamicBlocks, /Editor: \(props\) => <EventListRender \{\.\.\.props\} asEditor \/>/);
  assert.match(dynamicBlocks, /Renderer: EventListRender/);
});

test('actual inspector selector onChange saves composite values and clears the All sentinel', async (t) => {
  const inspectorSource = extractFunction('EventListInspector');
  const rendererSource = extractFunction('EventListRender');
  const runtimeFilterSource = extractFunction('filterAndSortEvents');
  const output = join(tmpdir(), `canvas-event-inspector-${process.pid}-${Date.now()}.cjs`);
  t.after(() => rmSync(output, { force: true }));

  buildSync({
    stdin: {
      loader: 'jsx',
      resolveDir: process.cwd(),
      sourcefile: 'extracted-event-list-inspector.jsx',
      contents: `
        import React, { useMemo } from 'react';
        import { createRoot } from 'react-dom/client';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { act } from 'react';
        import {
          ALL_EVENT_CATEGORIES,
          getCanvasEventCategoryOptions,
          matchesCanvasEventCategory,
          resolveCanvasEventCategory,
        } from ${JSON.stringify(new URL('./canvasEventCategories.js', import.meta.url).pathname)};
        let testCategories = [];
        let testEvents = [];
        function useEventListCategories() {
          return { categories: testCategories, isLoading: false, isError: false };
        }
        function useQuery() {
          return { data: testEvents, isLoading: false, isError: false };
        }
        function SelectField({ value, onChange, options, testId }) {
          return <select data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>;
        }
        function TextField() { return null; }
        function ToggleField() { return null; }
        function NumberField() { return null; }
        function PerBreakpointColumns() { return null; }
        function columnsForBreakpoint() { return 1; }
        function isEditorPreviewBreakpoint() { return true; }
        function buildResponsiveListGridCss() { return ''; }
        function gridStyle() { return {}; }
        function formatDate(value) { return value; }
        function Heading({ children }) { return <h2>{children}</h2>; }
        function ListSkeleton() { return <div>Loading</div>; }
        function ErrorState() { return <div>Error</div>; }
        function EmptyState() { return <div>Empty</div>; }
        function Calendar() { return <span />; }
        function MapPin() { return <span />; }
        function ArrowRight() { return <span />; }
        ${runtimeFilterSource}
        ${rendererSource}
        ${inspectorSource}
        export function mount(container, categories, block, update) {
          testCategories = categories;
          const root = createRoot(container);
          act(() => root.render(<EventListInspector block={block} update={update} />));
          return root;
        }
        export function change(select, value) {
          act(() => {
            select.value = value;
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
          });
        }
        export function unmount(root) {
          act(() => root.unmount());
        }
        export function renderFixture(categories, events, block, asEditor) {
          testCategories = categories;
          testEvents = events;
          return renderToStaticMarkup(
            <EventListRender block={block} breakpoint="desktop" asEditor={asEditor} />
          );
        }
      `,
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });

  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.navigator = previous.navigator;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    dom.window.close();
  });

  const require = createRequire(import.meta.url);
  const harness = require(output);
  let block = { content: { category: '' } };
  const updates = [];
  const update = (producer) => {
    block = producer(block);
    updates.push(block.content.category);
  };
  const root = harness.mount(dom.window.document.querySelector('#root'), categories, block, update);
  const selector = dom.window.document.querySelector('[data-testid="select-event-list-category"]');

  assert.ok(selector);
  assert.equal(selector.value, ALL_EVENT_CATEGORIES);
  assert.deepEqual(
    [...selector.options].map((option) => [option.value, option.textContent]),
    getCanvasEventCategoryOptions(categories).map((option) => [option.value, option.label]),
  );
  harness.change(selector, 'topic::Shared');
  harness.change(selector, ALL_EVENT_CATEGORIES);
  assert.deepEqual(updates, ['topic::Shared', '']);

  const renderBlock = {
    id: 'event-list-fixture',
    content: {
      title: 'Selected events',
      filter: 'all',
      showPast: true,
      category: 'topic::Shared',
    },
  };
  const renderEvents = [
    { id: 'wrong', slug: 'wrong-event', title: 'Wrong category', start_date: '2024-01-01', filter_tags: ['format::Shared'] },
    { id: 'right', slug: 'right-event', title: 'Right category', start_date: '2024-01-02', filter_tags: ['topic::Shared'] },
  ];
  const editorHtml = harness.renderFixture(categories, renderEvents, renderBlock, true);
  const publicHtml = harness.renderFixture(categories, renderEvents, renderBlock, false);
  for (const html of [editorHtml, publicHtml]) {
    assert.match(html, /Right category/);
    assert.doesNotMatch(html, /Wrong category/);
  }
  assert.doesNotMatch(editorHtml, /href=/);
  assert.match(publicHtml, /href="\/Events\/right-event"/);
  harness.unmount(root);
});