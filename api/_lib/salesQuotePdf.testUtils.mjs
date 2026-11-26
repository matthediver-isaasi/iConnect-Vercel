import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';

// Extract positioned text from every page of a generated PDF.
export async function extractPdf(bytes) {
  const pdf = await getDocument({ data: new Uint8Array(bytes), disableWorker: true,
    standardFontDataUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)) }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const { items } = await page.getTextContent();
      pages.push({ items: items.filter(item => item.str.trim()), text: items.map(item => item.str).join(' '), width: page.view[2], height: page.view[3] });
    }
    return pages;
  } finally { await pdf.destroy(); }
}
