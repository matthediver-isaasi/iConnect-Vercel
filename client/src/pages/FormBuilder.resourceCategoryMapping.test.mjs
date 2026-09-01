import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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