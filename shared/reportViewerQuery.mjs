export const EMPTY_REPORT_QUERY = Object.freeze({ search: '', filters: [] });
export const REPORT_FILTER_OPERATORS = [
  { value: 'contains', label: 'Contains' },
  { value: 'starts_with', label: 'Starts with' },
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
  { value: 'empty', label: 'Is empty' },
  { value: 'not_empty', label: 'Is not empty' },
];
const operators = new Set(REPORT_FILTER_OPERATORS.map(item => item.value));
export function normalizeReportViewerQuery(input, columnCount) {
  if (input == null) return { search: '', filters: [] };
  const fail = () => { throw new Error('Invalid report search or filters. Use up to 20 filters and 200 characters per value.'); };
  if (typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['search', 'filters'].includes(key))) fail();
  const { search = '', filters = [] } = input;
  if (typeof search !== 'string' || search.length > 200 || search.includes('\0')
    || !Array.isArray(filters) || filters.length > 20) fail();
  return { search: search.trim(), filters: filters.map(filter => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)
      || Object.keys(filter).some(key => !['column', 'operator', 'value'].includes(key))
      || !Number.isInteger(filter.column) || filter.column < 0 || filter.column >= columnCount
      || !operators.has(filter.operator)) fail();
    const value = filter.value ?? '';
    if (typeof value !== 'string' || value.length > 200 || value.includes('\0')) fail();
    if (!['empty', 'not_empty'].includes(filter.operator) && !value.trim()) fail();
    return { column: filter.column, operator: filter.operator,
      value: ['empty', 'not_empty'].includes(filter.operator) ? '' : value.trim() };
  }) };
}
export const hasReportViewerQuery = query => Boolean(query?.search || query?.filters?.length);

// Match only the projected, displayed cells. Never inspect IDs, sort values or
// source records. The database predicate follows the same literal-text rules.
export function matchesReportViewerQuery(values, query) {
  const text = value => String(value ?? '').trim().toLowerCase();
  if (query.search && !values.some(value => text(value).includes(text(query.search)))) return false;
  return query.filters.every(filter => {
    const cell = text(values[filter.column]), needle = text(filter.value);
    switch (filter.operator) {
      case 'contains': return cell.includes(needle);
      case 'starts_with': return cell.startsWith(needle);
      case 'equals': return cell === needle;
      case 'not_equals': return cell !== needle;
      case 'empty': return cell === '';
      case 'not_empty': return cell !== '';
      default: return false;
    }
  });
}
