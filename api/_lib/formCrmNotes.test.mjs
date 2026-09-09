import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectPipelineCrmNoteIntents,
  persistPipelineCrmNotes,
} from './formCrmNotes.js';
import { CRM_NOTE_SOURCE_FIELD_TYPES } from '../../shared/formCrmNotes.js';

const pipeline = (entity = 'member') => ({
  mappings: [{
    id: 'note-mapping',
    source_type: 'field',
    source_field_id: 'answer',
    target_type: 'crm_note',
    target_entity: entity,
    target_field: 'notes',
    transformation: 'trim',
  }],
});
const formFields = [
  { id: 'answer', type: 'textarea' },
  { id: 'first', type: 'text' },
  { id: 'second', type: 'text' },
  { id: 'other', type: 'text' },
];

function fakeDb({ tenantId = 'tenant-1', targetTenant = tenantId, authorTenant = tenantId } = {}) {
  const rows = { member_note: [], organization_note: [] };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.payload = null; }
    select() { return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    order() { return this; }
    limit() { return this; }
    insert(payload) { this.payload = payload; rows[this.table].push(payload); return Promise.resolve({ error: null }); }
    async maybeSingle() {
      const value = key => this.filters.find(([name]) => name === key)?.[1];
      if (this.table === 'member' && value('id') === 'author-1') {
        return { data: authorTenant === value('tenant_id') ? { id: 'author-1', tenant_id: authorTenant } : null, error: null };
      }
      if (this.table === 'member' && value('id') === 'member-1') {
        return { data: targetTenant === value('tenant_id') ? { id: 'member-1', tenant_id: targetTenant } : null, error: null };
      }
      if (this.table === 'organization' && value('id') === 'org-1') {
        return { data: targetTenant === value('tenant_id') ? { id: 'org-1', tenant_id: targetTenant } : null, error: null };
      }
      const existing = rows[this.table]?.find(row =>
        row.form_submission_id === value('form_submission_id')
        && row.form_mapping_id === value('form_mapping_id'));
      return { data: existing ? { id: 'existing' } : null, error: null };
    }
  }
  return { rows, from: table => new Query(table) };
}

test('CRM note mappings use transformations, fallback winners, and skip empty input', () => {
  const configured = {
    mappings: [
      { ...pipeline().mappings[0], id: 'first', source_field_id: 'first', fallback_group: { version: 1, id: 'note-fallback' } },
      { ...pipeline().mappings[0], id: 'second', source_field_id: 'second', fallback_group: { version: 1, id: 'note-fallback' } },
    ],
  };
  const intents = collectPipelineCrmNoteIntents(configured, { first: '   ', second: '  Useful note  ' }, {
    applyTransformation: value => String(value).trim(),
    formFields,
  });
  assert.deepEqual(intents, [{ mappingId: 'pipeline:second', content: 'Useful note' }]);
  assert.deepEqual(collectPipelineCrmNoteIntents(pipeline(), { answer: '   ' }, {
    applyTransformation: value => String(value).trim(),
    formFields,
  }), []);
});

test('CRM note mappings ignore hidden sources only when explicitly opted in', () => {
  const defaultOff = collectPipelineCrmNoteIntents(pipeline(), { answer: 'Legacy note' }, {
    hiddenFieldIds: new Set(['answer']),
    formFields,
  });
  const optedInPipeline = {
    mappings: [{
      ...pipeline().mappings[0],
      ignore_if_hidden: true,
    }],
  };
  const optedIn = collectPipelineCrmNoteIntents(optedInPipeline, { answer: 'Hidden note' }, {
    hiddenFieldIds: new Set(['answer']),
    formFields,
  });

  assert.deepEqual(defaultOff, [{ mappingId: 'pipeline:note-mapping', content: 'Legacy note' }]);
  assert.deepEqual(optedIn, []);
});

test('CRM note mapping visibility preserves current-date transforms and fallback order', () => {
  const currentDatePipeline = {
    mappings: [{
      ...pipeline().mappings[0],
      ignore_if_hidden: true,
      transformation: 'current_date',
    }],
  };
  assert.deepEqual(
    collectPipelineCrmNoteIntents(currentDatePipeline, { answer: 'forged' }, {
      hiddenFieldIds: new Set(['answer']),
      formFields,
      applyTransformation: (_value, transformation) =>
        transformation === 'current_date' ? '2026-09-09' : _value,
    }),
    [{ mappingId: 'pipeline:note-mapping', content: '2026-09-09' }],
  );

  const fallbackPipeline = {
    mappings: [
      {
        ...pipeline().mappings[0],
        id: 'hidden-first',
        source_field_id: 'first',
        ignore_if_hidden: true,
        fallback_group: { version: 1, id: 'crm-note-fallback' },
      },
      {
        ...pipeline().mappings[0],
        id: 'visible-second',
        source_field_id: 'second',
        fallback_group: { version: 1, id: 'crm-note-fallback' },
      },
    ],
  };
  assert.deepEqual(
    collectPipelineCrmNoteIntents(fallbackPipeline, {
      first: 'Forged hidden note',
      second: 'Visible note',
    }, {
      hiddenFieldIds: new Set(['first']),
      formFields,
    }),
    [{ mappingId: 'pipeline:visible-second', content: 'Visible note' }],
  );
});

