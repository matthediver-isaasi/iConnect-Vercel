#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import { FILE, HEADERS, parseSourceBytes } from './bnms-final-source.mjs';

export const ORIGINAL_BLOCKED_ROWS = Object.freeze([
  2, ...Array.from({ length: 26 }, (_, index) => index + 40), 76, 77, 80,
]);
export const EXCLUDED_ROWS = Object.freeze([75, 79]);
export const APPROVED_ROWS = Object.freeze(
  Array.from({ length: 79 }, (_, index) => index + 2)
    .filter((sourceRow) => !ORIGINAL_BLOCKED_ROWS.includes(sourceRow) && !EXCLUDED_ROWS.includes(sourceRow)),
);

const DETAIL_HEADERS = Object.freeze([
  'Source row',
  ...HEADERS,
  'Reconciliation status',
  'Reasons',
  'Conflict evidence',
  'Hierarchy evidence',
  'Matched member IDs',
  'Manual action',
  'Resolution',
  'Notes',
]);
const SUCCESS_STATUSES = new Set(['imported', 'verified', 'committed', 'success', 'succeeded']);
const safeText = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};
const listText = (value) => Array.isArray(value) ? value.map(safeText).join('; ') : safeText(value);
const outcomeStatus = (outcome) => String(outcome?.status || outcome?.outcome || 'not-run').trim().toLowerCase();
const isSuccessful = (outcome) => SUCCESS_STATUSES.has(outcomeStatus(outcome));

function fail(message) {
  throw new Error(message);
}

function validateInputs(source, preflight, outcomes) {
  if (!source || !Array.isArray(source.rows)) fail('Source rows are required.');
  const sourceRows = source.rows.map((row) => row.sourceRow);
  const expectedRows = Array.from({ length: 79 }, (_, index) => index + 2);
  if (JSON.stringify(sourceRows) !== JSON.stringify(expectedRows)) {
    fail('Source must contain worksheet rows 2 through 80 exactly once and in order.');
  }
  for (const row of source.rows) {
    if (!Array.isArray(row.original) || row.original.length !== HEADERS.length) {
      fail(`Source row ${row.sourceRow} must retain all ${HEADERS.length} original cells.`);
    }
  }
  const preflightRows = preflight?.rows;
  if (!Array.isArray(preflightRows)) fail('Fresh preflight rows are required.');
  const preflightByRow = new Map(preflightRows.map((row) => [row.sourceRow, row]));
  if (preflightByRow.size !== 79 || expectedRows.some((row) => !preflightByRow.has(row))) {
    fail('Preflight must reconcile all 79 source rows.');
  }
  for (const row of ORIGINAL_BLOCKED_ROWS) {
    if (preflightByRow.get(row)?.outcome !== 'blocked') {
      fail(`Original blocked row ${row} is not blocked in the supplied preflight.`);
    }
  }
  for (const row of EXCLUDED_ROWS) {
    if (preflightByRow.get(row)?.outcome !== 'user-excluded') {
      fail(`Pinned exclusion row ${row} is not user-excluded in the supplied preflight.`);
    }
  }
  if (!Array.isArray(outcomes)) fail('Execution outcomes are required.');
  const outcomeRows = outcomes.map((outcome) => outcome.sourceRow);
  if (new Set(outcomeRows).size !== outcomeRows.length) fail('Execution outcomes contain duplicate source rows.');
  if (outcomeRows.some((row) => !APPROVED_ROWS.includes(row))) {
    fail('Execution outcomes may only describe the 47 approved rows.');
  }
  return {
    sourceByRow: new Map(source.rows.map((row) => [row.sourceRow, row])),
    preflightByRow,
    outcomeByRow: new Map(outcomes.map((outcome) => [outcome.sourceRow, outcome])),
  };
}

function evidenceFor(preflightRow, outcome) {
  return {
    status: outcomeStatus(outcome || preflightRow),
    reasons: outcome?.reasons ?? preflightRow?.reasons ?? [],
    comparisons: outcome?.comparisons ?? outcome?.conflictEvidence ?? preflightRow?.comparisons ?? [],
    hierarchy: outcome?.hierarchyEvidence ?? preflightRow?.hierarchyEvidence ?? {},
    memberIds: outcome?.memberIds ?? (outcome?.memberId ? [outcome.memberId] : preflightRow?.memberIds ?? []),
  };
}

function detailRow(sourceRow, evidence, editable = false) {
  return [
    String(sourceRow.sourceRow),
    ...sourceRow.original.map(safeText),
    evidence.status,
    listText(evidence.reasons),
    safeText(evidence.comparisons),
    safeText(evidence.hierarchy),
    listText(evidence.memberIds),
    editable ? '' : 'No action permitted',
    '',
    '',
  ];
}

