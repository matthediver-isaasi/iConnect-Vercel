import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeGenericEntityName,
  rejectGenericServerOwnedEntity,
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
  }
});