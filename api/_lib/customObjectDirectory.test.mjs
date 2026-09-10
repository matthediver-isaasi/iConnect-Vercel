import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  customObjectDirectorySourceKey,
  parseCustomObjectDirectorySourceKey,
  encodeCustomObjectDirectoryCursor,
  decodeCustomObjectDirectoryCursor,
  CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE,
  matchesDirectoryValue,
  projectDirectoryFileValue,
  isDirectoryObjectFilePath,
  DIRECTORY_FILE_REUPLOAD_REASON,
} from './customObjectDirectory.js';

const ids = {
  relationshipId: '10000000-0000-4000-8000-000000000001',
  objectId: '20000000-0000-4000-8000-000000000002',
  fieldId: '30000000-0000-4000-8000-000000000003',
};

test('stable source key includes relationship, organisation direction, object and field', () => {
  const key = customObjectDirectorySourceKey({ ...ids, direction: 'source' });
  assert.equal(key, `object-field:${ids.relationshipId}:source:${ids.objectId}:${ids.fieldId}`);
  assert.deepEqual(parseCustomObjectDirectorySourceKey(key), { ...ids, direction: 'source' });
  assert.equal(parseCustomObjectDirectorySourceKey('object-field:bad:source:bad:bad'), null);
  assert.throws(() => customObjectDirectorySourceKey({ ...ids, direction: 'other' }));
});

test('cursor is opaque, deterministic and rejects malformed input', () => {
  const cursor = encodeCustomObjectDirectoryCursor(ids.objectId);
  assert.notEqual(cursor, ids.objectId);
  assert.equal(decodeCustomObjectDirectoryCursor(cursor), ids.objectId);
  assert.equal(decodeCustomObjectDirectoryCursor('not-a-cursor'), null);
  assert.equal(CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE, 25);
});

test('directory eligibility value matching mirrors member directory semantics', () => {
  assert.equal(matchesDirectoryValue('["active","pending"]', 'active'), true);
  assert.equal(matchesDirectoryValue(['active', 'pending'], 'pending'), true);
  assert.equal(matchesDirectoryValue('yes', true), true);
  assert.equal(matchesDirectoryValue(false, '0'), true);
  assert.equal(matchesDirectoryValue('active', ['pending', 'active']), true);
  assert.equal(matchesDirectoryValue('inactive', ['pending', 'active']), false);
});

test('file projection emits only a same-tenant secure reference and minimal metadata', () => {
  const value = JSON.stringify({
    file_url: 'https://storage.example.test/stale-signed-secret',
    storage_path: `tenant-a/custom-object-files/${ids.objectId}/${ids.fieldId}/40000000-0000-4000-8000-000000000004-Report.pdf`,
    bucket: 'private-uploads',
    file_name: 'Report.pdf',
    file_size: 42,
    mime_type: 'application/pdf',
    uploaded_at: 'private timestamp',
    arbitrary: 'must not escape',
  });
  const link = {
    directoryId: 'main',
    organizationId: ids.relationshipId,
    sourceKey: customObjectDirectorySourceKey({ ...ids, direction: 'source' }),
    recordId: ids.objectId,
    objectId: ids.objectId,
    fieldId: ids.fieldId,
  };
  const projected = projectDirectoryFileValue(value, 'tenant-a', link);
  assert.deepEqual(projected, {
    file_name: 'Report.pdf',
    file_size: 42,
    mime_type: 'application/pdf',
    file_url: `/api/organisation-directory/custom-object-file?directory_id=main&organization_id=${ids.relationshipId}&source_key=${encodeURIComponent(link.sourceKey)}&record_id=${ids.objectId}&file_index=0`,
  });
  assert.equal('storage_path' in projected, false);
  assert.equal('bucket' in projected, false);
  assert.doesNotMatch(projected.file_url, /storage|bucket|stale-signed-secret/);
  assert.deepEqual(projectDirectoryFileValue(JSON.stringify({
    storage_path: 'other-tenant/report.pdf',
    file_url: 'https://evil.example/report.pdf',
    bucket: 'private-uploads',
  }), 'tenant-a', link), {
    unavailable: true,
    reason: DIRECTORY_FILE_REUPLOAD_REASON,
  });
  assert.deepEqual(projectDirectoryFileValue(JSON.stringify({
    storage_path: `tenant-a/custom-object-files/${ids.objectId}/${ids.fieldId}/../other-tenant/report.pdf`,
    bucket: 'private-uploads',
  }), 'tenant-a', link), {
    unavailable: true,
    reason: DIRECTORY_FILE_REUPLOAD_REASON,
  });
});

