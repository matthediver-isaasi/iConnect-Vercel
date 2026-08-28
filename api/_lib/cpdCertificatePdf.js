import { createHash } from 'node:crypto';
import { degrees, PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const MAX_CPD_TEMPLATE_BYTES = 10 * 1024 * 1024;
const FONT = {
  Helvetica: { normal: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold, italic: StandardFonts.HelveticaOblique, bolditalic: StandardFonts.HelveticaBoldOblique },
  Times: { normal: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold, italic: StandardFonts.TimesRomanItalic, bolditalic: StandardFonts.TimesRomanBoldItalic },
  Courier: { normal: StandardFonts.Courier, bold: StandardFonts.CourierBold, italic: StandardFonts.CourierOblique, bolditalic: StandardFonts.CourierBoldOblique },
};

function checkedBytes(input, { mimeType, maxBytes }) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if ((mimeType || '').toLowerCase().split(';')[0].trim() !== 'application/pdf') throw new Error('Source must have application/pdf MIME type');
  if (!bytes.length) throw new Error('PDF source is empty');
  if (bytes.length > maxBytes) throw new Error(`PDF source exceeds ${maxBytes} bytes`);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Invalid PDF signature');
  return bytes;
}

/** Parse with pdf-lib, including PDFs using xref/object streams. */
export async function inspectPdf(input, { mimeType = 'application/pdf', maxBytes = MAX_CPD_TEMPLATE_BYTES } = {}) {
  const bytes = checkedBytes(input, { mimeType, maxBytes });
  let document;
  try {
    document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false });
  } catch (error) {
    throw new Error(`PDF is not parseable: ${error.message || 'invalid PDF'}`);
  }
  const pages = document.getPages().map((page) => {
    const {
      x: rawX, y: rawY, width: rawWidth, height: rawHeight,
    } = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    if (![rawWidth, rawHeight].every(Number.isFinite) || rawWidth <= 0 || rawHeight <= 0) throw new Error('PDF page has invalid geometry');
    if (![0, 90, 180, 270].includes(rotation)) throw new Error(`Unsupported PDF page rotation: ${rotation}`);
    const swap = rotation === 90 || rotation === 270;
    return {
      width: swap ? rawHeight : rawWidth,
      height: swap ? rawWidth : rawHeight,
      raw_width: rawWidth,
      raw_height: rawHeight,
      raw_x: rawX,
      raw_y: rawY,
      rotation,
    };
  });
  if (!pages.length) throw new Error('PDF contains no parseable pages');
  return { bytes, document, pages, geometry: pages, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Convert a visual top-left point into the page's unrotated PDF coordinates. */
export function visualToPdfPoint(x, y, rawWidth, rawHeight, rotation = 0, rawX = 0, rawY = 0) {
  const angle = ((Number(rotation) % 360) + 360) % 360;
  if (angle === 0) return { x: rawX + x, y: rawY + rawHeight - y };
  if (angle === 90) return { x: rawX + y, y: rawY + x };
  if (angle === 180) return { x: rawX + rawWidth - x, y: rawY + y };
  if (angle === 270) return { x: rawX + rawWidth - y, y: rawY + rawHeight - x };
  throw new Error(`Unsupported PDF page rotation: ${angle}`);
}

function formatValue(value, format) {
  if (value === null || value === undefined) return null;
  if (!format) return Array.isArray(value) ? value.join(', ') : String(value);
  if (format === 'uppercase') return String(value).toUpperCase();
  if (format === 'lowercase') return String(value).toLowerCase();
  if (format.startsWith('date') || /[DMY]/.test(format)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const requested = format.split(':')[1];
    if (requested && ['short', 'medium', 'long', 'full'].includes(requested)) {
      return new Intl.DateTimeFormat('en-GB', { dateStyle: requested, timeZone: 'UTC' }).format(date);
    }
    const day = String(date.getUTCDate());
    const day2 = day.padStart(2, '0');
    const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(date);
    const monthShort = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(date);
    return format
      .replace(/YYYY/g, String(date.getUTCFullYear()))
      .replace(/MMMM/g, month)
      .replace(/MMM/g, monthShort)
      .replace(/MM/g, String(date.getUTCMonth() + 1).padStart(2, '0'))
      .replace(/DD/g, day2)
      .replace(/\bD\b/g, day);
  }
  if (format.startsWith('number') || /[0#]/.test(format)) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    const generic = /^number(?::(\d{1,2}))?$/.exec(format);
    const decimals = generic
      ? (generic[1] === undefined ? 20 : Math.min(20, Number(generic[1])))
      : format.includes('.') ? format.split('.')[1].length : 0;
    const requiredDecimals = generic?.[1] === undefined
      ? 0
      : generic ? Math.min(20, Number(generic[1]))
        : format.includes('.') ? (format.split('.')[1].match(/0/g) || []).length : 0;
    return new Intl.NumberFormat('en-GB', {
      minimumFractionDigits: requiredDecimals,
      maximumFractionDigits: Math.min(20, decimals),
      useGrouping: format.includes(',') || format.startsWith('number'),
    }).format(number);
  }
  return String(value);
}

export function layoutPlaceholder(placeholder, values, font = null) {
  const family = placeholder.font_family || 'Helvetica';
  if (!FONT[family]) throw new Error(`Unsupported font: ${family}`);
  const supplied = values?.[placeholder.placeholder_key];
  let value = formatValue(
    supplied === null || supplied === undefined || supplied === ''
      ? placeholder.default_value
      : supplied,
    placeholder.format,
  );
  if (value === null) {
    if (placeholder.missing_policy === 'error') throw new Error(`Missing value: ${placeholder.placeholder_key}`);
    value = placeholder.missing_policy === 'literal' ? `{{${placeholder.placeholder_key}}}` : '';
  }
  const width = Number(placeholder.width), height = Number(placeholder.height);
  let size = Number(placeholder.font_size || 12);
  const minSize = Math.max(4, Number(placeholder.minimum_font_size || 4));
  const lineHeight = Number(placeholder.line_height || 1.2);
  const textWidth = (text) => font ? font.widthOfTextAtSize(text, size) : text.length * size * (family === 'Courier' ? .6 : family === 'Times' ? .48 : .52);
  const multiline = placeholder.multiline ?? placeholder.overflow_policy === 'wrap';
  const shouldShrink = placeholder.shrink_to_fit ?? placeholder.overflow_policy === 'shrink';
  const wrapParagraph = (paragraph) => {
    const output = [];
    let remaining = paragraph;
    while (remaining && textWidth(remaining) > width) {
      let low = 1, high = remaining.length, fit = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (textWidth(remaining.slice(0, middle)) <= width) { fit = middle; low = middle + 1; } else high = middle - 1;
      }
      if (!fit) throw new Error(`Placeholder ${placeholder.placeholder_key} is too narrow for its minimum font size`);
      const whitespace = remaining.slice(0, fit + 1).search(/\s+\S*$/);
      const splitAt = whitespace > 0 ? whitespace : fit;
      output.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    output.push(remaining);
    return output;
  };
  const wrap = () => {
    const text = String(value).replace(/\r\n?/g, '\n');
    if (!multiline) return [text.replace(/\s+/g, ' ').trim()];
    return text.split('\n').flatMap(wrapParagraph);
  };
  let lines = wrap();
  if (shouldShrink) {
    while (size > minSize && (lines.some((line) => textWidth(line) > width) || lines.length * size * lineHeight > height)) {
      size = Math.max(minSize, size - .5); lines = wrap();
    }
  }
  if (height < size * lineHeight) {
    throw new Error(`Placeholder ${placeholder.placeholder_key} is too short for its minimum font size`);
  }
  const maxLines = Math.max(1, Math.floor(height / (size * lineHeight)));
  const overflowedVertically = lines.length > maxLines;
  lines = lines.slice(0, maxLines);
  const truncate = (text, addEllipsis = false) => {
    const suffix = addEllipsis ? '…' : '';
    if (textWidth(text) <= width && !addEllipsis) return text;
    let candidate = text;
    while (candidate && textWidth(candidate + suffix) > width) candidate = candidate.slice(0, -1);
    return `${candidate}${suffix}`;
  };
  lines = lines.map((line, index) => truncate(line, overflowedVertically && index === lines.length - 1));
  return { family, size, lineHeight, lines, value };
}

function parseColor(hex) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex || '#000000')) throw new Error('Invalid placeholder color');
  return rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
}

