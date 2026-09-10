import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INCIDENT,
  createWriteGuard,
  recoverTraineeDepartmentLinks,
} from './recover-trainee-department-links.mjs';

const clone = value => structuredClone(value);

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
    this.nullFilters = [];
    this.inFilters = [];
    this.operation = 'select';
    this.payload = null;
  }

  select() { return this; }
  eq(column, value) {
    this.filters.push([column, value]);
    if (column === 'processing_notes') this.store.processingNotesCasValues.push(value);
    return this;
  }
  is(column, value) {
    this.nullFilters.push([column, value]);
    if (column === 'processing_notes') this.store.processingNotesCasNulls.push(value);
    return this;
  }
  in(column, values) { this.inFilters.push([column, values]); return this; }
  order() { return this; }
  range() { return this; }
  update(payload) { this.operation = 'update'; this.payload = payload; return this; }
  insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }

  rows() {
    return (this.store.rows[this.table] || []).filter(row =>
      this.filters.every(([column, value]) => {
        // Model PostgREST's jsonb equality wire value: callers must pass the
        // JSON string, not an array/object (which supabase-js interpolates as
        // "[object Object]").
        if (column === 'processing_notes') {
          return typeof value === 'string' && JSON.stringify(row[column]) === value;
        }
        return String(row[column]) === String(value);
      })
      && this.nullFilters.every(([column, value]) => row[column] === value)
      && this.inFilters.every(([column, values]) => values.map(String).includes(String(row[column]))));
  }

  execute() {
    if (this.operation === 'insert') {
      const values = (Array.isArray(this.payload) ? this.payload : [this.payload]).map(row => ({
        id: `edge-${++this.store.edgeSequence}`,
        archived_at: null,
        ...clone(row),
      }));
      this.store.rows[this.table] ||= [];
      this.store.rows[this.table].push(...values);
      this.store.writes.push({ table: this.table, operation: 'insert', values: clone(values) });
      return { data: values, error: null };
    }
    if (this.operation === 'update') {
      if (this.store.failNotes && this.table === 'form_submission') {
        return { data: null, error: { message: 'injected notes failure' } };
      }
      const matched = this.rows();
      for (const row of matched) Object.assign(row, clone(this.payload));
      if (matched.length) {
        this.store.writes.push({ table: this.table, operation: 'update', values: clone(this.payload) });
      }
      return { data: matched, error: null };
    }
    return { data: this.rows(), error: null };
  }

  async maybeSingle() {
    const result = this.execute();
    return { data: result.data?.[0] || null, error: result.error };
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

function fixture({ typeValue = INCIDENT.organizationType } = {}) {
  const i = INCIDENT;
  const objectId = INCIDENT.departmentObjectId;
  const displayFieldId = 'department-display';
  const orgFieldId = INCIDENT.organizationFieldId;
  const memberDefinition = {
    id: i.memberDepartmentDefinitionId,
    tenant_id: i.tenantId,
    status: 'active',
    source_kind: 'custom_object',
    source_custom_object_id: objectId,
    target_kind: 'member',
    target_custom_object_id: null,
    cardinality: 'many_to_many',
  };
  const orgDefinition = {
    id: i.organizationDepartmentDefinitionId,
    tenant_id: i.tenantId,
    status: 'active',
    source_kind: 'custom_object',
    source_custom_object_id: objectId,
    target_kind: 'organization',
    target_custom_object_id: null,
    cardinality: 'many_to_one',
    show_on_target: true,
  };
  const form = {
    id: i.formId,
    tenant_id: i.tenantId,
    fields: [{
      id: orgFieldId,
      type: 'organisation_dropdown',
      org_filter: {
        mode: 'include',
        type: 'custom',
        field: 'organisation_type',
        values: [
          'Hospital',
          'NHS/HSC hospital or clinical site',
          'Private hospital or imaging centre',
          'Public hospital or clinical site',
          'Commercial or industry organisation',
          'Research or charitable organisation',
        ],
      },
    }, {
      id: i.departmentFieldId,
      type: 'relationship_dropdown',
      selection_mode: 'multiple',
      parent_field_id: orgFieldId,
      relationship_parent_kind: 'organization',
      relationship_parent_side: 'target',
      relationship_definition_id: i.organizationDepartmentDefinitionId,
      related_kind: 'custom_object',
      related_custom_object_id: objectId,
      related_primary_display_field_id: displayFieldId,
    }],
    entity_pipelines: {
      members: [{
        isPrimary: true,
        related_records: [{
          id: 'pinned-department-link',
          source_field_id: i.departmentFieldId,
          relationship_definition_id: i.memberDepartmentDefinitionId,
        }],
      }],
      organisations: [],
    },
  };
  const submission = {
    id: i.submissionId,
    tenant_id: i.tenantId,
    form_id: i.formId,
    created_member_id: i.memberId,
    organization_id: i.organizationId,
    created_organization_id: null,
    processing_notes: [{ kind: 'submitted_relationship_invalid', message: 'Invalid organization selection' }],
    submission_data: {
      [orgFieldId]: i.organizationId,
      [i.departmentFieldId]: [...i.departmentIds],
    },
  };
  const rows = {
    form: [form],
    form_submission: [submission],
    member: [{ id: i.memberId, tenant_id: i.tenantId }],
    organization: [{
      id: i.organizationId,
      tenant_id: i.tenantId,
      name: 'Churchill Hospital',
      country: 'United Kingdom',
    }],
    preference_field: [{
      id: i.organizationTypePreferenceId,
      tenant_id: i.tenantId,
      name: 'organisation_type',
      entity_scope: 'organization',
      field_type: 'select',
      is_active: true,
    }, {
      id: displayFieldId,
      tenant_id: i.tenantId,
      custom_object_id: objectId,
      entity_scope: 'custom_object',
      field_type: 'text',
      name: 'name',
      field_key: 'name',
      is_active: true,
    }],
    organization_preference_value: typeValue == null ? [] : [{
      organization_id: i.organizationId,
      field_id: i.organizationTypePreferenceId,
      value: typeValue,
    }],
    custom_object_definition: [{
      id: objectId,
      tenant_id: i.tenantId,
      status: 'active',
      primary_display_field_id: displayFieldId,
    }],
    custom_object_record: i.departmentIds.map((id, index) => ({
      id,
      tenant_id: i.tenantId,
      custom_object_id: objectId,
      archived_at: null,
      data: { name: `Department ${index + 1}` },
    })),
    custom_object_relationship_definition: [memberDefinition, orgDefinition],
    custom_object_relationship: i.departmentIds.map((id, index) => ({
      id: `parent-${index}`,
      tenant_id: i.tenantId,
      relationship_definition_id: i.organizationDepartmentDefinitionId,
      source_record_id: id,
      target_record_id: i.organizationId,
      archived_at: null,
    })),
  };
  const store = {
    rows,
    writes: [],
    edgeSequence: 0,
    failNotes: false,
    processingNotesCasValues: [],
    processingNotesCasNulls: [],
  };
  return {
    store,
    db: {
      transactionCapable: true,
      from: table => new Query(store, table),
    },
  };
}

async function applyInFakeTransaction(db, store, options = {}) {
  const rowsBefore = clone(store.rows);
  const writesBefore = clone(store.writes);
  try {
    return await recoverTraineeDepartmentLinks({
      db,
      apply: true,
      operatorAuthorized: true,
      ...options,
    });
  } catch (error) {
    store.rows = rowsBefore;
    store.writes = writesBefore;
    throw error;
  }
}

test('blocks clearly while the historically evidenced organisation type is missing', async () => {
  const { db, store } = fixture({ typeValue: null });
  await assert.rejects(
    recoverTraineeDepartmentLinks({ db }),
    /organisation type must be exactly/i,
  );
  assert.equal(store.writes.length, 0);
});

test('blocks a nonempty organisation type that is not the exact evidenced value', async () => {
  const { db, store } = fixture({ typeValue: 'Hospital' });
  await assert.rejects(
    recoverTraineeDepartmentLinks({ db }),
    /must be exactly.*Public hospital or clinical site/i,
  );
  assert.equal(store.writes.length, 0);
});

test('blocks parent organisation eligibility filter drift', async () => {
  const { db, store } = fixture();
  store.rows.form[0].fields[0].org_filter.values.pop();
  await assert.rejects(
    recoverTraineeDepartmentLinks({ db }),
    /parent dropdown.*filter drifted/i,
  );
  assert.equal(store.writes.length, 0);
});

test('default dry-run exercises validation and plans three links with zero writes', async () => {
  const { db, store } = fixture();
  const result = await recoverTraineeDepartmentLinks({ db });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.wouldCreate, 3);
  assert.equal(result.result.linked_count, 3);
  assert.deepEqual(store.writes, []);
});

