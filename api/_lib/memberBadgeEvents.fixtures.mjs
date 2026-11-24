// In-memory PostgREST-shaped fixture; no external database access.
export function badgeDatabase(tables = {}, errors = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const query = {
        select(value) { call.select = value; return this; },
        eq(key, value) { call.filters.push([key, value]); return this; },
        is(key, value) { call.filters.push([key, value]); return this; },
        in(key, value) { call.filters.push([key, value]); return this; },
        order() { return this; },
        maybeSingle() { call.single = true; return this; },
        range(start, end) { call.range = [start, end]; return this; },
        then(resolve) {
          let rows = (tables[table] || []).filter(row => call.filters.every(([key, value]) => {
            const actual = key === 'badge.is_active' ? row.badge?.is_active !== false : row[key];
            return Array.isArray(value) ? value.includes(actual) : actual === value;
          }));
          if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
          resolve({ data: call.single ? rows[0] || null : rows, error: errors[table] || null });
        },
      };
      return query;
    },
  };
}
