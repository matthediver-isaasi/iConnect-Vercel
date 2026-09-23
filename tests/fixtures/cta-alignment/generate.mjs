import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { register } from 'tsx/esm/api';

const directory = dirname(fileURLToPath(import.meta.url));
const environment = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://fixture.example.invalid/',
});
globalThis.window = environment.window;
globalThis.document = environment.window.document;
globalThis.navigator = environment.window.navigator;
globalThis.HTMLElement = environment.window.HTMLElement;
globalThis.Element = environment.window.Element;
globalThis.Node = environment.window.Node;
const unregisterTsx = register({ namespace: 'cta-alignment-fixture' });
const [{ designToHtml }, { BLOCK_TYPES }] = await Promise.all([
  unregisterTsx.import('../../../client/src/components/email-builder/mjmlConverter.js', import.meta.url),
  unregisterTsx.import('../../../client/src/components/email-builder/types.js', import.meta.url),
]);
await unregisterTsx();

const cases = [
  ['left', 'left'],
  ['center', 'center'],
  ['right', 'right'],
  ['missing (defaults centre)', undefined],
  ['invalid (defaults centre)', 'unsupported'],
];

const styles = alignment => ({
  backgroundColor: '#174ea6',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: '700',
  borderRadius: '6px',
  innerPaddingTop: '12',
  innerPaddingRight: '22',
  innerPaddingBottom: '12',
  innerPaddingLeft: '22',
  paddingTop: '8',
  paddingRight: '8',
  paddingBottom: '8',
  paddingLeft: '8',
  ...(alignment === undefined ? {} : { textAlign: alignment }),
});

const button = (id, label, alignment, dynamic = false) => ({
  id,
  type: dynamic ? BLOCK_TYPES.DYNAMIC_BUTTON : BLOCK_TYPES.BUTTON,
  content: label,
  href: `https://example.invalid/cta/${id}`,
  ...(dynamic ? { token: `${id}_text`, linkToken: `${id}_link` } : {}),
  styles: styles(alignment),
});

const blocks = [];
for (const [label, alignment] of cases) {
  const key = label.split(' ')[0];
  blocks.push(button(`top-${key}`, `Top-level ${label}`, alignment));
  blocks.push({
    id: `section-${key}`,
    type: BLOCK_TYPES.SECTION,
    styles: { backgroundColor: '#f2f5fa', paddingTop: '4', paddingRight: '4', paddingBottom: '4', paddingLeft: '4' },
    children: [button(`section-button-${key}`, `Section dynamic ${label}`, alignment, true)],
  });
  blocks.push({
    id: `columns-${key}`,
    type: BLOCK_TYPES.COLUMNS,
    styles: { columnGap: '16px' },
    columns: [
      { id: `column-37-${key}`, width: '37%', blocks: [button(`column-button-${key}`, `37% column ${label}`, alignment)] },
      {
        id: `column-63-${key}`,
        width: '63%',
        blocks: [{
          id: `column-copy-${key}`,
          type: BLOCK_TYPES.TEXT,
          content: 'Sanitized 63% companion column',
          styles: {},
        }],
      },
    ],
  });
}

const html = designToHtml({
  globalStyles: {
    contentWidth: '640px',
    backgroundColor: '#e8edf4',
    contentBackgroundColor: '#ffffff',
  },
  blocks,
});

const parsed = new JSDOM(html);
for (const element of parsed.window.document.querySelectorAll('a, img')) {
  for (const attribute of ['href', 'src']) {
    const value = element.getAttribute(attribute);
    if (value && /^(?:https?:)?\/\//i.test(value) && !value.includes('example.invalid')) {
      throw new Error(`Unexpected remote ${attribute} in sanitized fixture`);
    }
  }
}
if (/<script\b/i.test(html)) throw new Error('Scripts are not permitted in the fixture');
if (/[A-Z0-9._%+-]+@(?!example\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}/i.test(html)) {
  throw new Error('Non-fixture email address found');
}

mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'alignment-matrix.html'), html);
environment.window.close();
console.log(`Wrote sanitized CTA alignment fixture (${Buffer.byteLength(html)} bytes)`);