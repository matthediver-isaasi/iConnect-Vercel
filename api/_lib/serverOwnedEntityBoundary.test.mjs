import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeGenericEntityName,
  rejectGenericServerOwnedEntity,
  stripGenericServerOwnedFields,
} from './serverOwnedEntityBoundary.js';

function responseRecorder() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('all generic naming variants of pipeline replay evidence are denied', () => {
  for (const entity of [
    'form_submission_pipeline_entity',
    'form-submission-pipeline-entity',
    'FormSubmissionPipelineEntity',
  ]) {
    assert.equal(normalizeGenericEntityName(entity), 'formsubmissionpipelineentity');
    const res = responseRecorder();
    assert.equal(rejectGenericServerOwnedEntity(entity, res), true);
    assert.equal(res.statusCode, 403);
  }
});

test('all generic naming variants of stage mapping actions are denied', () => {
  for (const entity of [
    'stage_field_mapping_action',
    'stage-field-mapping-action',
    'StageFieldMappingAction',
  ]) {
    assert.equal(normalizeGenericEntityName(entity), 'stagefieldmappingaction');
    const res = responseRecorder();
    assert.equal(rejectGenericServerOwnedEntity(entity, res), true);
    assert.equal(res.statusCode, 403);
  }
});

test('generic DD mutations strip only the server-owned retry occurrence field', () => {
  const payload = {
    form_submission_id: 'submission-1',
    workflow_status: 'pending',
    stage_action_occurrence_id: 'occurrence-secret',
  };
  const sanitized = stripGenericServerOwnedFields('FormSubmissionDueDiligence', payload);

  assert.deepEqual(sanitized, {
    form_submission_id: 'submission-1',
    workflow_status: 'pending',
  });
  assert.equal(payload.stage_action_occurrence_id, 'occurrence-secret');
});

test('generic DD bulk-shaped payloads are sanitized per row and ordinary fields remain writable', () => {
  const payload = [
    { id: 'dd-1', stage_action_occurrence_id: 'occ-1', review_notes: 'keep' },
    { id: 'dd-2', stage_action_occurrence_id: 'occ-2', decision: 'approved' },
  ];

  assert.deepEqual(
    stripGenericServerOwnedFields('form_submission_due_diligence', payload),
    [
      { id: 'dd-1', review_notes: 'keep' },
      { id: 'dd-2', decision: 'approved' },
    ],
  );
  assert.deepEqual(payload[0], {
    id: 'dd-1',
    stage_action_occurrence_id: 'occ-1',
    review_notes: 'keep',
  });
});

test('common bulk/import wrappers are sanitized without blocking the DD entity', () => {
  const payload = {
    records: [{ stage_action_occurrence_id: 'occ-1', workflow_status: 'pending' }],
    data: [{ stage_action_occurrence_id: 'occ-2', review_notes: 'keep' }],
  };

  assert.deepEqual(
    stripGenericServerOwnedFields('FormSubmissionDueDiligence', payload),
    {
      records: [{ workflow_status: 'pending' }],
      data: [{ review_notes: 'keep' }],
    },
  );
});

test('unrelated generic entities do not lose same-named fields', () => {
  const payload = { stage_action_occurrence_id: 'ordinary-value' };
  assert.deepEqual(
    stripGenericServerOwnedFields('Member', payload),
    payload,
  );
});

test('unrelated generic entities are not intercepted', () => {
  const res = responseRecorder();
  assert.equal(rejectGenericServerOwnedEntity('Member', res), false);
  assert.equal(res.statusCode, null);
});

test('both generic collection and item routes enforce the server-owned boundary', async () => {
  for (const relativePath of [
    '../entities/[entity]/index.js',
    '../entities/[entity]/[id].js',
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /rejectGenericServerOwnedEntity\(entity, res\)/);
      assert.match(source, /stripGenericServerOwnedFields\(/);
  }
});