import * as XLSX from 'xlsx';
import { NMC_HEADERS, NMC_SHEETS } from './nmcMembershipReport.js';

export const NMC_EXPORT_COLUMNS = {
  'Full and Full Junior': [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 16],
  'Online-only': [0, 1, 2, 10, 16],
};

export function nmcMembershipWorkbook(report) {
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: `BNMS NMC Membership Report — ${report.reportDate} (UTC)` };
  for (const name of NMC_SHEETS) {
    const rows = report.rows.filter(row => row.sheet === name);
    const columns = NMC_EXPORT_COLUMNS[name];
    const sheet = XLSX.utils.aoa_to_sheet([columns.map(c => NMC_HEADERS[c]), ...rows.map(row => columns.map(c => row.cells[c]))]);
    // Explicit string cells: preserve leading zeroes/+ phone prefixes exactly.
    // No formula or hyperlink properties are ever derived from member data.
    rows.forEach((row, r) => columns.forEach((original, c) => {
      sheet[XLSX.utils.encode_cell({ r: r + 1, c })] = { t: 's', v: String(row.cells[original] ?? ''), z: '@' };
    }));
    sheet['!cols'] = columns.map(i => ({ wch: i === 10 ? 36 : i === 0 ? 12 : 26 }));
    sheet['!autofilter'] = { ref: sheet['!ref'] };
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  const summary = [['Journal recipient counts', report.reportDate], [],
    ['Printed journal'], ['Member class', 'Records'],
    ...(report.classCounts?.printed || []).map(c => [c.label, c.count]),
    ['Total printed', report.rows.filter(r => r.sheet === NMC_SHEETS[0]).length], [],
    ['Online-only'], ['Member class', 'Records'],
    ...(report.classCounts?.online || []).map(c => [c.label, c.count]),
    ['Total online-only', report.rows.filter(r => r.sheet === NMC_SHEETS[1]).length]];
  const summarySheet = XLSX.utils.aoa_to_sheet(summary);
  summary.forEach((row, r) => row.forEach((value, c) => {
    if (typeof value === 'string') summarySheet[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: value, z: '@' };
  }));
  summarySheet['!cols'] = [{ wch: 42 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Class counts');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
