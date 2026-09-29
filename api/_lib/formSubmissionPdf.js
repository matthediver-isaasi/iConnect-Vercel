// Shared jsPDF form-submission PDF builder (Task #3312).
//
// Extracted from api/contracts/generate-pdf.js so vacancy application PDFs can
// reuse the exact same field-rendering logic (text, lists, yes/no, contact
// details, file names, signatures). The contract endpoint's output remains
// byte-for-byte equivalent in behaviour.

import { jsPDF } from 'jspdf';
import { groupedQuestionPdfAnswers } from './groupedQuestionPdf.js';
import { toWinAnsi } from './pdfWinAnsi.js';
import { loadTenantRelationshipDisplayLabels } from './relationshipDisplayLabels.js';
import {
  collectRelationshipRecordIds,
  formatRelationshipAnswerDisplayValue,
  getSubmissionFieldValue,
  isRelationshipDropdownField,
} from '../../client/src/lib/relationshipDisplayLabels.js';
import { resolveFormNotListedDisplayValue } from '../../shared/formNotListedChoice.js';
import { loadOrganisationGroupNamesForSubmission } from './formOrganisationGroups.js';
import {
  collectRepeatableRelationshipRecordIds,
  collectRepeatableOrganisationIds,
  formatRepeatableCellValue,
  formatRepeatableRowsText,
  isRepeatableRowsField,
  resolveRepeatableOrganisationLabel,
} from '../../shared/repeatableFormRowsFormat.js';
/**
 * Resolve only relationship IDs which occur in the persisted answers under
 * relationship fields from the saved form definition. The underlying loader
 * additionally limits records, definitions and display fields to the tenant
 * and to active/non-archived rows.
 */
export async function loadFormSubmissionRelationshipLabels({
  db,
  tenantId,
  fields,
  submissionData,
}) {
  const savedFields = Array.isArray(fields) ? fields : [];
  const recordIds = [
    ...collectRelationshipRecordIds(savedFields, submissionData),
    ...collectRepeatableRelationshipRecordIds(savedFields, submissionData),
  ];
  return loadTenantRelationshipDisplayLabels(db, tenantId, recordIds);
}

export async function loadFormSubmissionOrganisationLabels({ db, tenantId, fields, submissionData }) {
  const ids = collectRepeatableOrganisationIds(fields, submissionData);
  if (!db || !tenantId || !ids.length) return {};
  const { data, error } = await db.from('organization').select('id, name').eq('tenant_id', tenantId).in('id', ids);
  if (error) throw error;
  return Object.fromEntries((data || []).filter((row) => row?.id).map((row) => [row.id, row.name]));
}

export async function loadFormSubmissionOrganisationGroupLabels({
  db,
  tenantId,
  fields,
  submissionData,
}) {
  return loadOrganisationGroupNamesForSubmission({ db, tenantId, fields, submissionData });
}

/**
 * Pure field formatter exported for direct regression tests.
 */
export function formatFormSubmissionFieldValue(
  field,
  value,
  relationshipLabelsByRecordId = {},
  submissionData = {},
  organisationNamesById = {},
  organisationGroupNamesById = {},
) {
  const displayValue = resolveFormNotListedDisplayValue(field, value, submissionData);
  if (field?.type === 'grouped_question') {
    return groupedQuestionPdfAnswers(field, value)
      .map(({ label, answer }) => `${label}\n${answer}`).join('\n\n') || 'No answers provided';
  }
  if (isRepeatableRowsField(field)) {
    return formatRepeatableRowsText(field, value, {
      submissionData,
      formatCell: (cellValue, child, row) => child?.type === 'relationship_dropdown'
        ? formatRelationshipAnswerDisplayValue(
          child,
          cellValue,
          relationshipLabelsByRecordId,
          submissionData,
          { parentField: field, row },
        )
        : child?.type === 'organisation_dropdown'
          ? resolveRepeatableOrganisationLabel(cellValue, organisationNamesById)
          : formatRepeatableCellValue(cellValue, child),
    });
  }
  if (isRelationshipDropdownField(field)) {
    return formatRelationshipAnswerDisplayValue(
      field,
      value,
      relationshipLabelsByRecordId,
      submissionData,
    );
  }
  if (field?.type === 'organisation_group_dropdown') {
    if (displayValue === null || displayValue === undefined || displayValue === '') return displayValue;
    const resolve = entry => organisationGroupNamesById?.[String(entry)] || 'Unavailable organisation group';
    return Array.isArray(displayValue) ? displayValue.map(resolve).join(', ') : resolve(displayValue);
  }
  return displayValue;
}

