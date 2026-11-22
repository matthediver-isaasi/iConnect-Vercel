import React, { useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { REPORT_FILTER_OPERATORS } from '../../../../shared/reportViewerQuery.mjs';

export default function ReportViewerFilters({ columns, query, onChange, updating }) {
  const [draftOperators, setDraftOperators] = useState({});
  const changeFilter = (column, patch) => {
    const next = query.filters.filter(filter => filter.column !== column);
    const previous = query.filters.find(filter => filter.column === column) || { column, operator: draftOperators[column] || 'contains', value: '' };
    const filter = { ...previous, ...patch };
    if (filter.value.trim() || ['empty', 'not_empty'].includes(filter.operator)) next.push(filter);
    onChange({ ...query, filters: next.sort((a, b) => a.column - b.column) });
  };
  return <section aria-label="Search and filter report" className="mb-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-center gap-3">
      <label className="relative min-w-[16rem] flex-1">
        <span className="sr-only">Search all report fields</span>
        <Search aria-hidden="true" className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
        <Input type="search" value={query.search} maxLength={200} className="pl-9"
          placeholder="Search all report fields…" onChange={event => onChange({ ...query, search: event.target.value })} />
      </label>
      <Button type="button" variant="outline" onClick={() => { setDraftOperators({}); onChange({ search: '', filters: [] }); }}
        disabled={!query.search && !query.filters.length}><X className="mr-1 h-4 w-4" />Clear search and filters</Button>
    </div>
    <details>
      <summary className="cursor-pointer text-sm font-medium text-teal-800">Filter by field{query.filters.length ? ` (${query.filters.length})` : ''}</summary>
      <p className="mt-2 text-xs text-slate-500">Search matches any displayed field. Field filters are combined, and ignore case. Up to 20 filters.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {columns.map((column, index) => {
          const filter = query.filters.find(item => item.column === index);
          const blank = ['empty', 'not_empty'].includes(filter?.operator);
          const label = column.label || `Column ${index + 1}`;
          return <div key={index} className="space-y-2 rounded-md border border-slate-100 p-3">
            <p className="text-sm font-medium text-slate-700">{label}</p>
            <select aria-label={`Match type for ${label}`} className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm"
              value={filter?.operator || draftOperators[index] || 'contains'}
              disabled={!filter && query.filters.length >= 20}
              onChange={event => {
                setDraftOperators(previous => ({ ...previous, [index]: event.target.value }));
                changeFilter(index, { operator: event.target.value,
                  value: ['empty', 'not_empty'].includes(event.target.value) ? '' : filter?.value || '' });
              }}>
              {REPORT_FILTER_OPERATORS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <Input aria-label={`Filter ${label}`} value={filter?.value || ''} maxLength={200}
              disabled={blank || (!filter && query.filters.length >= 20)} placeholder={blank ? 'No value needed' : `Filter ${label}…`}
              onChange={event => changeFilter(index, { value: event.target.value })} />
            {filter && <button type="button" className="text-xs text-teal-800 underline" aria-label={`Clear filter for ${label}`}
              onClick={() => {
                setDraftOperators(previous => ({ ...previous, [index]: 'contains' }));
                onChange({ ...query, filters: query.filters.filter(item => item.column !== index) });
              }}>Clear field filter</button>}
          </div>;
        })}
      </div>
    </details>
    {updating && <p role="status" className="text-xs text-slate-500">Updating matching rows…</p>}
  </section>;
}
