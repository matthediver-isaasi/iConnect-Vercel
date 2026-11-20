import { randomUUID } from 'node:crypto';
export const tenantId = '22222222-2222-4222-8222-222222222222';
export const objectId = '11111111-1111-4111-8111-111111111111';
export const report = { id: 'r_report', name: 'Department report', config: { version: 2, start_object_id: objectId,
  start_endpoint: { kind: 'custom_object', customObjectId: objectId }, grain_path: [], include_empty: true,
  columns: [{ id: 'name', kind: 'field', field: 'id', path: [], label: 'Department' }] } };
export function reportSharingDb() {
  const tables = {
    custom_object_definition: [{ id: objectId, tenant_id: tenantId, status: 'active' }],
    system_settings: [{ id: 'settings', tenant_id: tenantId, setting_key: `custom_object_reports_${objectId}`,
      setting_value: JSON.stringify({ reports: [report] }) }],
    custom_object_report_share: [], custom_object_report_share_grant: [],
    custom_object_report_sort_job: [], custom_object_report_sort_row: [],
  };
  const calls = [];
  const db = { tables, calls, beforeUpdate: null, from(table) { return new Query(table); },
    async rpc(name, args) { calls.push({ name, args }); return { data: name === 'consume_sales_quote_public_rate_limit' ? false : null, error: null }; } };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.size = Infinity; this.from = 0; }
    select() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    like(k, v) { const re = new RegExp(`^${v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`); this.filters.push(r => re.test(r[k] || '')); return this; }
    is(k, v) { this.filters.push(r => (r[k] ?? null) === v); return this; }
    lt(k, v) { this.filters.push(r => r[k] < v); return this; }
    gte(k, v) { this.filters.push(r => r[k] >= v); return this; }
    in(k, v) { this.filters.push(r => v.includes(r[k])); return this; }
    order() { return this; }
    range(from, end) { this.from = from; this.size = end - from + 1; return this; }
    limit(n) { this.size = n; return this; }
    insert(value) { this.inserted = value; return this; }
    update(value) { this.updated = value; return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.one = true; return this; }
    then(resolve, reject) {
      try {
        tables[this.table] ||= [];
        if (this.updated && db.beforeUpdate) { const f = db.beforeUpdate; db.beforeUpdate = null; f(); }
        let rows;
        if (this.inserted) {
          const values = Array.isArray(this.inserted) ? this.inserted : [this.inserted];
          rows = values.map(value => ({ id: randomUUID(), claim_token: null, chunk_size: 200,
            next_page: 1, processed: 0, total: 0, ...structuredClone(value) }));
          tables[this.table].push(...rows);
        } else {
          rows = tables[this.table].filter(row => this.filters.every(f => f(row)));
          if (this.updated) rows.forEach(row => Object.assign(row, structuredClone(this.updated)));
        }
        rows = rows.slice(this.from, this.from + this.size).map(row => structuredClone(row));
        resolve({ data: this.one ? rows[0] || null : rows, error: null });
      } catch (error) { reject(error); }
    }
  }
  return db;
}