function styleDetailSheet(worksheet) {
  worksheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
  worksheet.autoFilter = { from: 'A1', to: `${worksheet.getColumn(DETAIL_HEADERS.length).letter}1` };
  worksheet.getRow(1).height = 34;
  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.numFmt = '@';
      cell.alignment = { ...cell.alignment, vertical: 'top', wrapText: true };
      if (rowNumber > 1) {
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9E2F3' } } };
      }
    });
  });
  worksheet.columns.forEach((column, index) => {
    column.width = index === 0 ? 12
      : index <= HEADERS.length ? 22
        : [24, 25, 26, 27, 28, 29].includes(index) ? 34 : 22;
  });
}

function addDetailSheet(workbook, name, rows) {
  const worksheet = workbook.addWorksheet(name, {
    properties: { defaultRowHeight: 30 },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  worksheet.addRow(DETAIL_HEADERS);
  rows.forEach((row) => worksheet.addRow(row));
  styleDetailSheet(worksheet);
  return worksheet;
}

function executionEvidence(sourceRow, preflightByRow, outcomeByRow) {
  if (EXCLUDED_ROWS.includes(sourceRow)) {
    return evidenceFor(preflightByRow.get(sourceRow), {
      status: 'user-excluded',
      reasons: ['Pinned user exclusion; no import attempted'],
    });
  }
  if (ORIGINAL_BLOCKED_ROWS.includes(sourceRow)) {
    return evidenceFor(preflightByRow.get(sourceRow), {
      status: 'blocked-original',
      reasons: preflightByRow.get(sourceRow)?.reasons,
    });
  }
  return evidenceFor(preflightByRow.get(sourceRow), outcomeByRow.get(sourceRow));
}

function workbookMatrices(workbook) {
  return workbook.worksheets.map((worksheet) => ({
    name: worksheet.name,
    values: Array.from({ length: worksheet.rowCount }, (_, rowIndex) =>
      Array.from({ length: worksheet.columnCount }, (_, columnIndex) => {
        const cell = worksheet.getCell(rowIndex + 1, columnIndex + 1);
        if (cell.type === ExcelJS.ValueType.Formula || (cell.value && typeof cell.value === 'object' && 'formula' in cell.value)) {
          fail(`Formula found at ${worksheet.name}!${cell.address}.`);
        }
        return safeText(cell.value);
      })),
  }));
}

export async function verifyWorkbook(file, expectedMatrices) {
  // Read back with SheetJS, independently of the ExcelJS writer. In addition to
  // comparing every cell, reject any formula token in the resulting workbook.
  const reopened = XLSX.readFile(file, { cellFormula: true, cellText: false, raw: true });
  const actualMatrices = reopened.SheetNames.map((name) => {
    const worksheet = reopened.Sheets[name];
    for (const [address, cell] of Object.entries(worksheet)) {
      if (!address.startsWith('!') && cell?.f != null) fail(`Formula found at ${name}!${address}.`);
    }
    return {
      name,
      values: XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        raw: true,
        defval: '',
        blankrows: true,
      }).map((row) => row.map(safeText)),
    };
  });
  if (JSON.stringify(actualMatrices) !== JSON.stringify(expectedMatrices)) {
    fail('Independent XLSX readback did not reproduce every worksheet cell.');
  }
  return {
    sheets: Object.fromEntries(actualMatrices.map((sheet) => [sheet.name, Math.max(0, sheet.values.length - 1)])),
    cells: actualMatrices.reduce((total, sheet) =>
      total + sheet.values.reduce((count, row) => count + row.length, 0), 0),
  };
}

export async function generateWorkbook({ source, preflight, outcomes, summary = {} }, outputPath) {
  const { sourceByRow, preflightByRow, outcomeByRow } = validateInputs(source, preflight, outcomes);
  const resolved = path.resolve(outputPath);
  if (resolved.split(path.sep).includes('public')) fail('Private exception workbooks cannot be written under a public directory.');
  const directory = path.dirname(resolved);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const newlyBlocked = APPROVED_ROWS.filter((sourceRow) => !isSuccessful(outcomeByRow.get(sourceRow)));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'iConnect guarded BNMS import';
  workbook.created = new Date(0);
  workbook.modified = new Date(0);
  workbook.calcProperties.fullCalcOnLoad = false;

  const summarySheet = workbook.addWorksheet('Summary');
  const summaryRows = [
    ['BNMS final member import — private reconciliation', ''],
    ['Source fingerprint', source.fingerprint || ''],
    ['Preflight generated at', preflight.generatedAt || ''],
    ['Original blocked', String(ORIGINAL_BLOCKED_ROWS.length)],
    ['Pinned exclusions', String(EXCLUDED_ROWS.length)],
    ['Approved cohort', String(APPROVED_ROWS.length)],
    ['Approved imported / verified', String(APPROVED_ROWS.length - newlyBlocked.length)],
    ['Newly blocked / not completed', String(newlyBlocked.length)],
    ['Execution summary', safeText(summary)],
    ['Handling', 'Contains personal data. Keep private; do not publish or commit.'],
  ];
  summaryRows.forEach((row) => summarySheet.addRow(row));
  summarySheet.getColumn(1).width = 36;
  summarySheet.getColumn(2).width = 90;
  summarySheet.eachRow((row, rowNumber) => row.eachCell({ includeEmpty: true }, (cell) => {
    cell.numFmt = '@';
    cell.alignment = { vertical: 'top', wrapText: true };
    if (rowNumber === 1) {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };
    }
  }));

  addDetailSheet(workbook, 'Original blocked', ORIGINAL_BLOCKED_ROWS.map((sourceRow) =>
    detailRow(sourceByRow.get(sourceRow), evidenceFor(preflightByRow.get(sourceRow)), true)));
  addDetailSheet(workbook, 'Exclusions', EXCLUDED_ROWS.map((sourceRow) =>
    detailRow(sourceByRow.get(sourceRow), executionEvidence(sourceRow, preflightByRow, outcomeByRow))));
  addDetailSheet(workbook, 'Newly blocked', newlyBlocked.map((sourceRow) =>
    detailRow(sourceByRow.get(sourceRow), executionEvidence(sourceRow, preflightByRow, outcomeByRow), true)));
  addDetailSheet(workbook, 'Execution', Array.from({ length: 79 }, (_, index) => index + 2).map((sourceRow) =>
    detailRow(sourceByRow.get(sourceRow), executionEvidence(sourceRow, preflightByRow, outcomeByRow))));

  const expectedMatrices = workbookMatrices(workbook);
  await workbook.xlsx.writeFile(resolved);
  chmodSync(resolved, 0o600);
  const verification = await verifyWorkbook(realpathSync(resolved), expectedMatrices);
  return { outputPath: resolved, newlyBlocked, verification };
}