for (const [entity, entityId, table, foreignKey] of [
  ['member', 'member-1', 'member_note', 'target_member_id'],
  ['organization', 'org-1', 'organization_note', 'organization_id'],
]) {
  test(`${entity} CRM notes persist once per submission and mapping`, async () => {
    const db = fakeDb();
    const input = {
      db,
      tenantId: 'tenant-1',
      submissionId: 'submission-1',
      entity,
      entityId,
      authorMemberId: 'author-1',
      pipeline: pipeline(entity),
      values: { answer: '  First-class note  ' },
      applyTransformation: value => String(value).trim(),
      formFields,
    };
    assert.equal((await persistPipelineCrmNotes(input)).inserted, 1);
    assert.equal((await persistPipelineCrmNotes(input)).inserted, 0);
    assert.equal(db.rows[table].length, 1);
    assert.equal(db.rows[table][0][foreignKey], entityId);
    assert.equal(db.rows[table][0].content, 'First-class note');
  });
}

test('CRM note persistence rejects a target from another tenant', async () => {
  const db = fakeDb({ targetTenant: 'tenant-2' });
  await assert.rejects(() => persistPipelineCrmNotes({
    db,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    entity: 'member',
    entityId: 'member-1',
    authorMemberId: 'author-1',
    pipeline: pipeline(),
    values: { answer: 'Do not attach' },
    formFields,
  }), error => error.code === 'CRM_NOTE_CROSS_TENANT_TARGET');
  assert.equal(db.rows.member_note.length, 0);
});

test('distinct mappings and submissions create distinct notes', async () => {
  const db = fakeDb();
  const base = {
    db,
    tenantId: 'tenant-1',
    entity: 'member',
    entityId: 'member-1',
    authorMemberId: 'author-1',
    values: { answer: 'One note', other: 'Another note' },
    formFields,
  };
  await persistPipelineCrmNotes({
    ...base,
    submissionId: 'submission-1',
    pipeline: {
      id: 'member-pipeline',
      mappings: [
        pipeline().mappings[0],
        { ...pipeline().mappings[0], id: 'other-mapping', source_field_id: 'other' },
      ],
    },
  });
  await persistPipelineCrmNotes({
    ...base,
    submissionId: 'submission-2',
    pipeline: { ...pipeline(), id: 'member-pipeline' },
  });
  assert.equal(db.rows.member_note.length, 3);
});

test('persisted non-field and non-text mappings are ignored', () => {
  const staticPipeline = {
    mappings: [{ ...pipeline().mappings[0], source_type: 'static', static_value: 'Not allowed' }],
  };
  assert.deepEqual(collectPipelineCrmNoteIntents(staticPipeline, { answer: 'ignored' }, { formFields }), []);
  assert.deepEqual(collectPipelineCrmNoteIntents(pipeline(), { answer: 42 }, {
    formFields: [{ id: 'answer', type: 'number' }],
  }), []);
});

test('CRM note persistence ignores mappings for a different pipeline entity', async () => {
  for (const [entity, entityId, mismatchedEntity, table] of [
    ['member', 'member-1', 'organization', 'member_note'],
    ['organization', 'org-1', 'member', 'organization_note'],
  ]) {
    const db = fakeDb();
    const result = await persistPipelineCrmNotes({
      db,
      tenantId: 'tenant-1',
      submissionId: 'submission-1',
      entity,
      entityId,
      authorMemberId: 'author-1',
      pipeline: pipeline(mismatchedEntity),
      values: { answer: 'Wrong destination' },
      formFields,
    });
    assert.deepEqual(result, { inserted: 0, skipped: 0 });
    assert.equal(db.rows[table].length, 0);
  }
});

test('every FormBuilder-supported source field type produces a note intent', () => {
  for (const type of CRM_NOTE_SOURCE_FIELD_TYPES) {
    const intents = collectPipelineCrmNoteIntents(pipeline(), { answer: `Value from ${type}` }, {
      formFields: [{ id: 'answer', type }],
    });
    assert.equal(intents.length, 1, `${type} should produce an intent`);
  }
});