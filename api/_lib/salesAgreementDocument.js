import { jsPDF } from 'jspdf';
import { PDFDocument } from 'pdf-lib';
import { parseFragment } from 'parse5';
import sharp from 'sharp';
import { buildSalesQuotePdf } from './salesQuotePdf.js';
import { toWinAnsi } from './pdfWinAnsi.js';

const MARGIN = 18;
const TOP = 22;
const BOTTOM = 277;
const IGNORED = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'img']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'hr', 'dl', 'dt', 'dd']);
const clean = value => toWinAnsi(String(value ?? ''));
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const children = node => node.childNodes || [];

function font(doc, style = {}) {
  doc.setFont('helvetica', style.bold ? (style.italic ? 'bolditalic' : 'bold') : (style.italic ? 'italic' : 'normal'));
  doc.setFontSize(style.size || 10);
}

function inlineRuns(node, style = {}) {
  if (node.nodeName === '#text') return [{ text: clean(node.value).replace(/\s+/g, ' '), ...style }];
  const tag = node.tagName;
  if (IGNORED.has(tag)) return [];
  if (tag === 'br') return [{ text: '\n', ...style }];
  const next = { ...style };
  if (['strong', 'b', 'th'].includes(tag)) next.bold = true;
  if (['em', 'i'].includes(tag)) next.italic = true;
  if (tag === 'u') next.underline = true;
  if (['s', 'strike', 'del'].includes(tag)) next.strike = true;
  if (['sup', 'sub'].includes(tag)) next.size = Math.max(7, (style.size || 10) - 2);
  if (tag === 'a') {
    const href = attr(node, 'href');
    // No browser, remote resource loading, or executable PDF links.
    if (/^(https?:\/\/|mailto:)/i.test(href || '')) next.href = href;
    next.underline = true;
  }
  const result = children(node).flatMap(child => inlineRuns(child, next));
  if (BLOCKS.has(tag) && result.length) result.push({ text: '\n', ...style });
  return result;
}

// Wrap by measured glyph width, not by character count. Even an unbroken URL or
// a single table cell taller than a page is split without discarding any text.
function wrapRuns(doc, runs, width) {
  const lines = [];
  let line = [];
  let used = 0;
  const finish = () => { lines.push(line); line = []; used = 0; };
  const append = (text, run) => {
    font(doc, run);
    const size = doc.getTextWidth(text);
    line.push({ ...run, text, width: size });
    used += size;
  };
  for (const run of runs) {
    for (let token of run.text.split(/(\n|[^\S\n]+)/).filter(Boolean)) {
      if (token === '\n') { finish(); continue; }
      const whitespace = /^\s+$/.test(token);
      if (whitespace) token = ' ';
      if (!line.length && whitespace) continue;
      font(doc, run);
      if (used + doc.getTextWidth(token) > width && line.length) finish();
      if (whitespace && !line.length) continue;
      font(doc, run);
      if (doc.getTextWidth(token) <= width) { append(token, run); continue; }
      let part = '';
      for (const char of token) {
        font(doc, run);
        if (used + doc.getTextWidth(part + char) > width && part) {
          append(part, run); finish(); part = '';
        }
        part += char;
      }
      if (part) append(part, run);
    }
  }
  if (line.length) finish();
  return lines.length ? lines : [[]];
}

class AgreementLayout {
  constructor(doc) {
    this.doc = doc;
    this.width = doc.internal.pageSize.getWidth() - MARGIN * 2;
    this.y = TOP;
  }

  newPage() { this.doc.addPage(); this.y = TOP; }
  ensure(height) { if (this.y + height > BOTTOM) this.newPage(); }
  gap(height = 3) { this.y = Math.min(BOTTOM, this.y + height); }

  drawLine(line, x, y) {
    const doc = this.doc;
    for (const run of line) {
      font(doc, run);
      doc.setTextColor(...(run.href ? [25, 70, 130] : [25, 25, 25]));
      doc.text(run.text, x, y);
      if (run.href && run.width) doc.link(x, y - 3.5, run.width, 5, { url: run.href });
      doc.setDrawColor(45, 45, 45);
      doc.setLineWidth(0.15);
      if (run.underline) doc.line(x, y + 0.6, x + run.width, y + 0.6);
      if (run.strike) doc.line(x, y - 1, x + run.width, y - 1);
      x += run.width;
    }
  }

  paragraph(runs, { indent = 0, size = 10, bold = false, after = 3 } = {}) {
    // Never reduce the text area below a useful width for deeply nested lists.
    indent = Math.min(indent, this.width - 30);
    const styled = runs.map(run => ({ size, bold, ...run }));
    const lines = wrapRuns(this.doc, styled, this.width - indent);
    const leading = Math.max(5, size * 0.3528 * 1.4);
    for (const line of lines) {
      this.ensure(leading);
      this.drawLine(line, MARGIN + indent, this.y);
      this.y += leading;
    }
    this.gap(after);
  }

  label(value, opts = {}) { this.paragraph([{ text: clean(value) }], opts); }

