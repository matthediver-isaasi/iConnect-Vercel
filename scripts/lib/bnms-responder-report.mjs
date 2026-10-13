import assert from 'node:assert/strict';

export const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const objectId = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
export const reportId = 'r_mv134nau_j0a4dp';
export const organizationId = '11b4eef3-43f1-4724-94cb-b7baeb27bbcf';
export const memberRelationship = '0fdede92-efa2-4d84-9b16-df1a88069486';
export const organizationRelationship = '30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e';
export const responderField = 'edf1fbf8-76f7-4455-a7e2-f0f45db57b43';
export const memberPath = [{ relationship_definition_id: memberRelationship, from_side: 'source' }];
export const responderConditions = [{
  kind: 'relationship_field', relationship_field_id: responderField, op: 'equals', value: true,
}];

// Exact non-personal saved definition inspected on DEST. Retained for recovery
// and regression tests; this is not a template for upgrading other reports.
export const originalReport = {
  id: reportId, name: 'Department member count with survey responder', version: 3,
  config: {
    version: 2, start_object_id: objectId, grain_path: [],
    columns: [
      { id: 'organization::name:1791557423522', kind: 'field',
        path: [{ relationship_definition_id: organizationRelationship, from_side: 'source' }],
        field: 'name', label: 'Name' },
      { id: `custom_object:${objectId}:35e4f2dd-6f22-4875-8d2f-4ffb05b1980f:1791557235822`,
        kind: 'field', path: [], field_id: '35e4f2dd-6f22-4875-8d2f-4ffb05b1980f', label: 'Name' },
      { id: `custom_object:${objectId}:c5dcd16c-e63e-49f2-b72f-b0caaa7c5903:1791557240892`,
        kind: 'field', path: [], field_id: 'c5dcd16c-e63e-49f2-b72f-b0caaa7c5903', label: 'Survey last updated' },
      { id: 'indicator:6d008f19-09e0-4e28-abe4-3ec4dcf7e78e', kind: 'exists_related',
        path: memberPath, conditions: responderConditions, label: 'Has department responder' },
      ...[
        ['first_name', '1791893493870', 'First name'],
        ['last_name', '1791893499630', 'Last name'],
        ['email', '1791893511039', 'Email'],
      ].map(([field, stamp, label]) => ({
        id: `member::${field}:${stamp}`, kind: 'matching_field', path: memberPath,
        conditions: [], field, label: `Responder ${label}`,
      })),
      { id: `count:${JSON.stringify(memberPath)}:1791894009751`, kind: 'count_distinct',
        path: memberPath, label: 'Department Member count' },
    ],
    multi_value: 'join', start_endpoint: { kind: 'custom_object', customObjectId: objectId },
    include_empty: false,
  },
};

export function correctedReport(report) {
  assert.deepEqual(report, originalReport, 'Affected report changed since inspection; stop for review');
  const next = structuredClone(report);
  next.version += 1;
  for (const column of next.config.columns) {
    if (column.kind === 'matching_field') column.conditions = structuredClone(responderConditions);
  }
  return next;
}

export function replaceAffectedReport(settings, expected, replacement) {
  assert.equal(settings.reports.filter((r) => r.id === reportId).length, 1, 'Report identity is ambiguous');
  assert.deepEqual(settings.reports.find((r) => r.id === reportId), expected, 'Concurrent report change');
  return { ...settings, reports: settings.reports.map((r) => r.id === reportId ? replacement : r) };
}
