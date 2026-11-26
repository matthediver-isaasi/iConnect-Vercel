import { jsPDF } from 'jspdf';
import sharp from 'sharp';
import { toWinAnsi } from './pdfWinAnsi.js';
import { bundleComponentQuantity } from '../../shared/salesBundleLabels.js';
import { DEFAULT_QUOTE_NAMING } from '../../shared/salesNaming.js';

// Bump whenever the commercial layout changes in a way that should be applied
// to retained signed agreements (see scripts/reformat-signed-sales-agreements.mjs).
export const SALES_QUOTE_PDF_LAYOUT = 'proposal-layout-v2';

// 300 CSS pixels at 96dpi. The height cap stops very tall logos taking over.
export const LOGO_WIDTH_MM = 300 * 25.4 / 96;
export const LOGO_MAX_HEIGHT_MM = 30;
// Stored for every scheduled quote; it duplicates the Payment terms section.
export const REDUNDANT_SCHEDULE_TERMS = 'Payment terms are specified per invoice in the billing schedule.';

/**
 * Fetch a tenant-uploaded logo and convert it to a PNG data URL sized for the
 * PDF header (3x the printed 300px width so it stays sharp). Only public
 * Supabase storage objects are permitted. Returns null when no logo is set.
 */
export async function loadTenantLogoDataUrl(tenant) {
  const logo = tenant?.header_logo_url || tenant?.logo_url;
  if (!logo) return null;
  if (logo.startsWith('data:')) return logo;
  const url = new URL(logo);
  // Tenant uploads are public Supabase objects. Never fetch arbitrary hosts,
  // redirects or private storage from a PDF render.
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)
    || url.port || url.username || url.password || !url.pathname.startsWith('/storage/v1/object/public/')) {
    throw new Error('Quote logo must be a public tenant-uploaded image. Upload the logo in tenant branding.');
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Could not load the tenant logo for the quote PDF.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error('Tenant logo exceeds the 5 MB PDF image limit.');
    chunks.push(chunk);
  }
  const width = 900;
  const png = await sharp(Buffer.concat(chunks), { limitInputPixels: 16000000 })
    .resize({ width, height: Math.round(width * LOGO_MAX_HEIGHT_MM / LOGO_WIDTH_MM), fit: 'inside', withoutEnlargement: true })
    .png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

export async function buildBrandedSalesQuotePdf(input) {
  const tenant = { ...input.tenant };
  const logo = await loadTenantLogoDataUrl(tenant);
  if (logo) tenant.header_logo_url = logo;
  return buildSalesQuotePdf({ ...input, tenant });
}

const safe = (v) => toWinAnsi(v == null ? '' : String(v));
const money = (minor, currency) => new Intl.NumberFormat('en-GB', {
  style: 'currency', currency: currency || 'GBP',
}).format(Number(minor || 0) / 100);
const present = (v) => v != null && String(v).trim() !== '';

