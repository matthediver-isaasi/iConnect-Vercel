import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOrganisationDirectoryMemberCounts } from './organisationDirectoryMemberCounts.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const objectId = '10000000-0000-4000-8000-000000000001';
const recordId = '80000000-0000-4000-8000-000000000001';
const relationshipId = '30000000-0000-4000-8000-000000000001';

function database(seed, ranges) {
  const tables = Object.fromEntries(Object.entries(seed).map(([table, rows]) => [
    table,
    rows.map((row) => structuredClone(row)),
  ]));
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.window = null;
      this.orders = [];
    }
    select() { return this; }
    eq(column, value) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    is(column, value) {
      this.filters.push((row) => value === null ? row[column] == null : row[column] === value);
      return this;
    }
    in(column, values) {
      const allowed = new Set(values);
      this.filters.push((row) => allowed.has(row[column]));
      return this;
    }
    or() { return this; }
    not() { return this; }
    order(column, { ascending = true } = {}) {
      this.orders.push({ column, ascending });
      return this;
    }
    range(from, to) {
      this.window = [from, to];
      return this;
    }
    then(resolve, reject) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
    execute() {
      if (this.table === 'custom_object_relationship' && this.window) {
        ranges.push(this.window);
      }
      let rows = (tables[this.table] || []).filter((row) =>
        this.filters.every((filter) => filter(row)));
      if (this.table !== 'custom_object_relationship') {
        for (const { column, ascending } of this.orders) {
          rows = [...rows].sort((left, right) => {
            const compared = String(left[column] ?? '').localeCompare(String(right[column] ?? ''));
            return ascending ? compared : -compared;
          });
        }
      }
      if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
      return { data: structuredClone(rows), error: null };
    }
  }
  return { from: (table) => new Query(table) };
}

test('member count pager probes beyond an exact 100,000-row edge boundary', async () => {
  const edgeCount = 100_000;
  const ranges = [];
  const db = database({
    custom_object_relationship_definition: [{
      id: relationshipId,
      tenant_id: tenantId,
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'member',
      target_custom_object_id: null,
      status: 'active',
      archived_at: null,
    }],
    custom_object_relationship: Array.from({ length: edgeCount }, (_, index) => ({
      id: `edge-${String(index).padStart(6, '0')}`,
      tenant_id: tenantId,
      relationship_definition_id: relationshipId,
      source_record_id: recordId,
      target_record_id: 'member-1',
      archived_at: null,
    })),
    member: [{
      id: 'member-1',
      tenant_id: tenantId,
      organization_id: 'org-1',
      email: 'member@example.test',
      show_in_directory: true,
      login_enabled: true,
    }],
  }, ranges);
  const result = await resolveOrganisationDirectoryMemberCounts({
    db,
    context: { tenantId },
    organizationIds: ['org-1'],
    fields: [{
      key: 'object-field',
      _kind: 'object',
      _source: { object_id: objectId },
    }],
    objectValues: new Map([
      ['object-field', new Map([
        ['org-1', [{ recordId }]],
      ])],
    ]),
  });
  assert.equal(result.recordCounts.get(`org-1:${objectId}:${recordId}`), 1);
  assert.ok(ranges.some(([from, to]) => from === 100_000 && to === 100_000));
});
