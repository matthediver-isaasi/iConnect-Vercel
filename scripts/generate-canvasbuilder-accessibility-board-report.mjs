// One-off: converts guides/canvasbuilder-accessibility-board-report.md into a
// board-ready Word document, omitting the Table of Contents section.
// Output: guides/canvasbuilder-accessibility-board-report.docx
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  PageBreak,
} from 'docx';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'guides/canvasbuilder-accessibility-board-report.md';
const OUT = 'guides/canvasbuilder-accessibility-board-report.docx';

const FONT = 'Calibri';
const BODY_SIZE = 22; // 11pt (half-points)
const BRAND = '1F3864'; // deep navy heading accent
const MUTED = '595959';
const BORDER = 'BFBFBF';

// ---------- Inline markdown (**bold**, *italic*, `code`) -> TextRuns ----------
function inlineRuns(text, base = {}) {
  const runs = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), ...base });
    if (m[2] !== undefined) runs.push({ text: m[2], bold: true, ...base });
    else if (m[4] !== undefined) runs.push({ text: m[4], italics: true, ...base });
    else if (m[6] !== undefined) runs.push({ text: m[6], font: 'Consolas', ...base });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), ...base });
  return runs.map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold,
        italics: r.italics,
        size: r.size ?? BODY_SIZE,
        color: r.color,
        font: r.font ?? FONT,
      }),
  );
}

function body(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 160, line: 300 },
    alignment: AlignmentType.JUSTIFIED,
    ...opts,
    children: inlineRuns(text),
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 180 },
    children: [new TextRun({ text, bold: true, size: 30, color: BRAND, font: FONT })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 120 },
    children: [new TextRun({ text, bold: true, size: 25, color: BRAND, font: FONT })],
  });
}

function bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 80, line: 290 },
    children: inlineRuns(text),
  });
}

function numbered(text) {
  return new Paragraph({
    numbering: { reference: 'ordered', level: 0 },
    spacing: { after: 100, line: 290 },
    children: inlineRuns(text),
  });
}

const cellBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  left: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
};

function tableCell(text, { header = false, width, fill } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: header
      ? { type: ShadingType.CLEAR, color: 'auto', fill: BRAND }
      : fill
        ? { type: ShadingType.CLEAR, color: 'auto', fill }
        : undefined,
    borders: cellBorders,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [
      new Paragraph({
        spacing: { after: 0, line: 280 },
        children: inlineRuns(text, header ? { bold: true, color: 'FFFFFF', size: 21 } : { size: 21 }),
      }),
    ],
  });
}

function mdTable(headerCells, rowsCells, widths) {
  const rows = [
    new TableRow({
      tableHeader: true,
      children: headerCells.map((t, i) => tableCell(t, { header: true, width: widths[i] })),
    }),
    ...rowsCells.map(
      (cells, idx) =>
        new TableRow({
          children: cells.map((t, i) =>
            tableCell(t, { width: widths[i], fill: idx % 2 === 1 ? 'F2F5FA' : undefined }),
          ),
        }),
    ),
  ];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: cellBorders.top,
      bottom: cellBorders.bottom,
      left: cellBorders.left,
      right: cellBorders.right,
      insideHorizontal: cellBorders.top,
      insideVertical: cellBorders.top,
    },
    rows,
  });
}

// ---------- Parse the markdown ----------
const raw = readFileSync(SRC, 'utf8');

// Strip YAML frontmatter
let md = raw.replace(/^---\n[\s\S]*?\n---\n/, '');

const lines = md.split('\n');

// Extract front matter block (title, subtitle, date/version, classification)
let title = '';
let subtitle = '';
const frontItalics = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  if (line.startsWith('# ')) title = line.slice(2).trim();
  else if (line.startsWith('## ') && !subtitle) subtitle = line.slice(3).trim();
  else if (/^\*[^*].*\*$/.test(line.trim())) frontItalics.push(line.trim().replace(/^\*|\*$/g, ''));
  else if (line.trim() === '---') { i += 1; break; }
  i += 1;
}

const children = [
  // ---- Title block ----
  new Paragraph({
    spacing: { before: 1600, after: 120 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'iConnect Platform', size: 26, color: MUTED, font: FONT })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
    children: [new TextRun({ text: title, size: 44, bold: true, color: BRAND, font: FONT })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 320 },
    children: [new TextRun({ text: subtitle, size: 26, color: '333333', font: FONT })],
  }),
  ...frontItalics.map(
    (t) =>
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        children: [new TextRun({ text: t, italics: true, size: 22, color: MUTED, font: FONT })],
      }),
  ),
  new Paragraph({ children: [new PageBreak()] }),
];

// Walk the remaining lines, skipping the Table of Contents section
let skipping = false;
let closingItalic = null;

while (i < lines.length) {
  const line = lines[i];
  const trimmed = line.trim();

  if (line.startsWith('## ')) {
    const heading = line.slice(3).trim();
    if (heading === 'Table of Contents') {
      skipping = true;
      i += 1;
      continue;
    }
    skipping = false;
    children.push(h1(heading));
    i += 1;
    continue;
  }

  if (skipping) { i += 1; continue; }

  if (trimmed === '' || trimmed === '---') { i += 1; continue; }

  if (line.startsWith('### ')) {
    children.push(h2(line.slice(4).trim()));
    i += 1;
    continue;
  }

  // Table
  if (trimmed.startsWith('|')) {
    const tblLines = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      tblLines.push(lines[i].trim());
      i += 1;
    }
    const parseRow = (l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const header = parseRow(tblLines[0]);
    const dataRows = tblLines.slice(2).map(parseRow);
    const widths = header.length === 2 ? [30, 70] : header.map(() => Math.floor(100 / header.length));
    children.push(mdTable(header, dataRows, widths));
    children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
    continue;
  }

  // Bullet list item
  if (trimmed.startsWith('- ')) {
    children.push(bullet(trimmed.slice(2)));
    i += 1;
    continue;
  }

  // Numbered list item
  const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
  if (numMatch) {
    // Gather continuation lines (indented paragraphs belonging to the item)
    let text = numMatch[2];
    let j = i + 1;
    while (j < lines.length && /^\s{3,}\S/.test(lines[j])) {
      text += ' ' + lines[j].trim();
      j += 1;
    }
    children.push(numbered(text));
    i = j;
    continue;
  }

  // Full-line italic (closing note)
  if (/^\*[^*].*\*$/.test(trimmed)) {
    closingItalic = trimmed.replace(/^\*|\*$/g, '');
    i += 1;
    continue;
  }

  // Body paragraph
  children.push(body(trimmed));
  i += 1;
}

if (closingItalic) {
  children.push(
    new Paragraph({
      spacing: { before: 300, after: 0 },
      children: [new TextRun({ text: closingItalic, italics: true, size: 20, color: MUTED, font: FONT })],
    }),
  );
}

const doc = new Document({
  creator: 'iConnect',
  title: `${title} — Board Report`,
  styles: {
    default: {
      document: { run: { font: FONT, size: BODY_SIZE } },
    },
  },
  numbering: {
    config: [
      {
        reference: 'ordered',
        levels: [
          {
            level: 0,
            format: 'decimal',
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 480, hanging: 300 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: { margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 } },
      },
      children,
    },
  ],
});

const buf = await Packer.toBuffer(doc);
writeFileSync(OUT, buf);
console.log('Written', OUT, buf.length, 'bytes');
