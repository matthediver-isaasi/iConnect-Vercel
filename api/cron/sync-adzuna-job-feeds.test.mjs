import test from 'node:test';
import assert from 'node:assert/strict';
import { listEnabledTenantBatch } from './sync-adzuna-job-feeds.js';

class TenantQuery {
  constructor(rows) { this.rows = rows; this.after = null; this.max = Infinity; }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter(row => row[field] === value);
    return this;
  }
  order() { this.rows.sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)); return this; }
  gt(field, value) { this.after = [field, value]; return this; }
  limit(value) { this.max = value; return this; }
  then(resolve) {
    let rows = this.rows;
    if (this.after) rows = rows.filter(row => row[this.after[0]] > this.after[1]);
    resolve({ data: rows.slice(0, this.max), error: null });
  }
}

test('cron tenant batches are ordered and continue after the durable cursor', async () => {
  const rows = [
    { tenant_id: '0003', integration_type: 'adzuna', is_enabled: true },
    { tenant_id: '0001', integration_type: 'adzuna', is_enabled: true },
    { tenant_id: '0002', integration_type: 'adzuna', is_enabled: true },
    { tenant_id: '0004', integration_type: 'adzuna', is_enabled: false },
    { tenant_id: '0005', integration_type: 'zoom', is_enabled: true },
  ];
  const db = { from: () => new TenantQuery([...rows]) };
  assert.deepEqual(
    (await listEnabledTenantBatch(db, '0001')).map(row => row.tenant_id),
    ['0002', '0003']
  );
});