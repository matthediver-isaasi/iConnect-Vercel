import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverDirectoryCarouselSources, presentDirectoryCarouselRecord, resolveDirectoryCarouselSource, resolveDirectoryCarouselPerView, resolveDirectoryCarouselOrganisationNameDisplay } from './directoryCarouselSource.mjs';

test('explicit source identity isolates primary sources and retains legacy slugs', () => {
  assert.equal(resolveDirectoryCarouselSource({}).configured, false);
  assert.equal(resolveDirectoryCarouselSource({ directorySlug: 'saved-orgs' }).identity, 'dynamic:saved-orgs');
  assert.deepEqual(resolveDirectoryCarouselSource({ source: 'primary-member', directorySlug: 'stale', directoryId: 'stale' }), {
    source: 'primary-member', directoryId: '', directorySlug: '', configured: true, identity: 'primary-member:',
  });
  assert.equal(resolveDirectoryCarouselSource({ source: 'dynamic', directoryId: 'stable-id', directorySlug: 'renamed' }).identity, 'dynamic:stable-id');
});

test('discovery loads beyond the first hundred and keeps both active entity types', async () => {
  const records = Array.from({ length: 237 }, (_, i) => ({
    id: String(i), name: `Directory ${i}`, is_active: i !== 214,
    entity_type: i % 2 ? 'member' : 'organization',
  }));
  records[235].entity_type = 'custom';
  const calls = [];
  const directories = await discoverDirectoryCarouselSources({
    list: async (options) => {
      calls.push(options);
      return records.slice(options.offset, options.offset + options.limit);
    },
  });
  assert.equal(directories.length, 235);
  assert.ok(directories.some((d) => d.id === '236'));
  assert.deepEqual(calls.map((c) => c.offset), [0, 100, 200, 237]);
});

test('discovery follows actual offsets until empty when the server caps batches at 37', async () => {
  const records = Array.from({ length: 137 }, (_, i) => ({
    id: String(i), name: `Directory ${i}`, entity_type: 'member', is_active: true,
  }));
  const calls = [];
  const directories = await discoverDirectoryCarouselSources({
    list: async ({ offset }) => {
      calls.push(offset);
      return records.slice(offset, offset + 37);
    },
  });
  assert.equal(directories.length, 137);
  assert.deepEqual(calls, [0, 37, 74, 111, 137]);
});

test('rendered entries per page match the bounded server contract for malformed legacy content', () => {
  assert.equal(resolveDirectoryCarouselPerView(999), 50);
  assert.equal(resolveDirectoryCarouselPerView(-4), 1);
  assert.equal(resolveDirectoryCarouselPerView(3.8), 3);
  assert.equal(resolveDirectoryCarouselPerView('2'), 2);
  assert.equal(resolveDirectoryCarouselPerView('invalid'), 3);
  assert.equal(resolveDirectoryCarouselPerView(Infinity), 3);
});

test('discovery surfaces failed/incomplete reads and stops repeated pages', async () => {
  await assert.rejects(discoverDirectoryCarouselSources({ list: async () => { throw new Error('Denied'); } }), /Denied/);
  await assert.rejects(discoverDirectoryCarouselSources({ list: async () => ({ records: [] }) }), /invalid response/);
  const repeated = Array.from({ length: 100 }, (_, id) => ({ id }));
  await assert.rejects(discoverDirectoryCarouselSources({ list: async () => repeated }), /next page/);
});

test('presentation only uses returned projection and has entity-specific fallback', () => {
  const member = presentDirectoryCarouselRecord({ id: '1', profile_photo_url: '/permitted.png', job_title: 'Coordinator' }, 'member');
  assert.equal(member.name, 'Member');
  assert.equal(member.logo_url, '/permitted.png');
  assert.equal(member.entity_type, 'member');
  assert.equal(member.email, undefined);
  const org = presentDirectoryCarouselRecord({ id: '2' }, 'organization');
  assert.equal(org.name, null);
  assert.equal(org.logo_url, null);
});

test('organisation name display defaults to inherit for existing and malformed content', () => {
  for (const value of [undefined, null, '', 'invalid', 'inherit']) {
    assert.equal(resolveDirectoryCarouselOrganisationNameDisplay(value), 'inherit');
  }
  for (const value of ['show', 'hide']) {
    assert.equal(resolveDirectoryCarouselOrganisationNameDisplay(value), value);
  }
});

test('withheld organisation names cannot be replaced by display_name or generic visible text', () => {
  for (const name of [undefined, null, '']) {
    assert.equal(presentDirectoryCarouselRecord({ name, display_name: 'Withheld name' }, 'organization').name, null);
  }
  assert.equal(presentDirectoryCarouselRecord({ name: 'Westhaven Society' }, 'organization').name, 'Westhaven Society');
  assert.equal(presentDirectoryCarouselRecord({ display_name: 'Alex Mercer' }, 'member').name, 'Alex Mercer');
});
