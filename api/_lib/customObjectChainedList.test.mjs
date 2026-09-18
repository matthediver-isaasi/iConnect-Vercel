import assert from 'node:assert/strict';
import test from 'node:test';
import { createChainedListService } from './customObjectChainedList.js';

function projectionDb(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const query = {
        select() { return this; },
        eq(column, value) { filters.push((row) => row[column] === value); return this; },
        is(column, value) { filters.push((row) => (row[column] ?? null) === value); return this; },
        in(column, values) {
          calls.push({ table, column, values });
          filters.push((row) => values.includes(row[column]));
          return this;
        },
        order() { return this; },
        range() { return this; },
        then(resolve, reject) {
          return Promise.resolve({
            data: (tables[table] || []).filter((row) => filters.every((filter) => filter(row))),
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

for (const side of ['source', 'target']) {
  test(`chained projector excludes deleted members before shared-prefix traversal and cell counts (${side})`, async () => {
    const tenantId = 'fixture-tenant';
    const other = side === 'source' ? 'target' : 'source';
    const members = [
      { id: 'deleted', first_name: 'Anonymised', email: 'DELETED_abc@DELETED.LOCAL' },
      { id: 'null', first_name: 'Null', email: null },
      { id: 'disabled', first_name: 'Disabled', email: 'disabled@example.test', is_active: false, show_in_directory: false },
      { id: 'named', first_name: 'Deleted', last_name: 'Member', email: 'real@example.test' },
      { id: 'near', first_name: 'Near match', email: 'deleted_@deleted.local' },
      { id: 'foreign', first_name: 'Foreign', email: null, tenant_id: 'another-tenant' },
    ].map((row) => ({ tenant_id: tenantId, ...row }));
    const records = [{ id: 'root' }, { id: 'all-deleted' }];
    const edges = members.flatMap((member) => [{
      id: `root-${member.id}`, tenant_id: tenantId, relationship_definition_id: 'root-member',
      [`${side}_record_id`]: 'root', [`${other}_record_id`]: member.id, archived_at: null,
    }, {
      id: `leaf-${member.id}`, tenant_id: tenantId, relationship_definition_id: 'member-leaf',
      [`${side}_record_id`]: member.id, [`${other}_record_id`]: `leaf-${member.id}`, archived_at: null,
    }]);
    edges.push({
      id: 'all-deleted-edge', tenant_id: tenantId, relationship_definition_id: 'root-member',
      [`${side}_record_id`]: 'all-deleted', [`${other}_record_id`]: 'deleted', archived_at: null,
    });
    const db = projectionDb({
      member: members,
      custom_object_relationship: edges,
      custom_object_record: members.map((member) => ({
        id: `leaf-${member.id}`, tenant_id: tenantId, custom_object_id: 'leaf-object',
        archived_at: null, data: { name: `Leaf ${member.id}` },
      })),
    });
    const memberEndpoint = { kind: 'member', custom_object_id: null };
    const leafEndpoint = { kind: 'custom_object', custom_object_id: 'leaf-object' };
    const firstHop = {
      relationship_definition_id: 'root-member', from_side: side, to_endpoint: memberEndpoint,
    };
    const columns = [{
      id: 'member-label', path: [firstHop], endpoint: memberEndpoint, terminal: { kind: 'label' },
    }, {
      id: 'member-email', path: [firstHop], endpoint: memberEndpoint,
      terminal: { kind: 'field', field_id: 'email', field_key: 'email' },
    }, {
      id: 'leaf-label', path: [firstHop, {
        relationship_definition_id: 'member-leaf', from_side: side, to_endpoint: leafEndpoint,
      }], endpoint: leafEndpoint, terminal: { kind: 'label', field_key: 'name' },
    }];
    const service = createChainedListService({ db, tenantId, isAdmin: true, ErrorClass: Error });
    const result = await service.project(records, columns);
    assert.deepEqual(result[0].chained_values['member-label'], {
      count: 4, records: [{ label: 'Deleted Member' }, { label: 'Disabled' }, { label: 'Near match' }],
    });
    assert.equal(result[0].chained_values['member-email'].count, 4);
    assert.ok(result[0].chained_values['member-email'].records.every((row) =>
      row.label !== 'DELETED_abc@DELETED.LOCAL'));
    assert.deepEqual(result[0].chained_values['leaf-label'], {
      count: 4, records: [{ label: 'Leaf disabled' }, { label: 'Leaf named' }, { label: 'Leaf near' }],
    });
    for (const column of columns) {
      assert.deepEqual(result[1].chained_values[column.id], { count: 0, records: [] });
    }
    const traversal = db.calls.filter((call) => call.table === 'custom_object_relationship');
    assert.ok(traversal.every((call) => !call.values.includes('deleted') && !call.values.includes('foreign')));
    assert.equal(db.calls.filter((call) => call.table === 'member').length, 1,
      'shared prefix caches only eligible member rows for all selected columns');
  });
}