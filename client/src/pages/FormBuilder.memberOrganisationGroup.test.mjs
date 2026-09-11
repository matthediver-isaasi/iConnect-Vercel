import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./FormBuilder.jsx', import.meta.url), 'utf8');

test('member mappings expose Organisation Group as a core destination', () => {
  assert.match(
    source,
    /\{ value: 'organization_group_id', label: 'Organisation Group' \}/,
  );
  assert.match(source, /data-testid=\{`member-organization-group-guidance-\$\{index\}`\}/);
  assert.match(source, /persisted Organisation Group ID, not its display name/);
});

test('member group mappings only offer persisted-ID dropdown sources', () => {
  assert.match(
    source,
    /const isOrganizationGroupTarget = mappingTargetEntity === 'member'[\s\S]*?mapping\.target_field === 'organization_group_id'/,
  );
  assert.match(
    source,
    /const availableSourceFields = fields\.filter\(field => \{[\s\S]*?organisation_group_dropdown[\s\S]*?organization_group_dropdown/,
  );
});

test('structured member actions treat Organisation Group as a record reference', () => {
  assert.match(
    source,
    /reference_kind:[\s\S]*?field\.value === 'organization_group_id'[\s\S]*?'organization_group'/,
  );
  assert.match(source, /data-testid=\{`member-organization-group-guidance-\$\{actionIndex\}`\}/);
  assert.match(source, /reference_kind \? `reference:\$\{target\.reference_kind\}`/);
});

test('member detail keeps stored group IDs visible after loading', async () => {
  const detailSources = await Promise.all([
    readFile(new URL('../components/MemberDetailView.jsx', import.meta.url), 'utf8'),
    readFile(new URL('./MemberDetail.jsx', import.meta.url), 'utf8'),
  ]);
  for (const detail of detailSources) {
    assert.match(detail, /organization_group_id: member\.organization_group_id \|\| ''/);
    assert.match(detail, /const displayedGroup = orgGroups\.find\(g => g\.id === derivedGroupId\)/);
  }
});