test('apply rejects a non-transaction-capable database client', async () => {
  const { db, store } = fixture();
  delete db.transactionCapable;
  await assert.rejects(
    recoverTraineeDepartmentLinks({ db, apply: true, operatorAuthorized: true }),
    /transaction-capable PostgreSQL adapter/i,
  );
  assert.deepEqual(store.writes, []);
});

test('authorized apply creates exactly three links and records verified durable success', async () => {
  const { db, store } = fixture();
  const result = await applyInFakeTransaction(db, store, {
    now: () => '2026-10-09T12:00:00.000Z',
  });
  assert.equal(result.created, 3);
  assert.equal(result.verified, 3);
  const relationshipWrites = store.writes.filter(write =>
    write.table === 'custom_object_relationship' && write.operation === 'insert');
  assert.equal(relationshipWrites.length, 3);
  assert.deepEqual(
    relationshipWrites.map(write => write.values[0].source_record_id).sort(),
    [...INCIDENT.departmentIds].sort(),
  );
  const notes = store.rows.form_submission[0].processing_notes;
  assert.equal(notes.at(-1).kind, 'task4349_department_link_recovery_succeeded');
  assert.deepEqual(notes.at(-1).department_ids, [...INCIDENT.departmentIds]);
  assert.equal(notes.at(-1).cas.prior_processing_notes_count, 1);
  assert.deepEqual(store.processingNotesCasValues, [
    JSON.stringify([{ kind: 'submitted_relationship_invalid', message: 'Invalid organization selection' }]),
  ]);
});

