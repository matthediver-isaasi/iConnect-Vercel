import assert from 'node:assert/strict';
import test from 'node:test';

import {
  relationshipEndpointLabel,
  structuredRecordDescriptor,
  structuredEndpointReferenceValue,
  structuredRelationshipEndpointOptions,
} from './structuredRelationshipActions.js';

const definition = {
  id: 'relationship-1',
  status: 'active',
  source_kind: 'organization',
  source_label: 'Employer',
  target_kind: 'custom_object',
  target_custom_object_id: 'project-object',
  target_label: 'Project',
};

const fields = [
  { id: 'org', type: 'organisation_dropdown', label: 'Organisation' },
  {
    id: 'rows',
    type: 'repeatable_rows',
    label: 'Assignments',
    repeatable_row: {
      children: [
        {
          id: 'project',
          type: 'relationship_dropdown',
          label: 'Project',
          related_kind: 'custom_object',
          related_custom_object_id: 'project-object',
        },
        { id: 'other-org', type: 'organisation_dropdown', label: 'Row organisation' },
      ],
    },
  },
  { id: 'later-org', type: 'organisation_dropdown', label: 'Later organisation' },
];

test('relationship endpoint labels retain definition direction', () => {
  assert.equal(relationshipEndpointLabel(definition, 'source'), 'Employer (source)');
  assert.equal(relationshipEndpointLabel(definition, 'target'), 'Project (target)');
});

test('member selectors can be used as generic relationship endpoints', () => {
  assert.deepEqual(
    structuredRecordDescriptor({ id: 'member', type: 'member_dropdown' }),
    { kind: 'member', customObjectId: null },
  );
});

test('top-level link actions only offer compatible top-level fields and prior top-level outputs', () => {
  const actions = [
    {
      id: 'create-org',
      label: 'Create employer',
      source: { scope: 'top_level' },
      operation: 'create',
      target: { kind: 'organization' },
    },
    {
      id: 'later-project',
      source: { scope: 'top_level' },
      operation: 'create',
      target: { kind: 'custom_object', custom_object_id: 'project-object' },
    },
    {
      id: 'link',
      source: { scope: 'top_level' },
      operation: 'link_relationship',
    },
  ];
  const source = structuredRelationshipEndpointOptions({
    fields, actions, actionIndex: 2, action: actions[2], definition, side: 'source',
  });
  const target = structuredRelationshipEndpointOptions({
    fields, actions, actionIndex: 2, action: actions[2], definition, side: 'target',
  });

  assert.deepEqual(source.map(option => option.value), [
    'field:form:org',
    'field:form:later-org',
    'action_output:create-org',
  ]);
  assert.deepEqual(target.map(option => option.value), [
    'action_output:later-project',
  ]);
});

test('repeatable links can combine an earlier form endpoint and a current-row endpoint', () => {
  const actions = [
    {
      id: 'same-row-project',
      source: { scope: 'repeatable_row', repeatable_field_id: 'rows' },
      operation: 'create',
      target: { kind: 'custom_object', custom_object_id: 'project-object' },
    },
    {
      id: 'other-row-project',
      source: { scope: 'repeatable_row', repeatable_field_id: 'other-rows' },
      operation: 'create',
      target: { kind: 'custom_object', custom_object_id: 'project-object' },
    },
    {
      id: 'link',
      source: { scope: 'repeatable_row', repeatable_field_id: 'rows' },
      operation: 'link_relationship',
    },
  ];
  const sourceOptions = structuredRelationshipEndpointOptions({
    fields, actions, actionIndex: 2, action: actions[2], definition, side: 'source',
  });
  const targetOptions = structuredRelationshipEndpointOptions({
    fields, actions, actionIndex: 2, action: actions[2], definition, side: 'target',
  });

  assert.deepEqual(sourceOptions.map(option => option.value), [
    'field:form:org',
    'field:repeatable_row:rows:other-org',
  ]);
  assert.ok(!sourceOptions.some(option => option.value.includes('later-org')));
  assert.deepEqual(targetOptions.map(option => option.value), [
    'field:repeatable_row:rows:project',
    'action_output:same-row-project',
  ]);
  assert.deepEqual(sourceOptions[0].reference, { type: 'field', scope: 'form', field_id: 'org' });
  assert.deepEqual(targetOptions[0].reference, { type: 'field', scope: 'row', field_id: 'project' });
  assert.equal(structuredEndpointReferenceValue(targetOptions[0].reference, 'rows'), targetOptions[0].value);
  assert.ok(!targetOptions.some(option => option.value.includes('other-row-project')));
});

test('a form Organisation and current-row Organisation can be selected as opposite endpoints', () => {
  const organisationRelationship = {
    id: 'organisation-relationship',
    source_kind: 'organization',
    target_kind: 'organization',
    source_label: 'Primary organisation',
    target_label: 'Secondary organisation',
  };
  const action = {
    id: 'link-organisations',
    source: { scope: 'repeatable_row', repeatable_field_id: 'rows' },
    operation: 'link_relationship',
  };
  const sourceOptions = structuredRelationshipEndpointOptions({
    fields, actions: [action], actionIndex: 0, action, definition: organisationRelationship, side: 'source',
  });
  const targetOptions = structuredRelationshipEndpointOptions({
    fields, actions: [action], actionIndex: 0, action, definition: organisationRelationship, side: 'target',
  });
  const primary = sourceOptions.find(option => option.value === 'field:form:org');
  const secondary = targetOptions.find(option => option.value === 'field:repeatable_row:rows:other-org');

  assert.deepEqual(primary?.reference, { type: 'field', scope: 'form', field_id: 'org' });
  assert.deepEqual(secondary?.reference, { type: 'field', scope: 'row', field_id: 'other-org' });
});

test('only earlier compatible action outputs are eligible', () => {
  const link = {
    id: 'link',
    source: { scope: 'top_level' },
    operation: 'link_relationship',
  };
  const actions = [
    {
      id: 'wrong-object',
      source: { scope: 'top_level' },
      operation: 'create',
      target: { kind: 'custom_object', custom_object_id: 'another-object' },
    },
    link,
    {
      id: 'future-project',
      source: { scope: 'top_level' },
      operation: 'create',
      target: { kind: 'custom_object', custom_object_id: 'project-object' },
    },
  ];
  const options = structuredRelationshipEndpointOptions({
    fields: [], actions, actionIndex: 1, action: link, definition, side: 'target',
  });
  assert.deepEqual(options, []);
});