/** Load/overlay/save: pdf-lib retains existing page streams/vectors and writes text as page content. */
export async function renderCpdCertificatePdf(source, placeholders, values = {}) {
  const parsed = await inspectPdf(source);
  const fonts = new Map();
  for (const placeholder of placeholders || []) {
    const family = placeholder.font_family || 'Helvetica';
    const style = placeholder.font_style || 'normal';
    if (!FONT[family]?.[style]) throw new Error(`Unsupported font/style: ${family}/${style}`);
    const key = `${family}/${style}`;
    if (!fonts.has(key)) fonts.set(key, await parsed.document.embedFont(FONT[family][style]));
  }
  const pages = parsed.document.getPages();
  for (const placeholder of placeholders || []) {
    const pageIndex = Number(placeholder.page_number) - 1;
    const page = pages[pageIndex];
    if (!page) throw new Error(`Placeholder ${placeholder.placeholder_key} refers to a missing page`);
    const font = fonts.get(`${placeholder.font_family || 'Helvetica'}/${placeholder.font_style || 'normal'}`);
    const layout = layoutPlaceholder(placeholder, values, font);
    const {
      x: rawX, y: rawY, width: rawWidth, height: rawHeight,
    } = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const swap = rotation === 90 || rotation === 270;
    const pageWidth = swap ? rawHeight : rawWidth;
    const pageHeight = swap ? rawWidth : rawHeight;
    const x = Number(placeholder.x), y = Number(placeholder.y), boxWidth = Number(placeholder.width), boxHeight = Number(placeholder.height);
    if (x < 0 || y < 0 || x + boxWidth > pageWidth || y + boxHeight > pageHeight) throw new Error(`Placeholder ${placeholder.placeholder_key} exceeds page bounds`);
    const textHeight = layout.lines.length * layout.size * layout.lineHeight;
    const vertical = placeholder.vertical_align || placeholder.vertical_alignment || 'middle';
    const topOffset = vertical === 'middle' ? (boxHeight - textHeight) / 2 : vertical === 'bottom' ? boxHeight - textHeight : 0;
    layout.lines.forEach((line, index) => {
      const lineWidth = font.widthOfTextAtSize(line, layout.size);
      const alignment = placeholder.alignment || 'left';
      const lineX = x + (alignment === 'center' ? (boxWidth - lineWidth) / 2 : alignment === 'right' ? boxWidth - lineWidth : 0);
      const visualBaselineY = y + topOffset + layout.size + (index * layout.size * layout.lineHeight);
      const point = visualToPdfPoint(lineX, visualBaselineY, rawWidth, rawHeight, rotation, rawX, rawY);
      page.drawText(line, {
        x: point.x,
        y: point.y,
        // The page's /Rotate matrix changes the raw content axes. Applying
        // the same numeric angle here is the compensating content transform:
        // after PDF.js applies the page viewport, the text basis is always
        // [right, up] in visual top-left coordinates.
        rotate: degrees(rotation),
        font,
        size: layout.size,
        color: parseColor(placeholder.color || '#000000'),
      });
    });
  }
  return Buffer.from(await parsed.document.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false }));
}