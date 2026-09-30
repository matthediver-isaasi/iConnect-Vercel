// Demo knowledge-resource PDFs — generation + storage + file_repository
// registration (shared engine helper, usable by ANY demo tenant definition).
//
// Unlike avatars/logos/news images (AI-generated outside the seed runtime),
// PDFs ARE generated here, deterministically, from structured content the
// definition authors (title, subtitle, sections of paragraphs/bullets). The
// module owns:
//   - deterministic branded multi-page PDF rendering (jspdf, byte-stable:
//     fixed creation date + file id, no timestamps or randomness)
//   - deterministic storage paths in the tenant's public-assets bucket so
//     re-runs overwrite, never duplicate
//   - file_repository registration via ctx.upsert (manifest-tracked, so
//     reset removes the rows) and ctx.recordStorageObject (so reset removes
//     the storage objects too)
//
// All writes go direct via supabase-js with the service key, matching the
// rest of the seed: no entity API, no workflows, no quota metering side
// effects (demo tenants are platform-owned).

import { jsPDF } from 'jspdf';

// Same bucket admin uploads use (api/storage/signed-upload-url.js BUCKETS.PUBLIC)
// so seeded PDFs behave exactly like admin-uploaded files in the File
// Repository (public URL, bucket + storage_path recorded on the row).
export const DEMO_RESOURCE_PDF_BUCKET = 'public-assets';

/** Deterministic per-resource storage path so re-runs overwrite, not duplicate. */
export function demoResourcePdfStoragePath(tenantId, slug) {
  const safe = String(slug).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `${tenantId}/demo-resources/${safe}.pdf`;
}

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------
const PAGE_W = 210; // A4 mm
const PAGE_H = 297;
const MARGIN = 22;
const TEXT_W = PAGE_W - MARGIN * 2;

function hexToRgb(hex, fallback = [23, 74, 58]) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Deterministically render a branded multi-page A4 PDF.
 *
 * doc: {
 *   title: string,
 *   subtitle?: string,
 *   sections: [{ heading: string, paragraphs?: string[], bullets?: string[] }],
 * }
 * brand: { orgName, primaryColor, accentColor, footer } — all optional.
 *
 * Returns a Node Buffer. Byte-stable across runs: creation date and PDF file
 * id are pinned so re-uploads of unchanged content are identical.
 */
export function buildResourcePdfBuffer(docSpec, brand = {}) {
  if (!docSpec?.title || !Array.isArray(docSpec.sections) || docSpec.sections.length === 0) {
    throw new Error('resource PDF spec needs a title and at least one section');
  }
  const primary = hexToRgb(brand.primaryColor, [23, 74, 58]);
  const accent = hexToRgb(brand.accentColor, [213, 166, 66]);
  const orgName = brand.orgName || 'Demo Organisation';
  const footer = brand.footer || `${orgName} — demonstration document`;

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', putOnlyUsedFonts: true, compress: false });
  pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  pdf.setFileId('DEADBEEF00000000DEADBEEF00000000');
  pdf.setDocumentProperties({ title: docSpec.title, author: orgName, creator: orgName });

  let y;

  const paintHeader = (first) => {
    if (first) {
      // Cover band
      pdf.setFillColor(...primary);
      pdf.rect(0, 0, PAGE_W, 64, 'F');
      pdf.setFillColor(...accent);
      pdf.rect(0, 64, PAGE_W, 2.5, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(11);
      pdf.text(orgName, MARGIN, 20);
      pdf.setFontSize(24);
      const titleLines = pdf.splitTextToSize(docSpec.title, TEXT_W);
      pdf.text(titleLines, MARGIN, 34);
      if (docSpec.subtitle) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(11.5);
        pdf.text(pdf.splitTextToSize(docSpec.subtitle, TEXT_W), MARGIN, 36 + titleLines.length * 10);
      }
      y = 80;
    } else {
      pdf.setFillColor(...primary);
      pdf.rect(0, 0, PAGE_W, 14, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(`${orgName} — ${docSpec.title}`, MARGIN, 9);
      y = 26;
    }
  };

  const ensureRoom = (needed) => {
    if (y + needed <= PAGE_H - 20) return;
    pdf.addPage();
    paintHeader(false);
  };

  paintHeader(true);

  for (const section of docSpec.sections) {
    ensureRoom(18);
    pdf.setTextColor(...primary);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    const headLines = pdf.splitTextToSize(section.heading, TEXT_W);
    pdf.text(headLines, MARGIN, y);
    y += headLines.length * 6.2 + 1.5;
    pdf.setDrawColor(...accent);
    pdf.setLineWidth(0.8);
    pdf.line(MARGIN, y, MARGIN + 24, y);
    y += 6;

    pdf.setTextColor(45, 51, 47);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10.5);
    for (const para of section.paragraphs || []) {
      const lines = pdf.splitTextToSize(para, TEXT_W);
      ensureRoom(lines.length * 5.2 + 3);
      pdf.text(lines, MARGIN, y);
      y += lines.length * 5.2 + 3.5;
    }
    for (const bullet of section.bullets || []) {
      const lines = pdf.splitTextToSize(bullet, TEXT_W - 7);
      ensureRoom(lines.length * 5.2 + 2);
      pdf.setFillColor(...accent);
      pdf.circle(MARGIN + 1.6, y - 1.4, 1.1, 'F');
      pdf.text(lines, MARGIN + 7, y);
      y += lines.length * 5.2 + 2.5;
    }
    y += 5;
  }

  // Footers with page numbers (after content so total page count is known).
  const pages = pdf.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    pdf.setPage(p);
    pdf.setTextColor(120, 126, 122);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(footer, MARGIN, PAGE_H - 10);
    pdf.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 10, { align: 'right' });
  }

  return Buffer.from(pdf.output('arraybuffer'));
}

