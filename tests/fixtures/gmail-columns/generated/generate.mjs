import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { BLOCK_TYPES } from '../../../../client/src/components/email-builder/types.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
});

const { designToHtml } = await import('../../../../client/src/components/email-builder/mjmlConverter.js');
const { applyHybridColumnFallback } = await import('../../../../client/src/components/email-builder/hybridColumns.js');
const outputDirectory = dirname(fileURLToPath(import.meta.url));
mkdirSync(outputDirectory, { recursive: true });

const sponsorImage = (label, color) => (
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="96" viewBox="0 0 240 96"><rect width="240" height="96" rx="8" fill="${color}"/><text x="120" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="#ffffff">${label}</text></svg>`,
  )}`
);

const sponsorBlocks = index => [
  {
    id: `image-${index}`,
    type: BLOCK_TYPES.IMAGE,
    src: sponsorImage(`Sponsor ${index + 1}`, ['#8b3a3a', '#286b46', '#3d4f8f'][index]),
    alt: `Sanitized sponsor ${index + 1}`,
    styles: {
      paddingTop: '8',
      paddingRight: '8',
      paddingBottom: '8',
      paddingLeft: '8',
    },
  },
  {
    id: `copy-${index}`,
    type: BLOCK_TYPES.TEXT,
    content: `<p>Sanitized fixture sponsor ${index + 1}</p>`,
    styles: {
      paddingTop: '2',
      paddingRight: '8',
      paddingBottom: '8',
      paddingLeft: '8',
      textAlign: 'center',
    },
  },
  ...(index === 1 ? [{
    id: 'fixture-cta',
    type: BLOCK_TYPES.BUTTON,
    content: 'Fixture action',
    href: '#',
    styles: {
      backgroundColor: '#263b68',
      color: '#ffffff',
      textAlign: 'center',
      paddingTop: '4',
      paddingRight: '8',
      paddingBottom: '12',
      paddingLeft: '8',
    },
  }] : []),
];

const design = {
  globalStyles: { contentWidth: '600px', contentPadding: '16px', contentBackgroundColor: '#ffffff' },
  blocks: [{
    id: 'columns',
    type: BLOCK_TYPES.COLUMNS,
    styles: {
      columnGap: '12px',
      paddingTop: '10',
      paddingRight: '14',
      paddingBottom: '10',
      paddingLeft: '14',
      backgroundColor: '#f3f3f3',
    },
    columns: ['33.333%', '33.333%', '33.334%'].map((width, index) => ({
      id: `column-${index}`,
      width,
      backgroundColor: ['#fff0f0', '#f0fff0', '#f0f0ff'][index],
      blocks: sponsorBlocks(index),
    })),
  }],
};

const footerHtml = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:12px;color:#666666;">Sanitized builder footer</td></tr></table>';
const dataImageNote = '<!-- Fixture images are self-contained data URLs for local browser rendering; Gmail may block data image URLs. -->';

const writeFixture = (basename, subject, sourceHtml, { usesDataImages = false } = {}) => {
  const html = usesDataImages
    ? sourceHtml.replace('</head>', `  ${dataImageNote}\n</head>`)
    : sourceHtml;
  const htmlPath = join(outputDirectory, `${basename}.html`);
  const emlPath = join(outputDirectory, `${basename}.eml`);
  writeFileSync(htmlPath, html);
  writeFileSync(
    emlPath,
    [
      'From: fixture@example.invalid',
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      html,
    ].join('\r\n'),
  );
  console.log(`${basename}.html: ${Buffer.byteLength(html)} decoded HTML bytes`);
  console.log(`${basename}.eml: ${Buffer.byteLength(readFileSync(emlPath))} bytes`);
};

writeFixture(
  'gmail-columns.before',
  'Gmail columns generated baseline',
  designToHtml(design, { footerHtml, hybridColumns: false }),
  { usesDataImages: true },
);
writeFixture(
  'gmail-columns.after',
  'Gmail columns generated candidate',
  designToHtml(design, { footerHtml, hybridColumns: true }),
  { usesDataImages: true },
);

const receivedPath = join(outputDirectory, '..', 'sponsor-columns-received.html');
const received = readFileSync(receivedPath, 'utf8');
const markedReceived = received.replace(
  '<div style="margin:0px auto;max-width:700px;">',
  '<div class="gmail-hybrid-section" style="margin:0px auto;max-width:700px;">',
);
writeFixture(
  'received-columns.before',
  'Received sanitized columns baseline',
  received,
);
writeFixture(
  'received-columns.after',
  'Received sanitized columns candidate',
  applyHybridColumnFallback(markedReceived),
);

console.log('Note: generated sponsor images use data URLs for local rendering; Gmail may block data image URLs.');