  table(node, indent = 0) {
    const rows = [];
    const collect = parent => {
      for (const child of children(parent)) {
        if (child.tagName === 'tr') rows.push(child);
        else if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) collect(child);
        else if (child.tagName === 'caption') this.paragraph(inlineRuns(child), { bold: true, indent });
      }
    };
    collect(node);
    const span = cell => Math.min(100, Math.max(1, Number.parseInt(attr(cell, 'colspan'), 10) || 1));
    const cellsFor = row => children(row).filter(cell => ['td', 'th'].includes(cell.tagName));
    // Reserve columns occupied by row-spanning cells, so subsequent rows never
    // move a cancellation charge under the wrong notice-period heading.
    const occupied = [];
    let columns = 1;
    const grid = rows.map((row, rowIndex) => {
      let column = 0;
      return cellsFor(row).map(cell => {
        const colspan = span(cell);
        while (Array.from({ length: colspan }, (_, i) => occupied[column + i] > rowIndex).some(Boolean)) column++;
        const start = column;
        const rowspan = Math.max(1, Number.parseInt(attr(cell, 'rowspan'), 10) || 1);
        for (let i = 0; i < colspan; i++) occupied[column + i] = rowIndex + rowspan;
        column += colspan;
        columns = Math.max(columns, column);
        return { cell, start, colspan };
      });
    });
    indent = Math.min(indent, this.width - 40);
    const unit = (this.width - indent) / columns;
    const leading = 5;
    // An unusually wide table is reflowed cell-by-cell rather than shrinking
    // text to illegibility or allowing it to overflow the page.
    const wide = unit < 12;
    const displayRows = wide ? grid.flatMap(row => row.map(entry => [entry])) : grid;
    for (const row of displayRows) {
      const cells = row.map(({ cell, start, colspan }) => {
        const width = wide ? this.width - indent : unit * colspan;
        const runs = inlineRuns(cell, { size: 9, bold: cell.tagName === 'th' });
        return { x: MARGIN + indent + (wide ? 0 : start * unit), width,
          lines: wrapRuns(this.doc, runs, width - 4) };
      });
      const totalLines = Math.max(1, ...cells.map(cell => cell.lines.length));
      // Move modest rows intact; oversized rows continue in bordered segments.
      const rowHeight = totalLines * leading + 4;
      if (rowHeight <= BOTTOM - TOP) this.ensure(rowHeight);
      let offset = 0;
      while (offset < totalLines) {
        this.ensure(leading + 4);
        const count = Math.min(totalLines - offset, Math.floor((BOTTOM - this.y - 4) / leading));
        const height = count * leading + 4;
        for (const cell of cells) {
          this.doc.setDrawColor(160, 160, 160);
          this.doc.setLineWidth(0.2);
          this.doc.rect(cell.x, this.y - 3, cell.width, height);
          for (let i = 0; i < count; i++) {
            if (cell.lines[offset + i]) this.drawLine(cell.lines[offset + i], cell.x + 2, this.y + i * leading + 1);
          }
        }
        this.y += height;
        offset += count;
        if (offset < totalLines) this.newPage();
      }
    }
    this.gap(4);
  }

  nodes(nodes, indent = 0) {
    let inline = [];
    const flush = () => {
      if (inline.some(run => run.text.trim())) this.paragraph(inline, { indent });
      inline = [];
    };
    for (const node of nodes) {
      const tag = node.tagName;
      if (IGNORED.has(tag)) continue;
      if (!BLOCKS.has(tag)) { inline.push(...inlineRuns(node)); continue; }
      flush();
      if (tag === 'table') { this.table(node, indent); continue; }
      if (tag === 'ol' || tag === 'ul') {
        let number = Number.parseInt(attr(node, 'start'), 10) || 1;
        for (const item of children(node)) {
          if (item.tagName !== 'li') continue;
          const explicit = Number.parseInt(attr(item, 'value'), 10);
          if (Number.isFinite(explicit)) number = explicit;
          const marker = tag === 'ol' && attr(item, 'data-list') !== 'bullet' ? `${number++}. ` : '- ';
          // Render list-item blocks in order, keeping nested lists as lists.
          const own = [];
          let prefixUsed = false;
          const itemFlush = () => {
            if (!own.length) return;
            this.paragraph([...(prefixUsed ? [] : [{ text: marker }]), ...own], { indent: indent + 5 });
            own.length = 0; prefixUsed = true;
          };
          for (const child of children(item)) {
            if (['ul', 'ol', 'table'].includes(child.tagName)) {
              itemFlush();
              this.nodes([child], indent + 5);
            } else own.push(...inlineRuns(child));
          }
          itemFlush();
        }
      } else if (/^h[1-6]$/.test(tag)) {
        const size = Math.max(11, 19 - Number(tag[1]) * 1.5);
        this.ensure(16);
        this.paragraph(inlineRuns(node), { indent, size, bold: true, after: 4 });
      } else if (tag === 'hr') {
        this.ensure(5);
        this.doc.setDrawColor(160);
        this.doc.line(MARGIN + indent, this.y, MARGIN + this.width, this.y);
        this.gap(5);
      } else {
        this.nodes(children(node), indent + (tag === 'blockquote' ? 5 : 0));
      }
    }
    flush();
  }
}

