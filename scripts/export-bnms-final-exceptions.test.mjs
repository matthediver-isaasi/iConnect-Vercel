import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { HEADERS } from './bnms-final-source.mjs';
import {
  APPROVED_ROWS, EXCLUDED_ROWS, ORIGINAL_BLOCKED_ROWS, finalInputs, generateWorkbook, verifyWorkbook,
} from './export-bnms-final-exceptions.mjs';

function fixture() {
  const rows = Array.from({ length: 79 }, (_, index) => {
    const sourceRow = index + 2;
    const original = Array.from({ length: HEADERS.length }, (unused, column) => `r${sourceRow}c${column + 1}`);
    original[0] = String(90000000 + sourceRow);
    original[8] = `person${sourceRow}@example.invalid`;
    original[10] = sourceRow === 3 ? '=1+1' : `07000 ${String(sourceRow).padStart(6, '0')}`;
    return { sourceRow, original };
  });
  const preflightRows = rows.map(({ sourceRow }) => ({
    sourceRow,
    outcome: EXCLUDED_ROWS.includes(sourceRow)
      ? 'user-excluded'
      : ORIGINAL_BLOCKED_ROWS.includes(sourceRow) ? 'blocked' : 'ready-new',
    reasons: ORIGINAL_BLOCKED_ROWS.includes(sourceRow) ? [`Synthetic conflict ${sourceRow}`] : [],
    comparisons: ORIGINAL_BLOCKED_ROWS.includes(sourceRow)
      ? [{ field: 'member.email', action: 'conflict', current: 'existing@example.invalid' }] : [],
    hierarchyEvidence: { currentGroup: null, currentOrganization: null },
    memberIds: ORIGINAL_BLOCKED_ROWS.includes(sourceRow) ? [`member-${sourceRow}`] : [],
  }));
  const outcomes = APPROVED_ROWS.map((sourceRow) => sourceRow === 3
    ? { sourceRow, status: 'blocked', reasons: ['Fresh identity collision'] }
    : { sourceRow, status: 'imported', memberId: `new-member-${sourceRow}` });
  return {
    source: { fingerprint: 'synthetic-fingerprint', rows },
    preflight: { generatedAt: '2026-09-23T00:00:00.000Z', rows: preflightRows },
    outcomes,
    summary: { transaction: 'synthetic' },
  };
}

test('exports exact cohorts, all original cells, editable evidence, and all-row reconciliation', async () => {
  assert.equal(ORIGINAL_BLOCKED_ROWS.length, 30);
  assert.equal(EXCLUDED_ROWS.length, 2);
  assert.equal(APPROVED_ROWS.length, 47);
  const directory = mkdtempSync(path.join(tmpdir(), 'bnms-final-export-'));
  const output = path.join(directory, 'private', 'exceptions.xlsx');
  const result = await generateWorkbook(fixture(), output);
  assert.deepEqual(result.newlyBlocked, [3]);
  assert.equal(statSync(path.dirname(output)).mode & 0o777, 0o700);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(result.verification.sheets, {
    Summary: 9,
    'Original blocked': 30,
    Exclusions: 2,
    'Newly blocked': 1,
    Execution: 79,
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    'Summary', 'Original blocked', 'Exclusions', 'Newly blocked', 'Execution',
  ]);
  const execution = workbook.getWorksheet('Execution');
  assert.equal(execution.getRow(2).getCell(1).text, '2');
  assert.equal(execution.getRow(3).getCell(12).text, '=1+1');
  assert.notEqual(execution.getRow(3).getCell(12).type, ExcelJS.ValueType.Formula);
  assert.equal(execution.getRow(3).getCell(23).text, 'blocked');
  const blocked = workbook.getWorksheet('Original blocked');
  assert.equal(blocked.getRow(2).getCell(29).text, '');
  assert.equal(blocked.getRow(2).getCell(30).text, '');
  assert.equal(blocked.getRow(2).getCell(25).text.includes('member.email'), true);
});

test('rejects cohort drift, duplicate outcomes, and public destinations', async () => {
  const input = fixture();
  input.preflight.rows.find((row) => row.sourceRow === 40).outcome = 'ready-new';
  await assert.rejects(generateWorkbook(input, '/tmp/private.xlsx'), /Original blocked row 40/);

  const duplicated = fixture();
  duplicated.outcomes.push({ ...duplicated.outcomes[0] });
  await assert.rejects(generateWorkbook(duplicated, '/tmp/private.xlsx'), /duplicate source rows/);

  await assert.rejects(
    generateWorkbook(fixture(), path.resolve('public', 'exceptions.xlsx')),
    /cannot be written under a public directory/,
  );
});

test('independent readback rejects formulas and changed cell values', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bnms-final-readback-'));
  const output = path.join(directory, 'exceptions.xlsx');
  await generateWorkbook(fixture(), output);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  workbook.getWorksheet('Summary').getCell('B2').value = { formula: '1+1', result: 2 };
  await workbook.xlsx.writeFile(output);
  await assert.rejects(verifyWorkbook(output, []), /Formula found/);
});

test('maps only committed inserts with matching zero-write replay to successful outcomes', () => {
  const input = fixture();
  const execution = Array.from({ length: 79 }, (_, index) => {
    const sourceRow = index + 2;
    return ORIGINAL_BLOCKED_ROWS.includes(sourceRow)
      ? { sourceRow, outcome: 'held-original', reasons: ['held'] }
      : EXCLUDED_ROWS.includes(sourceRow)
        ? { sourceRow, outcome: 'excluded', reasons: ['excluded'] }
        : { sourceRow, outcome: 'inserted', memberId: `member-${sourceRow}` };
  });
  const replayExecution = execution.map((row) => row.outcome === 'inserted'
    ? { ...row, outcome: 'already-imported' } : row);
  const verification = {
    committed: true, zeroWriteReplay: true, preExistingPreserved: true, accessDisabled: true,
  };
  const base = {
    fingerprint: input.source.fingerprint,
    project: 'pinned-project',
    tenant: 'pinned-tenant',
    preflight: { ...input.preflight, migrations: 'None expected or applied' },
    verification,
    authorization: { allowExistingRegionalRules: true },
  };
  const result = {
    ...base,
    counts: { inserted: 47, 'held-original': 30, excluded: 2 },
    execution,
  };
  const replay = {
    ...base,
    counts: { 'already-imported': 47, 'held-original': 30, excluded: 2 },
    execution: replayExecution,
  };
  const mapped = finalInputs(input.source, result, replay);
  assert.equal(mapped.outcomes.length, 47);
  assert.ok(mapped.outcomes.every((outcome) => outcome.status === 'imported'));
  assert.match(mapped.summary.regionalRuleApproval, /User approved/);
  replay.execution.find((row) => row.sourceRow === 3).memberId = 'different';
  assert.throws(() => finalInputs(input.source, result, replay), /identity changed/);
});