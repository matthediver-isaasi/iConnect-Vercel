import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('settings custom fields have an independent save and destructive confirmation', () => {
  assert.match(source('./MemberGroupSettings.jsx'), /<CustomFieldSettingsCard enabled=\{accessChecked\}/);
  const card = source('../components/member-groups/CustomFieldSettingsCard.jsx');
  assert.match(card, /confirmedDeletedIds: deletedIds/);
  assert.match(card, /fields, revision/);
  assert.match(card, /AlertDialogTitle>Remove this custom field/);
  assert.match(card, /show_on_detail: false/);
  assert.match(card, /disabled=\{!!field.id\}/);
  assert.match(card, /readOnly=\{choiceIndex < originalChoices.length\}/);
  assert.match(card, /Your draft is kept/);
  assert.match(card, /key=\{definitions.scopeKey\}/);
});

test('group modal supports create reset, edit, duplicate, explicit replacement and fail-closed saving', () => {
  const page = source('./MemberGroupManagement.jsx');
  const reset = page.slice(page.indexOf('const resetGroupForm'), page.indexOf('const handleEditGroup'));
  const edit = page.slice(page.indexOf('const handleEditGroup'), page.indexOf('const handleDuplicateGroup'));
  const duplicate = page.slice(page.indexOf('const handleDuplicateGroup'), page.indexOf('const handleSaveGroup'));
  assert.match(reset, /custom_field_values: \{\}/);
  for (const block of [edit, duplicate]) assert.match(block, /custom_field_values: copyCustomFieldValues\(group.custom_field_values\)/);
  assert.match(page, /custom_field_values: customFieldValues/);
  assert.match(page, /if \(!customFields.ready\)/);
  assert.match(page, /disabled=\{!customFields.ready \|\| createGroupMutation/);
  assert.match(page, /MemberGroup.create\(withCustomFieldValues\(data\)\)/);
  assert.match(page, /MemberGroup.update\(id, withCustomFieldValues\(data\)\)/);
  assert.match(page, /<CustomFieldInputs/);
});

test('public projection is rendered immediately after About independently of whether About exists', () => {
  const page = source('./MemberGroupDetail.jsx');
  const about = page.indexOf('{group.about_the_group && (');
  const fields = page.indexOf('<CustomFieldsDisplay fields={group.custom_fields_display} />');
  const next = page.indexOf('{group.linkedin_url && (', about);
  assert.ok(about < fields && fields < next);
  assert.match(page.slice(about, fields), /<\/>\s*\)\}/);
  const display = source('../components/member-groups/CustomFieldsDisplay.jsx');
  assert.doesNotMatch(display, /dangerouslySetInnerHTML|custom_field_values/);
  assert.match(display, /whitespace-pre-wrap break-words/);
  assert.match(display, /text-slate-700 mb-4 prose prose-sm max-w-none/);
});

test('definition discovery is tenant/session-scoped and uses authenticated tenant-header requests', () => {
  const hook = source('../hooks/useMemberGroupCustomFields.js');
  assert.match(hook, /subscribeToActiveTenantId/);
  assert.match(hook, /sessionRoleSnapshot\?\.session_key/);
  assert.match(hook, /memberInfo\?\.id/);
  assert.match(hook, /'X-Tenant-Id': tenantId/);
  assert.match(hook, /'X-Tenant-Id': snapshot.tenantId/);
  assert.match(hook, /scopeRef.current !== snapshot.scopeKey/);
  assert.match(hook, /query.isSuccess && !query.isFetching && !query.isError/);
});
