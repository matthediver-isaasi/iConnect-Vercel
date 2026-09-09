import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizePipelineMappingEntities } from '../../../shared/formCrmNotes.js';

const source = await readFile(new URL('./FormBuilder.jsx', import.meta.url), 'utf8');

test('category field types remain in the prepopulate field group only', () => {
  const standard = source.slice(
    source.indexOf('const STANDARD_FIELD_TYPES'),
    source.indexOf('const PREPOPULATE_FIELD_TYPES'),
  );
  const prepopulate = source.slice(
    source.indexOf('const PREPOPULATE_FIELD_TYPES'),
    source.indexOf('const AUTO_FIELD_TYPES'),
  );
  assert.doesNotMatch(standard, /category_(?:dropdown|multiselect)/);
  assert.match(prepopulate, /category_multiselect/);
  assert.match(prepopulate, /category_dropdown/);
});

test('resource-category mapping target is category-source and member-only', () => {
  const mappingSection = source.slice(
    source.indexOf('function FieldMappingSection'),
    source.indexOf('const VISIBILITY_OPERATORS'),
  );
  assert.match(
    mappingSection,
    /\['category_dropdown', 'category_multiselect'\]\.includes\(selectedSourceField\?\.type\)/,
  );
  assert.match(
    mappingSection,
    /\(fixedTargetEntity \|\| mapping\.target_entity \|\| effectiveEntity\) === 'member'/,
  );
  assert.match(mappingSection, /<SelectItem value="resource_category">Resource Category<\/SelectItem>/);
  assert.match(mappingSection, /compatibleResourceCategories\.map\(category =>/);
  assert.doesNotMatch(mappingSection, /value="organization_resource_category"/);
  assert.doesNotMatch(mappingSection, /value="custom_resource_category"/);
});

test('fixed pipelines normalize CRM note entity, labels, and serialization', () => {
  const mappingSection = source.slice(
    source.indexOf('function FieldMappingSection'),
    source.indexOf('const VISIBILITY_OPERATORS'),
  );
  assert.match(mappingSection, /normalizePipelineMappingEntities\(fieldMappings, fixedTargetEntity\)/);
  assert.match(mappingSection, /target_entity: effectiveEntity/);
  assert.match(mappingSection, /'Member CRM Notes'/);
  assert.match(mappingSection, /'Organisation CRM Notes'/);

  const migration = source.slice(
    source.indexOf('const migrateToEntityPipelines'),
    source.indexOf('const handleSave'),
  );
  assert.match(migration, /normalizePipelineMappingEntities\(member\.mappings, 'member'\)/);
  assert.match(migration, /normalizePipelineMappingEntities\(org\.mappings, 'organization'\)/);
});

test('pipeline mapping serialization replaces missing and stale entity metadata', () => {
  const mappings = [
    { id: 'missing', target_type: 'crm_note', target_field: 'notes' },
    { id: 'stale', target_type: 'crm_note', target_entity: 'organization', target_field: 'notes' },
  ];
  assert.deepEqual(
    normalizePipelineMappingEntities(mappings, 'member'),
    mappings.map(mapping => ({ ...mapping, target_entity: 'member' })),
  );
  assert.deepEqual(
    normalizePipelineMappingEntities(mappings, 'organization'),
    mappings.map(mapping => ({ ...mapping, target_entity: 'organization' })),
  );
});

test('field mappings expose and preserve the Ignore if hidden option', () => {
  const mappingSection = source.slice(
    source.indexOf('function FieldMappingSection'),
    source.indexOf('const VISIBILITY_OPERATORS'),
  );
  assert.match(mappingSection, /ignore_if_hidden: false/);
  assert.match(mappingSection, /sourceType === 'field' && mapping\.source_field_id/);
  assert.match(mappingSection, /checked=\{mapping\.ignore_if_hidden === true\}/);
  assert.match(mappingSection, /updateMapping\(mapping\.id, \{ ignore_if_hidden: checked \}\)/);
  assert.match(mappingSection, /data-testid=\{`switch-ignore-hidden-\$\{index\}`\}/);
  assert.doesNotMatch(
    mappingSection,
    /source_type: value,[\s\S]{0,250}ignore_if_hidden:/,
    'changing source type must not erase the saved option',
  );
});