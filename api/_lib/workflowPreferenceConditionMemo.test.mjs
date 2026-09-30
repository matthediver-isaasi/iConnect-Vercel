import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerPreferenceWorkflows } from './workflows.js';
import { supabase } from './database.js';

const condition = (field, expected) => ({
  field_type: 'org_custom',
  field_id: field,
  operator: 'equals',
  value: expected,
});

function fixture(workflows, initialValues, onUpdate = () => {}) {
  const values = { ...initialValues };
  const reads = [];
  const writes = [];
  const originalFrom = supabase.from;
  supabase.from = (table) => {
    const filters = {};
    let update = null;
    let insert = null;
    const chain = {
      select() { return chain; },
      eq(key, value) { filters[key] = value; return chain; },
      in() { return chain; },
      update(value) { update = value; return chain; },
      insert(value) { insert = value; return chain; },
      async maybeSingle() {
        if (table === 'preference_field') return { data: { field_type: 'text' }, error: null };
        if (table === 'organization_preference_value') {
          return { data: { id: filters.field_id, value: values[filters.field_id] }, error: null };
        }
        throw new Error(`unexpected maybeSingle ${table}`);
      },
      async single() {
        if (table === 'organization') return { data: { id: 'org', tenant_id: 'tenant' }, error: null };
        if (table === 'organization_preference_value') {
          reads.push(filters.field_id);
          return { data: Object.hasOwn(values, filters.field_id) ? { value: values[filters.field_id] } : null, error: null };
        }
        throw new Error(`unexpected single ${table}`);
      },
      then(resolve, reject) {
        const result = (() => {
          if (table === 'workflow') return { data: workflows, error: null };
          if (table === 'workflow_log' && insert) return { error: null };
          if (table === 'organization_preference_value' && update) {
            const field = filters.field_id || filters.id;
            writes.push({ field, value: update.value });
            values[field] = update.value;
            onUpdate(values, field);
            return { error: null };
          }
          throw new Error(`unexpected await ${table}`);
        })();
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  };
  return { values, reads, writes, restore: () => { supabase.from = originalFrom; } };
}

test('repeated organization custom conditions share one read per preference evaluation, not across events', async () => {
  const workflows = Array.from({ length: 12 }, (_, i) => ({
    id: `workflow-${i}`,
    name: `workflow-${i}`,
    tenant_id: 'tenant',
    entity_type: 'organization',
    trigger_type: 'record_update',
    conditions: [condition('shared', 'not-the-value'), condition('shared', 'not-the-value')],
    actions: [],
  }));
  const db = fixture(workflows, { shared: 'old' });
  try {
    await triggerPreferenceWorkflows('organization', 'org', 'changed', 'yes', '', 'no');
    assert.deepEqual(db.reads, ['shared']);
    assert.deepEqual(db.writes, []);
    db.values.shared = 'new';
    await triggerPreferenceWorkflows('organization', 'org', 'changed', 'yes', '', 'no');
    assert.deepEqual(db.reads, ['shared', 'shared']);
  } finally {
    db.restore();
  }
});

test('a preference revert invalidates condition reads before the next workflow', async () => {
  const workflows = [
    {
      id: 'revert', name: 'revert', tenant_id: 'tenant',
      trigger_type: 'field_change', trigger_config: { field_type: 'custom', field_id: 'changed', operator: 'equals', value: 'new' },
      conditions: [condition('shared', 'fresh')], revert_trigger_on_condition_fail: true,
    },
    {
      id: 'next', name: 'next', tenant_id: 'tenant',
      trigger_type: 'record_update', conditions: [condition('shared', 'stale')],
    },
  ];
  // Model a database-side change to another preference during the revert.
  const db = fixture(workflows, { shared: 'stale', changed: 'new' }, (values) => { values.shared = 'fresh'; });
  try {
    const result = await triggerPreferenceWorkflows('organization', 'org', 'changed', 'new', '', 'old');
    assert.deepEqual(db.reads, ['shared', 'shared']);
    assert.deepEqual(db.writes, [{ field: 'changed', value: 'old' }]);
    assert.equal(result.reverts.length, 1);
  } finally {
    db.restore();
  }
});

test('a workflow custom-field action is visible to later record_update conditions in the same evaluation', async () => {
  const workflows = [
    {
      id: 'setter', name: 'setter', tenant_id: 'tenant',
      trigger_type: 'record_update',
      conditions: [condition('shared', 'old')],
      actions: [{ type: 'update_field', config: { field_type: 'custom', field_id: 'shared', value: 'new' } }],
    },
    {
      id: 'reader', name: 'reader', tenant_id: 'tenant',
      trigger_type: 'record_update',
      conditions: [condition('shared', 'old')],
      actions: [],
    },
  ];
  const db = fixture(workflows, { shared: 'old' });
  try {
    await triggerPreferenceWorkflows('organization', 'org', 'changed', 'yes', '', 'no');
    // The action's own before-value lookup uses maybeSingle, not the condition
    // reader. The second read must come from the later workflow, after the write.
    assert.deepEqual(db.reads, ['shared', 'shared']);
    assert.deepEqual(db.writes, [{ field: 'shared', value: 'new' }]);
    assert.equal(db.values.shared, 'new');
  } finally {
    db.restore();
  }
});