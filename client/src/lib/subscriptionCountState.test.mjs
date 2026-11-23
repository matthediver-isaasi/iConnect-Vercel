import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { fetchSubscriberEntity, subscriberInputKey, subscriberInputState, invalidateSubscriberInputs } from './subscriptionCountState.mjs';
import { fetchAllExternalSubscribers } from './subscriberModalSearch.js';

const success = data => ({ data, isSuccess: true, isFetching: false });
test('admin preference mutation surfaces retain member invalidation and refresh aggregate inputs', () => {
  for (const path of ['../pages/MemberDetail.jsx', '../pages/AdminMemberEdit.jsx', '../components/MemberDetailView.jsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /invalidateQueries\(\{ queryKey: \["admin-member-communication-preferences", [^\n]+\n\s*invalidateSubscriberInputs\(queryClient\)/);
    if (!path.includes('AdminMemberEdit')) {
      assert.match(source, /await setAdminMemberCommunicationGlobalState[^\n]+\n\s*invalidateSubscriberInputs\(queryClient\)/);
    }
  }
});
test('external one before preferences never becomes an authoritative total; successful zero does', () => {
  assert.equal(subscriberInputState('a', [success([]), {}, success({ news: 1 })]), 'loading');
  assert.equal(subscriberInputState('a', [success([]), success([]), success({})]), 'ready');
  assert.equal(subscriberInputState(null, [success([]), success([]), success({})]), 'loading');
});
test('member and preference failures, including failed cached refreshes, are unavailable', () => {
  for (const index of [0, 1, 2]) {
    const queries = [success([]), success([]), success({ news: 1 })];
    queries[index] = { ...queries[index], isSuccess: false, isError: true };
    assert.equal(subscriberInputState('a', queries), 'unavailable');
    queries[index].isFetching = true;
    assert.equal(subscriberInputState('a', queries), 'refreshing');
  }
});
test('real query cache remount avoids a fresh request; mutations invalidate aggregates and retain legacy prefixes', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  let reads = 0;
  const options = { queryKey: subscriberInputKey('all-members-for-export', 'a'), queryFn: async () => { reads++; return []; } };
  await client.fetchQuery(options);
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  assert.equal(reads, 1);
  assert.equal(observer.getCurrentResult().isSuccess, true);
  client.setQueryData(subscriberInputKey('member-communication-preferences', 'a'), []);
  await invalidateSubscriberInputs(client);
  assert.equal(reads, 2);
  assert.equal(client.getQueryState(subscriberInputKey('member-communication-preferences', 'a')).isInvalidated, true);
  unsubscribe();
  client.clear();
});
test('old tenant requests cannot populate the new tenant cache', async () => {
  const client = new QueryClient();
  let finish;
  const old = client.fetchQuery({ queryKey: subscriberInputKey('all-members-for-export', 'a'), queryFn: () => new Promise(resolve => { finish = resolve; }) });
  const nextKey = subscriberInputKey('all-members-for-export', 'b');
  assert.equal(client.getQueryData(nextKey), undefined);
  await client.fetchQuery({ queryKey: nextKey, queryFn: async () => [{ id: 'b' }] });
  finish([{ id: 'a' }]);
  await old;
  assert.deepEqual(client.getQueryData(nextKey), [{ id: 'b' }]);
  client.clear();
});
test('all entity pages pin tenant and signal and reject later failures or malformed pages', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  await assert.rejects(fetchSubscriberEntity('Member', 'a', signal, async (url, options) => {
    assert.equal(options.headers['X-Tenant-Id'], 'a');
    assert.equal(options.signal, signal);
    calls++;
    return calls === 1 ? { ok: true, json: async () => Array.from({ length: 1000 }, (_, id) => ({ id })) } : { ok: false };
  }));
  assert.equal(calls, 2);
  await assert.rejects(fetchSubscriberEntity('Member', 'a', signal, async () => ({ ok: true, json: async () => ({}) })));
});
test('external export rejects partial, malformed, duplicate and changing totals', async () => {
  for (const pages of [
    [{ subscribers: [{ id: 'a' }], total: 2 }, { subscribers: [], total: 2 }],
    [{}],
    [{ subscribers: [{ id: 'a' }, { id: 'a' }], total: 2 }],
    [{ subscribers: [{ id: 'a' }], total: 2 }, { subscribers: [{ id: 'b' }], total: 3 }],
  ]) {
    await assert.rejects(fetchAllExternalSubscribers({ categoryId: 'news', fetchImpl: async () => ({ ok: true, json: async () => pages.shift() }) }));
  }
});
