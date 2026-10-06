import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  organisationDirectKey,
  organisationListKey,
  syncOrganisationCaches,
  syncOrganisationPreferenceCache,
  saveOrganisationEdits,
} from './organisationCacheSync.mjs';

const tenantId = 'tenant-a';
const memberId = 'member-a';
const organizationId = 'org-off-page';
const directKey = organisationDirectKey(tenantId, memberId, organizationId);
const listKey = [...organisationListKey(tenantId, memberId), 1, 20, ''];
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const sync = (queryClient, extra) => syncOrganisationCaches({
  queryClient, tenantId, memberId, organizationId, ...extra,
});

test('direct-linked organisation outside first page displays saved core values immediately', async () => {
  const queryClient = client();
  queryClient.setQueryData(directKey, { id: organizationId, name: 'Previous name', phone: '123' });
  const page = { organizations: [{ id: 'first-page-org', name: 'Another org' }], pagination: { total: 28 } };
  queryClient.setQueryData(listKey, page);
  await sync(queryClient, { updates: { name: 'Saved name' } });
  assert.equal(queryClient.getQueryData(directKey).name, 'Saved name');
  assert.equal(queryClient.getQueryData(directKey).phone, '123');
  assert.deepEqual(queryClient.getQueryData(listKey), page);
  assert.equal(queryClient.getQueryState(listKey).isInvalidated, true);
  queryClient.clear();
});

test('save patches every scoped cached page and direct record, preserving counts and other rows', async () => {
  const queryClient = client();
  const org = { id: organizationId, name: 'Before', member_count: 7, custom_fields: { other: 'unchanged' } };
  const other = { id: 'other-org', name: 'Other' };
  const pagination = { total: 28, totalPages: 2 };
  const secondKey = [...organisationListKey(tenantId, memberId), 2, 20, 'filtered'];
  queryClient.setQueryData(directKey, org);
  for (const key of [listKey, secondKey]) queryClient.setQueryData(key, { organizations: [org, other], pagination });
  await sync(queryClient, { updates: { name: 'After', tags: ['Partner'] } });
  for (const key of [listKey, secondKey]) {
    const page = queryClient.getQueryData(key);
    assert.equal(page.organizations[0].name, 'After');
    assert.equal(page.organizations[0].member_count, 7);
    assert.deepEqual(page.organizations[0].tags, ['Partner']);
    assert.strictEqual(page.organizations[1], other);
    assert.strictEqual(page.pagination, pagination);
  }
  assert.equal(queryClient.getQueryData(directKey).name, 'After');
  queryClient.clear();
});

test('same organisation id in another tenant or session is neither patched nor invalidated', async () => {
  const queryClient = client();
  const untouchedKeys = [];
  for (const [tenant, member] of [['tenant-b', memberId], [tenantId, 'member-b']]) {
    const direct = organisationDirectKey(tenant, member, organizationId);
    const list = [...organisationListKey(tenant, member), 1];
    queryClient.setQueryData(direct, { id: organizationId, name: 'Private' });
    queryClient.setQueryData(list, { organizations: [{ id: organizationId, name: 'Private' }] });
    untouchedKeys.push(direct, list);
  }
  await sync(queryClient, { updates: { name: 'Changed' } });
  assert.equal(queryClient.getQueryData(directKey), undefined, 'do not fabricate an uncached direct record');
  for (const key of untouchedKeys) {
    assert.equal(queryClient.getQueryState(key).isInvalidated, false);
    const cached = queryClient.getQueryData(key);
    assert.equal((cached.organizations?.[0] || cached).name, 'Private');
  }
  queryClient.clear();
});

