import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateStructuredActionsContract } from '../../../api/_lib/formStructuredActions.js';
import { applyStructuredMappingSourceSelection } from '../lib/structuredActionMappings.js';

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

test('structured action mappings support static and resolved-label sources in the editor', () => {
  const editor = source.slice(
    source.indexOf('function StructuredRecordActionsEditor'),
    source.indexOf('export default function FormBuilderPage'),
  );
  assert.match(editor, /<SelectItem value="static">Static value<\/SelectItem>/);
  assert.match(editor, /mapping\.source_type === 'static'[\s\S]*?static_value/);
  assert.match(
    editor,
    /\['static', 'resolved_record_labels'\]\.includes\(mapping\.source_type\) \? field\.type === 'text'/,
    'static mappings must expose compatible text targets without a source field',
  );
  assert.match(editor, /resolved_record_labels/);
  assert.match(editor, /No second resolved name/);
  assert.match(editor, /!sourceFields\.length && !recordLabelOptions\.length/);

  const validation = source.slice(
    source.indexOf('const structuredActions = formData.structured_actions'),
    source.indexOf('const updatedFormData'),
  );
  assert.match(validation, /\['clear', 'static', 'resolved_record_labels'\]/);
});

test('editor source selection emits valid static and resolved-label contracts without address metadata', () => {
  const base = {
    id: 'display-name',
    source_type: 'field',
    source_field_id: 'old-field',
    source_component: null,
    target_type: 'custom',
    target_field_id: 'old-target',
  };
  const staticMapping = {
    ...applyStructuredMappingSourceSelection({
      mapping: base,
      sourceFieldId: 'static',
    }),
    static_value: 'Legacy label',
    target_type: 'custom',
    target_field_id: 'assignment-name',
  };
  assert.equal(Object.hasOwn(staticMapping, 'source_component'), false);
  assert.doesNotThrow(() => validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'static-create',
      source: { scope: 'top_level' },
      target: { kind: 'custom_object', custom_object_id: 'assignment-object' },
      operation: 'create',
      mappings: [staticMapping],
    }],
  }, []));

  const resolvedMapping = {
    ...applyStructuredMappingSourceSelection({
      mapping: base,
      sourceFieldId: 'label:action:resolve-organization',
      resolvedRecordSource: { type: 'action_output', action_id: 'resolve-organization' },
    }),
    target_type: 'custom',
    target_field_id: 'assignment-name',
  };
  assert.equal(Object.hasOwn(resolvedMapping, 'source_component'), false);
  assert.doesNotThrow(() => validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'resolve-organization',
      source: { scope: 'top_level' },
      target: { kind: 'organization' },
      operation: 'create',
      mappings: [{
        id: 'organization-name',
        source_type: 'static',
        static_value: 'North Site',
        target_type: 'core',
        target_field_id: 'name',
      }],
    }, {
      id: 'resolved-create',
      source: { scope: 'top_level' },
      target: { kind: 'custom_object', custom_object_id: 'assignment-object' },
      operation: 'create',
      mappings: [resolvedMapping],
    }],
  }, []));
});

test('unsaved repeatable row editors keep strict custom-object sources disabled', () => {
  const repeatableEditor = source.slice(
    source.indexOf('function RepeatableRowsSettings'),
    source.indexOf('function FieldCard'),
  );
  assert.match(
    repeatableEditor,
    /data-testid=\{`repeatable-row-source-save-first-\$\{field\.id\}-\$\{child\.id\}`\}/,
  );
  assert.match(
    repeatableEditor,
    /<SelectItem value="records" disabled=\{!formId\}>/,
  );
  assert.match(
    repeatableEditor,
    /<SelectItem value="distinct" disabled=\{!formId\}>/,
  );
  assert.match(
    repeatableEditor,
    /<SelectItem value="relationship">Related records \(legacy\)<\/SelectItem>/,
  );
  assert.match(
    source,
    /const validation = validateRowSourceConfiguration\(child, children\);[\s\S]*?Complete its source configuration before saving\./,
  );
});