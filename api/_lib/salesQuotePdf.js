import { jsPDF } from 'jspdf';
import { toWinAnsi } from './pdfWinAnsi.js';
import sharp from 'sharp';

export async function buildBrandedSalesQuotePdf(input) {
  const tenant = { ...input.tenant };
  const logo = tenant.header_logo_url || tenant.logo_url;
  if (logo && !logo.startsWith('data:')) {
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
    const png = await sharp(Buffer.concat(chunks), { limitInputPixels: 16000000 }).resize({ width: 600, height: 200, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    tenant.header_logo_url = `data:image/png;base64,${png.toString('base64')}`;
  }
  return buildSalesQuotePdf({ ...input, tenant });
}

const safe = (v) => toWinAnsi(v == null ? '' : String(v));
const money = (minor, currency) => new Intl.NumberFormat('en-GB', {
  style: 'currency', currency: currency || 'GBP',
}).format(Number(minor || 0) / 100);

export function buildSalesQuotePdf({ quote, version, tenant }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const width = doc.internal.pageSize.getWidth();
  const margin = 18; let y = 20;
  const page = (need = 15) => { if (y + need > 280) { doc.addPage(); y = 20; } };
  const text = (value, x = margin, opts = {}) => {
    const lines = doc.splitTextToSize(safe(value), opts.width || width - margin * 2);
    doc.text(lines, x, y, opts); y += lines.length * (opts.leading || 5);
  };
  const brand = tenant?.primary_color || '#5C0085';
  const rgb = /^#[0-9a-f]{6}$/i.test(brand)
    ? [parseInt(brand.slice(1, 3), 16), parseInt(brand.slice(3, 5), 16), parseInt(brand.slice(5, 7), 16)] : [92, 0, 133];
  const logo = tenant?.header_logo_url || tenant?.logo_url;
  if (typeof logo === 'string' && /^data:image\/(png|jpe?g);base64,/i.test(logo)) {
    try { doc.addImage(logo, /^data:image\/png/i.test(logo) ? 'PNG' : 'JPEG', margin, y - 5, 40, 15, undefined, 'FAST'); y += 17; } catch {}
  }
  doc.setTextColor(...rgb); doc.setFont('helvetica', 'bold'); doc.setFontSize(22);
  text(tenant?.name || 'Quote');
  doc.setTextColor(0); doc.setFontSize(18); text(`QUOTE ${quote.quote_number || ''}`);
  if (version.status === 'draft') { doc.setFontSize(12); text('DRAFT — not issued'); }
  doc.setFontSize(10); doc.setFont('helvetica', 'normal');
  text(`Version ${version.version_number}  |  ${version.status === 'draft' ? 'Date' : 'Issued'} ${version.issue_date || version.issued_at?.slice(0, 10) || ''}`);
  if (version.valid_until) text(`Valid until ${new Date(version.valid_until).toLocaleDateString('en-GB')}`);
  y += 5;
  const org = version.organisation_snapshot || {};
  doc.setFont('helvetica', 'bold'); text('Prepared for');
  doc.setFont('helvetica', 'normal'); text(org.name || version.customer_contact_snapshot?.name || '');
  const addr = version.address_snapshot || {};
  text([addr.addressee, addr.line1, addr.line2, addr.city, addr.region, addr.postalCode || addr.postcode || addr.postal_code, addr.country].filter(Boolean).join(', '));
  y += 5;
  doc.setFont('helvetica', 'bold'); text('Description', margin);
  doc.text('Qty', 120, y - 5); doc.text('Net', 145, y - 5); doc.text('Gross', 175, y - 5);
  doc.setFont('helvetica', 'normal');
  for (const line of version.sales_quote_line || []) {
    page(18);
    const lineY = y; text(line.description, margin, { width: 95 });
    doc.text(safe(line.quantity), 120, lineY);
    doc.text(safe(money(line.net_minor, version.currency)), 145, lineY);
    doc.text(safe(money(line.gross_minor, version.currency)), 175, lineY);
    for (const component of line.sales_quote_bundle_component || []) {
      text(`  - ${component.product_snapshot?.name || 'Bundle item'} x ${component.quantity}`, margin + 3, { width: 90, leading: 4 });
    }
    y += 2;
  }
  page(25); y += 4; doc.setFont('helvetica', 'bold');
  text(`Net: ${money(version.net_minor, version.currency)}`, 125);
  text(`Tax: ${money(version.tax_minor, version.currency)}`, 125);
  doc.setFontSize(13); text(`Total: ${money(version.gross_minor, version.currency)}`, 125);
  doc.setFontSize(10);
  const terms = version.terms_snapshot?.text || version.payment_terms;
  if (terms) { page(25); y += 5; text('Terms'); doc.setFont('helvetica', 'normal'); text(terms); }
  const business = tenant?.settings?.business_details || tenant?.settings?.businessDetails
    || tenant?.branding_config?.business_details;
  if (business) { page(20); y += 5; doc.setFont('helvetica', 'bold'); text('Business details');
    doc.setFont('helvetica', 'normal'); text(Object.values(business).filter(v => typeof v === 'string').join(' | ')); }
  const footer = tenant?.footer_config || {};
  const legalLines = [footer.address?.name || footer.companyName, ...(Array.isArray(footer.address?.lines) ? footer.address.lines : []),
    footer.contact?.email, footer.contact?.phone, footer.legalText].filter(value => typeof value === 'string' && value.trim());
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  for (const line of legalLines) {
    for (const part of doc.splitTextToSize(safe(line), width - margin * 2)) { page(8); text(part); }
  }
  return Buffer.from(doc.output('arraybuffer'));
}