import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { BLOCK_TYPES } from './types.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;

const { designToHtml } = await import('./mjmlConverter.js');
const { applyHybridColumnFallback } = await import('./hybridColumns.js');

const launchChromium = async (t) => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    t.skip('Playwright is not installed');
    return null;
  }

  const pathChromium = String(process.env.PATH || '')
    .split(':')
    .map(directory => join(directory, 'chromium'))
    .find(existsSync);
  const executables = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    pathChromium,
    undefined,
  ].filter((value, index, values) => values.indexOf(value) === index);
  for (const executablePath of executables) {
    try {
      return await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
    } catch {
      // Try the environment-supported binary, then Playwright's bundled one.
    }
  }
  t.skip('No runnable Chromium binary is available');
  return null;
};

const removeStylesheets = page => page.evaluate(() => {
  document.querySelectorAll('style, link[rel~="stylesheet"]').forEach(node => node.remove());
});

const text = (id, content) => ({
  id,
  type: BLOCK_TYPES.TEXT,
  content,
  styles: { paddingTop: '4', paddingRight: '4', paddingBottom: '4', paddingLeft: '4' },
});

const nestedBlocks = index => [
  text(`text-${index}`, `Column ${index + 1}`),
  ...(index === 0 ? [{
    id: 'local-image',
    type: BLOCK_TYPES.IMAGE,
    src: 'cid:fixture-image',
    alt: 'Fixture image',
    styles: { paddingTop: '2', paddingRight: '3', paddingBottom: '2', paddingLeft: '3' },
  }] : []),
  ...(index === 1 ? [{
    id: 'fixture-button',
    type: BLOCK_TYPES.BUTTON,
    content: 'Fixture action',
    href: 'https://example.invalid/action',
    styles: {
      backgroundColor: '#123456',
      color: '#ffffff',
      paddingTop: '3',
      paddingRight: '4',
      paddingBottom: '3',
      paddingLeft: '4',
    },
  }] : []),
];

const columnsDesign = ({
  width = 600,
  columnWidths = ['33.333%', '33.333%', '33.334%'],
} = {}) => ({
  globalStyles: {
    contentWidth: `${width}px`,
    contentPadding: '12px 18px 16px 18px',
    backgroundColor: '#e7e7e7',
    contentBackgroundColor: '#ffffff',
  },
  blocks: [{
    id: 'generated-columns',
    type: BLOCK_TYPES.COLUMNS,
    styles: {
      columnGap: '12px',
      paddingTop: '9',
      paddingRight: '14',
      paddingBottom: '11',
      paddingLeft: '16',
      backgroundColor: '#f5f5f5',
    },
    columns: columnWidths.map((columnWidth, index) => ({
      id: `column-${index}`,
      width: columnWidth,
      backgroundColor: ['#ffecec', '#ecffec', '#ececff'][index],
      blocks: nestedBlocks(index),
    })),
  }],
});