test('active list refetch applies server-owned sort/filter membership after save', async () => {
  const queryClient = client();
  queryClient.setQueryData(listKey, { organizations: [{ id: organizationId, name: 'Before' }], pagination: { total: 1 } });
  let reads = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: listKey,
    staleTime: Infinity,
    queryFn: async () => {
      reads += 1;
      return { organizations: [], pagination: { total: 0 } };
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  await sync(queryClient, { updates: { name: 'No longer matches filter' } });
  assert.equal(reads, 1);
  assert.deepEqual(queryClient.getQueryData(listKey), { organizations: [], pagination: { total: 0 } });
  unsubscribe();
  queryClient.clear();
});

test('older in-flight direct read cannot overwrite a committed save', async () => {
  const queryClient = client();
  queryClient.setQueryData(directKey, { id: organizationId, name: 'Before' });
  let resolveRead;
  const pending = queryClient.fetchQuery({
    queryKey: directKey,
    queryFn: () => new Promise(resolve => { resolveRead = resolve; }),
  }).catch(() => {});
  await sync(queryClient, { updates: { name: 'Saved' } });
  resolveRead({ id: organizationId, name: 'Stale response' });
  await pending;
  assert.equal(queryClient.getQueryData(directKey).name, 'Saved');
  queryClient.clear();
});

test('custom fields update detail values and list columns, preserving unrelated fields and list values', async () => {
  const queryClient = client();
  const prefKey = ['org-detail-preference-values', organizationId];
  queryClient.setQueryData(prefKey, [
    { id: 'pref-one', field_id: 'country', value: '["Before"]' },
    { id: 'pref-two', field_id: 'other', value: 'Keep' },
  ]);
  queryClient.setQueryData(listKey, {
    organizations: [{ id: organizationId, custom_fields: { country: '["Before"]', other: 'Keep' } }],
  });
  const change = { fieldId: 'country', value: ['France', 'Japan'] };
  await syncOrganisationPreferenceCache(queryClient, organizationId, change);
  await sync(queryClient, { customValue: change });
  assert.deepEqual(queryClient.getQueryData(prefKey), [
    { id: 'pref-one', field_id: 'country', value: '["France","Japan"]' },
    { id: 'pref-two', field_id: 'other', value: 'Keep' },
  ]);
  assert.deepEqual(queryClient.getQueryData(listKey).organizations[0].custom_fields, {
    country: ['France', 'Japan'], other: 'Keep',
  });
  await syncOrganisationPreferenceCache(queryClient, organizationId, { fieldId: 'new', value: false });
  assert.equal(queryClient.getQueryData(prefKey).at(-1).value, 'false');
  await syncOrganisationPreferenceCache(queryClient, organizationId, { fieldId: 'country', value: [] });
  assert.equal(queryClient.getQueryData(prefKey)[0].value, '[]');
  queryClient.clear();
});

test('save stays in edit mode until both core and every custom-field write complete', async () => {
  const events = [];
  let releaseCustom;
  const saving = saveOrganisationEdits({
    core: { name: 'Saved' },
    custom: [{ fieldId: 'one', value: 'Saved custom' }, { fieldId: 'two', value: [] }],
    updateCore: async core => { events.push(core.name); },
    updateCustom: async change => {
      events.push(change.fieldId);
      if (change.fieldId === 'one') await new Promise(resolve => { releaseCustom = resolve; });
    },
    finish: () => events.push('close-editing'),
  });
  await Promise.resolve();
  assert.deepEqual(events, ['Saved', 'one']);
  releaseCustom();
  await saving;
  assert.deepEqual(events, ['Saved', 'one', 'two', 'close-editing']);
});

test('failed core/custom writes keep draft open and do not run remaining saves', async () => {
  for (const failingStep of ['core', 'custom']) {
    const events = [];
    await assert.rejects(saveOrganisationEdits({
      core: { name: 'Draft' },
      custom: [{ fieldId: 'one' }, { fieldId: 'two' }],
      updateCore: async () => {
        events.push('core');
        if (failingStep === 'core') throw new Error('Failed');
      },
      updateCustom: async change => {
        events.push(change.fieldId);
        throw new Error('Failed');
      },
      finish: () => events.push('close-editing'),
    }), /Failed/);
    assert.deepEqual(events, failingStep === 'core' ? ['core'] : ['core', 'one']);
  }
});

test('production component uses scoped keys, synchronizes tags/logo/core/custom, and preserves edit guards', () => {
  const detail = readFileSync(new URL('../components/OrganisationDetailView.jsx', import.meta.url), 'utf8');
  const list = readFileSync(new URL('../pages/OrganisationsList.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(detail, /\['organization-direct', organization/);
  assert.match(list, /queryKey: organisationDirectKey\(memberInfo\?\.tenant_id, memberInfo\?\.id, urlOrgId\)/);
  assert.match(detail, /await syncOrgCaches\(\{ \.\.\.updates, \.\.\.data \}\)/);
  assert.match(detail, /await syncOrgCaches\(\{ tags: newTags, \.\.\.updated \}\)/);
  assert.match(detail, /await syncOrgCaches\(\{ logo_url: result.file_url, \.\.\.updated \}\)/);
  assert.match(detail, /await syncOrganisationPreferenceCache\(queryClient, organization.id, change\)/);
  assert.match(detail, /await syncOrgCaches\(\{\}, change\)/);
  assert.match(detail, /await saveOrganisationEdits\(/);
  assert.match(detail, /if \(organization && !isEditing\)/);
  assert.match(detail, /if \(!isEditing && orgCustomFields.length > 0\)/);
});