test('directory file namespace rejects protected and different-object assets', () => {
  const tenant = 'tenant-a';
  const object = ids.objectId;
  const field = ids.fieldId;
  assert.equal(isDirectoryObjectFilePath(
    `${tenant}/custom-object-files/${object}/${field}/40000000-0000-4000-8000-000000000004-report.pdf`,
    tenant,
    object,
    field,
  ), true);
  for (const forged of [
    `${tenant}/galleries/gallery-id/1700000000000-abcdefg-private.jpg`,
    `${tenant}/opportunities/opportunity-id/1700000000000-abcdefg-contract.pdf`,
    `${tenant}/attachments/general/1700000000000-abcdefg-private.pdf`,
    `${tenant}/custom-object-files/${object}/60000000-0000-4000-8000-000000000006/40000000-0000-4000-8000-000000000004-other-field.pdf`,
    `${tenant}/custom-object-files/60000000-0000-4000-8000-000000000006/${field}/40000000-0000-4000-8000-000000000004-other-object.pdf`,
    `${tenant}/form-submissions/general/1700000000000-abcdefg-legacy.pdf`,
    `${tenant}/custom-object-files/${object}/${field}/forged-name.pdf`,
  ]) {
    assert.equal(isDirectoryObjectFilePath(forged, tenant, object, field), false, forged);
  }
});

test('legacy and field-mismatched nonempty references return actionable unavailability', () => {
  const link = {
    directoryId: 'main',
    organizationId: ids.relationshipId,
    sourceKey: customObjectDirectorySourceKey({ ...ids, direction: 'target' }),
    recordId: ids.objectId,
    objectId: ids.objectId,
    fieldId: ids.fieldId,
  };
  for (const storagePath of [
    `tenant-a/form-submissions/general/1700000000000-abcdefg-legacy.pdf`,
    `tenant-a/custom-object-files/${ids.objectId}/60000000-0000-4000-8000-000000000006/40000000-0000-4000-8000-000000000004-other.pdf`,
  ]) {
    const value = projectDirectoryFileValue(JSON.stringify({
      storage_path: storagePath,
      bucket: 'private-uploads',
      file_url: 'https://storage.example.test/raw-secret',
    }), 'tenant-a', link);
    assert.deepEqual(value, {
      unavailable: true,
      reason: DIRECTORY_FILE_REUPLOAD_REASON,
    });
    assert.doesNotMatch(JSON.stringify(value), /storage|raw-secret|general|other\.pdf/);
  }
});

test('projection code is tenant scoped, permission gated and bounded', () => {
  const source = fs.readFileSync(new URL('./customObjectDirectory.js', import.meta.url), 'utf8');
  assert.match(source, /configuration\?\.views\?\.organisation_directory/);
  for (const table of [
    'custom_object_definition', 'custom_object_relationship_definition',
    'preference_field', 'custom_object_role_permission',
    'custom_object_field_role_permission', 'custom_object_relationship',
    'custom_object_record',
  ]) {
    assert.match(source, new RegExp(`from\\('${table}'\\)[\\s\\S]{0,400}eq\\('tenant_id', context\\.tenantId\\)`));
  }
  assert.match(source, /capability: 'view_records'/);
  assert.match(source, /!context\.roleId/);
  assert.match(source, /primary_display_field_id/);
  assert.match(source, /\.is\('archived_at', null\)/);
  assert.match(source, /\.limit\(CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE \+ 1\)/);
  assert.match(source, /QUERY_ID_CHUNK_SIZE = 200/);
  assert.match(source, /QUERY_PAGE_SIZE = 500/);
  assert.match(source, /\.order\('id', \{ ascending: true \}\)/);
  assert.match(source, /\.range\(offset, offset \+ QUERY_PAGE_SIZE - 1\)/);
  assert.match(source, /requiredFieldIds/);
  assert.match(source, /\.in\('id', ids\)/);
  assert.doesNotMatch(source, /preference_field'\)\.select\('\*'\)/);
  assert.match(source, /if \(seen\.has\(key\)\) continue/);
  assert.doesNotMatch(source, /\.select\('\*'\).*custom_object_record/);
});

test('file fields never generate signed or public storage URLs', () => {
  const source = fs.readFileSync(new URL('./customObjectDirectory.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createSignedUrl|publicUrl/);
  assert.match(source, /field_type: metadata\.type/);
  assert.match(source, /allowed_file_types/);
});