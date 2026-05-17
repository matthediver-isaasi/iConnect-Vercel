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
  PageBreak,
  Footer,
  ImageRun,
  ExternalHyperlink,
} from 'docx';
import moment from 'moment';

const MOJIBAKE_MAP = [
  ['â€¯', '\u202F'],
  ['â€™', '\u2019'],
  ['â€˜', '\u2018'],
  ['â€œ', '\u201C'],
  ['â€\u009D', '\u201D'],
  ['â€"', '\u2014'],
  ['â€"', '\u2013'],
  ['â€¦', '\u2026'],
  ['Â£', '£'],
  ['Â©', '©'],
  ['Â®', '®'],
  ['Â°', '°'],
  ['Â', ''],
];

export function cleanMojibake(input) {
  if (input == null) return '';
  let out = String(input);
  for (const [from, to] of MOJIBAKE_MAP) {
    if (out.indexOf(from) !== -1) {
      out = out.split(from).join(to);
    }
  }
  return out;
}

export function sanitizeFileName(name) {
  if (!name) return 'submission';
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 120) || 'submission';
}

function isBulletLine(line) {
  return /^\s*([-*•])\s+/.test(line);
}

function stripBulletPrefix(line) {
  return line.replace(/^\s*([-*•])\s+/, '');
}

function makeParagraphsFromText(value) {
  const cleaned = cleanMojibake(value);
  if (!cleaned) return [new Paragraph({ children: [new TextRun('')] })];
  const lines = cleaned.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (isBulletLine(line)) {
      out.push(new Paragraph({
        children: [new TextRun(stripBulletPrefix(line))],
        bullet: { level: 0 },
      }));
    } else {
      out.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }
  return out;
}

function makeCell(children, opts = {}) {
  return new TableCell({
    children: Array.isArray(children) ? children : [children],
    width: opts.width,
    shading: opts.shading,
  });
}

const HEADER_SHADING = { type: 'clear', color: 'auto', fill: 'F1F5F9' };