export function formatPdfDate(value) {
  if (!present(value)) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

const percent = (bps) => `${Number((bps / 100).toFixed(2))}%`;
export function lineVatPercent(line) {
  const stored = line?.tax_rate_bps ?? line?.taxRateBps;
  if (stored != null && Number.isFinite(Number(stored)) && Number(stored) >= 0) return percent(Number(stored));
  // Older snapshots: derive from the frozen amounts, never recalculate them.
  const net = Number(line?.net_minor), tax = Number(line?.tax_minor);
  if (Number.isFinite(net) && net > 0 && Number.isFinite(tax) && tax >= 0) return percent(Math.round(tax / net * 10000));
  return '';
}

function quantityText(value) {
  if (!present(value)) return '';
  const text = String(value);
  return /^\d+\.\d+$/.test(text) ? text.replace(/\.?0+$/, '') : text;
}

function unitPriceMinor(line) {
  const stored = line.quoted_unit_price_minor ?? line.quotedUnitPriceMinor;
  if (stored != null && Number.isFinite(Number(stored))) return Number(stored);
  const quantity = Number(line.quantity);
  return Number.isFinite(quantity) && quantity > 0 && line.discount_bps == null
    ? Math.round(Number(line.net_minor || 0) / quantity) : null;
}

function componentProduct(component) {
  return component?.productSnapshot || component?.product_snapshot || component || {};
}
// Recipient-facing name only: categories stay in invoice descriptions.
const componentName = (component) => componentProduct(component).name || 'Included product';

function componentQuantity(lineQuantity, componentQuantityValue) {
  try { return bundleComponentQuantity(lineQuantity ?? 1, componentQuantityValue ?? 1); }
  catch { return quantityText(componentQuantityValue); }
}

export function quoteAddressLines(version, organisationAddress) {
  const snapshot = version?.address_snapshot;
  const pick = (a) => [a.line1 ?? a.line_1, a.line2 ?? a.line_2, a.city, a.region,
    a.postalCode ?? a.postcode ?? a.postal_code, a.country];
  const lines = (values) => values.flatMap(v => (present(v) ? String(v).split(/\r?\n/) : []))
    .map(v => v.trim()).filter(Boolean);
  const fromSnapshot = snapshot && typeof snapshot === 'object' ? lines(pick(snapshot)) : [];
  if (fromSnapshot.length) return fromSnapshot;
  if (Array.isArray(organisationAddress)) return lines(organisationAddress);
  if (organisationAddress && typeof organisationAddress === 'object') return lines(pick(organisationAddress));
  return [];
}

function quoteSingular(tenant, context) {
  const value = context?.quoteSingular ?? tenant?.quote_singular_name ?? tenant?.quoteNaming?.singular;
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_QUOTE_NAMING.singular;
}

function timingText(timing) {
  if (!timing || typeof timing !== 'object') return '';
  if (timing.kind === 'fixed') return timing.date ? `On ${formatPdfDate(timing.date)}` : '';
  const days = Number(timing.days || 0);
  return days === 0 ? 'On acceptance' : `${days} ${days === 1 ? 'day' : 'days'} after acceptance`;
}
function dueText(terms) {
  if (!terms || typeof terms !== 'object' || terms.days == null) return terms?.name || '';
  const days = Number(terms.days);
  return days === 0 ? 'On receipt of invoice' : `Within ${days} ${days === 1 ? 'day' : 'days'} of invoice`;
}

export function buildSalesQuotePdf({ quote, version, tenant, context = {} }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const margin = 15, right = width - margin, top = 15, bottom = height - 20;
  const currency = version.currency;
  const singular = quoteSingular(tenant, context);
  const number = quote?.quote_number || '';
  const brand = tenant?.primary_color || '#5C0085';
  const rgb = /^#[0-9a-f]{6}$/i.test(brand)
    ? [parseInt(brand.slice(1, 3), 16), parseInt(brand.slice(3, 5), 16), parseInt(brand.slice(5, 7), 16)] : [92, 0, 133];
  const dark = [33, 37, 41], muted = [108, 117, 125], rule = [222, 226, 230], shade = [241, 243, 245];
  let y = top;

  const font = (size, style = 'normal', color = dark) => {
    doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color);
  };
  const leadingFor = (size) => size * 0.3528 * 1.3;
  const split = (value, w) => doc.splitTextToSize(safe(value), w);
  // Draw wrapped text whose first baseline is at `baseline`; returns lines.
  const draw = (lines, x, baseline, opts = {}) => {
    const size = doc.getFontSize();
    lines.forEach((line, i) => doc.text(line, x, baseline + i * leadingFor(size), opts));
    return lines.length * leadingFor(size);
  };
  const newPage = () => { doc.addPage(); y = top + 5; };
  const ensure = (need, onBreak) => {
    if (y + need > bottom) { newPage(); onBreak?.(); return true; }
    return false;
  };
  const paragraph = (value, size = 9.5, style = 'normal', color = dark, x = margin, w = right - margin) => {
    font(size, style, color);
    for (const line of split(value, w)) {
      ensure(leadingFor(size));
      doc.text(line, x, y + size * 0.3528);
      y += leadingFor(size);
    }
  };
  const heading = (value, keepWith = 12) => {
    ensure(7 + keepWith);
    font(11, 'bold', rgb);
    doc.text(safe(value), margin, y + 4);
    y += 7;
  };

  // ---------------------------------------------------------------- Header
  const logo = context?.logoDataUrl || tenant?.header_logo_url || tenant?.logo_url;
  let logoBottom = top;
  let hasLogo = false;
  if (typeof logo === 'string' && /^data:image\/(png|jpe?g);base64,/i.test(logo)) {
    try {
      const image = doc.getImageProperties(logo);
      const scale = Math.min(LOGO_WIDTH_MM / image.width, LOGO_MAX_HEIGHT_MM / image.height);
      const logoWidth = image.width * scale, logoHeight = image.height * scale;
      doc.addImage(logo, /^data:image\/png/i.test(logo) ? 'PNG' : 'JPEG', margin, top, logoWidth, logoHeight, undefined, 'FAST');
      logoBottom = top + logoHeight;
      hasLogo = true;
    } catch {}
  }
  let nameBottom = top;
  if (present(tenant?.name)) {
    if (hasLogo) {
      font(11, 'bold', rgb);
      nameBottom = top + 4 + draw(split(tenant.name, right - margin - LOGO_WIDTH_MM - 10), right, top + 4, { align: 'right' });
    } else {
      font(13, 'bold', rgb);
      nameBottom = top + 5 + draw(split(tenant.name, right - margin), margin, top + 5);
    }
  }
  y = Math.max(logoBottom, nameBottom) + 8;
  font(18, 'bold', dark);
  y += draw(split(`${singular.toUpperCase()} ${number}`.trim(), right - margin), margin, y + 6) + 2;
  if (version.status === 'draft') {
    font(10, 'bold', [176, 42, 55]);
    doc.text(safe('DRAFT — not issued'), margin, y + 3.5);
    y += 6;
  }
  doc.setDrawColor(...rgb); doc.setLineWidth(0.6);
  doc.line(margin, y, right, y);
  y += 6;

  // Prepared for (left) and document details (right).
  const columnTop = y;
  font(8.5, 'bold', muted);
  doc.text('Prepared for', margin, y + 3);
  let left = y + 8;
  const org = version.organisation_snapshot && typeof version.organisation_snapshot === 'object' ? version.organisation_snapshot : {};
  const contact = version.customer_contact_snapshot && typeof version.customer_contact_snapshot === 'object' ? version.customer_contact_snapshot : {};
  const contactName = contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  const recipient = org.name || contactName || version.address_snapshot?.addressee || '';
  const leftWidth = 95;
  if (recipient) { font(10.5, 'bold', dark); left += draw(split(recipient, leftWidth), margin, left); }
  font(9.5, 'normal', dark);
  for (const line of quoteAddressLines(version, context?.organisationAddress)) {
    left += draw(split(line, leftWidth), margin, left);
  }
  if (org.name && contactName) { font(9, 'normal', muted); left += 1 + draw(split(`Attention: ${contactName}`, leftWidth), margin, left + 1); }

  const details = [
    [`${singular} number`, number],
    [version.status === 'draft' ? 'Date' : 'Issued', formatPdfDate(version.issue_date || version.issued_at)],
    ['Valid until', formatPdfDate(version.valid_until)],
    ['Version', version.version_number],
    ['Customer reference', version.customer_reference],
    ['Purchase order', version.purchase_order_reference],
    ['Event', version.event_snapshot?.name || version.event_snapshot?.title],
  ].filter(([, value]) => present(value));
  let detailY = columnTop + 3;
  const labelX = 115;
  for (const [label, value] of details) {
    font(9, 'normal', muted); doc.text(safe(label), labelX, detailY);
    font(9, 'bold', dark);
    const lines = split(value, right - labelX - 30);
    detailY += Math.max(leadingFor(9), draw(lines, right, detailY, { align: 'right' }));
  }
  y = Math.max(left, detailY) + 6;

  // ------------------------------------------------------------ Line items
  const cols = { desc: margin + 2, qty: 99, unit: 121, vat: 136, net: 156, tax: 175, gross: right - 2 };
  const descWidth = cols.qty - 12 - cols.desc;
  const tableHeader = () => {
    doc.setFillColor(...shade); doc.rect(margin, y, right - margin, 8, 'F');
    font(8.5, 'bold', dark);
    const base = y + 5.3;
    doc.text('Description', cols.desc, base);
    doc.text('Qty', cols.qty, base, { align: 'right' });
    doc.text('Unit price', cols.unit, base, { align: 'right' });
    doc.text('VAT %', cols.vat, base, { align: 'right' });
    doc.text('Net', cols.net, base, { align: 'right' });
    doc.text('VAT', cols.tax, base, { align: 'right' });
    doc.text('Gross', cols.gross, base, { align: 'right' });
    y += 8;
  };
  const row = ({ description, sub = [], qty, unit, vat, net, tax, gross, indent = 0, size = 9, color = dark }) => {
    font(size, 'normal', color);
    const descLines = split(description, descWidth - indent);
    font(7.5, 'normal', muted);
    const subLines = sub.flatMap(s => split(s, descWidth - indent));
    const rowHeight = descLines.length * leadingFor(size) + subLines.length * leadingFor(7.5) + 3.6;
    if (rowHeight > bottom - (top + 5) - 8) {
      // Taller than a page: flow the description line by line instead of clipping.
      ensure(leadingFor(size) + 3.6, tableHeader);
      const first = y + 1.8 + size * 0.3528;
      font(size, 'normal', color);
      for (const [key, value] of [['qty', qty], ['unit', unit], ['vat', vat], ['net', net], ['tax', tax], ['gross', gross]]) {
        if (present(value)) doc.text(safe(value), cols[key], first, { align: 'right' });
      }
      y += 1.8;
      for (const [text, lineSize, lineColor] of [...descLines.map(t => [t, size, color]), ...subLines.map(t => [t, 7.5, muted])]) {
        ensure(leadingFor(lineSize) + 1.8, tableHeader);
        font(lineSize, 'normal', lineColor);
        doc.text(text, cols.desc + indent, y + lineSize * 0.3528);
        y += leadingFor(lineSize);
      }
      y += 1.8;
      doc.setDrawColor(...rule); doc.setLineWidth(0.2);
      doc.line(margin, y, right, y);
      return;
    }
    ensure(rowHeight, tableHeader);
    const base = y + 1.8 + size * 0.3528;
    font(size, 'normal', color);
    draw(descLines, cols.desc + indent, base);
    for (const [key, value] of [['qty', qty], ['unit', unit], ['vat', vat], ['net', net], ['tax', tax], ['gross', gross]]) {
      if (present(value)) doc.text(safe(value), cols[key], base, { align: 'right' });
    }
    if (subLines.length) {
      font(7.5, 'normal', muted);
      draw(subLines, cols.desc + indent, base + descLines.length * leadingFor(size));
    }
    y += rowHeight;
    doc.setDrawColor(...rule); doc.setLineWidth(0.2);
    doc.line(margin, y, right, y);
  };

  ensure(30);
  tableHeader();
  const lines = Array.isArray(version.sales_quote_line) ? version.sales_quote_line : [];
  for (const line of lines) {
    const unit = unitPriceMinor(line);
    const discount = Number(line.discount_bps || 0);
    row({
      description: line.description || line.catalogue_snapshot?.name || '',
      sub: discount > 0 ? [`Includes ${percent(discount)} discount`] : [],
      qty: quantityText(line.quantity),
      unit: unit == null ? '' : money(unit, currency),
      vat: lineVatPercent(line),
      net: money(line.net_minor, currency), tax: money(line.tax_minor, currency), gross: money(line.gross_minor, currency),
    });
    const components = Array.isArray(line.sales_quote_bundle_component) ? line.sales_quote_bundle_component : [];
    for (const component of components) {
      row({ description: componentName(component), qty: componentQuantity(line.quantity, component.quantity),
        indent: 5, size: 8.5, color: muted });
    }
  }
  if (!lines.length) row({ description: 'No items', color: muted });

  // Totals block: right-aligned label/value pairs.
  y += 3;
  ensure(24);
  const totalsLabel = 160;
  for (const [label, value] of [['Subtotal', version.net_minor], ['VAT', version.tax_minor]]) {
    font(9.5, 'normal', muted); doc.text(label, totalsLabel, y + 4, { align: 'right' });
    font(9.5, 'normal', dark); doc.text(safe(money(value, currency)), cols.gross, y + 4, { align: 'right' });
    y += 5.5;
  }
  doc.setDrawColor(...dark); doc.setLineWidth(0.4);
  doc.line(totalsLabel - 30, y + 0.5, right, y + 0.5);
  y += 1.5;
  font(11.5, 'bold', dark);
  doc.text(`Total ${safe(currency || 'GBP')}`, totalsLabel, y + 5, { align: 'right' });
  doc.text(safe(money(version.gross_minor, currency)), cols.gross, y + 5, { align: 'right' });
  y += 12;

  // ---------------------------------------------------------- Payment terms
  const schedule = version.billing_schedule && typeof version.billing_schedule === 'object' ? version.billing_schedule : null;
  const groups = Array.isArray(schedule?.groups) ? schedule.groups : [];
  const rawTerms = version.terms_snapshot?.text ?? version.payment_terms;
  const terms = typeof rawTerms === 'string' && rawTerms.trim() && rawTerms.trim() !== REDUNDANT_SCHEDULE_TERMS ? rawTerms.trim() : '';
  const percentage = schedule?.mode === 'percentage' || groups.some(g => Number.isFinite(Number(g.percentageBps)));
  const pc = { name: margin + 2, pct: 80, when: 85, due: 124, amount: right - 2 };
  const nameWidth = (percentage ? pc.pct - 12 : pc.when - 4) - pc.name;
  // Map frozen bundle components back to their plain product names.
  const componentNames = new Map();
  for (const line of lines) {
    for (const component of line.sales_quote_bundle_component || []) {
      const product = componentProduct(component);
      const name = componentName(component);
      for (const key of [component.product_id, component.productId, component.componentId, product.billing_component_id]) {
        if (key) componentNames.set(String(key), name);
      }
      if (product.categoryName) componentNames.set(`${product.categoryName} — ${name}`, name);
    }
  }
  const instalments = groups.map((group) => {
    font(9, 'bold', dark);
    const nameLines = split(group.name || 'Instalment', nameWidth);
    const sub = [];
    if (present(group.bundleLineLabel)) sub.push(String(group.bundleLineLabel).replace(/^Line \d+:\s*/, ''));
    if (schedule.mode !== 'percentage' && Array.isArray(group.contents)) {
      for (const item of group.contents) {
        const name = componentNames.get(String(item.productId ?? item.componentId ?? '')) || componentNames.get(String(item.name)) || item.name;
        if (present(name)) sub.push(`${quantityText(item.quantity) || 1} × ${name}`);
      }
    }
    font(7.5, 'normal', muted);
    const subLines = sub.flatMap(value => split(value, nameWidth));
    font(9, 'normal', dark);
    const whenLines = split(timingText(group.timing) || '—', pc.due - pc.when - 3);
    const dueLines = split(dueText(group.paymentTerms) || '—', pc.amount - 25 - pc.due);
    const height = Math.max(nameLines.length * leadingFor(9) + subLines.length * leadingFor(7.5),
      whenLines.length * leadingFor(9), dueLines.length * leadingFor(9)) + 3.6;
    const amount = Number(group.grossMinor || 0) === 0 ? 'No charge' : money(group.grossMinor, group.currency || currency);
    return { group, nameLines, subLines, whenLines, dueLines, height, amount };
  });
  // Keep the heading and table header with the first instalment.
  if (groups.length || terms) heading('Payment terms', instalments.length ? Math.min(8 + instalments[0].height, 120) : 10);
  if (instalments.length) {
    const paymentHeader = () => {
      doc.setFillColor(...shade); doc.rect(margin, y, right - margin, 8, 'F');
      font(8.5, 'bold', dark);
      const base = y + 5.3;
      doc.text('Instalment', pc.name, base);
      if (percentage) doc.text('%', pc.pct, base, { align: 'right' });
      doc.text('Invoiced', pc.when, base);
      doc.text('Payment due', pc.due, base);
      doc.text('Amount', pc.amount, base, { align: 'right' });
      y += 8;
    };
    paymentHeader();
    for (const { group, nameLines, subLines, whenLines, dueLines, amount } of instalments) {
      // Main instalment row first; its contents then flow line by line so long
      // schedules paginate (with a repeated header) instead of being clipped.
      const mainHeight = Math.max(nameLines.length, whenLines.length, dueLines.length) * leadingFor(9) + 1.8;
      ensure(mainHeight + (subLines.length ? leadingFor(7.5) : 0) + 1.8, paymentHeader);
      const base = y + 1.8 + 9 * 0.3528;
      font(9, 'bold', dark); draw(nameLines, pc.name, base);
      font(9, 'normal', dark);
      if (percentage && Number.isFinite(Number(group.percentageBps))) doc.text(percent(Number(group.percentageBps)), pc.pct, base, { align: 'right' });
      draw(whenLines, pc.when, base);
      draw(dueLines, pc.due, base);
      doc.text(safe(amount), pc.amount, base, { align: 'right' });
      y += Math.max(nameLines.length * leadingFor(9) + 1.8, mainHeight);
      for (const line of subLines) {
        if (ensure(leadingFor(7.5) + 1.8, paymentHeader)) {
          font(8, 'bold', muted);
          doc.text(safe(`${group.name || 'Instalment'} (continued)`), pc.name, y + 1.2 + 8 * 0.3528);
          y += leadingFor(8) + 1.2;
        }
        font(7.5, 'normal', muted);
        doc.text(line, pc.name + 2, y + 7.5 * 0.3528);
        y += leadingFor(7.5);
      }
      y += 1.8;
      doc.setDrawColor(...rule); doc.setLineWidth(0.2);
      doc.line(margin, y, right, y);
    }
    y += 4;
  }
  if (terms) { paragraph(terms); y += 3; }

  // -------------------------------------------------- Business/legal footer
  const business = tenant?.settings?.business_details || tenant?.settings?.businessDetails
    || tenant?.branding_config?.business_details;
  const footer = tenant?.footer_config || {};
  const legalLines = [footer.address?.name || footer.companyName, ...(Array.isArray(footer.address?.lines) ? footer.address.lines : []),
    footer.contact?.email, footer.contact?.phone, footer.legalText].filter(value => typeof value === 'string' && value.trim());
  const businessText = business && typeof business === 'object'
    ? Object.values(business).filter(v => typeof v === 'string' && v.trim()).join('  |  ') : '';
  if (businessText || legalLines.length) {
    y += 4;
    ensure(14);
    doc.setDrawColor(...rule); doc.setLineWidth(0.3);
    doc.line(margin, y, right, y);
    y += 3;
    if (businessText) paragraph(businessText, 8, 'normal', muted);
    for (const line of legalLines) paragraph(line, 8, 'normal', muted);
  }

  // Page furniture.
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    font(7.5, 'normal', muted);
    doc.text(safe(`${singular} ${number}`.trim()), margin, height - 10);
    doc.text(`Page ${i} of ${pages}`, right, height - 10, { align: 'right' });
  }
  return Buffer.from(doc.output('arraybuffer'));
}
