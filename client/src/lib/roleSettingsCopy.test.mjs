import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { copyRoleSettings, publishRoleSettingsCopy, subscribeRoleSettingsCopy, refreshRoleSettingsQueries, ROLE_SETTINGS_CHANGED } from './roleSettingsCopy.js';
import { QueryClient } from '@tanstack/react-query';

test('refresh removes stale role and field permission projections and invalidates other effective access queries', async () => {
  const client = new QueryClient();
  for (const key of ['roles', 'memberRole', 'bulk-member-field-permissions', 'resource-categories-for-roles', 'authenticated-resource-categories', 'member-profile']) {
    client.setQueryData([key], { stale: true });
  }
  await refreshRoleSettingsQueries(client);
  for (const key of ['roles', 'memberRole', 'bulk-member-field-permissions', 'resource-categories-for-roles', 'authenticated-resource-categories']) {
    assert.equal(client.getQueryData([key]), undefined, key);
  }
  assert.equal(client.getQueryState(['member-profile']).isInvalidated, true);
  client.clear();
});

test('copy uses the dedicated authenticated endpoint and never duplicates', async () => {
  const role = { id: 'target', name: 'Target' };
  const result = await copyRoleSettings('source', 'target', async (url, options) => {
    assert.equal(url, '/api/admin/roles/copy-settings');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'include');
    assert.deepEqual(JSON.parse(options.body), { sourceRoleId: 'source', targetRoleId: 'target' });
    return { ok: true, json: async () => ({ role }) };
  });
  assert.deepEqual(result, role);
});

test('empty and identical selections never issue a request', async () => {
  for (const ids of [['', 'target'], ['source', ''], ['same', 'same']]) {
    await assert.rejects(copyRoleSettings(...ids, () => assert.fail('request issued')), /different roles/);
  }
});

test('server, malformed response, and transport failures remain explicit', async () => {
  await assert.rejects(copyRoleSettings('s', 't', async () => ({
    ok: false, json: async () => ({ error: 'Permission denied' }),
  })), /Permission denied/);
  for (const response of [
    { ok: true, json: async () => ({}) },
    { ok: false, json: async () => { throw new Error('HTML'); } },
  ]) {
    await assert.rejects(copyRoleSettings('s', 't', async () => response), /Failed to copy/);
  }
  await assert.rejects(copyRoleSettings('s', 't', async () => { throw new Error('Offline'); }), /Offline/);
});

test('copy notifies same-tab and other-tab draft/cache listeners, with cleanup', () => {
  const dom = new JSDOM('', { url: 'https://tenant.test' });
  const previous = globalThis.CustomEvent;
  globalThis.CustomEvent = dom.window.CustomEvent;
  try {
    const received = [];
    const unsubscribe = subscribeRoleSettingsCopy(detail => received.push(detail), dom.window);
    publishRoleSettingsCopy('target', dom.window);
    assert.equal(received[0].targetRoleId, 'target');
    const message = dom.window.localStorage.getItem(ROLE_SETTINGS_CHANGED);
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: ROLE_SETTINGS_CHANGED, newValue: message }));
    assert.equal(received.length, 2);
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: ROLE_SETTINGS_CHANGED, newValue: '{invalid' }));
    assert.equal(received.length, 2);
    unsubscribe();
    publishRoleSettingsCopy('target', dom.window);
    assert.equal(received.length, 2);
  } finally {
    globalThis.CustomEvent = previous;
    dom.window.close();
  }
});