// ---------------------------------------------------------------------------
// Storage + file_repository registration
// ---------------------------------------------------------------------------

/** Upload (upsert) a PDF buffer to the deterministic path; returns { url, path }. */
export async function uploadDemoResourcePdf(sb, { tenantId, slug, buffer, bucket = DEMO_RESOURCE_PDF_BUCKET }) {
  const path = demoResourcePdfStoragePath(tenantId, slug);
  const { error } = await sb.storage.from(bucket).upload(path, buffer, {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (error) throw new Error(`demo resource PDF upload failed for ${slug}: ${error.message}`);
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error(`demo resource PDF public URL missing for ${slug}`);
  return { url: data.publicUrl, path };
}

/**
 * Seed-time pass (shared engine helper): generate, upload and register one
 * PDF per item. Idempotent — deterministic storage paths overwrite on re-run
 * and file_repository rows are upserted by (tenant, file_name) via
 * ctx.upsert, so both are also manifest-tracked for reset. Storage objects
 * are recorded through ctx.recordStorageObject so reset removes them too.
 *
 * items: [{ slug, title, description?, pdf: { title, subtitle?, sections } }]
 * brand: { orgName, primaryColor, accentColor, footer }
 *
 * Returns a Map slug -> { url, path, fileRepositoryId, sizeBytes }.
 */
export async function seedDemoResourcePdfs({ ctx, items, brand = {}, bucket = DEMO_RESOURCE_PDF_BUCKET, uploadedBy = null }) {
  const { sb, tenantId } = ctx;
  const out = new Map();
  for (const item of items) {
    const spec = item.pdf || {};
    const buffer = buildResourcePdfBuffer({ title: spec.title || item.title, subtitle: spec.subtitle, sections: spec.sections }, brand);
    const { url, path } = await uploadDemoResourcePdf(sb, { tenantId, slug: item.slug, buffer, bucket });
    if (typeof ctx.recordStorageObject === 'function') ctx.recordStorageObject(bucket, path);
    const fileName = `${item.slug}.pdf`;
    const fileRow = await ctx.upsert('file_repository', { file_name: fileName }, {
      file_url: url,
      file_type: 'document',
      mime_type: 'application/pdf',
      file_size: buffer.length,
      description: item.description || `${item.title} (demo document)`,
      tags: ['demo-seed'],
      bucket,
      storage_path: path,
      uploaded_by: uploadedBy,
    });
    out.set(item.slug, { url, path, fileRepositoryId: fileRow.id, sizeBytes: buffer.length });
  }
  return out;
}

/**
 * Build a standard privacy-enhanced YouTube iframe embed (the format the
 * Resource Management admin UI stores in target_url for `video` resources).
 */
export function youtubeEmbedCode(videoId, title = '') {
  const id = String(videoId).replace(/[^A-Za-z0-9_-]/g, '');
  const t = String(title).replace(/"/g, '&quot;');
  return `<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/${id}" title="${t}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
}