test('replay performs zero duplicate relationship or note writes', async () => {
  const { db, store } = fixture();
  await applyInFakeTransaction(db, store);
  store.writes.length = 0;
  const replay = await applyInFakeTransaction(db, store);
  assert.equal(replay.created, 0);
  assert.equal(replay.noteAlreadyRecorded, true);
  assert.deepEqual(store.writes, []);
});

test('notes CAS uses PostgREST IS NULL rather than eq(null)', async () => {
  const { db, store } = fixture();
  store.rows.form_submission[0].processing_notes = null;
  await applyInFakeTransaction(db, store);
  assert.deepEqual(store.processingNotesCasValues, []);
  assert.deepEqual(store.processingNotesCasNulls, [null]);
  assert.equal(
    store.rows.form_submission[0].processing_notes.at(-1).kind,
    'task4349_department_link_recovery_succeeded',
  );
});

test('rejects a foreign or invalid selected Department before any write', async () => {
  const { db, store } = fixture();
  store.rows.custom_object_record[1].tenant_id = 'foreign-tenant';
  await assert.rejects(
    applyInFakeTransaction(db, store),
    /missing, foreign, or archived/i,
  );
  assert.equal(store.writes.length, 0);
});

test('notes failure remains actionable and is never returned as success', async () => {
  const { db, store } = fixture();
  store.failNotes = true;
  await assert.rejects(
    applyInFakeTransaction(db, store),
    /recovery note update failed.*injected notes failure/i,
  );
  assert.equal(
    store.rows.custom_object_relationship.filter(edge =>
      edge.relationship_definition_id === INCIDENT.memberDepartmentDefinitionId).length,
    0,
  );
  assert.equal(
    store.rows.form_submission[0].processing_notes.some(note =>
      note.kind === 'task4349_department_link_recovery_succeeded'),
    false,
  );
  assert.deepEqual(store.processingNotesCasValues, [
    JSON.stringify([{ kind: 'submitted_relationship_invalid', message: 'Invalid organization selection' }]),
  ]);
});

test('write guard rejects relationship inserts with any extra column', async () => {
  const { db } = fixture();
  const edge = {
    tenant_id: INCIDENT.tenantId,
    relationship_definition_id: INCIDENT.memberDepartmentDefinitionId,
    source_record_id: INCIDENT.departmentIds[0],
    target_record_id: INCIDENT.memberId,
  };
  const guard = createWriteGuard(db, { apply: false, allowedEdges: [edge] });
  await assert.rejects(
    async () => guard.db.from('custom_object_relationship').insert({ ...edge, created_by: 'operator' }),
    /non-canonical columns/i,
  );
});

test('apply reports actual linked outcomes rather than attempted plan count', async () => {
  const { db, store } = fixture();
  const raceProcessor = async ({ db: guardedDb }) => {
    for (const departmentId of INCIDENT.departmentIds) {
      await guardedDb.from('custom_object_relationship').insert({
        tenant_id: INCIDENT.tenantId,
        relationship_definition_id: INCIDENT.memberDepartmentDefinitionId,
        source_record_id: departmentId,
        target_record_id: INCIDENT.memberId,
      });
    }
    return {
      success: true,
      failed_count: 0,
      linked_count: 0,
      outcomes: INCIDENT.departmentIds.map(record_id => ({ status: 'already_linked', record_id })),
    };
  };
  const result = await applyInFakeTransaction(db, store, { processor: raceProcessor });
  assert.equal(result.created, 0);
  assert.equal(result.verified, 3);
  assert.equal(store.rows.form_submission[0].processing_notes.at(-1).links_created, 0);
});