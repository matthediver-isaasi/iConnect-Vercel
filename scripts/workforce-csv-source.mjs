import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

export const FILE = fileURLToPath(
  new URL("../attached_assets/Workforce_data_to_import_05.09.26_1789641429024.csv", import.meta.url),
);
export const EXPECTED_SHA256 =
  "b0c618501cf5af9073d074d6e0474cd772b0978437b3fdab55ff1a66390bf746";

const HEADERS = [
  "Department_UUID",
  "Reporting_Year",
  "Staff_Group",
  "Grade",
  "Occupied_Nuclear_Medicine_WTE",
  "Legacy_Vacancy_Reported",
];
const REPORTING_YEAR = "2025/26";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:\d+)(?:\.(\d{1,2}))?$/;
const sourceMetadata = new WeakMap();

function fail(message) {
  throw new Error(`Invalid workforce CSV: ${message}`);
}

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  throw new TypeError("parseSource expects a Buffer or Uint8Array");
}

/*
 * The supplied export is an old Windows code-page export with 0x96 in place
 * of an en dash.  Do not let Buffer's replacement-character behaviour hide a
 * damaged source file.  Valid UTF-8 is accepted as a convenience for small
 * local test fixtures; a mixed legacy/UTF-8 input is deliberately rejected.
 */
function decodeSource(bytes) {
  const hasLegacyDash = bytes.includes(0x96);
  if (hasLegacyDash) {
    for (const byte of bytes) {
      if (byte >= 0x80 && byte !== 0x96) {
        fail(`unexpected non-ASCII byte 0x${byte.toString(16).padStart(2, "0")}`);
      }
    }
    return Buffer.from(bytes)
      .toString("latin1")
      .replaceAll("\x96", "\u2013");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const byte = [...bytes].find((value) => value >= 0x80);
    fail(
      byte === undefined
        ? "could not decode source text"
        : `unexpected non-ASCII byte 0x${byte.toString(16).padStart(2, "0")}`,
    );
  }
}

function cents(value, sourceRow) {
  const match = DECIMAL.exec(value);
  if (!match) {
    fail(`source row ${sourceRow}: occupied WTE must be a non-negative decimal with at most 2 places`);
  }
  const [whole, fraction = ""] = value.split(".");
  const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(hundredths)) {
    fail(`source row ${sourceRow}: occupied WTE is too large`);
  }
  return hundredths;
}

function lineStart(info, raw) {
  // csv-parse's info.lines is the physical line on which the record ends.
  // raw includes blank lines before a skipped record, so remove those before
  // counting the record's own line endings.
  const recordRaw = raw.replace(/^(?:\r\n|\r|\n)+/, "");
  const lineEndings = (recordRaw.match(/\r\n|\r|\n/g) || []).length;
  return Math.max(1, info.lines - lineEndings + 1);
}

function parseRecords(text) {
  let parsed;
  try {
    parsed = parse(text, {
      columns: false,
      info: true,
      raw: true,
      skip_empty_lines: true,
      bom: false,
      relax_column_count: false,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (parsed.length === 0) fail("the source has no header");
  return parsed;
}

function countBlankSourceLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  // A line terminator is not itself an additional blank source line.
  if (lines.at(-1) === "") lines.pop();
  return lines.filter((line) => line.trim() === "").length;
}

function exactKey(row, mode) {
  const legacy = mode === "original" ? row.originalLegacy : row.data.legacy_vacancy_reported;
  return JSON.stringify([
    row.departmentId,
    row.data.row_name,
    row.data.staff_group,
    row.data.grade,
    row.occupiedHundredths,
    legacy,
  ]);
}

function departmentStaffGradeKey(row) {
  return JSON.stringify([
    row.departmentId,
    row.data.row_name,
    row.data.staff_group,
    row.data.grade,
  ]);
}

function grouped(rows, keyFor) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keyFor(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  });
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      sourceRows: group.map((row) => row.sourceRow),
      rows: group,
    }));
}

/**
 * Parse the pinned local workforce export without performing any I/O other
 * than validation of the bytes supplied by the caller.
 */
