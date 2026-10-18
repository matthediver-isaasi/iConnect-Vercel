import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { buildSalesAgreementPdf } from './salesAgreementDocument.js';
import { buildSalesQuotePdf } from './salesQuotePdf.js';

const fixture = (overrides = {}) => ({
  quote: { quote_number: 'AG-204' },
  version: {
    version_number: 3, status: 'issued', issue_date: '2026-08-01',
    currency: 'GBP', net_minor: 10000, tax_minor: 2000, gross_minor: 12000,
    organisation_snapshot: { name: 'Commercial Customer Limited' },
    address_snapshot: { line1: '19 Commercial Road', city: 'London' },
    sales_quote_line: [{
      description: 'Full commercial service', quantity: 1, net_minor: 10000, gross_minor: 12000,
      sales_quote_bundle_component: [{ quantity: 2, product_snapshot: { name: 'Included workshop' } }],
    }],
    terms_snapshot: { text: 'Payment within thirty days.', legalHtml: '<p>Frozen legal clause.</p>' },
  },
  tenant: { name: 'Agreement Supplier', footer_config: { legalText: 'Registered company 123456' } },
  documentHash: 'abcdef0123456789'.repeat(4),
  ...overrides,
});

async function extract(buffer) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), disableWorker: true,
    standardFontDataUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
  }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push({ text: content.items.map(item => item.str).join(' '), items: content.items,
        annotations: await page.getAnnotations(),
        width: page.view[2], height: page.view[3] });
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

const compact = value => value.replace(/\s+/g, ' ').trim();

test('preserves the commercial quote and appends every frozen legal clause and cancellation table', async () => {
  const input = fixture();
  input.version.terms_snapshot.legalHtml = `
    <h1>Contractual conditions</h1>
    <h2>Cancellation and rescheduling</h2>
    <p>Clause alpha: <strong>binding obligation</strong>, <em>reasonable notice</em>,
      <u>written confirmation</u>, <s>superseded wording</s>, and <a href="https://example.org/policy">policy link text</a>.</p>
    <ol start="3"><li>Third numbered clause<ul><li>Nested exception clause</li></ul></li>
      <li><p>Fourth numbered clause</p><p>Continuation of fourth clause</p></li></ol>
    <table><caption>Cancellation charges</caption><thead><tr><th>Notice period</th><th>Charge payable</th></tr></thead>
      <tbody><tr><td>More than 30 days</td><td>Zero percent</td></tr>
      <tr><td>15 to 30 days</td><td>Fifty percent</td></tr>
      <tr><td>Fewer than 15 days</td><td>One hundred percent</td></tr>
      <tr><td colspan="2"><p>Cancellation must be in writing.</p><p>VAT applies where required.</p></td></tr></tbody></table>
    <h3>Final provision</h3><p>Last legal clause &amp; complete agreement.</p>`;
  const buffer = await buildSalesAgreementPdf(input);
  assert.ok(Buffer.isBuffer(buffer));
  const pages = await extract(buffer);
  assert.ok(pages.length >= 2);
  const commercial = await extract(buildSalesQuotePdf(input));
  assert.deepEqual(pages.slice(0, commercial.length).map(page => page.text), commercial.map(page => page.text));
  const text = compact(pages.map(page => page.text).join(' '));
  for (const value of [
    'AG-204', 'Full commercial service', 'Included workshop', 'Payment within thirty days.',
    'Registered company 123456', 'Contractual conditions', 'Cancellation and rescheduling',
    'Clause alpha:', 'binding obligation', 'reasonable notice', 'written confirmation',
    'superseded wording', 'policy link text', '3.', 'Third numbered clause',
    'Nested exception clause', '4.', 'Fourth numbered clause', 'Continuation of fourth clause',
    'Cancellation charges', 'Notice period', 'Charge payable', 'More than 30 days', 'Zero percent',
    '15 to 30 days', 'Fifty percent', 'Fewer than 15 days', 'One hundred percent',
    'Cancellation must be in writing.', 'VAT applies where required.', 'Final provision',
    'Last legal clause & complete agreement.', 'Sender signature', 'Customer signature', input.documentHash,
  ]) assert.ok(text.includes(value), `Missing PDF text: ${value}`);
  assert.equal((text.match(/Status: Pending signature/g) || []).length, 2);
  assert.ok(!text.includes('Status: Signed'));
  assert.ok(pages.flatMap(page => page.annotations).some(annotation => annotation.url === 'https://example.org/policy'));
  const legalItems = pages.slice(commercial.length).flatMap(page => page.items);
  const bold = legalItems.find(item => item.str.includes('binding obligation'));
  const italic = legalItems.find(item => item.str.includes('reasonable notice'));
  const normal = legalItems.find(item => item.str.includes('written confirmation'));
  assert.ok(bold && italic && normal);
  assert.notEqual(bold.fontName, italic.fontName);
  assert.notEqual(bold.fontName, normal.fontName);
  assert.notEqual(italic.fontName, normal.fontName);
});