const msoComments = html => html.match(/<!--\[if[\s\S]*?<!\[endif\]-->/g) || [];

test('hybrid Columns is explicitly gated and option-off output is byte-equivalent', () => {
  const design = columnsDesign();
  const baseline = designToHtml(design);
  const explicitOff = designToHtml(design, { hybridColumns: false });
  const corrected = designToHtml(design, { hybridColumns: true });

  assert.equal(explicitOff, baseline);
  assert.doesNotMatch(baseline, /gmail-hybrid-column|HYBRID_COLUMNS/);
  assert.match(corrected, /@media only screen and \(max-width:479px\)/);
  assert.doesNotMatch(corrected, /HYBRID_COLUMNS/);
});

test('candidate preserves every conditional MSO block byte-for-byte', () => {
  for (const width of [500, 600, 700]) {
    const design = columnsDesign({ width, columnWidths: ['28%', '72%'] });
    assert.deepEqual(
      msoComments(designToHtml(design, { hybridColumns: true })),
      msoComments(designToHtml(design)),
    );
  }
});

test('candidate uses Outlook-computed pixel bounds while retaining desktop percentage CSS', () => {
  for (const [width, columnWidths] of [
    [500, ['50%', '50%']],
    [600, ['33.333%', '33.333%', '33.334%']],
    [700, ['25%', '75%']],
  ]) {
    const html = designToHtml(columnsDesign({ width, columnWidths }), { hybridColumns: true });
    const parsed = new JSDOM(html);
    const candidates = [...parsed.window.document.querySelectorAll('.gmail-hybrid-column')];
    assert.equal(candidates.length, columnWidths.length);
    for (const [index, candidate] of candidates.entries()) {
      assert.match(candidate.getAttribute('style'), /width:100%/);
      assert.match(candidate.getAttribute('style'), /max-width:[0-9.]+px/);
      const classSuffix = columnWidths[index].replace('%', '').replace('.', '-');
      assert.ok(
        html.includes(`.mj-column-per-${classSuffix} { width:${columnWidths[index]} !important;`),
        `desktop percentage rule remains for ${columnWidths[index]}`,
      );
    }
  }
});

test('hybrid correction remains scoped with images, buttons, backgrounds, padding, and footer', () => {
  const footerHtml = '<table role="presentation"><tr><td>Local fixture footer</td></tr></table>';
  const baseline = designToHtml(columnsDesign({ columnWidths: ['50%', '50%'] }), { footerHtml });
  const candidate = designToHtml(
    columnsDesign({ columnWidths: ['50%', '50%'] }),
    { footerHtml, hybridColumns: true },
  );
  assert.match(candidate, /cid:fixture-image/);
  assert.match(candidate, /Fixture action/);
  assert.match(candidate, /Local fixture footer/);
  assert.equal(
    new JSDOM(candidate).window.document.querySelectorAll('.gmail-hybrid-column').length,
    2,
  );
  assert.deepEqual(msoComments(candidate), msoComments(baseline));
});

test('received sponsor fixture reproduces CSS-free stacking and accepts the bounded candidate', () => {
  const fixtureUrl = new URL('../../../../tests/fixtures/gmail-columns/sponsor-columns-received.html', import.meta.url);
  const received = readFileSync(fixtureUrl, 'utf8');
  const receivedDom = new JSDOM(received);
  const receivedColumns = [...receivedDom.window.document.querySelectorAll('.mj-column-per-33')];
  assert.equal(receivedColumns.length, 3);
  for (const column of receivedColumns) {
    assert.match(column.getAttribute('style'), /width:100%/);
    assert.doesNotMatch(column.getAttribute('style'), /max-width/);
  }

  const marked = received.replace(
    '<div style="margin:0px auto;max-width:700px;">',
    '<div class="gmail-hybrid-section" style="margin:0px auto;max-width:700px;">',
  );
  const candidate = applyHybridColumnFallback(marked);
  const candidateDom = new JSDOM(candidate);
  const candidateColumns = [...candidateDom.window.document.querySelectorAll('.gmail-hybrid-column')];
  assert.equal(candidateColumns.length, 3);
  candidateColumns.forEach(column => assert.match(column.getAttribute('style'), /max-width:231px/));
  assert.deepEqual(msoComments(candidate), msoComments(received));
});

test('optional Chromium layout: mobile stacks and CSS-free desktop remains side-by-side', async (t) => {
  const browser = await launchChromium(t);
  if (!browser) return;
  t.after(() => browser.close());
  const matrix = [
    { canvas: 500, widths: ['33.333%', '33.333%', '33.334%'], label: 'equal-3' },
    { canvas: 600, widths: ['50%', '50%'], label: 'equal-2' },
    { canvas: 700, widths: ['60%', '40%'], label: 'unequal-60-40' },
  ];

  for (const scenario of matrix) {
    const html = designToHtml(
      columnsDesign({ width: scenario.canvas, columnWidths: scenario.widths }),
      {
        hybridColumns: true,
        footerHtml: '<table role="presentation"><tr><td>Fixture footer</td></tr></table>',
      },
    );
    const desktopWidth = scenario.canvas + 100;
    for (const viewportWidth of [320, 375, 479, 480, 481, desktopWidth]) {
      for (const cssEnabled of [true, false]) {
        const page = await browser.newPage({ viewport: { width: viewportWidth, height: 900 } });
        await page.setContent(html);
        if (!cssEnabled) await removeStylesheets(page);

        const layout = await page.evaluate(() => {
          const rect = element => element.getBoundingClientRect().toJSON();
          return {
            scrollWidth: document.documentElement.scrollWidth,
            columns: [...document.querySelectorAll('.gmail-hybrid-column')].map(rect),
            content: [...document.querySelectorAll('.gmail-hybrid-column td, .gmail-hybrid-column a, .gmail-hybrid-column img')].map(rect),
          };
        });
        const context = `${scenario.label}, ${scenario.canvas}px canvas, ${viewportWidth}px viewport, CSS ${cssEnabled ? 'on' : 'off'}`;
        assert.ok(layout.scrollWidth <= viewportWidth, `${context}: no horizontal document overflow`);
        for (const box of [...layout.columns, ...layout.content]) {
          assert.ok(box.left >= -1, `${context}: content left bound`);
          assert.ok(box.right <= viewportWidth + 1, `${context}: CTA/content right bound`);
        }
        if (cssEnabled && viewportWidth <= 479) {
          assert.ok(layout.columns[1].top >= layout.columns[0].bottom - 1, `${context}: mobile stacks`);
        }
        if (cssEnabled && viewportWidth >= 480) {
          assert.ok(Math.abs(layout.columns[0].top - layout.columns.at(-1).top) < 1, `${context}: desktop media widths align`);
        }
        if (!cssEnabled && viewportWidth === desktopWidth) {
          assert.ok(Math.abs(layout.columns[0].top - layout.columns.at(-1).top) < 1, `${context}: pixel bounds align`);
        }
        if (!cssEnabled && viewportWidth === 320 && layout.columns.length === 3) {
          assert.ok(layout.columns.some((box, index) => index > 0 && box.top > layout.columns[index - 1].top), `${context}: narrow columns wrap`);
        }
        await page.close();
      }
    }
  }
});

test('optional Chromium received-fixture regression: CSS-off desktop stacking is corrected', async (t) => {
  const browser = await launchChromium(t);
  if (!browser) return;
  t.after(() => browser.close());

  const fixtureUrl = new URL('../../../../tests/fixtures/gmail-columns/sponsor-columns-received.html', import.meta.url);
  const received = readFileSync(fixtureUrl, 'utf8');
  const candidate = applyHybridColumnFallback(received.replace(
    '<div style="margin:0px auto;max-width:700px;">',
    '<div class="gmail-hybrid-section" style="margin:0px auto;max-width:700px;">',
  ));

  const positions = async (html, width, cssEnabled) => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent(html);
    if (!cssEnabled) await removeStylesheets(page);
    const boxes = await page.locator('.mj-column-per-33').evaluateAll(elements => (
      elements.map(element => element.getBoundingClientRect().toJSON())
    ));
    await page.close();
    return boxes;
  };

  const baselineCssOff = await positions(received, 900, false);
  assert.ok(baselineCssOff[1].top >= baselineCssOff[0].bottom - 1, 'received CSS-off desktop stacks');
  const candidateCssOff = await positions(candidate, 900, false);
  assert.ok(Math.abs(candidateCssOff[0].top - candidateCssOff[2].top) < 1, 'candidate CSS-off desktop is side-by-side');
  const candidateMobile = await positions(candidate, 375, true);
  assert.ok(candidateMobile[1].top >= candidateMobile[0].bottom - 1, 'candidate mobile remains stacked');
});