import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const updateStatus = await readFile(new URL('./update-status.js', import.meta.url), 'utf8');
const stageActions = await readFile(new URL('./_stageActions.js', import.meta.url), 'utf8');

test('status transitions CAS the persisted stage-action occurrence', () => {
  assert.match(updateStatus, /import \{ randomUUID \} from 'node:crypto'/);
  assert.match(updateStatus, /stage_action_occurrence_id: transitionOccurrenceId/);
  assert.match(updateStatus, /\.eq\('workflow_status', previousStatus\)/);
  assert.match(updateStatus, /\.select\('id, workflow_status, stage_action_occurrence_id'\)/);
  assert.match(updateStatus, /Due diligence status changed concurrently/);
});

test('member stage mappings never derive occurrence identity from updated_at', () => {
  assert.match(stageActions, /ddSubmission\?\.stage_action_occurrence_id/);
  assert.doesNotMatch(stageActions, /memberMappingOccurrenceId[\s\S]{0,180}ddSubmission\?\.updated_at/);
});