async function fetchImageBuffer(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function detectImageType(url) {
  const lower = String(url || '').toLowerCase();
  if (lower.endsWith('.png')) return 'png';
  if (lower.endsWith('.gif')) return 'gif';
  if (lower.endsWith('.bmp')) return 'bmp';
  if (lower.endsWith('.svg')) return 'svg';
  return 'jpg';
}

// Resolve award type signal: 'team' | 'individual' | null
export function resolveAwardType(submission, form) {
  if (!submission) return null;
  const appLevel = form?.application_level;
  if (appLevel === 'organisation' || appLevel === 'organization') return 'team';
  if (appLevel === 'member') return 'individual';

  const data = submission.submission_data || {};
  const fields = form?.fields || [];
  const candidateLabels = ['award type', 'team or individual', 'award category type', 'application type'];
  for (const field of fields) {
    if (!field || !field.label) continue;
    const labelLower = String(field.label).toLowerCase();
    if (candidateLabels.some(c => labelLower.includes(c))) {
      const v = data[field.id];
      const str = Array.isArray(v) ? v.join(' ').toLowerCase() : String(v || '').toLowerCase();
      if (str.includes('team') || str.includes('organisation') || str.includes('organization')) return 'team';
      if (str.includes('individual') || str.includes('member')) return 'individual';
    }
  }

  for (const [, v] of Object.entries(data)) {
    const str = Array.isArray(v) ? v.join(' ').toLowerCase() : String(v || '').toLowerCase();
    if (str === 'team' || str === 'team award') return 'team';
    if (str === 'individual' || str === 'individual award') return 'individual';
  }

  return null;
}

function getApplicantName(submission, form) {
  if (submission?.submitted_by_name) return submission.submitted_by_name;
  const data = submission?.submission_data || {};
  const fields = form?.fields || [];
  for (const field of fields) {
    if (!field || !field.label) continue;
    const lower = String(field.label).toLowerCase();
    if (lower.includes('name') || lower.includes('applicant') || lower.includes('organisation') || lower.includes('organization')) {
      const v = data[field.id];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return `Submission ${submission?.id || ''}`.trim();
}

function getAwardCategory(submission, form) {
  const data = submission?.submission_data || {};
  const fields = form?.fields || [];
  for (const field of fields) {
    if (!field || !field.label) continue;
    const lower = String(field.label).toLowerCase();
    if (lower.includes('award') && (lower.includes('category') || lower.includes('classification') || lower.includes('class'))) {
      const v = data[field.id];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v) && v.length) return v.join(', ');
    }
  }
  return '';
}

function formatResponseValue(value, fieldDef, resolvers) {
  if (value == null || value === '') return { paragraphs: [new Paragraph({ children: [new TextRun('')] })], files: [] };
  const fieldType = fieldDef?.type;
  const r = resolvers || {};

  if (fieldType === 'file') {
    let rawList = value;
    if (typeof rawList === 'string') {
      const trimmed = rawList.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try { rawList = JSON.parse(trimmed); } catch { rawList = [rawList]; }
      } else {
        rawList = [rawList];
      }
    }
    if (!Array.isArray(rawList)) rawList = [rawList];
    return { paragraphs: null, files: rawList.map(f => r.resolveFile(f)).filter(Boolean) };
  }

  if (fieldType === 'organisation_dropdown') {
    const v = Array.isArray(value) ? value.map(r.resolveOrgName).join(', ') : r.resolveOrgName(value);
    return { paragraphs: makeParagraphsFromText(v), files: [] };
  }
  if (fieldType === 'member_dropdown') {
    const v = Array.isArray(value) ? value.map(r.resolveMemberName).join(', ') : r.resolveMemberName(value);
    return { paragraphs: makeParagraphsFromText(v), files: [] };
  }
  if (fieldType === 'role_dropdown') {
    const v = Array.isArray(value) ? value.map(r.resolveRoleName).join(', ') : r.resolveRoleName(value);
    return { paragraphs: makeParagraphsFromText(v), files: [] };
  }
  if (fieldType === 'category_dropdown' || fieldType === 'category_multiselect') {
    const v = Array.isArray(value) ? value.map(r.resolveResourceCategoryLabel).join(', ') : r.resolveResourceCategoryLabel(value);
    return { paragraphs: makeParagraphsFromText(v), files: [] };
  }
  if (fieldType === 'communication_preferences') {
    return { paragraphs: makeParagraphsFromText(r.resolveCommunicationPreferences(value)), files: [] };
  }
  if (fieldType === 'image_buttons') {
    const v = Array.isArray(value)
      ? value.map(x => r.resolveImageButtonLabel(x, fieldDef)).join(', ')
      : r.resolveImageButtonLabel(value, fieldDef);
    return { paragraphs: makeParagraphsFromText(v), files: [] };
  }
  if (fieldType === 'custom_field') {
    return { paragraphs: makeParagraphsFromText(r.resolveCustomFieldValue(value, fieldDef)), files: [] };
  }

  if (Array.isArray(value)) {
    const allStrings = value.every(v => v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
    if (allStrings) {
      const paragraphs = value
        .filter(v => v !== '' && v != null)
        .map(v => new Paragraph({ children: [new TextRun(cleanMojibake(String(v)))], bullet: { level: 0 } }));
      return { paragraphs: paragraphs.length ? paragraphs : [new Paragraph({ children: [new TextRun('')] })], files: [] };
    }
    return { paragraphs: makeParagraphsFromText(value.map(v => JSON.stringify(v)).join(', ')), files: [] };
  }

  if (typeof value === 'object') {
    const lines = Object.entries(value)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
    return { paragraphs: makeParagraphsFromText(lines), files: [] };
  }

  if (typeof value === 'boolean') {
    return { paragraphs: makeParagraphsFromText(value ? 'Yes' : 'No'), files: [] };
  }

  return { paragraphs: makeParagraphsFromText(String(value)), files: [] };
}

function buildSubmissionSection({ submission, form, selectedOptions, resolvers, isLast }) {
  const applicantName = cleanMojibake(getApplicantName(submission, form));
  const awardCategory = cleanMojibake(getAwardCategory(submission, form));

  const children = [];

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: applicantName, bold: true })],
    spacing: { before: 200, after: 80 },
  }));

  if (awardCategory) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: awardCategory, italics: true })],
      spacing: { after: 120 },
    }));
  }

  if (!form) {
    children.push(new Paragraph({
      children: [new TextRun({ text: '[Form definition not available — raw responses only]', italics: true, color: '888888' })],
      spacing: { after: 120 },
    }));
  }

  const fieldDefsById = {};
  (form?.fields || []).forEach(f => { if (f && f.id) fieldDefsById[f.id] = f; });

  const supportingDocs = [];
  const rows = [
    new TableRow({
      tableHeader: true,
      children: [
        makeCell(new Paragraph({ children: [new TextRun({ text: 'Field / Question', bold: true })] }), { shading: HEADER_SHADING, width: { size: 35, type: WidthType.PERCENTAGE } }),
        makeCell(new Paragraph({ children: [new TextRun({ text: 'Response', bold: true })] }), { shading: HEADER_SHADING, width: { size: 65, type: WidthType.PERCENTAGE } }),
      ],
    }),
  ];

  for (const opt of selectedOptions) {
    let label = opt.label;
    let paragraphs = null;
    let files = [];

    switch (opt.key) {
      case '__form_name':
        paragraphs = makeParagraphsFromText(resolvers.resolveFormName(submission));
        break;
      case '__submitter_name':
        paragraphs = makeParagraphsFromText(submission.submitted_by_name || '');
        break;
      case '__submitter_email':
        paragraphs = makeParagraphsFromText(resolvers.getSubmitterEmail(submission) || '');
        break;
      case '__status': {
        const s = submission.status || 'new';
        paragraphs = makeParagraphsFromText(s.charAt(0).toUpperCase() + s.slice(1));
        break;
      }
      case '__submission_date':
        paragraphs = makeParagraphsFromText(moment(submission.created_date).format('YYYY-MM-DD HH:mm'));
        break;
      default: {
        const val = submission.submission_data?.[opt.key];
        const fieldDef = fieldDefsById[opt.key];
        const result = formatResponseValue(val, fieldDef, resolvers);
        paragraphs = result.paragraphs;
        files = result.files;
        if (files.length) {
          supportingDocs.push({ label, files });
        }
      }
    }

    if (paragraphs) {
      rows.push(new TableRow({
        children: [
          makeCell(new Paragraph({ children: [new TextRun({ text: cleanMojibake(label) })] })),
          makeCell(paragraphs),
        ],
      }));
    } else if (files.length) {
      rows.push(new TableRow({
        children: [
          makeCell(new Paragraph({ children: [new TextRun({ text: cleanMojibake(label) })] })),
          makeCell(new Paragraph({ children: [new TextRun({ text: `${files.length} file(s) — see Supporting Documents below`, italics: true })] })),
        ],
      }));
    }
  }

  children.push(new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  }));

  if (supportingDocs.length) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_3,
      children: [new TextRun({ text: 'Supporting Documents', bold: true })],
      spacing: { before: 200, after: 80 },
    }));
    for (const group of supportingDocs) {
      children.push(new Paragraph({
        children: [new TextRun({ text: group.label, bold: true })],
        spacing: { before: 80, after: 40 },
      }));
      for (const file of group.files) {
        const name = cleanMojibake(file.name || 'file');
        if (file.url) {
          children.push(new Paragraph({
            bullet: { level: 0 },
            children: [
              new ExternalHyperlink({
                link: file.url,
                children: [new TextRun({ text: name, style: 'Hyperlink', color: '2563EB', underline: {} })],
              }),
            ],
          }));
        } else {
          children.push(new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text: name })],
          }));
        }
      }
    }
  }

  if (!isLast) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  return children;
}

