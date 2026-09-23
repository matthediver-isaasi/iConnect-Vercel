import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { BLOCK_TYPES, resolveButtonStyles } from './types.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
const { designToHtml } = await import('./mjmlConverter.js');

const campaignSource = await readFile(
  new URL('../../../../api/_lib/campaignService.js', import.meta.url),
  'utf8',
);
const converterSource = await readFile(
  new URL('./mjmlConverter.js', import.meta.url),
  'utf8',
);

const sourceBetween = (startMarker, endMarker) => {
  const start = campaignSource.indexOf(startMarker);
  const end = campaignSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `campaign source contains ${startMarker}`);
  assert.notEqual(end, -1, `campaign source contains ${endMarker}`);
  return campaignSource.slice(start, end).replace(/\bexport\s+/g, '');
};

// Exercise the production campaign transformations without importing the API
// module (and therefore without initializing its database or transport imports).
const campaignTransforms = vm.runInNewContext(`
  const APP_DOMAIN = 'example.test';
  const getPublicBaseUrl = () => 'https://example.test';
  const sanitizeSlotHtml = value => value;
  const htmlSlotToPlainText = value => value;
  ${sourceBetween('export function getTenantBaseUrl', 'async function enrichCampaignCounts')}
  ${sourceBetween('export function generateTrackingToken', '// Helper to fetch all members')}
  ${sourceBetween('export function encodeSlotValueForHtml', 'function parseCampaignDesign')}
  ${sourceBetween('const EVENT_QR_BLOCK_RE', 'function buildQrReqFromHost')}
  ({ rewriteLinksForTracking, applyDynamicSlotValues, stripHiddenDynamicRegions });
`, {
  Buffer,
  encodeURIComponent,
  Set,
});

const currentButtonSource = converterSource.slice(
  converterSource.indexOf('const escapeHtml'),
  converterSource.indexOf('const SOCIAL_SVG_PATHS'),
);
const oldButtonSource = currentButtonSource
  .replace(
    /  \/\/ Parent text-align[\s\S]*?  const margin = [^\n]+\n/,
    '',
  )
  .replace(
    ' role="presentation" align="${align}" style="border-collapse:separate;line-height:100%;margin:${margin};"',
    ' role="presentation" style="border-collapse:separate;line-height:100%;"',
  );
const { buttonToMjml: oldButtonToMjml } = vm.runInNewContext(
  `${oldButtonSource}; ({ buttonToMjml });`,
  {
    resolveButtonStyles,
  },
);

const configuredStyles = {
  backgroundColor: '#123456',
  color: '#fedcba',
  fontSize: '18px',
  fontWeight: '700',
  borderRadius: '13px',
  textAlign: 'left',
  innerPaddingTop: '9',
  innerPaddingRight: '27',
  innerPaddingBottom: '11',
  innerPaddingLeft: '25',
  paddingTop: '2',
  paddingRight: '3',
  paddingBottom: '4',
  paddingLeft: '5',
};