/**
 * Build a PDF document from form fields + submission data.
 *
 * @param {object} opts
 * @param {string} opts.title       Document heading (e.g. form name or vacancy title)
 * @param {string} [opts.dateLabel] Grey sub-heading line (e.g. "Signed: 1 May 2026")
 * @param {Array}  opts.fields      Form field definitions ({ id, label, type })
 * @param {object} opts.submissionData  Answers keyed by field id
 * @param {object|Map} [opts.relationshipLabelsByRecordId] Trusted, tenant-scoped relationship labels
 * @param {string} [opts.logPrefix] Prefix for console errors
 * @returns {Buffer} PDF file contents
 */
export function buildFormSubmissionPdf({
  title,
  dateLabel,
  fields,
  submissionData,
  relationshipLabelsByRecordId = {},
  organisationNamesById = {},
  organisationGroupNamesById = {},
  logPrefix = '[formSubmissionPdf]',
}) {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - (margin * 2);
  let yPos = margin;

  // Restrict the new layout to grouped fields; unrelated field presentation
  // remains unchanged. Explicit baselines make paragraph spacing page-safe.
  const lineHeight = 5;
  const bottom = pageHeight - margin - 1;
  const newPage = () => {
    doc.addPage();
    yPos = margin;
  };
  const splitGroupedText = (text, style, indent = 0) => {
    doc.setFontSize(10);
    doc.setFont('helvetica', style);
    // Standard PDF font metrics vary slightly between viewers. Leave a small
    // guard inside the right margin rather than wrapping exactly at its edge.
    const wrapWidth = contentWidth - indent - 3;
    return toWinAnsi(String(text)).replace(/\r\n?/g, '\n').split('\n')
      .flatMap(paragraph => paragraph ? doc.splitTextToSize(paragraph, wrapWidth) : ['']);
  };
  const writeGroupedLines = (lines, style, indent = 0, reserveAfter = 0) => {
    doc.setFont('helvetica', style);
    // Keep a whole heading with the first answer line whenever it fits a page.
    const required = (lines.length - 1) * lineHeight + reserveAfter;
    if (reserveAfter > 0 && required <= bottom - margin && yPos + required > bottom) newPage();
    lines.forEach((line, index) => {
      const reserve = index === lines.length - 1 ? reserveAfter : 0;
      if (yPos + reserve > bottom) newPage();
      doc.text(line, margin + indent, yPos);
      yPos += lineHeight;
    });
  };
  const renderGroupedQuestion = (field, rawValue) => {
    const answers = groupedQuestionPdfAnswers(field, rawValue);
    const blocks = answers.map(({ label, answer }) => ({
      label: splitGroupedText(label, 'bold', 4),
      // Leading blank lines must not strand the heading above an empty answer.
      answer: splitGroupedText(answer.replace(/^\s*\n/, ''), 'normal', 4),
    }));
    const heading = splitGroupedText(field.label || field.id || 'Questions', 'bold');
    const firstBlockLines = blocks.length ? blocks[0].label.length + 1 : 1;
    const headingReserve = Math.min(firstBlockLines * lineHeight, bottom - margin - lineHeight);
    writeGroupedLines(heading, 'bold', 0, headingReserve);
    if (!blocks.length) writeGroupedLines(['No answers provided'], 'normal', 4);
    for (const block of blocks) {
      writeGroupedLines(block.label, 'bold', 4, lineHeight);
      writeGroupedLines(block.answer, 'normal', 4);
      yPos += 3;
    }
    yPos += 3;
  };

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  const titleLines = doc.splitTextToSize(toWinAnsi(title || 'Document'), contentWidth);
  doc.text(titleLines, margin, yPos);
  yPos += titleLines.length * 8 + 4;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  if (dateLabel) {
    doc.text(toWinAnsi(dateLabel), margin, yPos);
  }
  yPos += 15;

  doc.setTextColor(0);

  const allFields = Array.isArray(fields) ? fields : [];
  const data = submissionData || {};

  for (const field of allFields) {
    if (field.type === 'instructions' || field.type === 'heading') {
      continue;
    }

    if (yPos > pageHeight - 40) {
      doc.addPage();
      yPos = margin;
    }

    const rawValue = getSubmissionFieldValue(data, field);
    if (field.type === 'grouped_question') {
      renderGroupedQuestion(field, rawValue);
      continue;
    }
    const value = formatFormSubmissionFieldValue(
      field,
      rawValue,
      relationshipLabelsByRecordId,
      data,
      organisationNamesById,
      organisationGroupNamesById,
    );

    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    const labelLines = doc.splitTextToSize(toWinAnsi(field.label || field.id), contentWidth);
    doc.text(labelLines, margin, yPos);
    yPos += labelLines.length * 5;

    doc.setFont('helvetica', 'normal');

    if (field.type === 'signature') {
      if (value && typeof value === 'object' && value.data) {
        try {
          const base64Data = value.data;
          if (base64Data.startsWith('data:image/png;base64,')) {
            const imgWidth = 60;
            const imgHeight = 20;

            if (yPos + imgHeight > pageHeight - margin) {
              doc.addPage();
              yPos = margin;
            }

            doc.addImage(base64Data, 'PNG', margin, yPos, imgWidth, imgHeight);
            yPos += imgHeight + 3;

            if (value.mode === 'typed' && value.typedName) {
              doc.setFontSize(8);
              doc.setTextColor(100);
              doc.text(toWinAnsi(`(Typed: ${value.typedName})`), margin, yPos);
              doc.setTextColor(0);
              yPos += 4;
            }

            if (value.signed_at) {
              doc.setFontSize(8);
              doc.setTextColor(100);
              const signedAt = new Date(value.signed_at).toLocaleString('en-GB');
              doc.text(toWinAnsi(`Signed at: ${signedAt}`), margin, yPos);
              doc.setTextColor(0);
              yPos += 4;
            }
          }
        } catch (imgError) {
          console.error(`${logPrefix} Error adding signature image:`, imgError);
          doc.text('[Signature]', margin, yPos);
          yPos += 5;
        }
      } else {
        doc.text('[No signature]', margin, yPos);
        yPos += 5;
      }
    } else if (field.type === 'contact') {
      if (value && typeof value === 'object') {
        const contactParts = [];
        if (value.firstName) contactParts.push(value.firstName);
        if (value.lastName) contactParts.push(value.lastName);
        if (value.email) contactParts.push(`<${value.email}>`);
        doc.text(toWinAnsi(contactParts.join(' ') || '-'), margin, yPos);
      } else {
        doc.text('-', margin, yPos);
      }
      yPos += 6;
    } else if (field.type === 'boolean' || field.type === 'terms_conditions') {
      doc.text(value ? 'Yes' : 'No', margin, yPos);
      yPos += 6;
    } else if (field.type === 'file_upload' || field.type === 'file') {
      if (value) {
        const fileInfo = typeof value === 'string' ? value : (value.name || value.filename || '[File attached]');
        doc.text(toWinAnsi(`[Uploaded: ${fileInfo}]`), margin, yPos);
      } else {
        doc.text('[No file uploaded]', margin, yPos);
      }
      yPos += 6;
    } else if (Array.isArray(value)) {
      const arrayText = toWinAnsi(value.join(', ') || '-');
      const lines = doc.splitTextToSize(arrayText, contentWidth);
      doc.text(lines, margin, yPos);
      yPos += lines.length * 5 + 3;
    } else if (typeof value === 'object' && value !== null) {
      const objText = toWinAnsi(JSON.stringify(value, null, 2));
      const lines = doc.splitTextToSize(objText, contentWidth);
      doc.text(lines, margin, yPos);
      yPos += lines.length * 5 + 3;
    } else {
      const textValue = toWinAnsi(value?.toString() || '-');
      const lines = doc.splitTextToSize(textValue, contentWidth);
      doc.text(lines, margin, yPos);
      yPos += lines.length * 5 + 3;
    }

    yPos += 3;
  }

  return Buffer.from(doc.output('arraybuffer'));
}
