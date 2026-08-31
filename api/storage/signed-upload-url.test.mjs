import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUsePrivateUpload } from './signed-upload-url.js';

test('opportunity-document uploads remain private when a caller requests public access', () => {
  assert.equal(shouldUsePrivateUpload('opportunity-document', false), true);
  assert.equal(shouldUsePrivateUpload('opportunity-document', undefined), true);
});

test('non-opportunity upload privacy retains existing caller-directed behavior', () => {
  assert.equal(shouldUsePrivateUpload('document', false), false);
  assert.equal(shouldUsePrivateUpload('upload', false), false);
  assert.equal(shouldUsePrivateUpload('upload', true), true);
});