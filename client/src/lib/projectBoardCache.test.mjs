import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { publishCreatedProjectCard, publishProjectCardUpdate, publishProjectCardComment, publishProjectCardAssignee } from './projectBoardCache.js';
import { refreshSalesProjects } from '../components/sales/useSalesProjectTasks.js';
test('assignment deltas cancel stale reads, preserve relationships and never await refreshes', async () => {
  const client = new QueryClient();
  const card = { id: 'card', title: 'Saved', project_card_label: [{ label_id: 'label' }],
    project_card_assignee: [{ identity_id: 'existing' }] };
  const detailKey = ['card-detail', 'card'];
  const boardKey = ['project-board', 'board'];
  client.setQueryData(detailKey, { card, comments: [{ id: 'comment', images: ['image'] }] });
  client.setQueryData(boardKey, { cards: [card, { id: 'other' }] });
  let finish;
  const stale = client.fetchQuery({ queryKey: detailKey,
    queryFn: () => new Promise(resolve => { finish = resolve; }) }).catch(() => {});
  await publishProjectCardAssignee(client, 'card', 'new', { identity_id: 'new', id: 'assignment' });
  await publishProjectCardAssignee(client, 'card', 'existing', null);
  finish({ card }); await stale;
  for (const saved of [client.getQueryData(detailKey).card, client.getQueryData(boardKey).cards[0]]) {
    assert.deepEqual(saved.project_card_assignee, [{ identity_id: 'new', id: 'assignment' }]);
    assert.deepEqual(saved.project_card_label, card.project_card_label);
  }
  assert.deepEqual(client.getQueryData(detailKey).comments, [{ id: 'comment', images: ['image'] }]);
  client.clear();
});

test('isolated assignment latency separates the write from eight-root refresh waiting', async t => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const client = new QueryClient();
  const roots = ['sales-project-tasks', 'opportunity', 'opportunities', 'project-board', 'project-boards', 'card-detail', 'sales-dashboard', 'sales-reports'];
  const subscriptions = roots.map(root => {
    const key = [root, root === 'card-detail' ? 'card' : 'fixture'];
    client.setQueryData(key, root === 'card-detail' ? { card: { id: 'card' } } : root === 'project-board' ? { cards: [{ id: 'card' }] } : {});
    const observer = new QueryObserver(client, { queryKey: key, staleTime: Infinity,
      queryFn: async () => { await sleep(150); return client.getQueryData(key); } });
    return observer.subscribe(() => {});
  });
  const start = performance.now();
  await sleep(25); // Isolated simulated write, not a production latency claim.
  const written = performance.now();
  await refreshSalesProjects(client); // Actual previous mutation callback.
  const before = performance.now() - start;
  const afterStart = performance.now();
  await sleep(25);
  const afterWrite = performance.now();
  await publishProjectCardAssignee(client, 'card', 'person', { identity_id: 'person' });
  void refreshSalesProjects(client);
  const after = performance.now() - afterStart;
  t.diagnostic(JSON.stringify({ fixtureWriteMs: written - start, beforePendingMs: before,
    afterWriteMs: afterWrite - afterStart, afterPendingMs: after }));
  assert.ok(after < before - 80);
  subscriptions.forEach(unsubscribe => unsubscribe());
  client.clear();
});
test('confirmed comments immediately update counts, deduplicate and preserve relationships', async () => {
  const client = new QueryClient();
  const card = { id: 'card', project_card_comment: [{ count: 2 }], project_card_label: [{ label_id: 'label' }], project_card_attachment: [{ id: 'file' }] };
  const key = ['project-board', 'board'];
  client.setQueryData(key, { cards: [card, { id: 'other' }], labels: ['label'] });
  client.setQueryData(['project-board', 'other'], { cards: [{ id: 'unrelated' }] });
  client.setQueryData(['card-detail', 'card'], { card, comments: [{ id: 'one' }, { id: 'two' }], activity: ['activity'] });
  const comment = { id: 'three', content: 'Ready' };
  await publishProjectCardComment(client, 'board', 'card', comment);
  assert.equal(client.getQueryData(key).cards[0].project_card_comment[0].count, 3);
  assert.deepEqual(client.getQueryData(key).cards[0].project_card_attachment, [{ id: 'file' }]);
  assert.deepEqual(client.getQueryData(key).cards[0].project_card_label, [{ label_id: 'label' }]);
  assert.deepEqual(client.getQueryData(key).cards[1], { id: 'other' });
  assert.deepEqual(client.getQueryData(['card-detail', 'card']).activity, ['activity']);
  await publishProjectCardComment(client, 'board', 'card', comment);
  assert.equal(client.getQueryData(key).cards[0].project_card_comment[0].count, 3);
  assert.equal(client.getQueryData(['card-detail', 'card']).comments.length, 3);
  assert.deepEqual(client.getQueryData(['project-board', 'other']).cards, [{ id: 'unrelated' }]);
  await publishProjectCardComment(client, 'missing', 'missing', comment);
  assert.equal(client.getQueryData(['project-board', 'missing']), undefined);
  client.clear();
});

