import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMemberGroup } from './memberGroupDerivation.mjs';

const ORG_A        = { id: 'org-a', organization_group_id: 'grp-1' };
const ORG_B        = { id: 'org-b', organization_group_id: 'grp-2' };
const ORG_UNGROUPED = { id: 'org-c', organization_group_id: null };
const ORGS = [ORG_A, ORG_B, ORG_UNGROUPED];

// ── view mode (isEditing = false) ────────────────────────────────────────────

test('view: member with org shows org-derived group, ignores manual value', () => {
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: 'org-a', formGroupId: 'grp-9', memberGroupId: 'grp-9',
    isEditing: false, organizations: ORGS,
  });
  assert.equal(hasOrg, true);
  assert.equal(derivedGroupId, 'grp-1');   // org-a's group
});

test('view: member with org that has no group gives null', () => {
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: 'org-c', formGroupId: null, memberGroupId: null,
    isEditing: false, organizations: ORGS,
  });
  assert.equal(hasOrg, true);
  assert.equal(derivedGroupId, null);
});

test('view: member with no org shows persisted manual group', () => {
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: '', formGroupId: 'grp-9', memberGroupId: 'grp-manual',
    isEditing: false, organizations: ORGS,
  });
  assert.equal(hasOrg, false);
  assert.equal(derivedGroupId, 'grp-manual');
});

test('view: member with no org and no manual group gives null', () => {
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: null, formGroupId: null, memberGroupId: null,
    isEditing: false, organizations: ORGS,
  });
  assert.equal(hasOrg, false);
  assert.equal(derivedGroupId, null);
});

// ── edit mode: org changes ───────────────────────────────────────────────────

test('edit: changing org immediately reflects new org\'s group', () => {
  // Member was on org-a; admin selects org-b in the dropdown
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: 'org-b', formGroupId: 'grp-1', memberGroupId: 'grp-1',
    isEditing: true, organizations: ORGS,
  });
  assert.equal(hasOrg, true);
  assert.equal(derivedGroupId, 'grp-2');   // org-b's group, not org-a's
});

test('edit: clearing org exposes manual selector (formGroupId is active)', () => {
  // Admin clears the org; manual selection grp-manual becomes active
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: '', formGroupId: 'grp-manual', memberGroupId: 'grp-1',
    isEditing: true, organizations: ORGS,
  });
  assert.equal(hasOrg, false);
  assert.equal(derivedGroupId, 'grp-manual');
});

test('edit: assigning a fresh org to an org-less member uses org group', () => {
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: 'org-a', formGroupId: 'grp-manual', memberGroupId: 'grp-manual',
    isEditing: true, organizations: ORGS,
  });
  assert.equal(hasOrg, true);
  assert.equal(derivedGroupId, 'grp-1');   // org-a's group; manual is ignored
});

test('edit: org not yet in list falls back to null', () => {
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: 'unknown-org', formGroupId: 'grp-1', memberGroupId: null,
    isEditing: true, organizations: ORGS,
  });
  assert.equal(hasOrg, true);
  assert.equal(derivedGroupId, null);
});

test('edit: no org selected and no manual group gives null', () => {
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: '', formGroupId: '', memberGroupId: null,
    isEditing: true, organizations: ORGS,
  });
  assert.equal(hasOrg, false);
  assert.equal(derivedGroupId, null);
});

test('edit: clearing org and no manual group selected gives null', () => {
  // Admin cleared org, formGroupId is also blank
  const { hasOrg, derivedGroupId } = deriveMemberGroup({
    formOrgId: null, formGroupId: null, memberGroupId: 'grp-1',
    isEditing: true, organizations: ORGS,
  });
  assert.equal(hasOrg, false);
  assert.equal(derivedGroupId, null);  // formGroupId (null) used, not memberGroupId
});