test('very long paragraphs and table rows paginate without dropping or clipping any content', async () => {
  const input = fixture();
  const clauses = Array.from({ length: 100 }, (_, i) => `Provision-${i}: this complete provision must remain readable.`);
  const cellClauses = Array.from({ length: 190 }, (_, i) => `Cell-clause-${i} requires written notice.`);
  const rows = Array.from({ length: 70 }, (_, i) => `<tr><td>Deadline-${i}</td><td>Charge-${i}</td></tr>`).join('');
  const longToken = 'LongUnbrokenContractReference'.repeat(40);
  input.version.terms_snapshot.legalHtml = `
    <h1>Long legal document</h1><p>${clauses.join(' ')}</p>
    <table><tr><th>Notice</th><th>Cancellation consequence</th></tr>${rows}
      <tr><td>Oversized row starts here</td><td>${cellClauses.join(' ')}</td></tr>
      <tr><td>Final table row</td><td>Final table condition</td></tr></table>
    <p>${longToken}</p><p>End of all legal terms.</p>`;
  const pages = await extract(await buildSalesAgreementPdf(input));
  assert.ok(pages.length > 7, 'Expected a genuinely multi-page agreement');
  const text = compact(pages.map(page => page.text).join(' '));
  for (const clause of clauses) assert.ok(text.includes(clause), clause);
  for (const clause of cellClauses) assert.ok(text.includes(clause), clause);
  for (let i = 0; i < 70; i++) {
    assert.ok(text.includes(`Deadline-${i}`));
    assert.ok(text.includes(`Charge-${i}`));
  }
  assert.ok(text.replace(/\s/g, '').includes(longToken));
  assert.ok(text.includes('Final table condition'));
  assert.ok(text.includes('End of all legal terms.'));
  // The commercial PDF is an unchanged dependency. Inspect the new appendix:
  // every text baseline and measured right edge remains inside the page.
  const commercialPages = (await PDFDocument.load(buildSalesQuotePdf(input))).getPageCount();
  for (const page of pages.slice(commercialPages)) {
    for (const item of page.items) {
      if (!item.str.trim()) continue;
      const [,,,, x, y] = item.transform;
      assert.ok(y > 35 && y < page.height - 25, `Text clipped vertically: ${item.str}`);
      assert.ok(x >= 45 && x + item.width < page.width - 40, `Text clipped horizontally: ${item.str}`);
    }
  }
});

test('renders both signed identities, typed name, safe drawn PNG, timestamps and hash', async () => {
  const png = await sharp({ create: { width: 100, height: 30, channels: 4, background: '#183557' } }).png().toBuffer();
  const input = fixture({
    sender: { name: 'Sender Person', role: 'Director', organization: 'Supplier Organization',
      email: 'sender@example.org', signature: { mode: 'drawn', data: `data:image/png;base64,${png.toString('base64')}` },
      signedAt: '2026-08-10T11:30:00Z' },
    customer: { name: 'Customer Person', role: 'Purchasing Lead', organization: 'Customer Organization',
      email: 'customer@example.org', signature: { mode: 'typed', typedName: 'Customer Signatory' },
      signedAt: '2026-08-11T12:45:00Z' },
  });
  const buffer = await buildSalesAgreementPdf(input);
  const pages = await extract(buffer);
  const text = compact(pages.map(page => page.text).join(' '));
  for (const value of ['Sender signature', 'Sender Person', 'Director', 'Supplier Organization', 'sender@example.org',
    'Customer signature', 'Customer Person', 'Purchasing Lead', 'Customer Organization', 'customer@example.org',
    'Typed signature: Customer Signatory', '2026-08-10T11:30:00.000Z', '2026-08-11T12:45:00.000Z', input.documentHash]) {
    assert.ok(text.includes(value), value);
  }
  assert.equal((text.match(/Status: Signed/g) || []).length, 2);
  assert.ok(!text.includes('Pending signature'));
  const document = await PDFDocument.load(buffer);
  assert.ok(document.getPages().slice(1).some(page =>
    (page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length || 0) > 0),
  'Expected the drawn signature to be embedded as a PDF image');
});

test('a timestamp alone, an empty signature or an undated signature never claims signing', async () => {
  for (const sender of [
    { name: 'Not signed', signedAt: '2026-08-10T11:30:00Z' },
    { name: 'Not signed', signature: {}, signedAt: '2026-08-10T11:30:00Z' },
    { name: 'Not signed', signature: { mode: 'drawn', data: '' }, signedAt: '2026-08-10T11:30:00Z' },
    { name: 'Not signed', signature: { mode: 'typed', typedName: 'Not signed' } },
  ]) {
    const text = (await extract(await buildSalesAgreementPdf(fixture({ sender })))).map(page => page.text).join(' ');
    assert.equal((text.match(/Status: Pending signature/g) || []).length, 2);
    assert.ok(!text.includes('Status: Signed'));
    assert.ok(!text.includes('Signed at (UTC)'));
  }
});

