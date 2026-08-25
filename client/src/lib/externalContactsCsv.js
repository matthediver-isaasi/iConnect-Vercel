// Small dependency-free parser for contact imports. Supports quoted CSV and TSV
// pasted from spreadsheets; callers decide whether the source is a file or paste.
export function parseExternalContacts(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  if (!input.trim()) return { rows: [], error: 'Add at least one row to import.' };
  const delimiter = input.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
  const records = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value === '') quoted = true;
    else if (char === delimiter) { row.push(value.trim()); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(value.trim());
      if (row.some(Boolean)) records.push(row);
      row = []; value = '';
    } else value += char;
  }
  if (quoted) return { rows: [], error: 'A quoted value is not closed.' };
  row.push(value.trim());
  if (row.some(Boolean)) records.push(row);
  if (!records.length) return { rows: [], error: 'Add at least one row to import.' };
  const headings = records[0].map((cell) => cell.toLowerCase().replace(/[_\s]+/g, '_'));
  const headerIndex = {
    first_name: headings.findIndex((heading) => heading === 'first_name'),
    last_name: headings.findIndex((heading) => heading === 'last_name'),
    email: headings.findIndex((heading) => heading === 'email'),
  };
  const hasHeader = headerIndex.email >= 0;
  const data = hasHeader ? records.slice(1) : records;
  const rows = data.map((cells) => ({
    first_name: cells[hasHeader ? headerIndex.first_name : 0] || '',
    last_name: cells[hasHeader ? headerIndex.last_name : 1] || '',
    email: cells[hasHeader ? headerIndex.email : 2] || '',
  })).filter((contact) => contact.first_name || contact.last_name || contact.email);
  return rows.length ? { rows } : { rows: [], error: 'No contact rows were found.' };
}