export function parseSource(bytes, { verifyFingerprint = true } = {}) {
  const input = asBuffer(bytes);
  const fingerprint = createHash("sha256").update(input).digest("hex");
  if (verifyFingerprint && fingerprint !== EXPECTED_SHA256) {
    throw new Error(
      `Workforce source fingerprint mismatch: expected ${EXPECTED_SHA256}, got ${fingerprint}`,
    );
  }

  const text = decodeSource(input);
  const records = parseRecords(text);
  const header = records[0].record;
  if (
    !Array.isArray(header) ||
    header.length !== HEADERS.length ||
    header.some((value, index) => value !== HEADERS[index])
  ) {
    fail(`expected exactly these six headers: ${HEADERS.join(", ")}`);
  }

  const rows = records.slice(1).map(({ record, info, raw }) => {
    if (!Array.isArray(record) || record.length !== HEADERS.length) {
      fail(`source row ${lineStart(info, raw)} must have exactly six columns`);
    }
    const sourceRow = lineStart(info, raw);
    const [
      departmentId,
      reportingYear,
      staffGroup,
      grade,
      occupiedWteText,
      originalLegacy,
    ] = record;

    if (!UUID.test(departmentId)) {
      fail(`source row ${sourceRow}: Department_UUID is not a UUID`);
    }
    if (reportingYear !== REPORTING_YEAR) {
      fail(`source row ${sourceRow}: Reporting_Year must be ${REPORTING_YEAR}`);
    }
    if (!staffGroup.trim()) fail(`source row ${sourceRow}: Staff_Group is required`);
    if (!grade.trim()) fail(`source row ${sourceRow}: Grade is required`);
    if (originalLegacy !== "" && originalLegacy !== "Yes" && originalLegacy !== "No") {
      fail(`source row ${sourceRow}: Legacy_Vacancy_Reported must be blank, Yes, or No`);
    }

    const occupiedHundredths = cents(occupiedWteText, sourceRow);
    const legacyVacancyReported = originalLegacy === "" ? "No" : originalLegacy;
    return {
      sourceRow,
      departmentId,
      originalLegacy,
      occupiedHundredths,
      data: {
        row_name: reportingYear,
        staff_group: staffGroup,
        grade,
        occupied_wte: occupiedHundredths / 100,
        legacy_vacancy_reported: legacyVacancyReported,
      },
    };
  });

  const source = Object.freeze({
    fingerprint,
    rows,
    reportingYear: REPORTING_YEAR,
  });
  sourceMetadata.set(source, { blankSourceLines: countBlankSourceLines(text) });
  return source;
}

/**
 * Return every exact duplicate group.  "original" distinguishes a blank
 * legacy answer from No; "normalized" applies the approved blank -> No
 * conversion already present in row.data.
 */
export function duplicateGroups(rows, mode = "normalized") {
  if (mode !== "original" && mode !== "normalized") {
    throw new RangeError(`duplicateGroups mode must be "original" or "normalized", got ${mode}`);
  }
  return grouped(rows, (row) => exactKey(row, mode));
}

function totals(rows) {
  const occupiedHundredths = rows.reduce((sum, row) => sum + row.occupiedHundredths, 0);
  return {
    rows: rows.length,
    occupiedHundredths,
    occupiedWte: occupiedHundredths / 100,
  };
}

function dedupedRows(rows, mode) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = exactKey(row, mode);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function exactStats(groups) {
  const rows = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return { groups: groups.length, rows, beyondFirst: rows - groups.length };
}

export function sourceSummary(source) {
  const { rows } = source;
  const originalGroups = duplicateGroups(rows, "original");
  const normalizedGroups = duplicateGroups(rows, "normalized");
  const departmentStaffGradeGroups = grouped(rows, departmentStaffGradeKey);

  const originalVacancy = { "": 0, Yes: 0, No: 0 };
  const normalizedVacancy = { Yes: 0, No: 0 };
  for (const row of rows) {
    originalVacancy[row.originalLegacy] += 1;
    normalizedVacancy[row.data.legacy_vacancy_reported] += 1;
  }

  const total = totals(rows);
  const originalDeduped = totals(dedupedRows(rows, "original"));
  const normalizedDeduped = totals(dedupedRows(rows, "normalized"));
  const exactDuplicates = {
    original: exactStats(originalGroups),
    normalized: exactStats(normalizedGroups),
  };
  const departmentYearStaffGrade = exactStats(departmentStaffGradeGroups);

  return {
    reportingYear: source.reportingYear,
    totalRows: rows.length,
    totalDepartments: new Set(rows.map((row) => row.departmentId)).size,
    totalWte: total.occupiedWte,
    totalOccupiedWte: total.occupiedWte,
    totalOccupiedHundredths: total.occupiedHundredths,
    zeroOccupiedRows: rows.filter((row) => row.occupiedHundredths === 0).length,
    vacancyCounts: {
      original: originalVacancy,
      normalized: normalizedVacancy,
    },
    originalVacancyCounts: originalVacancy,
    normalizedVacancyCounts: normalizedVacancy,
    blankSourceLines: sourceMetadata.get(source)?.blankSourceLines ?? 0,
    exactDuplicates,
    departmentYearStaffGrade,
    duplicateStats: {
      originalExact: exactDuplicates.original,
      normalizedExact: exactDuplicates.normalized,
      departmentYearStaffGrade,
    },
    duplicateGroups: {
      original: originalGroups,
      normalized: normalizedGroups,
      departmentYearStaffGrade: departmentStaffGradeGroups,
    },
    alternativeExactDedupTotals: {
      original: originalDeduped,
      normalized: normalizedDeduped,
    },
  };
}