const assertClientSafeButton = (html, text) => {
  const parsed = new JSDOM(html);
  const link = [...parsed.window.document.querySelectorAll('a')]
    .find((candidate) => candidate.textContent.trim() === text);
  assert.ok(link, `generated HTML contains the ${text} CTA`);
  const cell = link.closest('td');
  const span = link.querySelector('span');

  assert.match(link.getAttribute('style'), /background-color:#123456\s*!important/i);
  assert.match(link.getAttribute('style'), /color:#fedcba\s*!important/i);
  assert.match(link.getAttribute('style'), /padding:9px 27px 11px 25px/i);
  assert.match(link.getAttribute('style'), /border-radius:13px/i);
  assert.match(span.getAttribute('style'), /color:#fedcba\s*!important/i);
  assert.equal(cell.getAttribute('bgcolor'), '#123456');
  assert.match(cell.getAttribute('style'), /mso-padding-alt:9px 27px 11px 25px/i);
  assert.match(cell.getAttribute('style'), /border-radius:13px/i);
};

test('standalone CTA keeps configured delivery-safe colours, padding, and radius', () => {
  const html = designToHtml({
    blocks: [{ id: 'standalone', type: BLOCK_TYPES.BUTTON, content: 'Standalone CTA', href: 'https://example.com', styles: configuredStyles }],
  });
  assertClientSafeButton(html, 'Standalone CTA');
});

test('regression fixture reproduces the previous intrinsic-width table without positioning', () => {
  assert.notEqual(oldButtonSource, currentButtonSource, 'historical renderer is compiled by source replacement');
  const oldHtml = oldButtonToMjml({
    content: 'Previous unaligned CTA',
    href: 'https://example.invalid/previous',
    styles: configuredStyles,
  });
  const table = new JSDOM(oldHtml).window.document.querySelector('table[role="presentation"]');
  assert.ok(table);
  assert.equal(table.hasAttribute('align'), false);
  assert.doesNotMatch(table.getAttribute('style') || '', /(?:^|;)\s*margin\s*:/i);
});

test('column CTA uses the same delivery-safe markup', () => {
  const html = designToHtml({
    blocks: [{
      id: 'columns',
      type: BLOCK_TYPES.COLUMNS,
      styles: {},
      columns: [{ id: 'column', width: '100%', blocks: [
        { id: 'column-button', type: BLOCK_TYPES.BUTTON, content: 'Column CTA', href: 'https://example.com', styles: configuredStyles },
      ] }],
    }],
  });
  assertClientSafeButton(html, 'Column CTA');
});

test('dynamic CTA preserves tokens and uses the same delivery-safe markup', () => {
  const html = designToHtml({
    blocks: [{
      id: 'dynamic',
      type: BLOCK_TYPES.DYNAMIC_BUTTON,
      token: 'dynamic_cta_text',
      linkToken: 'dynamic_cta_link',
      content: 'Fallback CTA',
      href: 'https://example.com',
      styles: configuredStyles,
    }],
  });
  assertClientSafeButton(html, '{{dynamic_cta_text}}');
  assert.match(html, /href="\{\{dynamic_cta_link\}\}"/);
  assert.match(html, /DYN_BLOCK:START:dynamic_cta_text/);
});

test('legacy partial CTA styles resolve to the same safe defaults used by preview and output', () => {
  const effective = resolveButtonStyles({ backgroundColor: '#654321' });
  assert.deepEqual(effective, {
    backgroundColor: '#654321',
    color: '#ffffff',
    fontFamily: '',
    fontSize: '16px',
    fontWeight: 'bold',
    borderRadius: '4px',
    textAlign: 'center',
    innerPadding: '12px 24px 12px 24px',
    innerPaddingValues: {
      top: '12',
      right: '24',
      bottom: '12',
      left: '24',
    },
  });

  const html = designToHtml({
    blocks: [{ id: 'legacy', type: BLOCK_TYPES.BUTTON, content: 'Legacy CTA', href: '#', styles: { backgroundColor: '#654321' } }],
  });
  const link = [...new JSDOM(html).window.document.querySelectorAll('a')]
    .find((candidate) => candidate.textContent.trim() === 'Legacy CTA');
  assert.match(link.getAttribute('style'), /padding:12px 24px 12px 24px/i);
  assert.match(link.getAttribute('style'), /color:#ffffff\s*!important/i);
  assert.match(link.getAttribute('style'), /border-radius:4px/i);
});

test('legacy CTA with one populated padding side keeps safe defaults for missing sides', () => {
  const effective = resolveButtonStyles({ innerPaddingTop: '20' });
  assert.equal(effective.innerPadding, '20px 24px 12px 24px');
  assert.deepEqual(effective.innerPaddingValues, {
    top: '20',
    right: '24',
    bottom: '12',
    left: '24',
  });
});

const alignmentCases = [
  { key: 'left', value: 'left', expectedAlign: 'left', expectedMargin: '0 auto 0 0' },
  { key: 'center', value: 'center', expectedAlign: 'center', expectedMargin: '0 auto' },
  { key: 'right', value: 'right', expectedAlign: 'right', expectedMargin: '0 0 0 auto' },
  { key: 'missing', value: undefined, expectedAlign: 'center', expectedMargin: '0 auto' },
  { key: 'invalid', value: 'sideways', expectedAlign: 'center', expectedMargin: '0 auto' },
];

const placements = ['top-level', 'section', 'unequal-column'];
const variants = ['static', 'dynamic'];

const matrixButton = (placement, variant, alignment) => {
  const key = `${placement}-${variant}-${alignment.key}`;
  const dynamic = variant === 'dynamic';
  return {
    id: key,
    type: dynamic ? BLOCK_TYPES.DYNAMIC_BUTTON : BLOCK_TYPES.BUTTON,
    content: `CTA ${key}`,
    href: `https://destination.example.invalid/${key}?source=fixture&case=${alignment.key}`,
    ...(dynamic ? {
      token: `${key}-text`,
      linkToken: `${key}-link`,
    } : {}),
    styles: {
      ...configuredStyles,
      ...(alignment.value === undefined ? { textAlign: undefined } : { textAlign: alignment.value }),
    },
  };
};

const matrixBlocks = [];
const matrixEntries = [];
for (const placement of placements) {
  for (const variant of variants) {
    for (const alignment of alignmentCases) {
      const button = matrixButton(placement, variant, alignment);
      matrixEntries.push({ placement, variant, alignment, button });
      if (placement === 'top-level') {
        matrixBlocks.push(button);
      } else if (placement === 'section') {
        matrixBlocks.push({
          id: `section-${button.id}`,
          type: BLOCK_TYPES.SECTION,
          styles: {},
          children: [button],
        });
      } else {
        matrixBlocks.push({
          id: `columns-${button.id}`,
          type: BLOCK_TYPES.COLUMNS,
          styles: { columnGap: '17px' },
          columns: [
            { id: `narrow-${button.id}`, width: '37%', blocks: [button] },
            {
              id: `wide-${button.id}`,
              width: '63%',
              blocks: [{
                id: `copy-${button.id}`,
                type: BLOCK_TYPES.TEXT,
                content: `Unequal companion ${button.id}`,
                styles: {},
              }],
            },
          ],
        });
      }
    }
  }
}

const findCta = (html, text) => [...new JSDOM(html).window.document.querySelectorAll('a')]
  .find(candidate => candidate.textContent.trim() === text);

const assertAlignedCta = (html, text, alignment, expectedHref) => {
  const link = findCta(html, text);
  assert.ok(link, `${text}: CTA is present`);
  const table = link.closest('table[role="presentation"]');
  assert.ok(table, `${text}: CTA uses a presentation table`);
  assert.equal(table.getAttribute('align'), alignment.expectedAlign, `${text}: legacy table alignment`);
  assert.match(
    table.getAttribute('style') || '',
    new RegExp(`(?:^|;)margin\\s*:\\s*${alignment.expectedMargin.replaceAll(' ', '\\s*')}(?:;|$)`, 'i'),
    `${text}: CSS margin fallback`,
  );
  const wrapper = table.parentElement;
  assert.match(
    wrapper?.getAttribute('style') || '',
    new RegExp(`(?:^|;)text-align\\s*:\\s*${alignment.expectedAlign}(?:;|$)`, 'i'),
    `${text}: MJML wrapper uses validated alignment`,
  );
  assert.equal(
    wrapper?.parentElement?.getAttribute('align'),
    alignment.expectedAlign,
    `${text}: MJML wrapper cell uses validated alignment`,
  );
  assert.equal(link.getAttribute('href'), expectedHref, `${text}: link is preserved`);
  assertClientSafeButton(html, text);
};

test('CTA alignment matrix survives generation and pure campaign delivery transformations', () => {
  const generated = designToHtml({
    globalStyles: { contentWidth: '640px' },
    blocks: matrixBlocks,
  });

  const slotValues = {};
  for (const { variant, button } of matrixEntries) {
    if (variant !== 'dynamic') continue;
    slotValues[button.token] = `Delivered ${button.id}`;
    slotValues[button.linkToken] = button.href;
  }

  for (const { placement, variant, alignment, button } of matrixEntries) {
    const generatedText = variant === 'dynamic' ? `{{${button.token}}}` : button.content;
    const generatedHref = variant === 'dynamic' ? `{{${button.linkToken}}}` : button.href;
    assertAlignedCta(generated, generatedText, alignment, generatedHref);
    if (variant === 'dynamic') {
      assert.match(generated, new RegExp(`DYN_BLOCK:START:${button.token}`));
      assert.ok(generated.includes(`{{${button.linkToken}}}`), `${button.id}: dynamic link token survives generation`);
    }
    if (placement === 'unequal-column') {
      assert.match(generated, /mj-column-per-37/i);
      assert.match(generated, /mj-column-per-63/i);
      assert.match(generated, /gmail-hybrid-column/i);
    }
  }

  const visible = campaignTransforms.stripHiddenDynamicRegions(generated, []);
  assert.doesNotMatch(visible, /DYN_BLOCK:(?:START|END)/);
  const personalized = campaignTransforms.applyDynamicSlotValues(visible, slotValues, { html: true });

  for (const { variant, alignment, button } of matrixEntries) {
    const deliveredText = variant === 'dynamic' ? `Delivered ${button.id}` : button.content;
    assertAlignedCta(personalized, deliveredText, alignment, button.href);
  }

  const tracked = campaignTransforms.rewriteLinksForTracking(
    personalized,
    'cta-alignment-campaign',
    'cta-alignment-recipient',
    'fixture',
    'mail.example.test',
  );
  for (const { variant, alignment, button } of matrixEntries) {
    const deliveredText = variant === 'dynamic' ? `Delivered ${button.id}` : button.content;
    const link = findCta(tracked, deliveredText);
    assert.ok(link, `${button.id}: tracked CTA is present`);
    assert.equal(link.closest('table').getAttribute('align'), alignment.expectedAlign);
    assert.match(link.closest('table').getAttribute('style'), new RegExp(`margin:${alignment.expectedMargin.replaceAll(' ', '\\s*')}`));
    assert.match(link.getAttribute('href'), /^https:\/\/mail\.example\.test\/api\/track\/click\?t=/);
    assert.ok(
      link.getAttribute('href').includes(encodeURIComponent(button.href)),
      `${button.id}: tracking URL retains the original destination`,
    );
    assertClientSafeButton(tracked, deliveredText);
  }
});