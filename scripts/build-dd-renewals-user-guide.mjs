// Offline document build: no application, database or payment services.
// Run: node scripts/build-dd-renewals-user-guide.mjs
// Then: python scripts/validate-dd-renewals-user-guide.py (adds bookmarks and checks every page).
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import MarkdownIt from 'markdown-it';
import { execFileSync } from 'node:child_process';
const base = 'guides/direct-debit-membership-renewals-user-guide';
const md = new MarkdownIt();
md.renderer.rules.heading_open = (tokens, i) => {
  const text = tokens[i + 1].content;
  const id = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  return `<${tokens[i].tag} id="${id}">`;
};
const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Direct Debit Membership Renewals — User Guide</title>
<style>
@page { size: A4; margin: 17mm 17mm 18mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.35 Arial,sans-serif; color:#243548; margin:0; }
h1 { font-size:30pt; line-height:1.12; color:#113953; margin:20mm 0 10mm; }
h2 { font-size:21pt; line-height:1.2; color:#113953; margin:8mm 0 5mm; break-after:avoid; }
h2#understand-the-four-separate-parts { break-before:page; margin-top:0; }
h2#contents { break-before:auto; font-size:16pt; margin-top:12mm; }
h3 { font-size:12pt; color:#11656c; margin:5mm 0 2mm; break-after:avoid; }
p { margin:0 0 2.5mm; } li { margin:0 0 1.5mm; }
ul,ol { padding-left:6mm; margin:2mm 0 3mm; }
table { width:100%; border-collapse:collapse; font-size:9.5pt; margin:4mm 0 5mm; table-layout:fixed; break-inside:avoid; }
th { background:#e6f0f3; text-align:left; color:#113953; }
th,td { border:1px solid #bdccd3; padding:2mm; vertical-align:top; overflow-wrap:anywhere; }
tr { break-inside:avoid; } thead { display:table-header-group; }
a { color:#11656c; text-decoration:none; } code { font:9pt Arial,sans-serif; overflow-wrap:anywhere; }
p,li { orphans:3; widows:3; } strong { font-weight:700; }
</style><body>${md.render(await fs.readFile(`${base}.md`, 'utf8'))}</body></html>`;
await fs.mkdir('/tmp/dd-renewals-guide', {recursive:true});
await fs.writeFile('/tmp/dd-renewals-guide/guide.html', html);
const executablePath = process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], {encoding:'utf8'}).trim();
const browser = await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
try {
  const page = await browser.newPage();
  await page.setContent(html, {waitUntil:'load'});
  await page.pdf({
    path:`${base}.pdf`, preferCSSPageSize:true, printBackground:true,
    displayHeaderFooter:true, headerTemplate:'<div></div>',
    footerTemplate:'<div style="font:8px Arial;width:100%;text-align:center;color:#526575">Direct Debit Membership Renewals • 29 September 2026 • <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
} finally { await browser.close(); }
console.log(`Built ${base}.pdf`);