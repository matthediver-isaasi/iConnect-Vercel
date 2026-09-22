import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { BLOCK_TYPES } from '../../../../client/src/components/email-builder/types.js';
import { createFixtureImage } from '../fixture-image.mjs';

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
const assetDirectory = join(outputDirectory, 'assets');
mkdirSync(assetDirectory, { recursive: true });
const fixtureImageCid = 'fixture-image@example.invalid';
const fixturePng = createFixtureImage();
writeFileSync(join(assetDirectory, 'fixture-image.png'), fixturePng);

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

const makeDesign = (widths = ['33.333%', '33.333%', '33.334%'], imageSource) => ({
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
    columns: widths.map((width, index) => ({
      id: `column-${index}`,
      width,
      backgroundColor: ['#fff0f0', '#f0fff0', '#f0f0ff'][index],
      blocks: sponsorBlocks(index).map(block => (
        block.type === BLOCK_TYPES.IMAGE && imageSource
          ? { ...block, src: imageSource }
          : block
      )),
    })),
  }],
});
const design = makeDesign();

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

const writeCidFixture = (basename, subject, html) => {
  const htmlPath = join(outputDirectory, `${basename}.html`);
  const emlPath = join(outputDirectory, `${basename}.eml`);
  const boundary = 'fixture-related-boundary';
  writeFileSync(htmlPath, html);
  writeFileSync(emlPath, [
    'From: fixture@example.invalid',
    'To: recipient@example.invalid',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${boundary}`,
    'Content-Type: image/png; name="fixture-image.png"',
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${fixtureImageCid}>`,
    'Content-Disposition: inline; filename="fixture-image.png"',
    '',
    fixturePng.toString('base64').match(/.{1,76}/g).join('\r\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n'));
  console.log(`${basename}.html: ${Buffer.byteLength(html)} decoded HTML bytes`);
  console.log(`${basename}.eml: ${Buffer.byteLength(readFileSync(emlPath))} bytes`);
};

writeFixture(
  'gmail-columns.before',
  'Gmail columns generated baseline',
  designToHtml(design, { footerHtml, hybridColumns: false }),
  { usesDataImages: true },
);

const cidSource = `cid:${fixtureImageCid}`;
const cidGeneratedBaseline = designToHtml(makeDesign(undefined, cidSource), { footerHtml, hybridColumns: false });
const cidGeneratedCandidate = designToHtml(makeDesign(undefined, cidSource), { footerHtml, hybridColumns: true });
writeCidFixture(
  'send-ready-gmail-columns.before',
  'CID generated baseline',
  cidGeneratedBaseline,
);
writeCidFixture(
  'send-ready-gmail-columns.after',
  'CID generated candidate',
  cidGeneratedCandidate,
);

for (const [name, widths, label] of [
  ['gmail-columns-two', ['50%', '50%'], 'equal two-column'],
  ['gmail-columns-60-40', ['60%', '40%'], 'unequal 60/40'],
]) {
  const variant = makeDesign(widths, cidSource);
  writeCidFixture(
    `${name}.before`,
    `CID ${label} baseline`,
    designToHtml(variant, { footerHtml, hybridColumns: false }),
  );
  writeCidFixture(
    `${name}.after`,
    `CID ${label} candidate`,
    designToHtml(variant, { footerHtml, hybridColumns: true }),
  );
}
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

const receivedWithCid = received.replace(/\bsrc=""/g, `src="${cidSource}"`);
const markedReceivedWithCid = receivedWithCid.replace(
  '<div style="margin:0px auto;max-width:700px;">',
  '<div class="gmail-hybrid-section" style="margin:0px auto;max-width:700px;">',
);
writeCidFixture(
  'send-ready-received-columns.before',
  'CID received baseline',
  receivedWithCid,
);
writeCidFixture(
  'send-ready-received-columns.after',
  'CID received candidate',
  applyHybridColumnFallback(markedReceivedWithCid),
);

console.log(`CID mapping: ${fixtureImageCid} -> generated/assets/fixture-image.png`);
console.log('Note: original generated fixtures retain data URLs; send-ready and width variants use a local CID PNG.');