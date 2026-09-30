#!/usr/bin/env node
// Generates a compact Font Awesome icon dataset for the canvas Text-block
// bullet-icon picker (Task #1867). Reads the metadata shipped with
// @fortawesome/fontawesome-free and writes a trimmed JSON consumed (lazily)
// by client/src/components/canvas/FontAwesomeIconPicker.jsx.
//
// Output shape: array of { n, l, s, t }
//   n = icon name (e.g. "book-open")  -> used to build "fa-<name>"
//   l = human label (e.g. "Book Open")
//   s = available free styles, e.g. ["solid","regular"] or ["brands"]
//   t = a few search terms
//
// Run: node scripts/generate-fa-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const metaPath = path.join(
  root,
  'node_modules/@fortawesome/fontawesome-free/metadata/icon-families.json',
);
const outPath = path.join(root, 'client/src/lib/faIcons.json');

const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const out = [];
for (const [name, info] of Object.entries(data)) {
  const classic = (info.svgs && info.svgs.classic) || {};
  const styles = Object.keys(classic).filter((s) =>
    ['solid', 'regular', 'brands'].includes(s),
  );
  if (!styles.length) continue;
  out.push({
    n: name,
    l: info.label || name,
    s: styles,
    t: ((info.search && info.search.terms) || []).slice(0, 8),
  });
}
out.sort((a, b) => a.l.localeCompare(b.l));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${out.length} icons to ${path.relative(root, outPath)} (${JSON.stringify(out).length} bytes)`);