export function finalInputs(source, result, replay) {
  const assert = (condition, message) => { if (!condition) fail(message); };
  assert(result?.fingerprint === source.fingerprint && replay?.fingerprint === source.fingerprint,
    'Result/replay source fingerprint mismatch.');
  assert(result.project === replay.project && result.tenant === replay.tenant,
    'Result/replay destination mismatch.');
  assert(result.verification?.committed === true && result.verification?.zeroWriteReplay === true
    && result.verification?.preExistingPreserved === true && result.verification?.accessDisabled === true,
  'Committed result verification is incomplete.');
  assert(replay.verification?.committed === true && replay.verification?.zeroWriteReplay === true
    && replay.verification?.preExistingPreserved === true && replay.verification?.accessDisabled === true,
  'Replay verification is incomplete.');
  assert(result.counts?.inserted === 47 && result.counts?.['held-original'] === 30 && result.counts?.excluded === 2,
    'Committed result counts do not match 47/30/2.');
  assert(replay.counts?.['already-imported'] === 47 && replay.counts?.['held-original'] === 30
    && replay.counts?.excluded === 2,
  'Replay result counts do not match 47/30/2.');
  const resultByRow = new Map(result.execution.map((row) => [row.sourceRow, row]));
  const replayByRow = new Map(replay.execution.map((row) => [row.sourceRow, row]));
  const outcomes = APPROVED_ROWS.map((sourceRow) => {
    const committed = resultByRow.get(sourceRow);
    const verified = replayByRow.get(sourceRow);
    assert(committed?.outcome === 'inserted' && verified?.outcome === 'already-imported',
      `Approved row ${sourceRow} is not committed and zero-write replayed.`);
    assert(committed.memberId === verified.memberId, `Approved row ${sourceRow} member identity changed on replay.`);
    return {
      sourceRow,
      status: 'imported',
      memberId: committed.memberId,
      reasons: ['Committed insert; independently confirmed already imported by zero-write replay'],
    };
  });
  return {
    source,
    preflight: result.preflight,
    outcomes,
    summary: {
      execution: result.counts,
      replay: replay.counts,
      verification: result.verification,
      migrations: result.preflight?.migrations || 'None expected or applied',
      regionalRuleApproval: result.authorization?.allowExistingRegionalRules === true
        ? 'User approved existing supported regional rules, queueing, and rechecking of existing assignments.'
        : 'Not approved',
      privacy: 'Contains personal data. Keep private and do not commit or publish. The source workbook existed in inherited shared history before this task; this export does not purge that history.',
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length) fail('No arguments supported; fixed pinned private inputs and output only.');
  const directory = path.resolve('exports/bnms-final-import');
  const source = parseSourceBytes(readFileSync(FILE));
  const result = JSON.parse(readFileSync(path.join(directory, 'result.json'), 'utf8'));
  const replay = JSON.parse(readFileSync(path.join(directory, 'replay-result.json'), 'utf8'));
  const output = path.join(directory, 'BNMS-private-exceptions.xlsx');
  const generated = await generateWorkbook(finalInputs(source, result, replay), output);
  console.log(JSON.stringify({
    file: generated.outputPath,
    sheets: generated.verification.sheets,
    newlyBlocked: generated.newlyBlocked.length,
    privacy: 'Private ignored export; do not publish or commit.',
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Private workbook export failed: ${error.message}`);
    process.exitCode = 1;
  });
}