test('spanning and unusually wide tables retain all cell contents within page bounds', async () => {
  const input = fixture();
  const wideCells = Array.from({ length: 30 }, (_, i) =>
    `<td>Wide-column-${i}: ${'unbroken-reference-'.repeat(15)}</td>`);
  input.version.terms_snapshot.legalHtml = `
    <table><tr><th rowspan="2">Shared notice period</th><th>Charge A</th><th>Charge B</th></tr>
      <tr><td>First payable value</td><td>Second payable value</td></tr>
      <tr><td colspan="3">Entire width provision</td></tr></table>
    <table><tr>${wideCells.join('')}</tr></table><p>All tables complete.</p>`;
  const pages = await extract(await buildSalesAgreementPdf(input));
  const text = compact(pages.map(page => page.text).join(' '));
  for (const value of ['Shared notice period', 'First payable value', 'Second payable value',
    'Entire width provision', 'All tables complete.']) assert.ok(text.includes(value), value);
  for (let i = 0; i < 30; i++) assert.ok(text.includes(`Wide-column-${i}:`));
  for (const page of pages.slice(1)) {
    for (const item of page.items.filter(item => item.str.trim())) {
      assert.ok(item.transform[4] + item.width < page.width - 40, item.str);
      assert.ok(item.transform[5] > 35, item.str);
    }
  }
});

test('rejects remote, non-PNG, malformed, corrupt and oversized signature images without fetching', async () => {
  const badData = [
    'https://example.org/signature.png',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/jpeg;base64,/9j/2Q==',
    'data:image/png;base64,not base64!',
    'data:image/png;base64,aGVsbG8=',
    `data:image/png;base64,${Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64')}`,
    `data:image/png;base64,${'A'.repeat(2800000)}`,
  ];
  for (const data of badData) {
    await assert.rejects(buildSalesAgreementPdf(fixture({
      sender: { signature: { mode: 'drawn', data }, signedAt: '2026-08-01T00:00:00Z' },
    })), /Sender signature.*(PNG|image)/);
  }
  const excessivePixels = await sharp({
    create: { width: 2001, height: 2000, channels: 3, background: '#ffffff' },
  }).png().toBuffer();
  await assert.rejects(buildSalesAgreementPdf(fixture({
    customer: { signature: { mode: 'drawn', data: `data:image/png;base64,${excessivePixels.toString('base64')}` },
      signedAt: '2026-08-01T00:00:00Z' },
  })), /Customer signature.*oversized PNG/);
});

test('ignores active HTML and remote images but retains safe visible link text', async () => {
  const input = fixture();
  input.version.terms_snapshot.legalHtml = `
    <script>EXECUTABLE_SCRIPT</script><style>HIDDEN_STYLE</style>
    <iframe src="https://example.org">IFRAME_PAYLOAD</iframe>
    <img src="http://127.0.0.1/private.png">
    <p>Visible clause <a href="javascript:alert(1)">Visible unsafe-link label</a>
    and <a href="https://example.org/legal">Safe policy label</a>.</p>`;
  const pages = await extract(await buildSalesAgreementPdf(input));
  const text = pages.map(page => page.text).join(' ');
  assert.ok(text.includes('Visible clause'));
  assert.ok(text.includes('Visible unsafe-link label'));
  assert.ok(text.includes('Safe policy label'));
  assert.ok(!text.includes('EXECUTABLE_SCRIPT'));
  assert.ok(!text.includes('HIDDEN_STYLE'));
  assert.ok(!text.includes('IFRAME_PAYLOAD'));
  const links = pages.flatMap(page => page.annotations).filter(annotation => annotation.subtype === 'Link');
  assert.ok(links.some(link => link.url === 'https://example.org/legal'));
  assert.ok(!links.some(link => /javascript:/i.test(link.url || link.unsafeUrl || '')));
});

test('invalid signature mode, date and legal HTML surface explicit errors', async () => {
  await assert.rejects(buildSalesAgreementPdf(fixture({ sender: { signature: { mode: 'external' } } })), /signature mode/);
  await assert.rejects(buildSalesAgreementPdf(fixture({
    customer: { signature: { mode: 'typed', typedName: 'Name' }, signedAt: 'not-a-date' },
  })), /signedAt is invalid/);
  const input = fixture();
  input.version.terms_snapshot.legalHtml = {};
  await assert.rejects(buildSalesAgreementPdf(input), /legalHtml must be a string/);
});
