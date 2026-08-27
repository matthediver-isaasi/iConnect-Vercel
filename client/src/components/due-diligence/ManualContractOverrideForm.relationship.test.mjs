import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  resolveFormRendererFieldValue,
  resolveRelationshipDropdownValues,
} from '../../lib/formRelationshipDropdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.join(here, 'ManualContractOverrideForm.jsx'),
  'utf8',
);

test('manual contract override supplies dependent relationship renderer context', () => {
  assert.match(source, /formId=\{formSchema\?\.id \|\| contractFormId\}/);
  assert.match(source, /formSlug=\{formSchema\?\.slug\}/);
  assert.match(source, /allFormValues=\{formValues\}/);
  assert.match(source, /allFields=\{fields\}/);
  assert.match(source, /formValues\[field\.id\] \?\? formValues\[field\.name\] \?\? ''/);
});

test('manual contract values enable a related record after its organization is selected', () => {
  const fields = [
    { id: 'organization', name: 'organization_name', type: 'organisation_dropdown' },
    {
      id: 'department',
      name: 'department_name',
      type: 'relationship_dropdown',
      parent_field_id: 'organization',
    },
  ];
  const values = {
    organization: 'organization-1',
    department: 'department-1',
  };

  assert.equal(resolveFormRendererFieldValue({
    field: fields[0],
    fields,
    values,
    value: values.organization,
  }).value, 'organization-1');
  assert.deepEqual(resolveRelationshipDropdownValues({
    field: fields[1],
    fields,
    values,
    value: values.department,
  }), {
    parentField: fields[0],
    parentValue: 'organization-1',
    currentValue: 'department-1',
    needsCanonicalValue: false,
  });
});