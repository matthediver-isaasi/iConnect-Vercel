#!/usr/bin/env node
// Read-only verification of the live direct Workforce Row -> Department model.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createCustomObjectService } from '../api/_lib/customObjectService.js';

const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const departmentId = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
const rowObjectId = 'bf123bdb-7227-4f45-b5f9-8344d0f65446';
const definitionId = 'a422da51-6005-4831-a69e-bf284ff6f124';

async function verify() {
  assert.ok(process.env.DEST_SUPABASE_URL && process.env.DEST_SUPABASE_KEY,
    'Destination credentials must be configured');
  assert.equal(new URL(process.env.DEST_SUPABASE_URL).hostname,
    'lvmzliemqnieeoruhkik.supabase.co', 'Unexpected destination');
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const service = createCustomObjectService({
    db,
    context: { isAuthenticated: true, tenantId, tenantUserId: 'read-only-verification' },
    isAdmin: true,
  });
  const definition = await db.from('custom_object_relationship_definition')
    .select('*').eq('tenant_id', tenantId).eq('id', definitionId).single();
  assert.ifError(definition.error);
  assert.equal(definition.data.status, 'active');
  assert.equal(definition.data.archived_at, null);
  assert.equal(definition.data.cardinality, 'many_to_one');
  assert.equal(definition.data.is_required, true);
  assert.equal(definition.data.source_custom_object_id, rowObjectId);
  assert.equal(definition.data.target_custom_object_id, departmentId);

  const edges = await db.from('custom_object_relationship')
    .select('source_record_id,target_record_id', { count: 'exact' })
    .eq('tenant_id', tenantId).eq('relationship_definition_id', definitionId)
    .is('archived_at', null).order('id').range(0, 999);
  assert.ifError(edges.error);
  assert.equal(edges.data.length, edges.count, 'Verification must not use a truncated graph');
  const expected = new Map();
  for (const edge of edges.data) {
    if (!expected.has(edge.target_record_id)) expected.set(edge.target_record_id, []);
    expected.get(edge.target_record_id).push(edge.source_record_id);
  }
  let verifiedRows = 0;
  for (const [recordId, rowIds] of expected) {
    const actual = await service.listRelationships(departmentId, {
      recordId, definitionId, side: 'target', page: 1, pageSize: 100,
    });
    assert.equal(actual.total, rowIds.length);
    assert.deepEqual(actual.data.map(edge => edge.source_record_id).sort(), rowIds.sort());
    assert.ok(Array.isArray(actual.preview_columns), 'Related-record columns must resolve');
    verifiedRows += actual.data.length;
  }
  const rows = await db.from('custom_object_record')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
    .eq('custom_object_id', rowObjectId).is('archived_at', null);
  assert.ifError(rows.error);
  assert.equal(verifiedRows, rows.count, 'Every active workforce row must appear under its department');
  const candidates = await service.initialRelationshipCandidates(rowObjectId, {
    definitionId, newRecordSide: 'source', page: 1, pageSize: 1,
  });
  assert.ok(candidates.data.length > 0, 'New workforce rows need eligible department choices');
  console.log(JSON.stringify({
    readOnly: true,
    verifiedDepartments: expected.size,
    verifiedWorkforceRows: verifiedRows,
    requiredDepartmentRelationship: true,
    contextualDepartmentPicker: 'passed',
  }, null, 2));
}

verify().catch(error => {
  console.error('Read-only workforce verification failed:', error.message);
  process.exitCode = 1;
});