test('comment publication cancels an older board read and handles absent aggregate counts', async () => {
  const client = new QueryClient();
  const key = ['project-board', 'board'];
  client.setQueryData(key, { cards: [{ id: 'card' }] });
  let finish;
  const pending = client.fetchQuery({ queryKey: key, queryFn: () => new Promise(resolve => { finish = resolve; }) }).catch(() => {});
  await publishProjectCardComment(client, 'board', 'card', { id: 'comment' });
  finish({ cards: [{ id: 'card', project_card_comment: [{ count: 0 }] }] });
  await pending;
  assert.equal(client.getQueryData(key).cards[0].project_card_comment[0].count, 1);
  client.clear();
});
test('uploads and covers publish to both caches without dropping card relationships', async () => {
  const client = new QueryClient();
  const key = ['project-board', 'board'];
  const card = { id: 'card', board_id: 'board', cover_image: null, project_card_label: [{ label_id: 'label' }] };
  client.setQueryData(key, { cards: [card, { id: 'other' }], labels: ['label'] });
  client.setQueryData(['card-detail', 'card'], { card, attachments: [], comments: ['comment'] });
  const attachment = { id: 'image', url: '/image.png', file_type: 'image/png' };
  await publishProjectCardUpdate(client, 'card', {}, { attachment });
  await publishProjectCardUpdate(client, 'card', { cover_image: attachment.url });
  assert.equal(client.getQueryData(key).cards[0].cover_image, '/image.png');
  assert.deepEqual(client.getQueryData(key).cards[0].project_card_label, [{ label_id: 'label' }]);
  assert.deepEqual(client.getQueryData(['card-detail', 'card']).attachments, [attachment]);
  assert.deepEqual(client.getQueryData(['card-detail', 'card']).comments, ['comment']);
  await publishProjectCardUpdate(client, 'card', { cover_image: null }, { removedAttachmentId: 'image' });
  assert.deepEqual(client.getQueryData(['card-detail', 'card']).attachments, []);
  assert.equal(client.getQueryData(key).cards[0].cover_image, null);
  assert.deepEqual(client.getQueryData(key).cards[1], { id: 'other' });
  client.clear();
});

test('confirmed card is visible while the background board request is still pending', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ['project-board', 'board'];
  client.setQueryData(key, { board: { id: 'board' }, cards: [{ id: 'old' }] });
  let complete;
  const observer = new QueryObserver(client, {
    queryKey: key, staleTime: Infinity,
    queryFn: () => new Promise(resolve => { complete = resolve; }),
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await publishCreatedProjectCard(client, 'board', { id: 'new', board_id: 'board', list_id: 'list', title: 'Saved' });
    assert.equal(client.getQueryState(key).fetchStatus, 'fetching');
    assert.deepEqual(client.getQueryData(key).cards.map(card => card.id), ['old', 'new']);
    assert.deepEqual(client.getQueryData(key).cards[1].project_card_attachment, []);
    complete(client.getQueryData(key));
  } finally { unsubscribe(); client.clear(); }
});

test('a pre-save board read cannot overwrite the newly confirmed card', async () => {
  const client = new QueryClient();
  const key = ['project-board', 'board'];
  client.setQueryData(key, { cards: [] });
  let finishOld;
  const oldRead = client.fetchQuery({ queryKey: key,
    queryFn: () => new Promise(resolve => { finishOld = resolve; }) }).catch(() => {});
  await publishCreatedProjectCard(client, 'board', { id: 'new', board_id: 'board' });
  finishOld({ cards: [] });
  await oldRead;
  assert.equal(client.getQueryData(key).cards[0].id, 'new');
  client.clear();
});

test('does not duplicate realtime cards, affect another board or create an incomplete board cache', async () => {
  const client = new QueryClient();
  const key = ['project-board', 'board'];
  const existing = { id: 'new', board_id: 'board', title: 'Updated by colleague', project_card_attachment: [{ id: 'file' }] };
  client.setQueryData(key, { cards: [existing], members: ['member'] });
  client.setQueryData(['project-board', 'other'], { cards: [] });
  await publishCreatedProjectCard(client, 'board', { id: 'new', board_id: 'board', title: 'Original' });
  assert.deepEqual(client.getQueryData(key), { cards: [existing], members: ['member'] });
  await publishCreatedProjectCard(client, 'other', existing);
  assert.deepEqual(client.getQueryData(['project-board', 'other']).cards, []);
  await publishCreatedProjectCard(client, 'missing', { id: 'card', board_id: 'missing' });
  assert.equal(client.getQueryData(['project-board', 'missing']), undefined);
  await publishCreatedProjectCard(client, 'board', null);
  assert.deepEqual(client.getQueryData(key).cards, [existing]);
  client.clear();
});
