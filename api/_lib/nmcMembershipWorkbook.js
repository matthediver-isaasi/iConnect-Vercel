import * as XLSX from 'xlsx';
import { NMC_HEADERS, NMC_SHEETS } from './nmcMembershipReport.js';

export function nmcMembershipWorkbook(report) {
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: `BNMS NMC Membership Report — ${report.reportDate} (UTC)` };
  for (const name of NMC_SHEETS) {
    const rows = report.rows.filter(row => row.sheet === name);
    const sheet = XLSX.utils.aoa_to_sheet([NMC_HEADERS, ...rows.map(row => row.cells)]);
    // Explicit string cells: preserve leading zeroes/+ phone prefixes exactly.
    // No formula or hyperlink properties are ever derived from member data.
    rows.forEach((row, r) => row.cells.forEach((value, c) => {
      if (c < 13) sheet[XLSX.utils.encode_cell({ r: r + 1, c })] = { t: 's', v: String(value ?? ''), z: '@' };
    }));
    sheet['!cols'] = NMC_HEADERS.map((_, i) => ({ wch: i === 10 ? 36 : i === 13 ? 25 : i === 0 ? 12 : 26 }));
    sheet['!autofilter'] = { ref: sheet['!ref'] };
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
