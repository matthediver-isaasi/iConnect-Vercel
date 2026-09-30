import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EXPECTED_SHA256,
  FILE,
  duplicateGroups,
  parseSource,
  sourceSummary,
} from "./workforce-csv-source.mjs";

test("parses the pinned source and reports its fingerprint", async () => {
  const bytes = await readFile(FILE);
  const source = parseSource(bytes);
  assert.equal(source.fingerprint, EXPECTED_SHA256);
  assert.equal(source.reportingYear, "2025/26");
  assert.equal(source.rows.length, 1242);
  assert.equal(new Set(source.rows.map((row) => row.departmentId)).size, 136);
  assert.deepEqual(source.rows[0], {
    sourceRow: 2,
    departmentId: "42ff2358-a27e-4abd-92df-6f6a3f406819",
    originalLegacy: "No",
    occupiedHundredths: 80,
    data: {
      row_name: "2025/26",
      staff_group: "Clinical Scientist",
      grade: "Band 8d",
      occupied_wte: 0.8,
      legacy_vacancy_reported: "No",
    },
  });
  assert.equal(source.rows.find((row) => row.originalLegacy === "").data.legacy_vacancy_reported, "No");
  assert.ok(source.rows.every((row) => !("vacant_wte" in row.data)));
});

test("source statistics retain raw and normalized duplicate semantics", async () => {
  const source = parseSource(await readFile(FILE));
  const summary = sourceSummary(source);
  assert.equal(summary.totalRows, 1242);
  assert.equal(summary.totalDepartments, 136);
  assert.equal(summary.totalOccupiedHundredths, 170814);
  assert.equal(summary.totalWte, 1708.14);
  assert.equal(summary.zeroOccupiedRows, 11);
  assert.deepEqual(summary.vacancyCounts.original, { "": 53, Yes: 101, No: 1088 });
  assert.deepEqual(summary.vacancyCounts.normalized, { Yes: 101, No: 1141 });
  assert.deepEqual(summary.exactDuplicates.original, { groups: 82, rows: 210, beyondFirst: 128 });
  assert.deepEqual(summary.exactDuplicates.normalized, { groups: 84, rows: 216, beyondFirst: 132 });
  assert.deepEqual(summary.departmentYearStaffGrade, { groups: 155, rows: 425, beyondFirst: 270 });
  assert.deepEqual(summary.alternativeExactDedupTotals.original, {
    rows: 1114,
    occupiedHundredths: 159999,
    occupiedWte: 1599.99,
  });
  assert.deepEqual(summary.alternativeExactDedupTotals.normalized, {
    rows: 1110,
    occupiedHundredths: 159639,
    occupiedWte: 1596.39,
  });
  assert.equal(summary.duplicateGroups.original.length, 82);
  assert.equal(summary.duplicateGroups.normalized.length, 84);
  assert.deepEqual(summary.duplicateGroups.original[0].sourceRows, [27, 28]);
});

test("duplicateGroups preserves all rows and supports original mode", async () => {
  const source = parseSource(await readFile(FILE));
  const normalized = duplicateGroups(source.rows);
  const original = duplicateGroups(source.rows, "original");
  assert.equal(normalized.reduce((sum, group) => sum + group.rows.length, 0), 216);
  assert.equal(original.reduce((sum, group) => sum + group.rows.length, 0), 210);
  assert.deepEqual(original[0].rows.map((row) => row.sourceRow), original[0].sourceRows);
  assert.throws(() => duplicateGroups(source.rows, "bad"), /mode must be/);
});

test("rejects a changed fingerprint by default, but permits local fixtures", () => {
  const fixture = Buffer.from(
    "Department_UUID,Reporting_Year,Staff_Group,Grade,Occupied_Nuclear_Medicine_WTE,Legacy_Vacancy_Reported\n" +
      "42ff2358-a27e-4abd-92df-6f6a3f406819,2025/26,Clinical Scientist,Band 1,1.25,\n",
  );
  assert.throws(() => parseSource(fixture), /fingerprint mismatch/);
  const source = parseSource(fixture, { verifyFingerprint: false });
  assert.equal(source.rows[0].occupiedHundredths, 125);
  assert.equal(source.rows[0].data.legacy_vacancy_reported, "No");
});

test("maps legacy 0x96 to an en dash and rejects other legacy high bytes", () => {
  const prefix =
    "Department_UUID,Reporting_Year,Staff_Group,Grade,Occupied_Nuclear_Medicine_WTE,Legacy_Vacancy_Reported\n" +
    "42ff2358-a27e-4abd-92df-6f6a3f406819,2025/26,Clinical Practitioner ";
  const suffix = " Technologist,Band 1,1.00,No\n";
  const source = parseSource(
    Buffer.concat([Buffer.from(prefix, "ascii"), Buffer.from([0x96]), Buffer.from(suffix, "ascii")]),
    { verifyFingerprint: false },
  );
  assert.equal(source.rows[0].data.staff_group, "Clinical Practitioner – Technologist");
  assert.throws(
    () => parseSource(Buffer.from(prefix + "\x80" + suffix, "latin1"), { verifyFingerprint: false }),
    /unexpected non-ASCII byte/,
  );
});

test("enforces headers, year, UUID, staff/grade, and decimal rules", () => {
  const base =
    "Department_UUID,Reporting_Year,Staff_Group,Grade,Occupied_Nuclear_Medicine_WTE,Legacy_Vacancy_Reported\n";
  const row = "42ff2358-a27e-4abd-92df-6f6a3f406819,2025/26,Staff,Band 1,1.00,No\n";
  const fixture = (value) => Buffer.from(base + value);
  assert.throws(
    () => parseSource(fixture(row.replace("1.00", "-0.01")), { verifyFingerprint: false }),
    /non-negative decimal/,
  );
  assert.throws(
    () => parseSource(fixture(row.replace("1.00", "1.000")), { verifyFingerprint: false }),
    /non-negative decimal/,
  );
  assert.throws(
    () => parseSource(fixture(row.replace("2025\/26", "2024\/25")), { verifyFingerprint: false }),
    /Reporting_Year/,
  );
  assert.throws(
    () => parseSource(fixture(row.replace("Band 1", "")), { verifyFingerprint: false }),
    /Grade is required/,
  );
});