import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./FormBuilder.jsx', import.meta.url), 'utf8');

test('structured relationship editor receives primary pipeline configuration', () => {
  const editor = source.slice(
    source.indexOf('function StructuredRecordActionsEditor'),
    source.indexOf('export default function FormBuilderPage'),
  );
  assert.match(
    editor.slice(0, editor.indexOf('}) {')),
    /\bentityPipelines\b/,
    'the editor must destructure the prop used to build primary-pipeline endpoint options',
  );
  assert.match(
    editor,
    /structuredRelationshipEndpointOptions\(\{[\s\S]*?\bentityPipelines,\s*\}\)/,
  );

  const usageStart = source.indexOf('<StructuredRecordActionsEditor');
  const usage = source.slice(usageStart, usageStart + 1_500);
  assert.match(usage, /entityPipelines=\{formData\.entity_pipelines\}/);
});