function buildTitleBlock({ tenantName, tenantLogo, documentTitle }) {
  const blocks = [];
  if (tenantLogo) {
    blocks.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({
        data: tenantLogo.data,
        transformation: { width: 160, height: 60 },
        type: tenantLogo.type,
      })],
    }));
  }
  if (tenantName) {
    blocks.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: cleanMojibake(tenantName), bold: true, size: 28 })],
      spacing: { after: 120 },
    }));
  }
  blocks.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    heading: HeadingLevel.TITLE,
    children: [new TextRun({ text: cleanMojibake(documentTitle), bold: true })],
    spacing: { after: 80 },
  }));
  blocks.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `Exported ${moment().format('D MMMM YYYY')}`, color: '64748B', italics: true })],
    spacing: { after: 400 },
  }));
  return blocks;
}

function buildFooter() {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: `Generated from iConnect on ${moment().format('D MMMM YYYY')}. This document contains award submission information and should be treated as confidential.`,
          size: 16,
          color: '64748B',
          italics: true,
        })],
      }),
    ],
  });
}

export async function renderSubmissionsDocx({
  submissions,
  formsById,
  selectedOptions,
  resolvers,
  tenantName,
  tenantLogoUrl,
  documentTitle,
}) {
  let tenantLogo = null;
  if (tenantLogoUrl) {
    const data = await fetchImageBuffer(tenantLogoUrl);
    if (data) {
      tenantLogo = { data, type: detectImageType(tenantLogoUrl) };
    }
  }

  const body = [];
  body.push(...buildTitleBlock({ tenantName, tenantLogo, documentTitle }));

  if (submissions.length === 0) {
    body.push(new Paragraph({
      children: [new TextRun({ text: 'No submissions to export.', italics: true })],
    }));
  } else {
    submissions.forEach((submission, idx) => {
      const form = formsById?.[submission.form_id] || null;
      body.push(...buildSubmissionSection({
        submission,
        form,
        selectedOptions,
        resolvers,
        isLast: idx === submissions.length - 1,
      }));
    });
  }

  const doc = new Document({
    creator: 'iConnect',
    title: documentTitle,
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 },
        },
      },
    },
    sections: [{
      properties: {},
      footers: { default: buildFooter() },
      children: body,
    }],
  });

  return Packer.toBlob(doc);
}

export async function downloadSubmissionsDocx(args) {
  const blob = await renderSubmissionsDocx(args);
  const { saveAs } = await import('file-saver');
  saveAs(blob, args.fileName);
  return blob;
}
