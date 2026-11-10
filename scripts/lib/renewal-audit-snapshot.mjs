// No live client: every query is evaluated against a captured snapshot.
export function offlineDatabase(tables, capabilities = {}) {
  const field = (r,k) => k.split(/->>?/).reduce((v,p)=>v?.[p],r);
  const reads = new Set();
  const denied = [];
  const db = {
    reads, denied,
    async rpc(name) {
      if (!Object.hasOwn(capabilities, name)) {
        denied.push(`rpc:${name}`);
        throw new Error(`Audit forbids RPC: ${name}`);
      }
      return structuredClone(capabilities[name]);
    },
    from(table) {
      reads.add(table);
      if (!Object.hasOwn(tables, table)) throw new Error(`Evidence not captured: ${table}`);
      const filters = [], orders = [];
      let first = 0, last = Infinity, single = false;
      const q = {
        select() { return q; },
        eq(k, v) { filters.push(r => field(r,k) === v); return q; },
        or(expression) {
          const alternatives=expression.split(',').map(part=>{
            const match=/^([a-z_]+)\.(is|lte|gte)\.(.+)$/.exec(part);
            if(!match)throw new Error('Unsupported audit OR expression');
            const [,key,op,value]=match;
            if(op==='is'&&value!=='null')throw new Error('Unsupported audit IS expression');
            return r=>op==='is' ? r[key]==null : r[key]!=null&&(op==='lte'?r[key]<=value:r[key]>=value);
          });
          filters.push(r=>alternatives.some(f=>f(r)));return q;
        },
        neq(k, v) { filters.push(r => r[k] !== v); return q; },
        is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
        in(k, v) { filters.push(r => v.includes(r[k])); return q; },
        gte(k, v) { filters.push(r => r[k] >= v); return q; },
        lte(k, v) { filters.push(r => r[k] <= v); return q; },
        gt(k, v) { filters.push(r => r[k] > v); return q; },
        lt(k, v) { filters.push(r => r[k] < v); return q; },
        order(k, { ascending = true } = {}) { orders.push([k, ascending]); return q; },
        range(a, b) { first = a; last = b; return q; },
        limit(n) { first = 0; last = n - 1; return q; },
        maybeSingle() { single = true; return q; },
        then(resolve, reject) {
          let rows = tables[table].filter(r => filters.every(f => f(r)));
          rows.sort((a, b) => {
            for (const [key, asc] of orders) {
              const diff = String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
              if (diff) return diff * (asc ? 1 : -1);
            }
            return 0;
          });
          rows = rows.slice(first, last + 1);
          return Promise.resolve(single && rows.length > 1
            ? { data: null, error: { code: 'AUDIT_NONUNIQUE', message: 'Nonunique snapshot evidence' } }
            : { data: structuredClone(single ? rows[0] || null : rows), error: null }).then(resolve, reject);
        },
      };
      for (const op of ['insert', 'update', 'delete', 'upsert']) q[op] = () => {
        denied.push(`${op}:${table}`); throw new Error(`Audit forbids ${op}`);
      };
      return q;
    },
  };
  return db;
}
