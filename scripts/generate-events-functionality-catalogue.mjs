/**
 * Generates the stakeholder-facing Events Functionality Catalogue.
 * Run from repository root: node scripts/generate-events-functionality-catalogue.mjs
 * Requires: pandoc and chromium on PATH (both are supplied by this workspace).
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const source = 'guides/events-functionality-catalogue.md';
const html = 'guides/events-functionality-catalogue.html';
const pdf = 'guides/events-functionality-catalogue.pdf';
const rawPdf = 'guides/.events-functionality-catalogue.raw.pdf';

for (const file of [source]) {
  if (!existsSync(file)) throw new Error(`Required source file is missing: ${file}`);
}
for (const command of ['pandoc', 'chromium']) {
  try { execFileSync(command, ['--version'], { stdio: 'pipe' }); }
  catch { throw new Error(`Required command is unavailable: ${command}. Install it and rerun from repository root.`); }
}

const css = `<style>
@page { size:A4; margin:18mm 15mm 16mm; }
:root{--navy:#17365d;--blue:#2e75b6;--pale:#edf3f8;--ink:#202936;--muted:#5c6673} *{box-sizing:border-box} html{font-size:10pt} body{max-width:none;padding:0;font-family:Arial,Helvetica,sans-serif;color:var(--ink);line-height:1.43;margin:0} h1,h2,h3{color:var(--navy);line-height:1.17;break-inside:avoid-page} h2,h3{break-after:avoid-page} h1{font-size:20pt;border-bottom:2px solid var(--blue);padding-bottom:5px;margin:24px 0 12px} h2{font-size:13.5pt;margin:19px 0 8px} p{margin:0 0 9px} ul{margin:6px 0 10px;padding-left:20px} a{color:#1c609c;text-decoration:none} #TOC ul{list-style:none;padding-left:0}.cover{height:252mm;display:flex;flex-direction:column;justify-content:center;text-align:center;page-break-after:always}.cover h1{border:0;font-size:34pt;margin:8px 0 18px}.cover-kicker{letter-spacing:2px;color:var(--muted);font-weight:bold}.cover-subtitle{font-size:15pt;color:var(--muted);margin-bottom:36px}.confidence{display:inline-block;margin:34px auto 0!important;color:#a61b2b;font-weight:bold;letter-spacing:.7px}.print-header,.print-footer{display:none}table{width:100%;border-collapse:collapse;margin:8px 0 16px;font-size:8.6pt;break-inside:auto}thead{display:table-header-group}tr{break-inside:avoid}th{background:var(--navy);color:white;text-align:left;font-weight:bold}th,td{border:1px solid #b9c5d1;padding:6px 7px;vertical-align:top}td:first-child{width:18%;font-weight:bold;color:#244d77}td:nth-child(2){width:24%;font-weight:bold}td:nth-child(3){width:58%}tbody tr:nth-child(even){background:#f7f9fb}hr{border:0;border-top:1px solid #c7d2dc;margin-top:24px} @media print{a{color:inherit}h1{break-before:page}h1:first-of-type{break-before:auto}}
</style>`;

try {
  execFileSync('pandoc', [source, '--from=markdown+raw_html', '--to=html5', '--standalone', '--metadata=lang:en-GB', '--output', html], { stdio: 'inherit' });
  let document = readFileSync(html, 'utf8');
  document = document
    .replace(/<header id="title-block-header">[\s\S]*?<\/header>/, '')
    .replace('</head>', `${css}</head>`);
  writeFileSync(html, document);
  if (existsSync(pdf)) unlinkSync(pdf);
  if (existsSync(rawPdf)) unlinkSync(rawPdf);
  execFileSync('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${rawPdf}`, `file://${process.cwd()}/${html}`], { stdio: 'inherit' });
  if (!existsSync(rawPdf)) throw new Error(`Chromium completed but did not create ${rawPdf}`);

  const pdfDocument = await PDFDocument.load(readFileSync(rawPdf));
  const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
  const pages = pdfDocument.getPages();
  const footerColour = rgb(0.35, 0.40, 0.46);
  pages.forEach((page, index) => {
    const { width } = page.getSize();
    const header = index === 0 ? '' : 'iConnect Platform · Events Functionality Catalogue';
    const footer = `Commercial in Confidence · 7 September 2026 · v1.0`;
    const pageNumber = `${index + 1} / ${pages.length}`;
    if (header) page.drawText(header, { x: 43, y: 820, size: 7.5, font, color: footerColour });
    page.drawText(footer, { x: 43, y: 18, size: 7.5, font, color: footerColour });
    page.drawText(pageNumber, {
      x: width - 43 - font.widthOfTextAtSize(pageNumber, 7.5),
      y: 18,
      size: 7.5,
      font,
      color: footerColour,
    });
  });
  writeFileSync(pdf, await pdfDocument.save());
  unlinkSync(rawPdf);
  const required = ['Events Functionality Catalogue', 'Commercial in Confidence', 'Simple and complex events at a glance', 'Important current boundaries'];
  const output = readFileSync(html, 'utf8').replace(/\s+/g, ' ');
  for (const phrase of required) if (!output.includes(phrase)) throw new Error(`Generated HTML validation failed: missing "${phrase}".`);
  console.log(`Created ${html} and ${pdf} (${pages.length} A4 pages). Source: ${source}`);
} catch (error) {
  console.error(`Catalogue generation failed: ${error.message}`);
  process.exitCode = 1;
}