/**
 * Render already-sanitized legal HTML using a server-side parser. No browser
 * globals, HTML image loading, scripts, CSS, or network access are used.
 * The backend owns sanitization; unsafe active elements are ignored defensively.
 */
export function renderSalesAgreementLegal(doc, legalHtml) {
  if (legalHtml != null && typeof legalHtml !== 'string') throw new Error('Agreement legalHtml must be a string.');
  const layout = new AgreementLayout(doc);
  layout.label('Sales agreement - legal terms', { size: 17, bold: true, after: 6 });
  layout.nodes(children(parseFragment(legalHtml || '')));
  return layout;
}

async function prepareSignature(person, label) {
  const signature = person?.signature;
  if (!signature || (!signature.mode && !signature.data && !signature.typedName)) return { signed: false };
  if (!['drawn', 'typed'].includes(signature.mode)) throw new Error(`${label} signature mode must be drawn or typed.`);
  const typedName = typeof signature.typedName === 'string' ? signature.typedName.trim() : '';
  let image;
  if (signature.data != null && signature.data !== '') {
    // Reject external URLs, SVG, oversized payloads, malformed base64 and
    // decompression bombs before jsPDF sees any untrusted image bytes.
    const data = signature.data;
    if (typeof data !== 'string' || data.length > 2800000
      || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new Error(`${label} signature must be a PNG data URL smaller than 2 MB.`);
    }
    const bytes = Buffer.from(data.slice('data:image/png;base64,'.length), 'base64');
    if (bytes.length > 2 * 1024 * 1024
      || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.toString('base64') !== data.slice('data:image/png;base64,'.length)) {
      throw new Error(`${label} signature contains invalid PNG data.`);
    }
    try {
      const options = { limitInputPixels: 4000000, failOn: 'warning' };
      const metadata = await sharp(bytes, options).metadata();
      if (metadata.format !== 'png' || (metadata.pages || 1) !== 1) throw new Error('Not a single PNG');
      image = await sharp(bytes, options).resize({ width: 900, height: 300, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    } catch {
      throw new Error(`${label} signature contains invalid or oversized PNG image data.`);
    }
  }
  if (!image && !(signature.mode === 'typed' && typedName)) return { signed: false };
  const date = person.signedAt ? new Date(person.signedAt) : null;
  if (date && !Number.isFinite(date.getTime())) throw new Error(`${label} signature signedAt is invalid.`);
  return { signed: Boolean(date), image, typedName, signedAt: date?.toISOString() };
}

function signatureSection(layout, label, person, signature) {
  layout.ensure(65);
  layout.label(`${label} signature`, { size: 13, bold: true });
  for (const [key, value] of [
    ['Name', person?.name], ['Role', person?.role],
    ['Organization', person?.organization], ['Email', person?.email],
  ]) layout.label(`${key}: ${value || 'Not provided'}`, { after: 1 });
  if (!signature.signed) {
    layout.label('Status: Pending signature', { bold: true, after: 7 });
    return;
  }
  layout.label('Status: Signed', { bold: true, after: 2 });
  if (signature.image) {
    layout.ensure(25);
    const data = `data:image/png;base64,${signature.image.toString('base64')}`;
    const props = layout.doc.getImageProperties(data);
    const scale = Math.min(80 / props.width, 22 / props.height);
    layout.doc.addImage(data, 'PNG', MARGIN, layout.y - 2, props.width * scale, props.height * scale);
    layout.y += props.height * scale + 3;
  }
  if (signature.typedName) layout.label(`Typed signature: ${signature.typedName}`, { after: 2 });
  layout.label(`Signed at (UTC): ${signature.signedAt}`, { after: 7 });
}

/**
 * Preserve the complete existing commercial quote PDF, then append the frozen
 * legal snapshot and both signature records. This function has no storage,
 * database, browser or remote image dependencies.
 */
export async function buildSalesAgreementPdf({ quote, version, tenant, sender, customer, documentHash }) {
  if (!quote || !version) throw new Error('A quote and version are required to build a sales agreement.');
  const [senderSignature, customerSignature] = await Promise.all([
    prepareSignature(sender, 'Sender'), prepareSignature(customer, 'Customer'),
  ]);
  const commercialPdf = buildSalesQuotePdf({ quote, version, tenant });
  const appendix = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const layout = renderSalesAgreementLegal(appendix, version.terms_snapshot?.legalHtml);
  layout.gap(6);
  signatureSection(layout, 'Sender', sender, senderSignature);
  signatureSection(layout, 'Customer', customer, customerSignature);
  layout.ensure(16);
  layout.label('Document hash', { bold: true });
  layout.label(documentHash || 'Not supplied', { size: 9 });
  const merged = await PDFDocument.load(commercialPdf);
  const legal = await PDFDocument.load(appendix.output('arraybuffer'));
  const pages = await merged.copyPages(legal, legal.getPageIndices());
  for (const page of pages) merged.addPage(page);
  return Buffer.from(await merged.save());
}
