import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

function ReportCell({ column, value }) {
  if (column === 'Score' && (value === '' || value == null)) return <span className="awards-help">Not scored</span>;
  if (value === '' || value == null) return <span className="awards-help" aria-label={value === '' ? 'Empty value' : 'Not supplied'}>—</span>;
  if (column === 'Discrepancy' && value === 'Yes') return <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900">Yes</span>;
  if (column === 'Complete' && value === 'No') return <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900">No</span>;
  return <span className={column === 'Comment' || column === 'Answer' ? 'block min-w-40 max-w-lg whitespace-pre-wrap break-words' : 'whitespace-pre-wrap break-words'}>{String(value)}</span>;
}

export default function ReportTable({ rows, columns, section, title, emptyMessage }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize;
  return <section className="space-y-3 min-w-0">
    <div className="flex flex-wrap justify-between items-center gap-3"><h3 className="font-semibold text-sm">{title}</h3><div className="flex items-center gap-2"><Label htmlFor={`report-page-size-${section}`} className="text-xs">Rows per page</Label><select id={`report-page-size-${section}`} className="awards-select !w-auto !min-h-8" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="12">12</option><option value="25">25</option><option value="50">50</option></select></div></div>
    {rows.length ? <div className="overflow-x-auto rounded-lg border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700" role="region" aria-label={`${title}, horizontally scrollable`} tabIndex={0}>
      <table className="w-full text-sm text-left"><caption className="sr-only">{title}. {rows.length} rows match the local display filters. Exports are generated separately from the full server source.</caption>
        <thead className="bg-[var(--awards-tint)]"><tr>{columns.map(column => <th key={column} scope="col" className="px-4 py-3 font-semibold whitespace-nowrap border-b">{column}</th>)}</tr></thead>
        <tbody className="divide-y">{rows.slice(start, start + pageSize).map((row, index) => <tr key={start + index} className="align-top hover:bg-[var(--awards-tint)]">{columns.map(column => <td key={column} className={`px-4 py-3 ${column === 'Exact numerator' || column === 'Exact denominator' || column === 'Criteria version' ? 'font-mono text-xs' : ''}`}><ReportCell column={column} value={row[column]} /></td>)}</tr>)}</tbody>
      </table>
    </div> : <div className="rounded-lg border p-5"><h4 className="text-sm font-medium">No matching rows</h4><p className="awards-help mt-1">{emptyMessage}</p></div>}
    <div className="flex flex-wrap justify-between items-center gap-3"><p className="awards-help" aria-live="polite">{rows.length ? `${start + 1}–${Math.min(start + pageSize, rows.length)} of ${rows.length} matching rows` : '0 matching rows'} · Display pagination only</p><div className="flex items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous rows</Button><span className="awards-help">{current} / {pages}</span><Button type="button" size="sm" variant="outline" disabled={current >= pages} onClick={() => setPage(current + 1)}>Next rows</Button></div></div>
  </section>;
}
